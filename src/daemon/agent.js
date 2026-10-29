'use strict';

/**
 * Katana herself, in the daemon, so she works with no window open. Each
 * turn is a hidden `claude -p` run (main/claude.js) in her own folder
 * (<userData>/katana, where she keeps notes and scratch files) that resumes
 * her own session, with the app's controls as tools (toolport.js → a window,
 * or headless.js when none is open) besides a normal agent's.
 *
 * She's woken by you ([user] typed, [voice] said), by a task finishing
 * ([finished]), by her reminders ([reminder]) and by her recurring checks
 * ([check]); one turn at a time. What she remembers (her session, the
 * conversation, reminders, checks) is kept in <userData>/agent.json, which
 * only the daemon writes.
 *
 * A check ("every 10 minutes, see whether CI is green") wakes her on its
 * interval; she looks, and until its condition is met her answer is NOT YET
 * and nobody hears of it. Once it's met she tells you, once, and it ends. It
 * gives up after its hours (or after failing a few times in a row) and says so.
 *
 * Events (emit):
 *   agent:message  a line of the conversation
 *   agent:state    the whole conversation, reminders and checks (after a change)
 *   agent:busy     { busy, since, activity }
 *   agent:reply    { askId, reply | error, kind } a turn's answer
 *   run:event      her runs' plan usage (the sidebar shows it)
 *
 * What she says about a finished task is its "done" alert (one, quiet);
 * a reminder is alerted at once, with sound, and her words about it are FYI;
 * a check that's met is alerted with her words, with sound.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startRun, cancelRun } = require('../main/claude');
const { writeIfChanged } = require('../main/statefile');
const { transcriptPath } = require('../main/tasks');

const RUN_ID = 'agent';
const RESUME_GONE = /No conversation found|session.*not found/i;
const HISTORY = 120;
const LAST_WORDS = 280;
const REMINDER_EVERY_MS = 5000;
const CHECK_HOURS = 24;
const CHECK_MAX_HOURS = 7 * 24;
const CHECK_FAILS = 3;
const NOT_YET = /^\W*not yet\b/i;
const SAVE_MS = 200;
const TAIL_BYTES = 256 * 1024;

const clip = (text, max) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const uid = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/**
 * Her answer in words. (An older answer was JSON {reply, actions}; its reply
 * is still read. Other JSON in her words is only words.)
 */
function parseReply(text) {
  const value = String(text || '').trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(value.slice(start, end + 1));
      if (json && typeof json === 'object' && typeof json.reply === 'string') return json.reply.trim();
    } catch {
      /* plain words */
    }
  }
  return value;
}

/** A Claude task's last words, from the end of its transcript (no window needed). */
function lastAnswer(task) {
  if (task.kind !== 'claude' || !task.started || !task.sessionId) return '';
  const file = transcriptPath(task.cwd, task.sessionId);
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const json = JSON.parse(line);
        if (json.type !== 'assistant' || json.isSidechain) continue;
        const text = (json.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) return text;
      } catch {
        /* a line cut by where the tail starts */
      }
    }
  } catch {
    /* no transcript yet */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return '';
}

