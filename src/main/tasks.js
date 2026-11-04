'use strict';

/**
 * Tasks, the way Katana-style apps run them: each one a real terminal
 * session (node-pty) in its folder — interactive Claude Code, Codex or a
 * shell. Nothing is hidden from it; the app only reads along:
 *
 *   task:data        what the terminal printed (the >_ view draws it)
 *   task:hook        Claude Code's hooks: SessionStart, UserPromptSubmit,
 *                    PreToolUse (its question tools), Notification, Stop
 *                    (hook.cjs writes them); for Codex, the same read off
 *                    its rollout (codex.js)
 *   task:transcript  new lines of the session's transcript (~/.claude/projects;
 *                    Codex's rollout as the same lines), with a Codex
 *                    session's id once its file is found. A resumed Claude
 *                    session's is read from where it was when it resumed:
 *                    what came before is history (history(), read once).
 *   task:exit        the session ended
 *
 * Writing a message pastes it into the terminal and presses Enter, exactly
 * as if typed; Stop presses Esc. A Claude Code or Codex session still
 * starting up would drop that Enter (the message left unsent in its input
 * box), so a message for one waits until its input box is drawn.
 *
 * What Claude Code shows that this reads (its questions, its input box) is
 * in screens.js.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { taskCommand } = require('./runargs');
const { cleanEnv } = require('./claude');
const { createConverter, findRollout, findNewRollout, rolloutTranscript } = require('./codex');
const { plain, findQuestion, inputReady, SESSION_IN_USE } = require('./screens');

const FLUSH_MS = 16;
const POLL_MS = 250; // a busy session's hooks and transcript: read this often
const IDLE_POLL_MS = 1500; // a quiet one's: this often
const BUSY_MS = 5000; // it printed something, or was written to, this recently: busy
const READ_MAX = 1024 * 1024; // the most of a file one look reads: a big backlog is read over several
const LINE_MAX = 32 * 1024 * 1024; // a single line longer than this is skipped, not kept in memory
const HISTORY_BYTES = 4 * 1024 * 1024; // what opening an old task reads of its transcript: its end
const FOLLOW_BACK = 256 * 1024; // a resumed session found in another file: its last part is read
const HELD_MS = 3000; // a permission dialog seen before its tool call was read: how long it waits for it
const READY_QUIET_MS = 300; // drawn, and done drawing for a moment
const READY_MAX_MS = 20000; // no input box seen by then (a new look?): typed in anyway
const TAIL_CHARS = 300_000; // what a terminal opened later replays
// Pasted text and its Enter: Codex takes an Enter that comes too soon as part of the paste.
const ENTER_MS = { claude: 80, codex: 500 };
const CODEX_SCAN_MS = 1000; // how often a new Codex session's file is looked for
const REPORTED_MAX = 500; // transcript paths the hooks reported, kept

/* ----------------------- where transcripts are ----------------------- */

// The transcript path Claude Code's own hooks reported for a session (its word
// beats our guess), kept in <hooks>/transcripts.json across daemon restarts.
const reported = new Map();
let reportedFile = '';

function loadReported(dir) {
  reportedFile = path.join(dir, 'transcripts.json');
  try {
    for (const [session, file] of Object.entries(JSON.parse(fs.readFileSync(reportedFile, 'utf8')) || {})) if (typeof file === 'string') reported.set(session, file);
  } catch {
    /* none yet */
  }
}

function remember(sessionId, file) {
  if (!sessionId || !file || reported.get(sessionId) === file) return;
  reported.delete(sessionId);
  reported.set(sessionId, file);
  while (reported.size > REPORTED_MAX) reported.delete(reported.keys().next().value);
  if (!reportedFile) return;
  try {
    fs.writeFileSync(reportedFile, JSON.stringify(Object.fromEntries(reported), null, 1));
  } catch {
    /* kept in memory still */
  }
}

