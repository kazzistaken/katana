'use strict';

/**
 * Where each task stands, decided once, here in the daemon, so every window
 * that connects (or reconnects after F5) agrees:
 *
 *   idle      nothing running, or done with its turn
 *   working   on it (UserPromptSubmit … Stop, or a message just sent)
 *   needs     waiting for you, `need` saying why:
 *               asking      it asked you a question (its question tools)
 *               permission  it wants your OK to go on (a tool, a folder)
 *
 * Claude Code says most of it through its hooks; what it doesn't (an Esc
 * interrupt, a turn that ended with no Stop hook) comes from its transcript.
 * Codex and shells send no hooks: working from a message until their
 * terminal goes quiet. Pure (timers aside), so scripts/test-daemon.mjs runs it.
 *
 * Every change is emitted as { id, state, need, since, tool, message,
 * running, finished?, stopped? }; `finished` when a turn ended on its own.
 */

const QUIET_MS = 4000; // a quiet Codex or shell terminal is done
const NO_START_MS = 12000; // a first message not picked up by then: something is asking
const STOP_MS = 1500; // Stop pressed: shown stopped by then at the latest
const INTERRUPTED = /^\[Request interrupted by user/;
// Claude Code's tools that ask you something (and wait for the answer).
const ASKING = new Set(['AskUserQuestion', 'ExitPlanMode']);

const at = (line) => Date.parse(line?.timestamp || '') || 0;

/** A raw transcript user line's typed words. */
function userText(line) {
  const content = line?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

function createTaskStates({ emit, now = () => Date.now() }) {
  const tasks = new Map();

  function get(id) {
    if (!tasks.has(id)) tasks.set(id, { state: 'idle', need: '', since: now(), tool: null, message: '', kind: 'claude', running: false, hooks: false, started: false, finishedAt: 0, waitTimer: 0, stopTimer: 0 });
    return tasks.get(id);
  }

  const view = (id, t) => ({ id, state: t.state, need: t.need, since: t.since, tool: t.tool, message: t.message, running: t.running, finishedAt: t.finishedAt });

  function set(id, state, { stopped = false, ...patch } = {}) {
    const t = get(id);
    clearTimeout(t.waitTimer);
    clearTimeout(t.stopTimer);
    const was = t.state;
    Object.assign(t, patch, { state });
    if (state === 'working' && was !== 'working') {
      t.since = patch.since || now();
      t.tool = null;
    }
    // Its question goes with the asking.
    if (state !== 'needs') {
      t.need = '';
      if (!('message' in patch)) t.message = '';
    } else if (!t.need) t.need = 'permission';
    // Stopped by you: not "finished" (no ding, nothing for Katana).
    const finished = was === 'working' && state === 'idle' && !stopped;
    if (finished) t.finishedAt = now();
    emit({ ...view(id, t), finished, stopped });
  }

  /** Something changed that isn't a new state (the tool in use): say so. */
  const touch = (id) => emit({ ...view(id, get(id)), finished: false, stopped: false });

  return {
    get,
    snapshot: () => [...tasks].map(([id, t]) => ({ ...view(id, t), kind: t.kind })),

    /** Its session started; with a first message it's working at once. */
    started(id, { kind = 'claude', prompt = '' } = {}) {
      const t = get(id);
      Object.assign(t, { kind, running: true, hooks: false });
      if (!prompt) return touch(id);
      set(id, 'working', { since: now() });
      // Claude never picking the message up means it's asking something first.
      if (kind === 'claude') {
        t.waitTimer = setTimeout(() => {
          if (t.state === 'working' && !t.hooks && !t.started) set(id, 'needs', { need: 'permission', message: 'Claude is asking something in its terminal.' });
        }, NO_START_MS);
      }
      return undefined;
    },

    /** A message typed in. */
    said(id) {
      if (get(id).state !== 'working') set(id, 'working', { since: now() });
    },

    hook(id, event = {}) {
      const t = get(id);
      t.hooks = true;
      t.running = true;
      switch (event.event) {
        case 'SessionStart':
          touch(id);
          break;
        case 'UserPromptSubmit':
          t.started = true;
          set(id, 'working', { since: event.at || now() });
          break;
        case 'PreToolUse':
          t.started = true;
          // A question for you: it waits for the answer.
          if (ASKING.has(event.tool)) {
            set(id, 'needs', { need: 'asking', message: event.detail || (event.tool === 'ExitPlanMode' ? 'Claude has a plan for you to approve.' : 'Claude has a question for you.') });
            break;
          }
          if (t.state !== 'working') set(id, 'working');
          t.tool = { name: event.tool, desc: event.desc, detail: event.detail };
          touch(id);
          break;
        case 'PostToolUse':
          // A tool ran: whatever it asked for was answered (it keeps its clock).
          t.started = true;
          if (t.state === 'needs') set(id, 'working', { since: t.since });
          break;
        case 'Notification':
          // "needs your permission", "waiting for your input"…: it's asking.
          if (/permission|approve|needs your/i.test(event.message || '')) set(id, 'needs', { need: t.need === 'asking' ? 'asking' : 'permission', message: t.need === 'asking' ? t.message : event.message });
          break;
        case 'Stop':
          set(id, 'idle');
          break;
        default:
          break;
      }
    },

    /** A question on screen in its terminal (trust this folder, a permission…). */
    ask(id, text, need = 'permission') {
      // Its own question already says more than the screen does.
      if (get(id).need === 'asking') return;
      set(id, 'needs', { need, message: text });
    },

    /** New transcript lines (raw JSON): an interrupt, or a turn ending with no Stop hook. */
    transcript(id, lines = []) {
      const t = get(id);
      for (const line of lines) {
        if (line?.type === 'user' && !line.isMeta) {
          const text = userText(line).trim();
          if (text) t.started = true;
          // Esc: Claude Code sends no Stop hook for that.
          if (INTERRUPTED.test(text) && t.state !== 'idle' && at(line) >= t.since - 1000) set(id, 'idle', { stopped: true });
        } else if (line?.type === 'assistant' && line.isApiErrorMessage && t.state !== 'idle') {
          // An API error (a limit, an outage) ends the turn: no Stop hook comes for it.
          set(id, 'idle');
        } else if (line?.type === 'assistant' && line.message?.stop_reason === 'end_turn' && t.state === 'working' && !t.hooks) {
          set(id, 'idle');
        }
      }
    },

    /** You pressed Stop: shown stopped once the transcript says so, or soon anyway. */
    stopping(id) {
      const t = get(id);
      if (t.state === 'idle') return;
      clearTimeout(t.stopTimer);
      t.stopTimer = setTimeout(() => {
        if (t.state !== 'idle') set(id, 'idle', { stopped: true });
      }, STOP_MS);
    },

    /** Someone answered its question in the terminal: back to work, the clock running on. */
    answered(id) {
      const t = get(id);
      if (t.state === 'needs') set(id, 'working', { since: t.since, message: '' });
    },

    /** Codex and shells: quiet output after a message means done. */
    quiet(id, quietMs) {
      const t = get(id);
      if (t.kind === 'claude' || t.state !== 'working' || !t.running) return;
      if (quietMs > QUIET_MS && now() - t.since > QUIET_MS) set(id, 'idle');
    },

    exited(id) {
      const t = get(id);
      t.running = false;
      t.hooks = false;
      if (t.state !== 'idle') set(id, 'idle', { stopped: true });
      else touch(id);
    },

    forget(id) {
      const t = tasks.get(id);
      if (!t) return;
      clearTimeout(t.waitTimer);
      clearTimeout(t.stopTimer);
      tasks.delete(id);
    },
  };
}

module.exports = { createTaskStates, QUIET_MS, NO_START_MS, STOP_MS };