function instructions(folder) {
  return `You are Katana, the agent inside the user's coding app (also called Katana). The app runs the user's coding tasks: each task is a real Claude Code (or Codex, or shell) session in one of the user's trusted folders, run by a background process, so tasks keep going when the app's window is closed. You run the app for the user: anything they could do in it with the mouse and keyboard, you do with your tools. You also have a normal agent's tools (read and search files in the trusted folders, the web; with bypass permissions on, also commands and edits).

The user sees your reply in big text and may hear it spoken. When the app's window is closed, your answers to [finished], [reminder] and a met [check] reach them as a Windows notification instead, so make those stand on their own. Be brief and plain, like a calm colleague: one to three short sentences, no lists or headings unless asked.

Every message starts with a tag, then a summary of the app's state (time, whether a window is open, folders, tasks):
- [user]: the user typed something.
- [voice]: the user said it out loud (your reply is spoken: by GPT-Live in its own words, or read out as you wrote it). The words are a transcript, so allow for mishearing; ask when it matters. Reply in one or two spoken sentences, never Markdown, ids or paths; end with a question only when you need an answer (the mic opens again for it).
- [finished]: a task just finished; say what it did and whether it needs the user (to try it, merge it, or answer).
- [reminder]: a reminder you set is due; tell the user.
- [check]: one of your recurring checks (set with watch) is due. Look now with your tools. If its condition isn't met yet, your whole reply is NOT YET and nothing else (the user isn't told). If it is met, your reply tells the user what happened; that ends the check. If you can't tell (an error, no access), say what's wrong instead of NOT YET; that ends it too.

How to work:
- Act with your tools (mcp__katana__*), then reply in plain words saying what you did or found. Call app_state when you need task ids or the current state; never invent an id or folder.
- Coding work goes to tasks: start one with new_task, or send_to_task to continue an existing task's own work. Split big work into tasks that don't touch the same files; use a worktree when two tasks share a folder.
- When a task needs the user (state "needs"), read_terminal to see the question. Answer it with press_keys only when the user already told you what to choose; otherwise ask them.
- Only delete, discard or remove things when the user asked for exactly that.
- "Run it", "show me the app": run_app runs the task's app (or shows a web page) live in the app viewer, where the user can use it. To test it yourself: app_screenshot to see it, then app_click, app_type, app_key, app_scroll; read_app_output for its console and logged errors; stop_app ends it. Test there, never in separate windows. Task sessions have the same tools for their own app.
- With no window open, tools that change the screen (show, open_file, run_app) and ones the user must confirm (trust_folder, remove_folder) can't run; say so instead.
- Settings, themes, what's on screen, reminders, checks, folders: all yours to change when asked.
- "Every N minutes, check X and tell me when Y" is a check: use watch, not remind. Write its check so it stands on its own (what to look at, how, and what counts as met).
- Short questions about the app or its tasks: answer from app_state, read_task or read_terminal.
- A task in hierarchy mode is run by a team: its own session is the Leader (send_to_task, read_task and read_terminal reach the leader), which splits the work across up to 4 worker sessions and 2 verifiers and merges what passes. app_state shows each member's state; you hear once when the whole task finishes, not per member.
- "This", "that" or "it" with nothing else named means what's on screen (the "On screen" line): "commit this" on a task's page means that task.
- Your own folder is ${folder}: keep notes, lists and scratch files there; it's yours across turns.`;
}

/** What the window shows, in words: which task and how (its conversation, terminal, a file). */
function describeScreen({ view, task, title, file, pane } = {}) {
  if (pane === 'settings') return 'Settings';
  if (view === 'agent') return 'your own conversation (Katana)';
  if (view === 'new' || !task) return 'the New task screen';
  const how = pane === 'terminal' ? 'its terminal' : file ? `its file ${file}` : 'its conversation';
  return `task ${task} "${title || ''}", ${how}`;
}

function normalize(saved = {}) {
  return {
    sessionId: saved.sessionId || '',
    messages: Array.isArray(saved.messages) ? saved.messages.slice(-HISTORY) : [],
    reminders: Array.isArray(saved.reminders) ? saved.reminders : [],
    watches: Array.isArray(saved.watches) ? saved.watches : [],
  };
}

