/**
 * The errors a task's app (or page) logged while it ran in the viewer:
 * kept quietly per task, never shown while you use it. Your next message
 * to that task asks first whether to have them fixed; yes attaches them
 * to the message, no drops them; either way the log is cleared.
 * No DOM here, so scripts/test-apperrors.mjs runs it under Node.
 */

export const MAX_ERRORS = 50;
const clip = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** The log with one more error: a repeat of the same one counts up instead. */
export function addError(log, entry) {
  const list = Array.isArray(log) ? log : [];
  const next = {
    kind: String(entry?.kind || 'error'),
    message: clip(entry?.message || 'Unknown error', 500),
    detail: clip(entry?.detail || '', 2000),
    at: Number(entry?.at) || Date.now(),
    count: 1,
  };
  const same = list.findIndex((e) => e.kind === next.kind && e.message === next.message);
  if (same !== -1) {
    const merged = { ...list[same], count: (list[same].count || 1) + 1, at: next.at, detail: list[same].detail || next.detail };
    return [...list.slice(0, same), merged, ...list.slice(same + 1)];
  }
  return [...list, next].slice(-MAX_ERRORS);
}

/** How many times anything went wrong (repeats included). */
export const errorCount = (log) => (Array.isArray(log) ? log.reduce((n, e) => n + (e.count || 1), 0) : 0);

const KIND_WORDS = {
  console: 'console error',
  uncaught: 'uncaught exception',
  'unhandled-rejection': 'unhandled promise rejection',
  'error-box': 'error dialog',
  'load-failed': 'failed load',
  preload: 'preload error',
  crash: 'crash',
  hang: 'hang',
  stderr: 'error output',
  'start-failed': 'failed start',
};

/** For the question: { count, title, lines } (the first few, short). */
export function summarize(log, { show = 3 } = {}) {
  const count = errorCount(log);
  const lines = (log || []).slice(0, show).map((e) => `${KIND_WORDS[e.kind] || e.kind}${e.count > 1 ? ` ×${e.count}` : ''}: ${clip(e.message.split('\n')[0], 90)}`);
  if ((log || []).length > show) lines.push(`and ${(log || []).length - show} more`);
  return { count, title: `The app logged ${count} error${count === 1 ? '' : 's'} while it ran. Fix ${count === 1 ? 'it' : 'them'} with this message?`, lines };
}

/** The errors as the agent reads them, after your message. */
export function errorsForPrompt(log) {
  const items = (log || []).map((e, i) => {
    const head = `${i + 1}. [${KIND_WORDS[e.kind] || e.kind}${e.count > 1 ? `, ×${e.count}` : ''}] ${e.message}`;
    return e.detail ? `${head}\n   ${e.detail.split('\n').slice(0, 12).join('\n   ')}` : head;
  });
  return `[App errors] While the app ran in Katana's viewer it logged these errors (the user didn't see them). Please fix them too:\n${items.join('\n')}`;
}

/**
 * Before a message goes to a task: with errors logged, ask (`ask(summary)`
 * resolves true or false). { text, clear }: the text to send, and whether
 * the log is handled (cleared) now.
 */
export async function askToFix(text, log, ask) {
  if (!errorCount(log)) return { text, clear: false };
  const yes = await ask(summarize(log));
  return { text: yes ? `${text}\n\n${errorsForPrompt(log)}` : text, clear: true };
}
