'use strict';

/**
 * Hierarchy mode: a task run by a team instead of one session.
 *
 *   Leader      the task's own Claude Code session (id = the task's id). The
 *               user talks to it; it plans, assigns, verifies and merges
 *               through the team tools (TEAM_TOOLS) and writes no code.
 *   Worker 1-4  `<task>--w1` … : each a real Claude Code session, on its own
 *               git worktree and branch per assignment (or, in a folder that
 *               isn't a git repository, on files it claims, which may not
 *               overlap another worker's).
 *   Verifier 1-2 `<task>--v1`, `--v2`: a fresh session in the worktree of the
 *               worker it checks; it reviews the diff, runs the tests, tries
 *               the app in the viewer and calls team_verdict.
 *
 * Sessions start only when there's work for them. A member's finished turn
 * (or a verdict) goes in the team's inbox until the leader collects it; the
 * daemon wakes an idle leader about it (wantsNudge / nudgeText). A team is
 * settled when nothing works and nothing waits to be collected: only then
 * does a leader's finished turn count as the task finishing.
 *
 * Pure apart from `io` (sessions, git, transcripts), so scripts/test-team.mjs
 * runs it with fakes. Shown states: idle | working | done | failed (+ needs).
 */

const WORKERS = ['w1', 'w2', 'w3', 'w4'];
const VERIFIERS = ['v1', 'v2'];
const KEYS = [...WORKERS, ...VERIFIERS];
const LOG_MAX = 80;
const WAIT_MAX_S = 240;
const RESULT_MAX = 4000;
const VERDICT = /VERDICT:\s*(PASS|FAIL)\b/i;

const labelOf = (key) => `${key[0] === 'w' ? 'Worker' : 'Verifier'} ${key[1]}`;
const memberId = (taskId, key) => `${taskId}--${key}`;

/** { taskId, key } for a member's session id, else null. */
function parseMember(id) {
  const match = /^(.+)--([wv][1-4])$/.exec(String(id || ''));
  if (!match || !KEYS.includes(match[2])) return null;
  return { taskId: match[1], key: match[2] };
}

/** "Worker 2", "worker 2", "w2", 2 → "w2" (workers), or null. */
function keyOf(value, role = 'worker') {
  const text = String(value ?? '').trim().toLowerCase();
  const n = /(\d)\s*$/.exec(text)?.[1];
  if (!n) return null;
  const key = `${role === 'worker' ? 'w' : 'v'}${n}`;
  return (role === 'worker' ? WORKERS : VERIFIERS).includes(key) ? key : null;
}