// `runner` is main/claude.js's; tests hand in their own, so no Claude starts.
function createAgent({ userDataDir, readState, snapshot, emit, toolsConfig, alert, windowOpen, screen = () => null, team = () => [], block = false, runner = { startRun, cancelRun } }) {
  const file = path.join(userDataDir, 'agent.json');
  const promptFile = path.join(userDataDir, 'agent.md');
  // Her own folder: her runs start there, and it's hers to write in.
  const home = path.join(userDataDir, 'katana');
  const queue = [];
  let busy = false;
  let since = 0;
  let activity = '';
  let turn = null; // { text, chunks, retried, kind, askId, note }
  let saveTimer = 0;
  const checking = new Set(); // checks queued or being looked at now

  /** Her memory: agent.json, or (the first time) what the window kept in state.json. */
  const data = (() => {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      const moved = normalize(readState()?.agent || {});
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(moved, null, 1));
      return moved;
    }
  })();

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_MS);
  }

  function flush() {
    clearTimeout(saveTimer);
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1));
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      /* next time */
    }
  }

  const state = () => ({ messages: data.messages, reminders: data.reminders, watches: data.watches });
  const status = () => ({ busy, since, activity });
  const changed = () => emit('agent:state', state());

  function say(role, text, extra = {}) {
    const message = { role, text: String(text || ''), at: Date.now(), ...extra };
    data.messages.push(message);
    if (data.messages.length > HISTORY) data.messages.splice(0, data.messages.length - HISTORY);
    save();
    emit('agent:message', message);
    return message;
  }

  /** What she needs to know, every turn. */
  function situation() {
    const saved = readState() || {};
    const projects = saved.projects || [];
    const states = new Map((snapshot() || []).map((t) => [t.id, t]));
    const lines = [`Time: ${new Date().toLocaleString()}`, `Window: ${windowOpen() ? 'open' : 'closed (the user is away from the app)'}`];
    const shown = screen();
    if (shown) lines.push(`On screen: ${describeScreen(shown)}`);
    lines.push(`Folders: ${projects.map((p) => p.name).join(', ') || '(none yet)'}`);
    const tasks = (saved.tasks || []).filter((t) => !t.doneAt || Date.now() - t.doneAt < 864e5);
    lines.push(tasks.length ? 'Tasks:' : 'Tasks: (none)');
    for (const task of tasks) {
      const live = states.get(task.id);
      const where = projects.find((p) => p.id === task.projectId)?.name || '?';
      const stateName = live?.running ? live.state : 'not running';
      const last = lastAnswer(task);
      // Hierarchy mode: run by a team (its leader is the task's session); one line for the team.
      const crew = task.mode === 'hierarchy' ? ` — hierarchy (leader + team): ${team(task.id).join('; ') || 'no subtasks yet'}` : '';
      lines.push(`- ${task.id} "${task.title}" in ${where} (${task.kind}${task.worktree && !task.merged ? ', worktree' : ''}) — ${stateName}${task.doneAt ? ', done' : ''}${crew}${last ? ` — last said: "${clip(last, LAST_WORDS)}"` : ''}`);
    }
    if (data.reminders.length) lines.push(`Reminders: ${data.reminders.map((r) => `"${r.text}" at ${new Date(r.at).toLocaleTimeString()}`).join('; ')}`);
    if (data.watches.length) lines.push(`Checks: ${data.watches.map((w) => `${w.id} "${w.check}" every ${w.every} min until ${new Date(w.until).toLocaleString()}`).join('; ')}`);
    return lines.join('\n');
  }

  async function run(message, extra = {}) {
    turn = { text: message, chunks: [], retried: false, ...extra };
    if (block) return { error: 'Claude is disabled for this test run' };
    fs.mkdirSync(home, { recursive: true });
    writeIfChanged(promptFile, instructions(home));
    const saved = readState() || {};
    const folders = (saved.projects || []).map((project) => project.path).filter((folder) => {
      try {
        return fs.statSync(folder).isDirectory();
      } catch {
        return false;
      }
    });
    const settings = saved.settings || {};
    return runner.startRun(
      {
        runId: RUN_ID,
        cwd: home,
        message,
        sessionId: data.sessionId,
        model: settings.agentModel || 'claude-opus-5-5',
        effort: settings.agentEffort || 'low',
        managerPromptFile: promptFile,
        mcpConfig: await toolsConfig(),
        dirs: [home, ...folders],
        bypass: settings.bypassPermissions !== false,
      },
      onEvent
    );
  }

  async function next() {
    if (busy || !queue.length) return;
    busy = true;
    since = Date.now();
    activity = '';
    emit('agent:busy', status());
    const item = queue.shift();
    // A turn that can't even start (its config, the disk) ends as an error, not busy forever.
    const reply = await run(`[${item.kind}] ${item.text}\n\n${situation()}`, { kind: item.kind, askId: item.askId, note: item.note, taskId: item.taskId, watchId: item.watchId }).catch((error) => ({ error: error.message || String(error) }));
    if (reply?.error && busy) finish({ error: reply.error });
  }

  function finish({ error, text } = {}) {
    const done = turn;
    turn = null;
    busy = false;
    activity = '';
    if (done?.kind === 'check') checked(done.watchId, { error, text });
    else if (error) {
      say('error', error);
      emit('agent:reply', { askId: done?.askId, error, kind: done?.kind });
      // She couldn't say it: the plain news still reaches you.
      if (done?.kind === 'finished') alert({ level: 'done', title: done.note || 'A task finished', body: 'Finished.', taskId: done.taskId });
    } else {
      const reply = parseReply(text);
      if (reply) say('agent', reply);
      emit('agent:reply', { askId: done?.askId, reply, kind: done?.kind });
      // What she says about a finished task is its one, quiet alert.
      if (done?.kind === 'finished') alert({ level: 'done', title: done.note || 'A task finished', body: reply || 'Finished.', taskId: done.taskId });
    }
    emit('agent:busy', status());
    next();
  }

  function onEvent(event) {
    if (event.type === 'limits') emit('run:event', event);
    if (!turn) return;
    if (event.type === 'init' && event.sessionId && event.sessionId !== data.sessionId) {
      data.sessionId = event.sessionId;
      save();
    } else if (event.type === 'assistant' && event.text) turn.chunks.push(event.text);
    else if (event.type === 'tool') {
      activity = String(event.tool || '').replace(/^mcp__katana__/, '').replace(/_/g, ' ') + (event.detail && !/^mcp__/.test(event.tool) ? ` ${event.detail}` : '');
      emit('agent:busy', status());
    } else if (event.type === 'result') {
      // Her last words: what she says after using her tools.
      const text = String(event.result || '').trim() || turn.chunks.at(-1) || '';
      if (event.ok === false && RESUME_GONE.test(String(event.result || '')) && !turn.retried) return retryFresh();
      finish(event.ok === false ? { error: String(event.result || 'Katana couldn’t answer.') } : { text });
    } else if (event.type === 'error' || event.type === 'dead') {
      if (RESUME_GONE.test(String(event.message || '')) && !turn.retried) return retryFresh();
      if (event.type === 'dead') finish({ error: event.message || 'Katana stopped.' });
    }
    return undefined;
  }

  /** Her saved session is gone (Claude Code cleans old ones up): a fresh one, once. */
  function retryFresh() {
    const { text, kind, askId, note, taskId, watchId } = turn;
    data.sessionId = '';
    save();
    run(text, { kind, askId, note, taskId, watchId, retried: true })
      .catch((error) => ({ error: error.message || String(error) }))
      .then((reply) => reply?.error && finish({ error: reply.error }));
  }

  // Reminders and checks come due on their own, window or not.
  function tick(now = Date.now()) {
    for (const reminder of [...data.reminders]) {
      if (reminder.at > now) continue;
      drop(reminder.id);
      // At once, with sound; what she then says about it is FYI.
      alert({ level: 'reminder', title: 'Reminder', body: reminder.text });
      tell('reminder', `Reminder due: ${reminder.text}`, `Reminder: ${reminder.text}`);
    }
    for (const item of [...data.watches]) {
      if (checking.has(item.id)) continue;
      if (item.until <= now) {
        drop(item.id);
        const span = item.until - item.at;
        const hours = Math.round(span / 36e5);
        const lasted = span < 36e5 ? `${Math.round(span / 60000)} minutes` : hours === 1 ? 'an hour' : `${hours} hours`;
        const body = `I stopped checking after ${lasted}; it never happened: ${item.check}`;
        say('agent', body);
        alert({ level: 'reminder', title: 'Check ended', body });
        continue;
      }
      if (item.next > now) continue;
      // Quiet: no line in the conversation until there's something to say.
      checking.add(item.id);
      queue.push({ kind: 'check', text: `Check ${item.id} (every ${item.every} min; looked ${item.checks} times so far): ${item.check}`, watchId: item.id });
      next();
    }
  }
  const reminderTimer = setInterval(tick, REMINDER_EVERY_MS);
  reminderTimer.unref?.();

  function remind(minutes, text) {
    const reminder = { id: uid('rem'), at: Date.now() + Math.max(0.1, Number(minutes) || 0) * 60000, text: String(text || '') };
    data.reminders.push(reminder);
    save();
    changed();
    return reminder;
  }

  /** Look at something every `every` minutes until it's met (or `hours` pass). */
  function watch(every, check, hours = CHECK_HOURS) {
    const minutes = Math.max(1, Number(every) || 0);
    const lasts = Math.min(CHECK_MAX_HOURS, Math.max(minutes / 60, Number(hours) || CHECK_HOURS));
    const now = Date.now();
    // The first look is right away: it may be true already.
    const item = { id: uid('chk'), every: minutes, check: String(check || ''), at: now, next: now, until: now + lasts * 36e5, checks: 0, fails: 0 };
    data.watches.push(item);
    save();
    changed();
    return item;
  }

  /** A check's turn ended: quiet while NOT YET; met (or broken), it tells you once and ends. */
  function checked(id, { error, text }) {
    checking.delete(id);
    const item = data.watches.find((w) => w.id === id);
    const reply = error ? '' : parseReply(text);
    // Cancelled while she looked: nothing more to say.
    if (!item) return emit('agent:reply', { reply: '', kind: 'check' });
    item.checks += 1;
    item.next = Date.now() + item.every * 60000;
    item.fails = error ? item.fails + 1 : 0;
    const quiet = error ? item.fails < CHECK_FAILS : !reply || NOT_YET.test(reply);
    if (quiet) {
      save();
      changed();
      return emit('agent:reply', { reply: '', kind: 'check' });
    }
    drop(id);
    const words = error ? `I stopped checking "${item.check}": it failed ${CHECK_FAILS} times in a row (${error}).` : reply;
    say('agent', words);
    alert({ level: 'reminder', title: 'Check', body: words });
    return emit('agent:reply', { reply: words, kind: 'check' });
  }

  /** A reminder or a check, gone. */
  function drop(id) {
    data.reminders = data.reminders.filter((r) => r.id !== id);
    data.watches = data.watches.filter((w) => w.id !== id);
    save();
    changed();
    return true;
  }

  /** Something happened she should hear about: a task finished (its id), a reminder is due. */
  function tell(kind, text, note, taskId = '') {
    if (note) say('event', note);
    queue.push({ kind, text, note, taskId });
    next();
  }

  return {
    /** You wrote or said something; the answer comes as agent:reply with the same askId. */
    ask({ text, kind = 'user', log = true, askId = '' } = {}) {
      const value = String(text || '').trim();
      if (!value) return { queued: false };
      if (log) say('user', value);
      queue.push({ kind, text: value, askId });
      next();
      return { queued: true };
    },
    tell,
    stop() {
      // A check stopped mid-look is looked at again next time.
      for (const item of queue.splice(0)) {
        checking.delete(item.watchId);
        emit('agent:reply', { askId: item.askId, error: 'Stopped.', kind: item.kind });
      }
      runner.cancelRun(RUN_ID);
      checking.delete(turn?.watchId);
      if (busy) {
        emit('agent:reply', { askId: turn?.askId, error: 'Stopped.', kind: turn?.kind });
        turn = null;
        busy = false;
        say('agent', 'Stopped.', { kind: 'stopped' });
        emit('agent:busy', status());
      }
      return true;
    },
    say,
    remind,
    /** Reminders and checks that are due, now (the timer does it every few seconds; tests call it). */
    tick,
    watch,
    drop,
    state,
    status,
    close() {
      clearInterval(reminderTimer);
      runner.cancelRun(RUN_ID);
      flush();
    },
  };
}

module.exports = { createAgent, parseReply, lastAnswer, instructions, describeScreen };