/** Where Claude Code keeps a session's transcript: where its hooks said, else where it usually is. */
function transcriptPath(cwd, sessionId) {
  const known = reported.get(String(sessionId || ''));
  if (known) return known;
  const slug = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

const samePath = (a, b) => {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return Boolean(a && b) && norm(a) === norm(b);
};

/* ---------------------------- reading files --------------------------- */

/**
 * New whole lines of a growing file since `offset`, at most READ_MAX bytes of
 * it per call: { lines, offset, carry, more }. `carry` is the start of a line
 * not finished yet (pass it back next time); `more`: there's more to read now.
 */
function readNew(file, offset, carry = null, max = READ_MAX) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset, carry, more: false };
  }
  if (size < offset) {
    // Rewritten: from the top.
    offset = 0;
    carry = null;
  }
  if (size === offset) return { lines: [], offset, carry, more: false };
  const length = Math.min(size - offset, max);
  const buffer = Buffer.alloc(length);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, offset);
  } catch {
    return { lines: [], offset, carry, more: false };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  const next = offset + length;
  const more = next < size;
  let start = 0;
  // Skipping (a line too long to keep, or the cut-off line a look starts in): up to its end.
  if (carry?.skip) {
    const end = buffer.indexOf(0x0a);
    if (end === -1) return { lines: [], offset: next, carry, more };
    start = end + 1;
    carry = null;
  }
  const end = buffer.lastIndexOf(0x0a);
  if (end < start) {
    // No line ends here: kept for the next look (a newline byte is never inside a UTF-8 character).
    const parts = [...(carry?.parts || []), buffer.subarray(start)];
    const kept = (carry?.length || 0) + length - start;
    return { lines: [], offset: next, carry: kept > LINE_MAX ? { skip: true } : { parts, length: kept }, more };
  }
  const text = Buffer.concat([...(carry?.parts || []), buffer.subarray(start, end)]).toString('utf8');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const rest = end + 1 < length ? { parts: [Buffer.from(buffer.subarray(end + 1))], length: length - end - 1 } : null;
  return { lines, offset: next, carry: rest, more };
}

/** The last whole lines of a file, at most `bytes` of it (a long transcript's end). */
function tailLines(file, bytes = HISTORY_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    // Started mid-line: from the next one.
    const from = start > 0 ? buffer.indexOf(0x0a) + 1 : 0;
    if (start > 0 && from === 0) return { lines: [], cut: true };
    const lines = buffer
      .toString('utf8', from)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { lines, cut: start > 0 };
  } catch {
    return { lines: [], cut: false };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** A line where you typed something (where an exchange starts), not a tool's result. */
const typedLine = (line) => {
  if (line?.type !== 'user' || line.isMeta) return false;
  const content = line.message?.content;
  return typeof content === 'string' || (Array.isArray(content) && content.some((b) => b?.type === 'text'));
};

/**
 * The end of what a terminal printed, at most `max` characters. Kept as the
 * chunks it came in (a running length, the oldest dropped), joined only when
 * read: a busy terminal's every chunk doesn't copy the whole tail.
 */
function createTail(max = TAIL_CHARS) {
  let chunks = [];
  let head = 0;
  let length = 0;
  return {
    push(data) {
      if (!data) return;
      chunks.push(data);
      length += data.length;
      while (length - chunks[head].length >= max) {
        length -= chunks[head].length;
        head += 1;
      }
      if (head > 1024) {
        chunks = chunks.slice(head);
        head = 0;
      }
    },
    text() {
      if (chunks.length - head > 1) {
        chunks = [chunks.slice(head).join('')];
        head = 0;
      }
      let all = chunks[head] || '';
      if (all.length > max) {
        all = all.slice(-max);
        chunks = [all];
        head = 0;
        length = all.length;
      }
      return all;
    },
    get length() {
      return length;
    },
  };
}

/** Tool calls in transcript lines still waiting for their results (for whether a permission dialog can be up). */
function trackTools(pending, lines) {
  for (const line of lines) {
    // Something typed (or an Esc's note): whatever was called before is over.
    if (typedLine(line)) pending.clear();
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (line.type === 'assistant' && block?.type === 'tool_use' && block.id) pending.add(block.id);
      else if (line.type === 'user' && block?.type === 'tool_result') pending.delete(block.tool_use_id);
    }
  }
}

/* -------------------------------- tasks ------------------------------- */

