'use strict';

/**
 * What the daemon does: runs every task's terminal session (main/tasks.js),
 * keeps Claude Code's hooks installed, decides where each task stands
 * (taskstate.js), and runs Katana (agent.js) with her tools (toolport.js):
 * carried out by a window when one is open (`toWindow`), else here
 * (headless.js). It wakes her when a task finishes and, with no window
 * open, notifies you itself (notify.js). katanad.js serves it over a local
 * pipe; in test runs the app uses it in-process instead.
 *
 * A task in hierarchy mode is run by a team (team.js): its own session is
 * the Leader, with the team tools; workers and verifiers are more sessions
 * here (`<task>--w1` ...), started when the leader gives them work. Their
 * states feed the team, never Katana; team:state tells windows about it.
 *
 * `emit(channel, payload)` sends task:data, task:transcript, task:state and
 * task:exit, Katana's agent:* events and run:event (see agent.js).
 * `toWindow(channel, payload)` sends to one window, false when none is open.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTasks } = require('../main/tasks');
const { createTaskStates } = require('./taskstate');
const { resolveClaude, existsInPath } = require('../main/claude');
const { shellsFrom, pickShell } = require('../main/shells');
const { runGuard } = require('../main/runargs');
const { readStateFile, writeIfChanged } = require('../main/statefile');
const { createAgent, lastAnswer } = require('./agent');
const { createToolPort } = require('./toolport');
const { createHeadless } = require('./headless');
const { createNotifier } = require('./notify');
const { createTeams, parseMember, labelOf, trustKeys, LEADER_NOTE } = require('./team');
const worktree = require('../main/worktree');
const { plain } = require('../main/tasks');

const QUIET_EVERY_MS = 1000;
const ANSWER = /^(\r|\n|[1-9]|y|n)$/i;
const WINDOW_CALL_MS = 5 * 60_000; // long enough for a dialog the user answers
const SETTLE_MS = 1200; // a transcript's last lines land a moment after Stop
const GROUP_MS = 4000; // done alerts this close together are one
// Proving hierarchy mode without Claude: members run as shells (a test run only).
const TEAM_SHELL = process.env.XODE2_TEAM_SHELL === '1' && Boolean(process.env.XODE2_TEST);

function createCore({ userDataDir, emit, toWindow = () => false, block = false, log = () => {}, runner, notifier }) {
  const hooksDir = path.join(userDataDir, 'hooks');
  const hookScript = path.join(userDataDir, 'hook.cjs');
  const hookSettings = path.join(hooksDir, 'settings.json');
  const readState = () => readStateFile(path.join(userDataDir, 'state.json'));
  let shellList = null;
  const shells = () => (shellList = shellList || shellsFrom(existsInPath));

  // Tests hand in their own, so nothing pops up on the screen.
  const notify = notifier || createNotifier({ log });
  let windows = 0; // windows connected (katanad counts them)
  const windowOpen = () => windows > 0;
  const shown = new Map(); // task id -> the state last seen

  const states = createTaskStates({
    emit(update) {
      // A worker's or verifier's session: it tells the team, never Katana.
      const member = parseMember(update.id);
      if (member && teams.has(member.taskId)) return memberState(update, member);
      // A leader's turn that ends while its team works (or has news for it) isn't the task finishing.
      if (update.finished && teams.has(update.id) && !teams.settled(update.id) && taskById(update.id)?.mode === 'hierarchy') {
        update = { ...update, finished: false };
        setTimeout(() => wakeLeader(update.id), SETTLE_MS);
      }
      emit('task:state', update);
      const was = shown.get(update.id);
      shown.set(update.id, update.state);
      if (update.finished) setTimeout(() => finished(update.id), SETTLE_MS);
      // Waiting for you: an alert with sound.
      if (update.state === 'needs' && was !== 'needs') {
        const task = taskById(update.id);
        alert({ level: 'needs', title: task?.title || 'A task', body: update.message || (update.need === 'asking' ? 'It has a question for you.' : 'It needs your permission.'), taskId: update.id });
      }
    },
  });

  /* ------------------------------- alerts ------------------------------- */

  /**
   * Every alert is decided here, at one of four levels:
   *   needs     a task waits for you      sound
   *   reminder  one of hers came due      sound
   *   done      a task finished           quiet; ones close together are one
   *   fyi       anything else             no alert (her reply says it)
   * A window plays it (it knows whether you're looking: alert); with none
   * open, it's a Windows notification from here.
   */
  let doneBatch = [];
  let doneTimer = 0;

  function alert(note) {
    if (!note || note.level === 'fyi') return;
    if (note.level === 'done') {
      doneBatch.push(note);
      clearTimeout(doneTimer);
      doneTimer = setTimeout(flushDone, GROUP_MS);
      return;
    }
    deliver(note);
  }

  function flushDone() {
    const batch = doneBatch;
    doneBatch = [];
    if (!batch.length) return;
    if (batch.length === 1) return deliver(batch[0]);
    return deliver({ level: 'done', title: `${batch.length} tasks finished`, body: batch.map((n) => n.title.replace(/ finished$/, '')).join(', '), taskIds: batch.map((n) => n.taskId).filter(Boolean) });
  }

  function deliver(note) {
    if (windowOpen()) return emit('alert', note);
    if (readState()?.settings?.notifications === false) return undefined;
    return notify({ title: note.title, body: note.body, sound: note.level !== 'done' });
  }

  const taskById = (id) => (readState()?.tasks || []).find((t) => t.id === id) || null;

  /** A task finished: Katana hears of it, and what she says is its alert; else a plain quiet one. */
  function finished(id) {
    const task = taskById(id);
    if (!task) return;
    const settings = readState()?.settings || {};
    if (task.kind === 'claude' && settings.wakeAgent !== false && !block) {
      const answer = lastAnswer(task);
      // A hierarchy task: one summary for the whole team (its leader's last words, and who did what).
      const team = task.mode === 'hierarchy' ? teams.summary(id) : [];
      const crew = team.length ? ` It ran as a team: ${team.join('; ')}.` : '';
      agent.tell('finished', `Task ${id} "${task.title}" finished.${crew}${answer ? ` Its last reply: ${answer.slice(0, 1500)}` : ''}`, `${task.title} finished`, id);
    } else {
      alert({ level: 'done', title: task.title, body: 'Finished.', taskId: id });
    }
  }

  /* ------------------------------ her tools ----------------------------- */

  const pending = new Map(); // a window's tool call: callId -> { resolve, timer }

  function callWindow(name, args) {
    return new Promise((resolve) => {
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pending.delete(callId);
        resolve({ error: 'The app didn’t answer in time.' });
      }, WINDOW_CALL_MS);
      pending.set(callId, { resolve, timer });
      if (!toWindow('tools:call', { callId, name, args })) {
        clearTimeout(timer);
        pending.delete(callId);
        resolve(headless.call(name, args));
      }
    });
  }

  /** A member's viewer call: on its task's app viewer, run from the member's own folder. */
  function onTask(args) {
    const member = parseMember(args?.task);
    const team = member && teams.get(member.taskId);
    if (!team) return args;
    return { ...args, task: member.taskId, cwd: team.members[member.key].cwd || team.cwd, member: labelOf(member.key) };
  }

  const port = createToolPort({
    route: (name, args) => (windowOpen() ? callWindow(name, onTask(args)) : headless.call(name, onTask(args))),
    team: { tools: (id) => teams.toolsFor(id), call: (id, name, args) => teams.call(id, name, args) },
  });
  const mcpScript = path.join(userDataDir, 'mcp-app.cjs');
  const mcpConfig = path.join(userDataDir, 'katana-mcp.json');

  /** The MCP server her turns start, and the config naming it; its path. */
  async function toolsConfig() {
    const { url, token } = await port.start();
    writeIfChanged(mcpScript, fs.readFileSync(path.join(__dirname, '..', 'main', 'mcp-app.cjs'), 'utf8'));
    // Node when it's installed; otherwise this app's own runtime, as Node.
    const node = existsInPath('node');
    const env = { KATANA_TOOLS_URL: url, KATANA_TOOLS_TOKEN: token, ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }) };
    writeIfChanged(mcpConfig, JSON.stringify({ mcpServers: { katana: { type: 'stdio', command: node || process.execPath, args: [mcpScript], env } } }, null, 2));
    return mcpConfig;
  }

  /**
   * A session's own MCP servers, good only for that session; the config
   * naming them: the app viewer's tools (run its app, see it, click and type
   * in it) and, in hierarchy mode, its team tools (a leader's, a verifier's).
   */
  async function sessionConfig(id, { viewer = true, team = false } = {}) {
    const { url } = await port.start();
    writeIfChanged(mcpScript, fs.readFileSync(path.join(__dirname, '..', 'main', 'mcp-app.cjs'), 'utf8'));
    const node = existsInPath('node');
    const server = (env) => ({ type: 'stdio', command: node || process.execPath, args: [mcpScript], env: { KATANA_TOOLS_URL: url, ...env, ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }) } });
    const servers = {};
    if (viewer) servers['katana-viewer'] = server({ KATANA_VIEW_TOKEN: port.viewToken(id) });
    if (team) servers['katana-team'] = server({ KATANA_TEAM_TOKEN: port.teamToken(id) });
    const dir = path.join(userDataDir, 'viewer');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id.replace(/[^\w-]/g, '')}.json`);
    writeIfChanged(file, JSON.stringify({ mcpServers: servers }, null, 2));
    return file;
  }

  /** The hook script and the settings that name it, kept current in userData. */
  function installHooks() {
    fs.mkdirSync(hooksDir, { recursive: true });
    writeIfChanged(hookScript, fs.readFileSync(path.join(__dirname, '..', 'main', 'hook.cjs'), 'utf8'));
    const script = hookScript.replace(/\\/g, '/');
    // Node when it's installed; otherwise this app's own runtime, as Node.
    const command = existsInPath('node') ? `node "${script}"` : `ELECTRON_RUN_AS_NODE=1 "${process.execPath.replace(/\\/g, '/')}" "${script}"`;
    const run = [{ type: 'command', command, timeout: 10 }];
    const hooks = {};
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop']) hooks[name] = [{ hooks: run }];
    hooks.PreToolUse = [{ matcher: '*', hooks: run }];
    hooks.PostToolUse = [{ matcher: '*', hooks: run }];
    writeIfChanged(hookSettings, JSON.stringify({ hooks }, null, 2));
  }

  // What the sessions say: the window gets the screen and transcript; the
  // hooks and on-screen questions only decide the state.
  const tasks = createTasks({
    hooksDir,
    settingsFile: hookSettings,
    found: () => ({
      claude: resolveClaude(),
      codex: existsInPath('codex'),
      shell: pickShell(String(readState()?.settings?.shell || ''), shells()),
    }),
    send(channel, payload) {
      if (channel === 'task:hook') return states.hook(payload.id, payload);
      if (channel === 'task:ask') {
        // A team member's new worktree inside a folder the user trusted: Claude Code's "trust this folder?" is answered yes.
        if (parseMember(payload.id) && /trust/i.test(payload.text)) return answerTrust(payload);
        return states.ask(payload.id, payload.text, payload.need);
      }
      if (channel === 'task:transcript') states.transcript(payload.id, payload.lines);
      if (channel === 'task:exit') {
        emit(channel, payload);
        return states.exited(payload.id);
      }
      return emit(channel, payload);
    },
  });

  const quietTimer = setInterval(() => {
    for (const id of tasks.running()) states.quiet(id, tasks.quietFor(id));
  }, QUIET_EVERY_MS);
  quietTimer.unref?.();

  const kindOf = (id) => states.get(id).kind;

  /* ------------------------------- teams -------------------------------- */

  const teamsFile = path.join(userDataDir, 'teams.json');
  const teams = createTeams({
    emit: (view) => emit('team:state', view),
    save: (all) => writeIfChanged(teamsFile, JSON.stringify(all, null, 2)),
    io: {
      start: startMember,
      // (A shell standing in for Claude in a test run gets just the feedback, as a command.)
      say: (id, text, raw) => handlers.say(id, TEAM_SHELL && raw ? raw : text),
      kill: (id) => tasks.kill(id),
      uuid: () => crypto.randomUUID(),
      isRepo: (cwd) => worktree.isRepo(cwd),
      makeTree: (cwd, title) => worktree.create(cwd, title),
      merge: (tree, message) => worktree.merge(tree, message),
      changes: async (tree) => (await worktree.changes(tree)).text,
      // A shell (proving it without Claude) has no transcript: its screen is its answer.
      lastAnswer: (cwd, sessionId, id) => (TEAM_SHELL ? plain(tasks.tail(id)).trim().slice(-1500) : lastAnswer({ kind: 'claude', started: true, cwd, sessionId })),
      settings: () => readState()?.settings || {},
      inbox: (taskId) => wakeLeader(taskId),
    },
  });
  try {
    teams.load(JSON.parse(fs.readFileSync(teamsFile, 'utf8')));
  } catch {
    /* no teams yet */
  }

  /** A worker's or verifier's session, started for its team (in a trusted folder only). */
  async function startMember(id, { role, cwd, prompt, model, effort, sessionId, resume = false, raw = '' }) {
    if (block && !TEAM_SHELL) return { error: 'Claude is disabled for this test run' };
    const trusted = (readState()?.projects || []).map((project) => project.path);
    const refused = runGuard({ role: 'task', cwd }, trusted);
    if (refused) return { error: refused };
    installHooks();
    const kind = TEAM_SHELL ? 'shell' : 'claude';
    // (Shells get the config too, so a test run can call a verifier's tools as it would.)
    const mcpConfig = await sessionConfig(id, { viewer: true, team: role === 'verifier' }).catch(() => '');
    const bypass = readState()?.settings?.bypassPermissions !== false;
    const reply = tasks.start({ id, kind, cwd, sessionId, resume, model, effort, bypass, role, mcpConfig, prompt: kind === 'shell' ? '' : prompt, cols: 80, rows: 24 });
    if (!reply?.started) return reply;
    states.started(id, { kind, prompt: kind === 'shell' ? '' : prompt });
    // A shell runs the subtask's own words as its command.
    if (kind === 'shell' && raw) setTimeout(() => handlers.say(id, raw), 600);
    return reply;
  }

  /** Yes to "trust this folder?" for a member, read off its screen once drawn (a few looks); asks you when it can't tell. */
  function answerTrust({ id, text, need }, tries = 4) {
    setTimeout(() => {
      const keys = trustKeys(plain(tasks.tail(id)).slice(-4000));
      if (!keys) return tries > 1 ? answerTrust({ id, text, need }, tries - 1) : states.ask(id, text, need);
      keys.forEach((key, i) => setTimeout(() => tasks.write(id, key), i * 300));
      return undefined;
    }, 400);
  }

  /** A member's session changed: the team hears (a finished turn once its transcript settles); windows see it too. */
  function memberState(update, member) {
    emit('task:state', update);
    const was = shown.get(update.id);
    shown.set(update.id, update.state);
    if (update.finished) setTimeout(() => teams.sessionEvent(update.id, update), SETTLE_MS);
    else teams.sessionEvent(update.id, update);
    if (update.state === 'needs' && was !== 'needs') {
      const task = taskById(member.taskId);
      alert({ level: 'needs', title: `${task?.title || 'A task'} · ${labelOf(member.key)}`, body: update.message || 'It needs your permission.', taskId: member.taskId });
    }
  }

  /**
   * News for a leader (a worker finished, a verdict): an idle leader is
   * told in its terminal, which starts its next turn (one not running is
   * resumed with it). A working one collects it itself, or is told when
   * its turn ends.
   */
  function wakeLeader(taskId) {
    if (!teams.wantsNudge(taskId)) return;
    const task = taskById(taskId);
    if (!task || task.doneAt || task.mode !== 'hierarchy') return;
    const running = tasks.running().includes(taskId);
    if (running && states.get(taskId).state !== 'idle') return;
    const text = teams.nudgeText(taskId);
    if (running) {
      handlers.say(taskId, text);
      return;
    }
    const leader = teams.get(taskId)?.leader || {};
    handlers.start({ ...leader, id: taskId, kind: 'claude', mode: 'hierarchy', resume: true, prompt: text, cols: 80, rows: 24 });
  }

  let onScreen = null; // what the window shows (it says so): "this" means that
  const agent = createAgent({ userDataDir, readState, snapshot: () => snapshot(), emit, toolsConfig, alert, windowOpen, screen: () => (windowOpen() ? onScreen : null), team: (id) => teams.summary(id), block, ...(runner ? { runner } : {}) });

  function snapshot() {
    const running = new Set(tasks.running());
    return states.snapshot().map((t) => ({ ...t, running: running.has(t.id) }));
  }

  // The handlers headless.js uses: the same as a window's calls.
  const handlers = {};
  const headless = createHeadless({ userDataDir, core: handlers, agent, notify });

  Object.assign(handlers, {
    /** Start (or resume) a task's session; only in a folder the user trusted. */
    async start(options = {}) {
      const id = String(options.id || '');
      if (!id) return { error: 'missing id' };
      const trusted = (readState()?.projects || []).map((project) => project.path);
      const refused = runGuard({ role: 'task', cwd: options.cwd }, trusted);
      if (refused) return { error: refused };
      installHooks();
      const kind = ['claude', 'codex', 'shell'].includes(options.kind) ? options.kind : 'claude';
      // Hierarchy mode: this session is the team's Leader (team tools, no code-writing tools).
      const leader = kind === 'claude' && options.mode === 'hierarchy';
      // A test run proving the team without Claude: the leader is a shell too (its team tools still served).
      const runKind = leader && TEAM_SHELL ? 'shell' : kind;
      if (leader) teams.ensure(id, { cwd: options.cwd, title: options.title || '', leader: { cwd: options.cwd, sessionId: options.sessionId, model: options.model, effort: options.effort, bypass: options.bypass } });
      // Claude Code tasks test their app in the viewer, with its tools.
      const mcp = kind === 'claude' && !block ? await sessionConfig(id, { viewer: !leader, team: leader }).catch(() => '') : '';
      const role = leader ? { role: 'leader', note: LEADER_NOTE } : { role: 'task', note: '' };
      const reply = tasks.start({ ...options, id, kind: runKind, prompt: String(options.prompt || ''), mcpConfig: mcp, ...role });
      if (reply?.started) states.started(id, { kind: runKind, prompt: runKind === 'shell' ? '' : String(options.prompt || '') });
      return reply;
    },
    say(id, text) {
      const ok = tasks.say(String(id), text);
      if (ok) states.said(String(id));
      return ok;
    },
    write(id, data) {
      const key = String(id);
      tasks.write(key, data);
      // Enter or a choice's number typed while it asks: that's the answer.
      if (states.get(key).state === 'needs' && ANSWER.test(String(data))) states.answered(key);
    },
    resize: (id, cols, rows) => tasks.resize(String(id), cols, rows),
    /** Esc, as in Claude Code (Ctrl+C for a shell). */
    stop(id) {
      const key = String(id);
      tasks.write(key, kindOf(key) === 'shell' ? '\x03' : '\x1b');
      states.stopping(key);
      return true;
    },
    answered: (id) => states.answered(String(id)),
    kill(id) {
      tasks.kill(String(id));
      return true;
    },
    tail: (id) => tasks.tail(String(id)),
    running: () => tasks.running(),
    quiet: (id) => tasks.quietFor(String(id)),
    history: (cwd, sessionId) => tasks.history(String(cwd || ''), String(sessionId || '')),
    /** Every task it knows, where it stands (a window catching up). */
    snapshot,
    /** Everything ends (quitting for good). */
    killAll() {
      tasks.killAll();
      return true;
    },

    /* ---------------------------- teams ---------------------------- */

    /** Every team, as windows draw them. */
    teamSnapshot: () => teams.views(),
    /**
     * A task switching between Single agent and Hierarchy. Only while its
     * session isn't working; an idle one closes and resumes in its new role
     * on the next message. Leaving hierarchy stops the members (unmerged
     * branches stay, named in `unmerged`).
     */
    teamMode(taskId, mode) {
      const id = String(taskId);
      const running = tasks.running().includes(id);
      if (running && states.get(id).state !== 'idle') return { error: 'It’s working: wait for it to finish (or stop it), then switch.' };
      const unmerged = mode === 'hierarchy' ? [] : teams.stopAll(id).unmerged;
      if (running) tasks.kill(id);
      return { ok: true, mode: mode === 'hierarchy' ? 'hierarchy' : 'single', unmerged, closed: running };
    },
    /** A task done or deleted: its members' sessions end (`forget`: the team goes too). */
    teamStop: (taskId, forget = false) => teams.stopAll(String(taskId), { forget: Boolean(forget) }),
    /** One of the team tools, as session `id` would call it (in-process tests). */
    teamTool: (id, name, args) => teams.call(String(id), name, args),

    /* --------------------------- Katana --------------------------- */

    agentAsk: (options) => agent.ask(options),
    agentStop: () => agent.stop(),
    agentSay: (role, text, extra) => agent.say(role, text, extra),
    agentRemind: (minutes, text) => agent.remind(minutes, text),
    agentWatch: (every, check, hours) => agent.watch(every, check, hours),
    agentDrop: (id) => agent.drop(id),
    agentState: () => ({ ...agent.state(), ...agent.status() }),
    /** What the window shows now: { view, task, title, file, pane }. */
    screen(next) {
      onScreen = next && typeof next === 'object' ? next : null;
      return true;
    },
    /** A window answered one of her tool calls. */
    toolResult(callId, result, error) {
      const wait = pending.get(callId);
      if (!wait) return false;
      pending.delete(callId);
      clearTimeout(wait.timer);
      wait.resolve(error ? { error: String(error) } : { result: result ?? { ok: true } });
      return true;
    },
    /** How many windows are connected (katanad tells it); calls waiting on a gone one fail. */
    setWindows(count) {
      windows = Math.max(0, count);
      if (windows) return;
      for (const [callId, wait] of pending) {
        clearTimeout(wait.timer);
        pending.delete(callId);
        wait.resolve({ error: 'The Katana window closed before it answered.' });
      }
    },
    windowOpen,
    /** An alert, as the daemon would raise one (in-process tests). */
    alert,
    /** One of her tools, as her turn would call it (in-process tests). */
    tool: (name, args) => port.call(name, args),
    close() {
      clearInterval(quietTimer);
      clearTimeout(doneTimer);
      agent.close();
      port.close();
      tasks.killAll();
    },
  });
  return handlers;
}

module.exports = { createCore };
