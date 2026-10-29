'use strict';

/**
 * Tasks, the way Katana-style apps run them: each one a real terminal
 * session (node-pty) in its folder — interactive Claude Code, Codex or a
 * shell. Nothing is hidden from it; the app only reads along:
 *
 *   task:data        what the terminal printed (the >_ view draws it)
 *   task:hook        Claude Code's hooks: SessionStart, UserPromptSubmit,
 *                    PreToolUse, Notification, Stop (hook.cjs writes them)
 *   task:transcript  new lines of the session's transcript (~/.claude/projects)
 *   task:exit        the session ended
 *
 * Writing a message pastes it into the terminal and presses Enter, exactly
 * as if typed; Stop presses Esc.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { taskCommand } = require('./runargs');
const { cleanEnv } = require('./claude');

const FLUSH_MS = 16;

// Questions Claude Code asks in its terminal that only you can answer, and
// what kind: all of these want your permission (asking is its question tools).
const QUESTIONS = [
  [/one you trust|trust this folder/i, 'Claude Code asks whether you trust this folder. Answer it in the terminal.', 'permission'],
  [/Bypass Permissions mode/i, 'Claude Code asks you to accept bypass permissions mode (once). Answer it in the terminal.', 'permission'],
  [/Do you want to (proceed|make this edit|create|allow)/i, 'Claude wants permission for its next step. Answer it in the terminal.', 'permission'],
];
// Terminal output as text: cursor moves become spaces and line breaks, colours go.
const plain = (text) =>
  text
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(Number(n) || 1, 40)))
    .replace(/\x1b\[\d*;?\d*H/g, '\n')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
const POLL_MS = 250;
const TAIL_CHARS = 300_000; // what a terminal opened later replays

/** Where Claude Code keeps a session's transcript. */
function transcriptPath(cwd, sessionId) {
  const slug = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/** New whole lines of a growing file since `offset`: { lines, offset }. */
function readNew(file, offset) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset };
  }
  if (size < offset) offset = 0; // rewritten
  if (size === offset) return { lines: [], offset };
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const text = buffer.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end === -1) return { lines: [], offset };
    const lines = text
      .slice(0, end)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { lines, offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    fs.closeSync(fd);
  }
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

function createTasks({ send, hooksDir, settingsFile, found }) {
  let pty = null;
  const tasks = new Map();
  fs.mkdirSync(hooksDir, { recursive: true });

  function start(options) {
    const { id, kind = 'claude', cwd, cols, rows } = options;
    if (tasks.has(id)) return { running: true };
    const command = taskCommand({ ...options, settingsFile }, found());
    if (command.error) return { error: command.error };
    pty = pty || require('node-pty');
    const hookFile = path.join(hooksDir, `${String(id).replace(/[^\w-]/g, '')}.jsonl`);
    let proc;
    try {
      proc = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: Math.max(20, Math.floor(cols) || 100),
        rows: Math.max(6, Math.floor(rows) || 30),
        cwd,
        env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', XODE_TASK: String(id), XODE_HOOKS: hooksDir }),
      });
    } catch (error) {
      return { error: error.message };
    }
    const entry = {
      proc,
      kind,
      tail: '',
      out: '',
      timer: null,
      hookFile,
      hookOffset: fileSize(hookFile),
      transcript: kind === 'claude' && options.sessionId ? transcriptPath(cwd, options.sessionId) : '',
      transcriptOffset: 0,
      lastData: Date.now(),
      seen: '',
    };
    tasks.set(id, entry);
    const flush = () => {
      entry.timer = null;
      if (!entry.out) return;
      send('task:data', { id, data: entry.out });
      entry.out = '';
    };
    proc.onData((data) => {
      entry.tail = (entry.tail + data).slice(-TAIL_CHARS);
      entry.out += data;
      entry.lastData = Date.now();
      if (!entry.timer) entry.timer = setTimeout(flush, FLUSH_MS);
      if (kind === 'claude') spotQuestion(id, entry, data);
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(entry.timer);
      flush();
      poll(id, entry);
      clearInterval(entry.poller);
      // A killed task restarted under the same id: this is the old one's late exit, not the new session's.
      if (tasks.has(id) && tasks.get(id) !== entry) return;
      tasks.delete(id);
      send('task:exit', { id, code: exitCode });
    });
    entry.poller = setInterval(() => poll(id, entry), POLL_MS);
    return { started: true, pid: proc.pid };
  }

  /** A question showing up in the terminal: say so once. */
  function spotQuestion(id, entry, data) {
    entry.seen = (entry.seen + plain(data)).slice(-3000);
    const found = QUESTIONS.find(([re]) => re.test(entry.seen));
    if (!found) return;
    entry.seen = '';
    send('task:ask', { id, text: found[1], need: found[2] });
  }

  function fileSize(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  /** Hook lines and transcript lines that arrived since the last look. */
  function poll(id, entry) {
    const hooks = readNew(entry.hookFile, entry.hookOffset);
    entry.hookOffset = hooks.offset;
    for (const line of hooks.lines) {
      const event = parse(line);
      if (!event) continue;
      if (event.transcript && !entry.transcript) entry.transcript = event.transcript;
      send('task:hook', { id, ...event });
    }
    if (entry.transcript) {
      const next = readNew(entry.transcript, entry.transcriptOffset);
      entry.transcriptOffset = next.offset;
      const lines = next.lines.map(parse).filter(Boolean);
      if (lines.length) send('task:transcript', { id, lines });
    }
  }

  /** Paste text as if typed, then press Enter. */
  function say(id, text) {
    const entry = tasks.get(id);
    if (!entry) return false;
    const value = String(text || '');
    if (entry.kind === 'shell') entry.proc.write(`${value}\r`);
    else {
      entry.proc.write(`\x1b[200~${value}\x1b[201~`);
      setTimeout(() => tasks.get(id)?.proc.write('\r'), 80);
    }
    return true;
  }

  const write = (id, data) => tasks.get(id)?.proc.write(String(data));

  function resize(id, cols, rows) {
    try {
      tasks.get(id)?.proc.resize(Math.max(20, Math.floor(cols)), Math.max(6, Math.floor(rows)));
    } catch {
      /* it just exited */
    }
  }

  function kill(id) {
    const entry = tasks.get(id);
    if (!entry) return;
    tasks.delete(id);
    clearTimeout(entry.timer);
    clearInterval(entry.poller);
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
  }

  /** A finished session's transcript, read whole (opening an old task). */
  function history(cwd, sessionId) {
    if (!sessionId) return [];
    const file = transcriptPath(cwd, sessionId);
    try {
      return fs.readFileSync(file, 'utf8').split('\n').map(parse).filter(Boolean);
    } catch {
      return [];
    }
  }

  return {
    start,
    say,
    write,
    resize,
    kill,
    killAll: () => [...tasks.keys()].forEach(kill),
    tail: (id) => tasks.get(id)?.tail || '',
    running: () => [...tasks.keys()],
    // Codex and shells send no hooks: quiet output for a while means idle.
    quietFor: (id) => (tasks.has(id) ? Date.now() - tasks.get(id).lastData : Infinity),
    history,
  };
}

module.exports = { createTasks, transcriptPath, readNew, plain };
