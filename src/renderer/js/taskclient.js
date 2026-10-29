import { createTranscript } from './transcript.js';

/**
 * What each task is doing right now. The tasks run in katanad, the
 * background daemon (src/daemon), which also decides where each one stands
 * and says so (task:state); this window follows along and keeps each
 * Claude task's transcript to show it. After a reload it catches up
 * (sync): which tasks are running, and their states.
 *
 *   idle      nothing running (or the session isn't open)
 *   working   on it
 *   needs     waiting for you; `need` says why: 'asking' (a question for
 *             you) or 'permission' (your OK to go on): open >_ to answer
 *
 * Events (on): { id, type: 'change' | 'finished' | 'needs' | 'exit' | 'error' | 'missed' }.
 * 'missed': it finished while no window was open (finishedAt says when).
 */

export function createTaskClient({ api, store }) {
  const live = new Map();
  const listeners = new Set();

  const emit = (id, type, extra = {}) => {
    for (const fn of listeners) {
      try {
        fn({ id, type, ...extra });
      } catch (error) {
        console.error('[tasks] listener failed', error);
      }
    }
  };

  function get(id) {
    if (!live.has(id)) {
      live.set(id, {
        transcript: createTranscript(),
        state: 'idle',
        need: '',
        since: Date.now(),
        tool: null,
        running: false,
        loaded: false,
        message: '',
        finishedAt: 0,
      });
    }
    return live.get(id);
  }

  /** Where the daemon says a task stands. */
  function apply(update, { quiet = false } = {}) {
    const { id } = update;
    const t = get(id);
    const was = t.state;
    Object.assign(t, {
      state: update.state,
      need: update.need || '',
      since: update.since || t.since,
      tool: update.tool || null,
      message: update.message || '',
      running: Boolean(update.running),
      finishedAt: update.finishedAt || t.finishedAt,
    });
    emit(id, 'change');
    if (quiet) return;
    if (update.finished) emit(id, 'finished');
    if (t.state === 'needs' && was !== 'needs') emit(id, 'needs');
  }

  /* ------------------------------ events ------------------------------ */

  /** Claude Code's short title names the task, unless you named it yourself. */
  function adoptTitle(id) {
    const task = store.task(id);
    const title = get(id).transcript.title();
    if (task && title && !task.named && task.title !== title) store.renameTask(id, title);
  }

  api.task.onState((update) => apply(update));

  api.task.onTranscript(({ id, lines }) => {
    const t = get(id);
    if (!t.transcript.add(lines)) return;
    t.loaded = true;
    adoptTitle(id);
    emit(id, 'change');
  });

  api.task.onExit(({ id }) => {
    get(id).running = false;
    emit(id, 'exit');
  });

  // The daemon went away (it crashed, or was stopped): nothing is running now.
  api.task.onLost?.(() => {
    for (const [id, t] of live) {
      if (!t.running && t.state === 'idle') continue;
      Object.assign(t, { running: false, state: 'idle', need: '', tool: null, message: '' });
      emit(id, 'change');
    }
  });

  /** Catch up with the daemon: what runs, where each task stands, what finished while away. */
  async function sync() {
    const list = await api.task.snapshot().catch(() => []);
    for (const update of list || []) {
      if (!store.task(update.id)) continue;
      apply(update, { quiet: true });
      const task = store.task(update.id);
      if (update.finishedAt && update.finishedAt > (task.updatedAt || 0)) emit(update.id, 'missed', { at: update.finishedAt });
    }
    return list;
  }

  /* ------------------------------ actions ----------------------------- */

  /** Read an earlier session's transcript once (opening an old task). */
  async function load(task) {
    const t = get(task.id);
    if (t.loaded || t.loading || task.kind !== 'claude' || !task.started) return;
    t.loading = true;
    const lines = await api.task.history(task.cwd, task.sessionId).catch(() => []);
    t.loading = false;
    t.loaded = true;
    if (t.transcript.add(lines)) {
      adoptTitle(task.id);
      emit(task.id, 'change');
    }
  }

  /** Open the task's terminal session (resuming it when it ran before). */
  async function start(task, prompt = '', size = {}) {
    const t = get(task.id);
    if (t.running) return { running: true };
    const reply = await api.task.start({
      id: task.id,
      kind: task.kind,
      cwd: task.cwd,
      sessionId: task.sessionId,
      resume: task.started,
      model: task.model,
      effort: task.effort,
      // Hierarchy mode: the session is its team's leader.
      mode: task.mode,
      title: task.title,
      prompt,
      cols: size.cols || 120,
      rows: size.rows || 34,
    });
    if (reply?.error) {
      emit(task.id, 'error', { message: reply.error });
      return reply;
    }
    t.running = true;
    if (!task.started) store.patchTask(task.id, { started: true });
    emit(task.id, 'change');
    return reply;
  }

  /** Write to a task: starts (or resumes) its session with it, or types it in. */
  async function send(task, text) {
    const t = get(task.id);
    const value = String(text || '').trim();
    if (!value) return null;
    if (!t.running) {
      // A shell takes no first message: it's typed once the shell is up.
      const reply = await start(task, task.kind === 'shell' ? '' : value);
      if (reply?.error) return reply;
      if (task.kind === 'shell') setTimeout(() => api.task.say(task.id, value), 700);
      return reply;
    }
    // Typing into a question would answer it: it waits for you in the terminal.
    if (t.state === 'needs') return { error: t.need === 'asking' ? 'Claude asked you something first. Answer it in the terminal (Ctrl+`).' : 'Claude needs your permission first. Answer it in the terminal (Ctrl+`).' };
    await api.task.say(task.id, value);
    return { sent: true };
  }

  /** Esc, like in Claude Code (Ctrl+C for a shell); the daemon shows it stopped. */
  function stop(task) {
    if (task) api.task.stop(task.id);
  }

  /** Someone answered its question in the terminal (Katana pressed keys): back to work. */
  function answered(id) {
    api.task.answered(id);
  }

  function kill(id) {
    api.task.kill(id);
    const t = live.get(id);
    if (t) t.running = false;
  }

  return {
    get,
    /** Why it waits, in a few words ('' when it doesn't). */
    waiting(id) {
      const t = get(id);
      if (t.state !== 'needs') return '';
      return t.need === 'asking' ? 'Asking you' : 'Needs permission';
    },
    sync,
    load,
    start,
    send,
    stop,
    answered,
    kill,
    forget: (id) => live.delete(id),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