const clip = (text, max) => {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/* ------------------------------ file claims ------------------------------ */

const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

/** A claim as path segments, cut at its first wildcard (a glob claims its folder). */
function segments(claim) {
  const value = normPath(claim);
  const wild = value.search(/[*?[{]/);
  const fixed = wild < 0 ? value : value.slice(0, wild).replace(/[^/]*$/, '');
  return fixed.split('/').filter(Boolean);
}

/** Two claims overlap when one's path is (or is inside) the other's. */
function claimsOverlap(a, b) {
  const x = segments(a);
  const y = segments(b);
  if (!x.length || !y.length) return true; // "everything" overlaps everything
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

/** The first pair of overlapping claims between two lists, or null. */
function overlapping(mine, theirs) {
  for (const a of mine) for (const b of theirs) if (claimsOverlap(a, b)) return [a, b];
  return null;
}

/* ------------------------------ trust prompt ----------------------------- */

const DOWN = String.fromCharCode(27) + '[B';
const ENTER = String.fromCharCode(13);

/**
 * The keys that answer Claude Code's "trust this folder?" with yes, read off
 * its screen (plain text): a member's new worktree is inside a folder the
 * user trusted. Its choices come in either order ("No, exit" first in some
 * versions), so it looks at where the pointer is. null when it can't tell.
 */
function trustKeys(screen) {
  const text = String(screen || '');
  const at = text.search(/trust (this|the files in this) folder|one you trust|trust this project/i);
  if (at < 0) return null;
  const rest = text.slice(at);
  const pointers = [...rest.matchAll(/[❯›>]\s*(?:\d+\.\s*)?(Yes|No)\b/gi)];
  const last = pointers.at(-1);
  if (!last) return null;
  if (last[1].toLowerCase() === 'yes') return [ENTER];
  // On "No": yes is the next choice down (when there is one).
  return /\n[^\S\n]*(?:\d+\.\s*)?Yes\b/i.test(rest.slice(last.index)) ? [DOWN, ENTER] : null;
}

/* -------------------------------- tools -------------------------------- */

const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
const workerArg = { type: 'string', description: 'The worker: "Worker 1" … "Worker 4" (or 1-4).' };

/** The leader's tools (its katana-team MCP server). */
const TEAM_TOOLS = [
  tool(
    'team_assign',
    'Give a subtask to a worker: a real Claude Code session that starts on it at once, on its own git branch and worktree (or, outside git, on the files it claims). Subtasks must not overlap: a claim that overlaps another worker’s unmerged claim is refused. Returns the worker, its branch and folder.',
    {
      worker: { type: 'string', description: 'Which worker ("Worker 1"-"Worker 4"); default: the first free one.' },
      title: { type: 'string', description: 'The subtask in 3-8 words (shown to the user).' },
      prompt: { type: 'string', description: 'Everything the worker needs, standing on its own: the goal, the files to change, acceptance criteria, how to test it.' },
      files: { type: 'array', items: { type: 'string' }, description: 'The files or folders (globs allowed) it may change, relative to the project. Required outside git.' },
    },
    ['title', 'prompt']
  ),
  tool('team_status', 'Where every worker and verifier stands: state (idle, working, done, failed), subtask, files, branch, attempt, verdict, merged, and its last words.'),
  tool(
    'team_collect',
    'Results not collected yet: workers that finished (their summary and what they changed), verdicts, failures. With wait, blocks up to that many seconds for the next one while anyone is working.',
    { wait: { type: 'number', minimum: 0, maximum: WAIT_MAX_S, description: `Seconds to wait when there's nothing yet (0-${WAIT_MAX_S}).` } }
  ),
  tool(
    'team_verify',
    'Have a verifier check a finished worker’s work before you accept it: it reviews the diff, runs the tests and tries the app in the app viewer, then gives pass or fail with specifics (team_collect brings it).',
    { worker: workerArg, verifier: { type: 'string', description: '"Verifier 1" or "Verifier 2"; default: a free one.' }, focus: { type: 'string', description: 'Anything in particular to check (optional).' } },
    ['worker']
  ),
  tool(
    'team_send_back',
    'Send a worker’s work back for fixes (after a FAIL, or anything you want changed): the feedback is typed into its session, which continues on the same branch.',
    { worker: workerArg, feedback: { type: 'string', description: 'What to fix, with the verifier’s specifics.' } },
    ['worker', 'feedback']
  ),
  tool(
    'team_merge',
    'Accept a worker’s work: only after a verifier passed its latest attempt. Its branch is committed and merged into the task’s branch, its worktree removed, and the worker is free again.',
    { worker: workerArg },
    ['worker']
  ),
];

/** A verifier's one team tool. */
const VERIFIER_TOOLS = [
  tool(
    'team_verdict',
    'Your verdict on the worker’s work, for the Leader. Call it once, when you’ve checked everything.',
    {
      pass: { type: 'boolean', description: 'true: correct and complete, tests pass, it works in the app. false: anything is wrong.' },
      details: { type: 'string', description: 'Specifics: what you checked; for a fail, what is wrong, where (file:line), how to reproduce, what to fix.' },
    },
    ['pass', 'details']
  ),
];

/* ------------------------------- prompts -------------------------------- */

const LEADER_NOTE = `You are the Leader of a team in Katana (the app running you). The user talks only to you. You plan and coordinate; you never write code yourself (your edit, write and shell tools are off).

Your team (the mcp__katana-team tools):
- Workers 1-4: each a full Claude Code session working on its own git branch and worktree (outside git: on the files it claims). Give each a clear subtask with team_assign.
- Verifiers 1-2: check a worker's finished work (review its diff, run the tests, try the app in the app viewer) and give a pass or fail with specifics.

How to work:
1. Read enough of the code (Read, Grep, Glob) to plan. Small, single-file work can still go to one worker.
2. Split the work into clear subtasks that don't touch the same files; use only as many workers as the work needs. Each team_assign prompt stands on its own: goal, files, acceptance criteria, how to test.
3. Hear back with team_collect (wait up to a few minutes), or end your turn telling the user what's under way: a [team] message wakes you when results arrive.
4. team_verify each finished worker. On a FAIL, team_send_back to that worker with the verifier's specifics, then verify again. On a PASS, team_merge it.
5. When everything is merged (or can't be), tell the user plainly what was done, what was verified and anything left. Keep your messages to the user short.
team_status shows everyone at any time.`;

function workerBrief({ key, title, prompt, files, tree, cwd, shared }) {
  const where = shared
    ? `You share the folder ${cwd} with other workers: change only your files.`
    : `You work in ${cwd}, on branch ${tree.branch} (your own worktree, from ${tree.base}). Don't switch branches or merge: the Leader merges your work.`;
  return [
    `[${labelOf(key)} · from your Leader] Your subtask: ${title}`,
    '',
    prompt,
    '',
    `Files you own: ${files.length ? files.join(', ') : 'only what the subtask needs'}. Don't change anything else.`,
    where,
    'When you are done, end with a short summary: what you changed, how you tested it, anything unfinished.',
  ].join('\n');
}

function verifierBrief({ key, worker, focus, shared }) {
  const diff = shared
    ? `Review the files it owns (${worker.files.join(', ')}) for this change.`
    : `Review the diff: git diff ${worker.tree.base}...HEAD for what it committed, and git status / git diff for what it hasn't.`;
  return [
    `[${labelOf(key)} · from your Leader] Check ${labelOf(worker.key)}'s work on "${worker.subtask}" before the Leader accepts it.`,
    `You are in its folder ${worker.cwd}${shared ? '' : ` (branch ${worker.tree.branch}, from ${worker.tree.base})`}. Its files: ${worker.files.length ? worker.files.join(', ') : '(not listed)'}.`,
    `What it was asked:\n${clip(worker.prompt, 3000)}`,
    `Its summary:\n${clip(worker.result, 3000) || '(none)'}`,
    focus ? `The Leader asks you to look especially at: ${focus}` : '',
    'Check it:',
    `1. ${diff} Is it correct, complete, and limited to its files?`,
    '2. Run the project’s tests (and its build or lint, if it has them).',
    '3. If it has a UI, run it in the app viewer (run_app, app_screenshot, app_click, app_type) and try the change; stop_app when done (the other verifier may need the viewer).',
    'Don’t fix anything yourself. Then call team_verdict: pass true or false, with specifics (what is wrong, where as file:line, how to reproduce, what to fix). If you can’t call it, end with VERDICT: PASS or VERDICT: FAIL and your reasons.',
  ]
    .filter(Boolean)
    .join('\n');
}

/* -------------------------------- teams --------------------------------- */

function blankMember(key) {
  return { key, role: key[0] === 'w' ? 'worker' : 'verifier', state: 'idle', needs: false, subtask: '', prompt: '', files: [], tree: null, cwd: '', sessionId: '', attempt: 0, result: '', verdict: null, target: '', merged: false, note: '', since: 0 };
}

/**
 * io: {
 *   start(id, { role, cwd, prompt, raw, model, effort, sessionId, resume }) → { started } | { error }
 *              (raw: the subtask's own words, for a shell standing in for Claude in a test run)
 *   say(id, text) → bool       kill(id)       uuid() → string
 *   isRepo(cwd) → bool         makeTree(cwd, title) → { path, branch, base, top } | { error }
 *   merge(tree, message) → { ok } | { error }     changes(tree) → text
 *   lastAnswer(cwd, sessionId, id) → text        settings() → saved settings
 *   inbox(taskId)  something arrived for the leader
 * }
 * emit(view) after any change; save(all) to persist.
 */
function createTeams({ io, emit = () => {}, save = () => {}, now = () => Date.now() }) {
  const teams = new Map();
  const waiters = new Map(); // taskId -> Set of resolve
  const locks = new Map(); // taskId -> promise chain (git runs one at a time per team)

  const has = (taskId) => teams.has(taskId);

  function ensure(taskId, { cwd = '', title = '', leader = null } = {}) {
    let team = teams.get(taskId);
    if (!team) {
      team = { taskId, cwd, title, git: null, base: '', leader: null, members: Object.fromEntries(KEYS.map((k) => [k, blankMember(k)])), inbox: [], nudged: 0, log: [] };
      teams.set(taskId, team);
    }
    if (cwd) team.cwd = cwd;
    if (title) team.title = title;
    if (leader) team.leader = leader;
    return team;
  }

  function need(taskId) {
    const team = teams.get(taskId);
    if (!team) throw new Error('This task has no team (it isn’t in hierarchy mode).');
    return team;
  }

  function changed(team) {
    emit(view(team.taskId));
    save(dump());
  }

  function log(team, key, text, kind = '') {
    team.log.push({ at: now(), key, text: clip(text, 240), kind });
    if (team.log.length > LOG_MAX) team.log.splice(0, team.log.length - LOG_MAX);
  }

  function deliver(team, item) {
    team.inbox.push({ at: now(), ...item });
    for (const resolve of waiters.get(team.taskId) || []) resolve();
    waiters.delete(team.taskId);
    io.inbox?.(team.taskId);
  }

  /** Runs git work for a team one at a time. */
  function locked(taskId, fn) {
    const before = locks.get(taskId) || Promise.resolve();
    const next = before.then(fn, fn);
    locks.set(taskId, next.catch(() => {}));
    return next;
  }

  const working = (m) => m.state === 'working';
  /** A worker holding work that isn't merged (or dropped). */
  const holding = (m) => m.role === 'worker' && Boolean(m.subtask) && !m.merged;

  /* ------------------------------ actions ------------------------------ */

  async function assign(taskId, { worker, title, prompt, files } = {}) {
    const team = need(taskId);
    const name = clip(title, 80);
    const text = String(prompt || '').trim();
    if (!name || !text) return { error: 'A subtask needs a title and a prompt.' };
    const claims = (Array.isArray(files) ? files : files ? [files] : []).map(String).map((f) => f.trim()).filter(Boolean);
    let key = worker === undefined || worker === null || worker === '' ? null : keyOf(worker, 'worker');
    if (worker && !key) return { error: `There’s no ${worker}: workers are Worker 1 to Worker 4.` };
    if (key) {
      const m = team.members[key];
      if (working(m)) return { error: `${labelOf(key)} is busy with “${m.subtask}”. Wait for it, or pick another worker.` };
      if (holding(m)) return { error: `${labelOf(key)} still holds unmerged work (“${m.subtask}”): verify and merge it, or send it back, first.` };
    } else {
      key = WORKERS.find((k) => !working(team.members[k]) && !holding(team.members[k]));
      if (!key) return { error: 'All four workers are busy or hold unmerged work. Collect, verify and merge first.' };
    }
    return locked(taskId, async () => {
      if (team.git === null) team.git = Boolean(await io.isRepo(team.cwd));
      if (!team.git && !claims.length) return { error: 'This folder isn’t a git repository, so workers share it: list the files each one may change (files).' };
      for (const other of WORKERS) {
        if (other === key || !holding(team.members[other])) continue;
        const hit = overlapping(claims, team.members[other].files);
        if (hit) return { error: `“${hit[0]}” overlaps ${labelOf(other)}’s “${hit[1]}”. Give each worker separate files.` };
      }
      let tree = null;
      if (team.git) {
        tree = await io.makeTree(team.cwd, name);
        if (!tree || tree.error) return { error: `Couldn’t make ${labelOf(key)}’s worktree: ${tree?.error || 'unknown error'}` };
        team.base = tree.base;
      }
      const m = team.members[key];
      Object.assign(m, blankMember(key), { subtask: name, prompt: text, files: claims, tree, cwd: tree ? tree.path : team.cwd, sessionId: io.uuid(), attempt: 1, state: 'working', since: now() });
      const settings = io.settings() || {};
      const reply = await io.start(memberId(taskId, key), {
        role: 'worker',
        cwd: m.cwd,
        sessionId: m.sessionId,
        model: settings.workerModel || 'claude-sonnet-5-5',
        effort: settings.workerEffort || 'medium',
        prompt: workerBrief({ key, title: name, prompt: text, files: claims, tree, cwd: m.cwd, shared: !team.git }),
        raw: text,
      });
      if (!reply || reply.error) {
        m.state = 'failed';
        m.note = reply?.error || 'It didn’t start.';
        log(team, key, `couldn’t start: ${m.note}`, 'fail');
        changed(team);
        return { error: `${labelOf(key)} didn’t start: ${m.note}` };
      }
      log(team, key, `started · ${name}`, 'start');
      changed(team);
      return { worker: labelOf(key), subtask: name, folder: m.cwd, ...(tree ? { branch: tree.branch, base: tree.base } : { shared: true, files: claims }) };
    });
  }

  async function verify(taskId, { worker, verifier, focus = '' } = {}) {
    const team = need(taskId);
    const wkey = keyOf(worker, 'worker');
    if (!wkey) return { error: `There’s no ${worker}: workers are Worker 1 to Worker 4.` };
    const w = team.members[wkey];
    if (!w.subtask || w.merged) return { error: `${labelOf(wkey)} has no work to check.` };
    if (working(w)) return { error: `${labelOf(wkey)} is still working. Collect its result first.` };
    let vkey = verifier ? keyOf(verifier, 'verifier') : null;
    if (verifier && !vkey) return { error: `There’s no ${verifier}: verifiers are Verifier 1 and Verifier 2.` };
    if (vkey && working(team.members[vkey])) return { error: `${labelOf(vkey)} is busy checking ${labelOf(team.members[vkey].target)}.` };
    if (!vkey) vkey = VERIFIERS.find((k) => !working(team.members[k]));
    if (!vkey) return { error: 'Both verifiers are busy. Collect their verdicts first.' };
    if (VERIFIERS.some((k) => working(team.members[k]) && team.members[k].target === wkey)) return { error: `${labelOf(wkey)} is already being checked.` };
    const v = team.members[vkey];
    io.kill(memberId(taskId, vkey)); // a fresh session for each check (its folder changes)
    Object.assign(v, blankMember(vkey), { subtask: `Check ${labelOf(wkey)}: ${w.subtask}`, target: wkey, cwd: w.cwd, sessionId: io.uuid(), attempt: w.attempt, state: 'working', since: now() });
    const settings = io.settings() || {};
    const reply = await io.start(memberId(taskId, vkey), {
      role: 'verifier',
      cwd: v.cwd,
      sessionId: v.sessionId,
      model: settings.verifierModel || 'claude-sonnet-5-5',
      effort: settings.verifierEffort || 'medium',
      prompt: verifierBrief({ key: vkey, worker: w, focus: String(focus || ''), shared: !team.git }),
      raw: String(focus || ''),
    });
    if (!reply || reply.error) {
      v.state = 'failed';
      v.note = reply?.error || 'It didn’t start.';
      log(team, vkey, `couldn’t start: ${v.note}`, 'fail');
      changed(team);
      return { error: `${labelOf(vkey)} didn’t start: ${v.note}` };
    }
    w.verdict = null;
    log(team, vkey, `checking ${labelOf(wkey)} · ${w.subtask}`, 'start');
    changed(team);
    return { verifier: labelOf(vkey), checking: labelOf(wkey), attempt: w.attempt };
  }

  /** A verifier's verdict (its team_verdict call, or read from its last words). */
  function verdict(id, { pass, details = '' } = {}) {
    const who = parseMember(id);
    const team = who && teams.get(who.taskId);
    const v = team?.members[who.key];
    if (!v || v.role !== 'verifier') return { error: 'Only a verifier gives verdicts.' };
    if (!v.target) return { error: 'You aren’t checking anyone right now.' };
    if (v.verdict) return { error: 'You already gave your verdict.' };
    const w = team.members[v.target];
    const ok = pass === true || pass === 'true';
    v.verdict = { pass: ok, details: clip(details, RESULT_MAX) };
    v.state = 'done';
    v.needs = false;
    if (w.attempt === v.attempt && !w.merged) {
      w.verdict = { pass: ok, details: v.verdict.details, attempt: w.attempt, by: who.key };
      w.state = ok ? 'done' : 'failed';
    }
    log(team, who.key, `${ok ? 'PASS' : 'FAIL'} · ${labelOf(v.target)}${ok ? '' : ` · ${clip(details, 120)}`}`, ok ? 'pass' : 'fail');
    deliver(team, { kind: 'verdict', member: labelOf(who.key), worker: labelOf(v.target), pass: ok, details: v.verdict.details, attempt: v.attempt });
    changed(team);
    return { recorded: true, pass: ok };
  }

  async function sendBack(taskId, { worker, feedback } = {}) {
    const team = need(taskId);
    const key = keyOf(worker, 'worker');
    if (!key) return { error: `There’s no ${worker}: workers are Worker 1 to Worker 4.` };
    const m = team.members[key];
    const text = String(feedback || '').trim();
    if (!text) return { error: 'Say what to fix (feedback).' };
    if (!m.subtask || m.merged) return { error: `${labelOf(key)} has no work to send back.` };
    if (working(m)) return { error: `${labelOf(key)} is still working.` };
    const message = `[${labelOf(key)} · from your Leader] Fixes needed on “${m.subtask}”:\n\n${text}\n\nFix them, re-test, and end with a short summary of what you changed.`;
    let ok = io.say(memberId(taskId, key), message, text);
    if (!ok) {
      // Its session ended (a restart): it resumes its conversation with the feedback.
      const settings = io.settings() || {};
      const reply = await io.start(memberId(taskId, key), { role: 'worker', cwd: m.cwd, sessionId: m.sessionId, resume: true, model: settings.workerModel || 'claude-sonnet-5-5', effort: settings.workerEffort || 'medium', prompt: message });
      ok = Boolean(reply && !reply.error);
      if (!ok) return { error: `${labelOf(key)} couldn’t be reached: ${reply?.error || 'its session didn’t start'}` };
    }
    m.attempt += 1;
    m.verdict = null;
    m.result = '';
    m.note = '';
    m.state = 'working';
    m.since = now();
    log(team, key, `sent back · ${clip(text, 120)}`, 'back');
    changed(team);
    return { worker: labelOf(key), attempt: m.attempt };
  }

  async function merge(taskId, { worker } = {}) {
    const team = need(taskId);
    const key = keyOf(worker, 'worker');
    if (!key) return { error: `There’s no ${worker}: workers are Worker 1 to Worker 4.` };
    const m = team.members[key];
    if (!m.subtask) return { error: `${labelOf(key)} has nothing to merge.` };
    if (m.merged) return { error: `${labelOf(key)}’s work is already merged.` };
    if (working(m)) return { error: `${labelOf(key)} is still working.` };
    if (!m.verdict || m.verdict.attempt !== m.attempt) return { error: `${labelOf(key)}’s latest work hasn’t been verified. team_verify it first.` };
    if (!m.verdict.pass) return { error: `${labelOf(key)}’s latest work failed verification. team_send_back the fixes, then verify again.` };
    return locked(taskId, async () => {
      // Its folder goes: every session working in it ends first.
      io.kill(memberId(taskId, key));
      for (const v of VERIFIERS) if (team.members[v].cwd === m.cwd && team.git) io.kill(memberId(taskId, v));
      if (m.tree) {
        const reply = await io.merge(m.tree, `${labelOf(key)}: ${m.subtask}`);
        if (!reply || reply.error) {
          log(team, key, `merge failed · ${clip(reply?.error, 120)}`, 'fail');
          changed(team);
          return { error: `${reply?.error || 'The merge failed.'} Send it back to ${labelOf(key)} to rebase on ${m.tree.base}, or resolve it with the user.` };
        }
      }
      m.merged = true;
      m.state = 'done';
      m.needs = false;
      log(team, key, `merged${m.tree ? ` ${m.tree.branch} → ${m.tree.base}` : ''}`, 'merge');
      changed(team);
      return { merged: labelOf(key), ...(m.tree ? { branch: m.tree.branch, into: m.tree.base } : {}) };
    });
  }

  function memberStatus(m) {
    return {
      member: labelOf(m.key),
      state: m.state,
      ...(m.needs ? { needs: 'waiting for the user in its terminal' } : {}),
      ...(m.subtask ? { subtask: m.subtask } : {}),
      ...(m.role === 'worker' && m.files.length ? { files: m.files } : {}),
      ...(m.tree ? { branch: m.tree.branch } : {}),
      ...(m.role === 'worker' && m.subtask ? { attempt: m.attempt, verdict: m.verdict ? (m.verdict.attempt === m.attempt ? (m.verdict.pass ? 'pass' : 'fail') : 'stale') : 'unverified', merged: m.merged } : {}),
      ...(m.role === 'verifier' && m.target ? { checking: labelOf(m.target) } : {}),
      ...(m.note ? { note: m.note } : {}),
      ...(m.result ? { last: clip(m.result, 300) } : {}),
    };
  }

  function status(taskId) {
    const team = need(taskId);
    return {
      folder: team.cwd,
      mode: team.git === null ? 'unknown until the first assignment' : team.git ? `git worktrees, merged into ${team.base || 'the task’s branch'}` : 'shared folder (file claims)',
      waiting: team.inbox.length,
      members: KEYS.map((k) => memberStatus(team.members[k])),
    };
  }

  /** What arrived since the leader last looked (it's taken); waits up to `wait` s while anyone works. */
  async function collect(taskId, { wait = 0 } = {}) {
    const team = need(taskId);
    const seconds = Math.max(0, Math.min(WAIT_MAX_S, Number(wait) || 0));
    if (!team.inbox.length && seconds && KEYS.some((k) => working(team.members[k]))) {
      await new Promise((resolve) => {
        const set = waiters.get(taskId) || new Set();
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, seconds * 1000);
        set.add(done);
        waiters.set(taskId, set);
      });
    }
    const items = team.inbox.splice(0);
    team.nudged = 0;
    const out = [];
    for (const item of items) {
      const entry = { ...item, at: new Date(item.at).toLocaleTimeString() };
      if (item.kind === 'finished') {
        const m = team.members[keyOf(item.member)];
        if (m?.tree) entry.changes = clip(await Promise.resolve(io.changes(m.tree)).catch(() => ''), 1500) || '(no changes)';
      }
      out.push(entry);
    }
    if (items.length) changed(team);
    const busy = KEYS.filter((k) => working(team.members[k])).map(labelOf);
    return { results: out, ...(busy.length ? { stillWorking: busy } : {}), ...(!out.length && !busy.length ? { note: 'Nothing new, and nobody is working.' } : {}) };
  }

  /**
   * Where a member's session stands (taskstate's update): working, asking
   * you, its turn finished, stopped, or ended. Finished updates come after
   * its transcript settles (the daemon waits), so its last words are there.
   */
  function sessionEvent(id, update = {}) {
    const who = parseMember(id);
    const team = who && teams.get(who.taskId);
    if (!team) return;
    const m = team.members[who.key];
    const label = labelOf(who.key);
    if (update.state === 'needs') {
      if (!m.needs) {
        m.needs = true;
        log(team, who.key, 'needs you in its terminal', 'needs');
        changed(team);
      }
      return;
    }
    if (update.state === 'working') {
      // A verifier finishing its turn after its verdict: still done.
      if (m.role === 'verifier' && m.verdict) return;
      if (m.state !== 'working' || m.needs) {
        // Typed into by the user (or the leader): it's on it again.
        m.state = 'working';
        m.needs = false;
        if (!m.since) m.since = now();
        changed(team);
      }
      return;
    }
    if (update.state !== 'idle' || m.state !== 'working') {
      if (m.needs) {
        m.needs = false;
        changed(team);
      }
      return;
    }
    // Idle without finishing or being stopped: only a note (its session opened, or closed while idle).
    if (!update.finished && !update.stopped) return;
    m.needs = false;
    if (!update.finished) {
      // Stopped (Esc), or its session ended mid-turn.
      m.state = 'failed';
      m.note = update.stopped && update.running !== false ? 'Stopped before it finished.' : 'Its session ended before it finished.';
      log(team, who.key, m.note.toLowerCase().replace(/\.$/, ''), 'fail');
      deliver(team, { kind: 'failed', member: label, subtask: m.subtask, note: m.note });
      changed(team);
      return;
    }
    const words = clip(io.lastAnswer(m.cwd, m.sessionId, id), RESULT_MAX);
    if (m.role === 'worker') {
      m.result = words;
      m.state = 'done';
      log(team, who.key, `finished · ${m.subtask}`, 'done');
      deliver(team, { kind: 'finished', member: label, subtask: m.subtask, attempt: m.attempt, summary: words || '(it said nothing)', ...(m.tree ? { branch: m.tree.branch } : { files: m.files }) });
      changed(team);
      return;
    }
    // A verifier that ended without calling team_verdict: its last words decide.
    if (m.verdict) return;
    const said = VERDICT.exec(words);
    if (said) {
      verdict(id, { pass: said[1].toUpperCase() === 'PASS', details: words });
      return;
    }
    m.state = 'failed';
    m.note = 'It finished without a verdict.';
    log(team, who.key, 'no verdict', 'fail');
    deliver(team, { kind: 'failed', member: label, checking: labelOf(m.target), note: `${m.note} Its last words: ${clip(words, 600) || '(none)'}` });
    changed(team);
  }

  /* --------------------------- leader & task ---------------------------- */

  /** Nothing working and nothing waiting for the leader: a finished leader turn is the task finishing. */
  function settled(taskId) {
    const team = teams.get(taskId);
    if (!team) return true;
    return !team.inbox.length && !KEYS.some((k) => working(team.members[k]));
  }

  /** Anyone on the team working (the task shows as working while its leader waits). */
  const busy = (taskId) => {
    const team = teams.get(taskId);
    return Boolean(team && KEYS.some((k) => working(team.members[k])));
  };

  /** Results the leader hasn't been told about: wake it. */
  const wantsNudge = (taskId) => {
    const team = teams.get(taskId);
    return Boolean(team && team.inbox.length > team.nudged);
  };

  function nudgeText(taskId) {
    const team = need(taskId);
    const fresh = team.inbox.slice(team.nudged);
    team.nudged = team.inbox.length;
    const parts = fresh.map((item) =>
      item.kind === 'verdict' ? `${item.member}: ${item.pass ? 'PASS' : 'FAIL'} for ${item.worker}` : item.kind === 'finished' ? `${item.member} finished "${item.subtask}"` : `${item.member} failed (${item.note})`
    );
    return `[team] ${parts.join('; ')}. Call team_collect for the details, then carry on.`;
  }

  /** Every member's session ends (switching to Single agent, or the task going away). Unmerged branches stay. */
  function stopAll(taskId, { forget = false } = {}) {
    const team = teams.get(taskId);
    if (!team) return { unmerged: [] };
    for (const k of KEYS) {
      io.kill(memberId(taskId, k));
      const m = team.members[k];
      if (working(m)) {
        m.state = 'failed';
        m.note = 'Stopped (the task left hierarchy mode).';
      }
      m.needs = false;
    }
    const unmerged = WORKERS.map((k) => team.members[k]).filter((m) => holding(m) && m.tree).map((m) => m.tree.branch);
    // Nobody leads it now: its news goes too.
    team.inbox = [];
    team.nudged = 0;
    if (forget) {
      teams.delete(taskId);
      save(dump());
    } else changed(team);
    return { unmerged };
  }

  /* ------------------------------- views -------------------------------- */

  function view(taskId) {
    const team = teams.get(taskId);
    if (!team) return { taskId, gone: true };
    return {
      taskId,
      git: team.git,
      base: team.base,
      waiting: team.inbox.length,
      members: KEYS.map((k) => {
        const m = team.members[k];
        return { key: k, id: memberId(taskId, k), label: labelOf(k), role: m.role, state: m.state, needs: m.needs, subtask: m.subtask, branch: m.tree?.branch || '', attempt: m.attempt, verdict: m.verdict ? (m.verdict.pass ? 'pass' : 'fail') : '', merged: m.merged, note: m.note, since: m.since, target: m.target };
      }),
      log: team.log.slice(-LOG_MAX),
    };
  }

  /** Compact for Katana: one entry per member that has something going on. */
  function summary(taskId) {
    const team = teams.get(taskId);
    if (!team) return [];
    return KEYS.map((k) => team.members[k])
      .filter((m) => m.subtask)
      .map((m) => `${labelOf(m.key)} ${m.needs ? 'needs the user' : m.state}${m.merged ? ' (merged)' : ''}: ${clip(m.subtask, 60)}`);
  }

  const dump = () => ({ version: 1, teams: [...teams.values()].map((t) => ({ ...t, inbox: t.inbox, nudged: 0 })) });

  /** Teams saved before the daemon restarted: their sessions are gone, so nobody is working. */
  function load(data) {
    for (const saved of data?.teams || []) {
      if (!saved?.taskId) continue;
      const team = ensure(saved.taskId, { cwd: saved.cwd, title: saved.title, leader: saved.leader });
      Object.assign(team, { git: saved.git ?? null, base: saved.base || '', inbox: Array.isArray(saved.inbox) ? saved.inbox : [], log: Array.isArray(saved.log) ? saved.log : [] });
      for (const k of KEYS) {
        const m = Object.assign(blankMember(k), saved.members?.[k] || {}, { key: k });
        if (m.state === 'working') {
          m.state = 'failed';
          m.note = 'Interrupted: the background process restarted.';
        }
        m.needs = false;
        team.members[k] = m;
      }
    }
  }

  /* -------------------------------- tools -------------------------------- */

  /** Which team tools a session gets: the leader's, a verifier's, or none. */
  function toolsFor(id) {
    if (teams.has(id)) return TEAM_TOOLS;
    const who = parseMember(id);
    return who && who.key[0] === 'v' && teams.has(who.taskId) ? VERIFIER_TOOLS : [];
  }

  /** A team tool called by session `id`. */
  async function call(id, name, args = {}) {
    if (!toolsFor(id).some((t) => t.name === name)) return { error: `There’s no tool called ${name}.` };
    try {
      let result;
      if (name === 'team_assign') result = await assign(id, args);
      else if (name === 'team_status') result = status(id);
      else if (name === 'team_collect') result = await collect(id, args);
      else if (name === 'team_verify') result = await verify(id, args);
      else if (name === 'team_send_back') result = await sendBack(id, args);
      else if (name === 'team_merge') result = await merge(id, args);
      else if (name === 'team_verdict') result = verdict(id, args);
      return result?.error ? { error: result.error } : { result };
    } catch (error) {
      return { error: error.message };
    }
  }

  return {
    has,
    ensure,
    get: (taskId) => teams.get(taskId) || null,
    assign,
    verify,
    verdict,
    sendBack,
    merge,
    status,
    collect,
    sessionEvent,
    settled,
    busy,
    wantsNudge,
    nudgeText,
    stopAll,
    view,
    views: () => [...teams.keys()].map(view),
    summary,
    load,
    dump,
    toolsFor,
    call,
  };
}

module.exports = { createTeams, trustKeys, parseMember, memberId, keyOf, labelOf, claimsOverlap, overlapping, TEAM_TOOLS, VERIFIER_TOOLS, LEADER_NOTE, workerBrief, verifierBrief, WORKERS, VERIFIERS, KEYS };
