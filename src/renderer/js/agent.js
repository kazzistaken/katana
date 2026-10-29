/**
 * Katana, as the window sees her. She lives in katanad, the background
 * daemon (src/daemon/agent.js), so she keeps working, reminding and
 * telling you things with no window open; this follows along: what she
 * says (kept in the store, for the screen), whether she's busy and with
 * what, and the answer to each thing you ask.
 *
 * Events (on): { type: 'busy' | 'activity' | 'reply', text?, kind? }.
 */

export function createAgent({ api, store }) {
  let status = { busy: false, since: 0, activity: '' };
  const asks = new Map(); // askId -> resolve
  const listeners = new Set();
  const emit = (type, extra = {}) =>
    listeners.forEach((fn) => {
      try {
        fn({ type, ...extra });
      } catch (error) {
        console.error('[agent] listener failed', error);
      }
    });

  api.agent.onBusy((next) => {
    const activityOnly = status.busy && next.busy && status.activity !== next.activity;
    status = { busy: Boolean(next.busy), since: next.since || 0, activity: next.activity || '' };
    emit(activityOnly ? 'activity' : 'busy');
  });
  api.agent.onMessage((message) => store.receiveAgentMessage(message));
  api.agent.onState((state) => store.setAgentState(state));
  api.agent.onReply(({ askId, reply, error, kind }) => {
    const resolve = asks.get(askId);
    if (resolve) {
      asks.delete(askId);
      resolve(error ? { error } : { reply: reply || '' });
    }
    if (!error && reply) emit('reply', { text: reply, kind });
  });
  // The daemon went away (it crashed, or was stopped): she isn't thinking, and no answer is coming.
  api.task.onLost?.(() => {
    for (const resolve of asks.values()) resolve({ error: 'Katana’s background process stopped.' });
    asks.clear();
    if (!status.busy) return;
    status = { busy: false, since: 0, activity: '' };
    emit('busy');
  });

  /** Catch up with her (on start, after a reload): the conversation, reminders, busy or not. */
  async function sync() {
    const state = await api.agent.state().catch(() => null);
    if (!state || state.error) return;
    store.setAgentState(state);
    status = { busy: Boolean(state.busy), since: state.since || 0, activity: state.activity || '' };
    emit('busy');
  }

  return {
    sync,
    /**
     * You wrote or said something: resolves with { reply } or { error }.
     * `kind` 'voice' for the live conversation; `log` false when it's
     * already in the conversation (what you said, heard as you said it).
     */
    ask(text, { kind = 'user', log = true } = {}) {
      const value = String(text || '').trim();
      if (!value) return Promise.resolve({ reply: '' });
      const askId = crypto.randomUUID();
      return new Promise((resolve) => {
        asks.set(askId, resolve);
        api.agent.ask({ text: value, kind, log, askId }).then((reply) => {
          if (reply?.error && asks.has(askId)) {
            asks.delete(askId);
            resolve({ error: reply.error });
          }
        });
      });
    },
    stop: () => api.agent.stop(),
    busy: () => status.busy,
    since: () => status.since,
    /** Which tool she's using right now ('' while she thinks). */
    activity: () => status.activity,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
