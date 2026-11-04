'use strict';

/**
 * Where each task stands, decided once, here in the daemon, so every window
 * that connects (or reconnects after F5) agrees:
 *
 *   idle      nothing running, or done with its turn
 *   working   on it (UserPromptSubmit … Stop, or a message just sent);
 *             `tool` is the tool running now (its tool_use … tool_result in
 *             the transcript; PreToolUse … PostToolUse hooks where a
 *             session sends them), none while it thinks between tools
 *   needs     waiting for you, `need` saying why:
 *               asking      it asked you a question (its question tools)
 *               permission  it wants your OK to go on (a tool, a folder)
 *
 * Claude Code says most of it through its hooks; what it doesn't (an Esc
 * interrupt, a turn that ended with no Stop hook) comes from its transcript.
 * Codex says the same through its rollout, read as hooks (main/codex.js);
 * until that's found, and for shells, which say nothing: working from a
 * message until the terminal goes quiet. Pure (timers aside), so
 * scripts/test-daemon.mjs runs it.
 *
 * Every change is emitted as { id, state, need, since, tool, message,
 * running, finished?, stopped? }; `finished` when a turn ended on its own.
 */

const QUIET_MS = 4000; // a quiet shell terminal (or a Codex one not read yet) is done
const NO_START_MS = 12000; // a first message not picked up by then: something is asking
const STOP_MS = 1500; // Stop pressed: shown stopped by then at the latest
const { INTERRUPTED, NEEDS_YOU } = require('../main/screens');
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
    if (!tasks.has(id)) tasks.set(id, { state: 'idle', need: '', since: now(), tool: null, tools: new Map(), asking: new Set(), message: '', kind: 'claude', running: false, hooks: false, started: false, finishedAt: 0, waitTimer: 0, stopTimer: 0 });
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
      t.tools.clear();
      t.tool = null;
    }
    if (state === 'idle') {
      t.tools.clear();
      t.asking.clear();
      t.tool = null;
    }
    // Its question goes with the asking.
    if (state !== 'needs') {
      t.need = '';
      if (!('message' in patch)) t.message = '';
    } else if (!t.need) t.need = 'permission';
    // Stopped by you: not "finished" (no ding, nothing for Katana). A turn that
    // ends while it was shown waiting for you (Stop came: it wasn't) finished too.
    const finished = (was === 'working' || was === 'needs') && state === 'idle' && !stopped;
    if (finished) t.finishedAt = now();
    emit({ ...view(id, t), finished, stopped });
  }

  /** The tools running now (several at once, sub-agents among them): the latest is shown; none while it thinks. */
  function toolsChanged(t) {
    t.tool = [...t.tools.values()].at(-1) || null;
  }

  /** Something changed that isn't a new state (the tool in use): say so. */
  const touch = (id) => emit({ ...view(id, get(id)), finished: false, stopped: false });

  /** A tool began (its hook, or its call in the transcript). */
  function toolStarted(id, t, key, tool) {
    t.tools.set(key, tool);
    toolsChanged(t);
    touch(id);
  }

  /** A tool ran; `answers`: whatever it waited for you for was answered (it keeps its clock). */
  function toolEnded(id, t, key, answers = true) {
    t.tools.delete(key);
    t.asking.delete(key);
    toolsChanged(t);
    if (t.state === 'needs' && answers) set(id, 'working', { since: t.since });
    else touch(id);
  }

  /** A tool call's input as the hook script sums it up (hook.cjs). */
  const toolOf = (block) => {
    const input = block.input || {};
    return {
      name: String(block.name || ''),
      desc: String(input.description || '').slice(0, 200),
      detail: String(input.command || input.file_path || input.pattern || input.url || input.questions?.[0]?.question || input.question || '').slice(0, 300),
    };
  };

  /**
   * A Claude session's tool calls and their results, read off its transcript
   * (no hook runs per tool): the tool in use, and a result ending a wait for you.
   */
  function transcriptTools(id, t, line) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (line.type === 'assistant' && block?.type === 'tool_use' && block.id) {
        t.started = true;
        // Its question tools are its PreToolUse hook's (needs: asking); only their answer is read here.
        if (ASKING.has(block.name)) t.asking.add(block.id);
        // (A finished turn's late lines don't start it again; a wait for you stays one.)
        else if (t.state !== 'idle' && !t.tools.has(block.id)) toolStarted(id, t, block.id, toolOf(block));
      } else if (line.type === 'user' && block?.type === 'tool_result') {
        const key = block.tool_use_id;
        // Its question is answered by its own tool's result, not another tool's.
        const answers = t.state === 'needs' && (t.need !== 'asking' || t.asking.has(key));
        if (t.tools.has(key) || answers) toolEnded(id, t, key, answers);
      }
    }
  }

  return {
    get,
    snapshot: () => [...tasks].map(([id, t]) => ({ ...view(id, t), kind: t.kind })),

    /** Its session started; with a first message it's working at once. */
    started(id, { kind = 'claude', prompt = '' } = {}) {
      const t = get(id);
      Object.assign(t, { kind, running: true, hooks: false });
      if (!prompt) return touch(id);
      set(id, 'working', { since: now() });
      // Claude (or Codex) never picking the message up means it's asking something first.
      if (kind !== 'shell') {
        t.waitTimer = setTimeout(() => {
          // (Codex's SessionStart is its rollout being found, before it reads the message.)
          if (t.state === 'working' && (kind === 'codex' || !t.hooks) && !t.started) set(id, 'needs', { need: 'permission', message: `${kind === 'codex' ? 'Codex' : 'Claude'} is asking something in its terminal.` });
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
            if (event.toolId) t.asking.add(event.toolId);
            set(id, 'needs', { need: 'asking', message: event.detail || (event.tool === 'ExitPlanMode' ? 'Claude has a plan for you to approve.' : 'Claude has a question for you.') });
            break;
          }
          if (t.state !== 'working') set(id, 'working');
          toolStarted(id, t, event.toolId || Symbol(event.tool), { name: event.tool, desc: event.desc, detail: event.detail });
          break;
        case 'PostToolUse':
        case 'PostToolUseFailure': {
          // (Codex's, read off its rollout; a Claude session started with older hook settings.)
          t.started = true;
          // (No id from an older hook script: its oldest run of that tool.)
          const key = t.tools.has(event.toolId) ? event.toolId : [...t.tools.keys()].find((k) => t.tools.get(k).name === event.tool);
          toolEnded(id, t, key);
          break;
        }
        case 'Notification':
          // "needs your permission", "waiting for your input"…: it's asking.
          if (NEEDS_YOU.test(event.message || '')) set(id, 'needs', { need: t.need === 'asking' ? 'asking' : 'permission', message: t.need === 'asking' ? t.message : event.message });
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

    /** New transcript lines (raw JSON): its tools, an interrupt, or a turn ending with no Stop hook. */
    transcript(id, lines = []) {
      const t = get(id);
      for (const line of lines) {
        // What came before this turn (a transcript read from further back than now) is history.
        if (at(line) < t.since - 1000) continue;
        if (t.kind === 'claude') transcriptTools(id, t, line);
        if (line?.type === 'user' && !line.isMeta) {
          const text = userText(line).trim();
          if (text) t.started = true;
          // Esc: Claude Code sends no Stop hook for that.
          if (INTERRUPTED.test(text) && t.state !== 'idle') set(id, 'idle', { stopped: true });
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

    /** Shells (and a Codex whose rollout isn't read yet): quiet output after a message means done. */
    quiet(id, quietMs) {
      const t = get(id);
      if (t.kind === 'claude' || t.hooks || t.state !== 'working' || !t.running) return;
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
