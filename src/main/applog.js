'use strict';

/**
 * Errors in what an app running in the viewer prints (appview.js). The
 * hook (apphook.cjs) and the page host (pagehost.js) report theirs as a
 * marked line on stdout; anything else is read from stderr. Pure, so
 * scripts/test-apperrors.mjs checks it under Node.
 */

const MARK = '[katana:error] ';

/** A marked line as { kind, message, detail }, or null. */
function markedError(line) {
  const at = String(line).indexOf(MARK);
  if (at === -1) return null;
  try {
    const entry = JSON.parse(String(line).slice(at + MARK.length));
    return entry && entry.message ? { kind: String(entry.kind || 'error'), message: String(entry.message), detail: String(entry.detail || '') } : null;
  } catch {
    return null;
  }
}

// Chromium's own logging ([pid:tid:time:ERROR:file.cc(12)] …): about itself, not the app.
const CHROMIUM = /^\[\d+:\d+:[\d/.]+:(?:ERROR|WARNING|INFO|VERBOSE\d*|FATAL)[:\]]/;
const LOOKS_WRONG = /(?:error|exception)\b|\b(?:uncaught|traceback|fatal|unhandled|failed)\b/i;
// Warnings that mention errors (deprecations, security warnings) aren't errors.
const JUST_WARNING = /\b(?:deprecat\w*|warning|DeprecationWarning|ExperimentalWarning)\b/i;

/** An error-looking stderr line as an entry, or null (noise, warnings, blank). */
function stderrError(line) {
  const text = String(line).trim();
  if (!text || CHROMIUM.test(text) || !LOOKS_WRONG.test(text) || JUST_WARNING.test(text)) return null;
  return { kind: 'stderr', message: text.slice(0, 500), detail: '' };
}

/** It ended on its own with a failure code: a crash, with what it said last. */
function crashError(code, signal, lastLines = []) {
  if (code === 0 || (code == null && !signal)) return null;
  return { kind: 'crash', message: `It quit unexpectedly (${code != null ? `exit code ${code}` : signal}).`, detail: lastLines.slice(-12).join('\n') };
}

/**
 * Splits output into whole lines as it comes: `push(text)` → the complete
 * lines so far; the rest waits for its newline.
 */
function lineSplitter() {
  let rest = '';
  return (text) => {
    rest += text;
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    return lines;
  };
}

module.exports = { MARK, markedError, stderrError, crashError, lineSplitter };