function createTasks({ send, hooksDir, settingsFile, found }) {
  let pty = null;
  const tasks = new Map();
  // Codex rollouts some running task reads (two tasks in one folder never take the same one).
  const claimed = new Set();
  fs.mkdirSync(hooksDir, { recursive: true });
  loadReported(hooksDir);
  const hookFileOf = (id) => path.join(hooksDir, `${String(id).replace(/[^\w-]/g, '')}.jsonl`);
  let swept = false;

  /** The first start in this daemon: hook files left by sessions that no longer run go. */
  function sweep() {
    if (swept) return;
    swept = true;
    const live = new Set([...tasks.values()].map((entry) => path.basename(entry.hookFile)));
    let names = [];
    try {
      names = fs.readdirSync(hooksDir);
    } catch {
      return;
    }
    for (const name of names) if (name.endsWith('.jsonl') && !live.has(name)) removeFile(path.join(hooksDir, name));
  }

  function start(options) {
    const { id, kind = 'claude', cwd, cols, rows } = options;
    if (tasks.has(id)) return { running: true };
    sweep();
    // A session that already has a transcript is resumed, whatever the caller thought:
    // --session-id on it fails ("Session ID … is already in use").
    if (kind === 'claude' && options.sessionId && !options.resume && fs.existsSync(transcriptPath(cwd, options.sessionId))) options = { ...options, resume: true };
    // A branch whose copy was never made (started once, closed before its first message): made now.
    else if (kind === 'claude' && options.forkFrom && options.resume && !fs.existsSync(transcriptPath(cwd, options.sessionId))) options = { ...options, resume: false };
    const command = taskCommand({ ...options, settingsFile }, found());
    if (command.error) return { error: command.error };
    pty = pty || require('node-pty');
    const hookFile = hookFileOf(id);
    let proc;
    try {
      proc = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: Math.max(20, Math.floor(cols) || 100),
        rows: Math.max(6, Math.floor(rows) || 30),
        cwd,
        env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', XODE_TASK: String(id), XODE_HOOKS: hooksDir, ...command.env }),
      });
    } catch (error) {
      return { error: error.message };
    }
    const transcript = kind === 'claude' && options.sessionId ? transcriptPath(cwd, options.sessionId) : '';
    const entry = {
      proc,
      kind,
      tail: createTail(TAIL_CHARS),
      out: '',
      timer: null,
      hookFile,
      hookOffset: fileSize(hookFile),
      hookCarry: null,
      transcript,
      // A resumed session's past is history (the window reads it once): only what it adds now.
      transcriptOffset: transcript && options.resume ? fileSize(transcript) : 0,
      transcriptCarry: null,
      sessionId: String(options.sessionId || ''),
      resumed: Boolean(options.resume),
      // Bypass on: a tool's permission dialog only shows while a tool waits (tools: its calls not answered yet).
      bypass: options.bypass !== false,
      tools: new Set(),
      held: null,
      more: false,
      // Codex: its rollout, read as a Claude transcript (found once Codex writes it).
      codex: kind === 'codex' ? { converter: createConverter({ since: Date.now() }), since: Date.now(), sessionId: options.resume ? String(options.sessionId || '') : '', cwd, scanned: 0, told: false } : null,
      lastData: Date.now(),
      lastInput: Date.now(),
      lastPoll: 0,
      seen: '',
      // Messages for a Claude or Codex session whose input box isn't up yet; what it drew since then.
      ready: kind === 'shell',
      queue: [],
      screen: '',
      readyTimer: null,
      readyLast: null,
    };
    // A first message that can't go on its command line: typed in once its input box is up.
    if (command.typed) entry.queue.push(command.typed);
    tasks.set(id, entry);
    const flush = () => {
      entry.timer = null;
      if (!entry.out) return;
      send('task:data', { id, data: entry.out });
      entry.out = '';
    };
    proc.onData((data) => {
      entry.tail.push(data);
      entry.out += data;
      entry.lastData = Date.now();
      if (!entry.timer) entry.timer = setTimeout(flush, FLUSH_MS);
      if (kind !== 'shell') spotQuestion(id, entry, data);
      if (!entry.ready) watchReady(id, entry, data);
    });
    if (!entry.ready) {
      entry.readyLast = setTimeout(function last() {
        // Still a question on screen: it waits for your answer first.
        if (findQuestion(plain(entry.screen), kind)) entry.readyLast = setTimeout(last, READY_MAX_MS);
        else setReady(id, entry);
      }, READY_MAX_MS);
    }
    proc.onExit(({ exitCode }) => {
      clearTimeout(entry.timer);
      clearTimeout(entry.readyTimer);
      clearTimeout(entry.readyLast);
      flush();
      poll(id, entry);
      clearInterval(entry.poller);
      claimed.delete(entry.transcript);
      // A killed task restarted under the same id: this is the old one's late exit, not the new session's.
      if (tasks.has(id) && tasks.get(id) !== entry) return;
      tasks.delete(id);
      // Its hook lines are read: the file goes (a new session under this id starts its own).
      removeFile(entry.hookFile);
      // Started with --session-id on a session that exists after all (its transcript somewhere we didn't look): resume it, once.
      if (kind === 'claude' && !options.resume && !options.retried && SESSION_IN_USE.test(plain(entry.tail.text()))) {
        send('task:data', { id, data: '\r\n[resuming the session…]\r\n' });
        if (start({ ...options, resume: true, retried: true }).started) return;
      }
      send('task:exit', { id, code: exitCode });
    });
    // Busy (printing, just written to, a backlog to read): every tick; quiet: now and then.
    entry.poller = setInterval(() => {
      const now = Date.now();
      const busy = entry.more || now - entry.lastData < BUSY_MS || now - entry.lastInput < BUSY_MS;
      if (busy || now - entry.lastPoll >= IDLE_POLL_MS) poll(id, entry);
    }, POLL_MS);
    return { started: true, pid: proc.pid };
  }

  /** A starting session's screen: once its input box is drawn (and settles), what waited is typed in. */
  function watchReady(id, entry, data) {
    entry.screen = (entry.screen + data).slice(-8000);
    clearTimeout(entry.readyTimer);
    if (inputReady(plain(entry.screen), entry.kind)) entry.readyTimer = setTimeout(() => setReady(id, entry), READY_QUIET_MS);
  }

  function setReady(id, entry) {
    if (entry.ready || tasks.get(id) !== entry) return;
    entry.ready = true;
    clearTimeout(entry.readyTimer);
    clearTimeout(entry.readyLast);
    entry.screen = '';
    entry.queue.splice(0).forEach((value, i) => setTimeout(() => type(id, value), i * 400));
  }

  /**
   * A question showing up in the terminal: say so once. A tool's permission
   * dialog only counts when one can be up: bypass off, or a tool call waiting
   * (one drawn before its call reached the transcript waits a moment for it).
   */
  function spotQuestion(id, entry, data) {
    entry.seen = (entry.seen + plain(data)).slice(-3000);
    const toolDialogs = !entry.bypass || entry.tools.size > 0;
    let found = findQuestion(entry.seen, entry.kind, { toolDialogs });
    if (!found && !toolDialogs && entry.kind === 'claude') {
      const dialog = findQuestion(entry.seen, entry.kind, { toolDialogs: true });
      if (!dialog) return;
      entry.seen = '';
      poll(id, entry);
      if (entry.tools.size) found = dialog;
      else {
        entry.held = { ...dialog, at: Date.now() };
        return;
      }
    }
    if (!found) return;
    entry.seen = '';
    entry.held = null;
    send('task:ask', { id, text: found.text, need: found.need });
  }

  function fileSize(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  function removeFile(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* in use: the next sweep */
    }
  }

  /**
   * The hooks name the session's transcript: when that isn't where we looked
   * (Claude Code moved it, or /clear began a new session), it's read from
   * there on. The session this task resumed already has its past in it: only
   * its last part is read (lines the window has are dropped there, by uuid).
   */
  function follow(entry, event) {
    remember(event.session, event.transcript);
    if (samePath(event.transcript, entry.transcript)) return;
    const resumedThis = entry.resumed && event.session && event.session === entry.sessionId;
    const size = fileSize(event.transcript);
    entry.transcript = event.transcript;
    entry.transcriptOffset = resumedThis ? Math.max(0, size - FOLLOW_BACK) : 0;
    entry.transcriptCarry = resumedThis && entry.transcriptOffset > 0 ? { skip: true } : null;
  }

  /** Hook lines and transcript lines that arrived since the last look. */
  function poll(id, entry) {
    entry.lastPoll = Date.now();
    if (entry.codex) return pollCodex(id, entry);
    const hooks = readNew(entry.hookFile, entry.hookOffset, entry.hookCarry);
    entry.hookOffset = hooks.offset;
    entry.hookCarry = hooks.carry;
    for (const line of hooks.lines) {
      const event = parse(line);
      if (!event) continue;
      if (event.transcript && entry.kind === 'claude') follow(entry, event);
      // A turn over: no tool waits any more (one stopped mid-call never gets its result).
      if (event.event === 'Stop') entry.tools.clear();
      send('task:hook', { id, ...event });
    }
    entry.more = hooks.more;
    if (entry.transcript) {
      const next = readNew(entry.transcript, entry.transcriptOffset, entry.transcriptCarry);
      entry.transcriptOffset = next.offset;
      entry.transcriptCarry = next.carry;
      entry.more = entry.more || next.more;
      const lines = next.lines.map(parse).filter(Boolean);
      trackTools(entry.tools, lines);
      if (lines.length) send('task:transcript', { id, lines });
    }
    if (entry.held) {
      if (entry.tools.size) {
        send('task:ask', { id, text: entry.held.text, need: entry.held.need });
        entry.held = null;
      } else if (Date.now() - entry.held.at > HELD_MS) entry.held = null;
    }
    return undefined;
  }

  /**
   * A Codex session: its rollout once it shows up (a new session's: the one
   * begun in its folder since it started; a resumed one's: by its id), then
   * what it added, as hook events and transcript lines.
   */
  function pollCodex(id, entry) {
    const codex = entry.codex;
    if (!entry.transcript) {
      if (Date.now() - codex.scanned < CODEX_SCAN_MS) return;
      codex.scanned = Date.now();
      let file = '';
      if (codex.sessionId) {
        // (A compressed one is history: Codex writes the resumed session to a live file.)
        const known = findRollout(codex.sessionId);
        if (known.endsWith('.jsonl') && !claimed.has(known)) file = known;
      } else {
        const fresh = findNewRollout({ cwd: codex.cwd, since: codex.since, claimed });
        if (fresh) {
          file = fresh.file;
          codex.sessionId = fresh.sessionId;
        }
      }
      if (!file) return;
      entry.transcript = file;
      claimed.add(file);
    }
    const next = readNew(entry.transcript, entry.transcriptOffset, entry.transcriptCarry);
    entry.transcriptOffset = next.offset;
    entry.transcriptCarry = next.carry;
    entry.more = next.more;
    const { lines, events } = codex.converter.convert(next.lines.map(parse).filter(Boolean));
    for (const event of events) send('task:hook', { id, ...event, session: codex.sessionId });
    // The first read names the session (the window keeps its id, to resume it and read it back).
    if (lines.length || !codex.told) {
      codex.told = true;
      send('task:transcript', { id, lines, sessionId: codex.sessionId });
    }
  }

  /** Paste text as if typed, then press Enter (once a starting Claude session can take it). */
  function say(id, text) {
    const entry = tasks.get(id);
    if (!entry) return false;
    const value = String(text || '');
    entry.lastInput = Date.now();
    if (entry.ready) type(id, value);
    else entry.queue.push(value);
    return true;
  }

  function type(id, value) {
    const entry = tasks.get(id);
    if (!entry) return;
    entry.lastInput = Date.now();
    if (entry.kind === 'shell') entry.proc.write(`${value}\r`);
    else {
      entry.proc.write(`\x1b[200~${value}\x1b[201~`);
      setTimeout(() => tasks.get(id)?.proc.write('\r'), ENTER_MS[entry.kind] || ENTER_MS.claude);
    }
  }

  function write(id, data) {
    const entry = tasks.get(id);
    if (!entry) return;
    entry.lastInput = Date.now();
    // Keys pressed while it starts (answering its question): only what it draws after them counts.
    if (!entry.ready) entry.screen = '';
    entry.proc.write(String(data));
  }

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
    clearTimeout(entry.readyTimer);
    clearTimeout(entry.readyLast);
    clearInterval(entry.poller);
    claimed.delete(entry.transcript);
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
  }

  /**
   * A session's transcript as the window shows it (opening an old task): its
   * end, HISTORY_BYTES of it, from where an exchange starts (a long session's
   * transcript runs to hundreds of MB); a Codex one's from its rollout.
   */
  function history(cwd, sessionId, kind = 'claude') {
    if (!sessionId) return [];
    if (kind === 'codex') return rolloutTranscript(findRollout(sessionId));
    const { lines, cut } = tailLines(transcriptPath(cwd, sessionId), HISTORY_BYTES);
    const parsed = lines.map(parse).filter(Boolean);
    if (!cut) return parsed;
    const first = parsed.findIndex(typedLine);
    // (Its title, if the cut-off part had it, is kept.)
    return first <= 0 ? parsed : [...parsed.slice(0, first).filter((line) => line.type === 'ai-title'), ...parsed.slice(first)];
  }

  /** What a terminal printed so far; `sent`: only what already went out as task:data (a window starting to watch). */
  function tail(id, { sent = false } = {}) {
    const entry = tasks.get(id);
    if (!entry) return '';
    const text = entry.tail.text();
    return sent && entry.out ? text.slice(0, Math.max(0, text.length - entry.out.length)) : text;
  }

  return {
    start,
    say,
    write,
    resize,
    /** Its terminal's size, for reading what it has drawn. */
    size: (id) => {
      const proc = tasks.get(id)?.proc;
      return proc ? { cols: proc.cols, rows: proc.rows } : null;
    },
    kill,
    killAll: () => [...tasks.keys()].forEach(kill),
    tail,
    running: () => [...tasks.keys()],
    // Shells send no hooks: quiet output for a while means idle (a Codex's rollout says, once found).
    quietFor: (id) => (tasks.has(id) ? Date.now() - tasks.get(id).lastData : Infinity),
    history,
  };
}

module.exports = { createTasks, transcriptPath, readNew, tailLines, createTail, trackTools, plain, inputReady, HISTORY_BYTES, READ_MAX };
