'use strict';

/**
 * Loaded into an Electron app running in Katana's viewer, before the app
 * itself (`electron -r apphook.cjs .`, appview.js). It never changes what
 * the app does, except that errors aren't shown: they're reported on
 * stdout as one marked line each (main applog.js reads them), quietly.
 *
 *   - uncaught exceptions and unhandled rejections in the main process
 *     (Electron would show its error dialog), and dialog.showErrorBox
 *   - console errors in any page, preload errors, failed loads
 *   - crashed or hung pages, crashed helper processes
 *
 * Self-contained: it's copied next to Katana's data and loaded from there.
 */

const MARK = '[katana:error] ';

function report(kind, message, detail = '') {
  try {
    process.stdout.write(`\n${MARK}${JSON.stringify({ kind, message: String(message ?? '').slice(0, 2000), detail: String(detail ?? '').slice(0, 4000) })}\n`);
  } catch {
    /* nowhere to say it */
  }
}

try {
  const { app, dialog } = require('electron');
  process.on('uncaughtException', (error) => report('uncaught', error?.message || error, error?.stack));
  process.on('unhandledRejection', (error) => report('unhandled-rejection', error?.message || error, error?.stack));
  dialog.showErrorBox = (title, content) => report('error-box', title || 'Error', content);

  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => {
      if (event.level === 'error') report('console', event.message, event.sourceId ? `${event.sourceId}:${event.lineNumber}` : '');
    });
    contents.on('preload-error', (_e, preloadPath, error) => report('preload', error?.message || error, `${preloadPath}\n${error?.stack || ''}`));
    contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is a load cut short by another (a redirect, a reload): not a failure.
      if (code !== -3) report('load-failed', `${description || 'Load failed'} (${code})${isMainFrame ? '' : ' in a frame'}`, url);
    });
    contents.on('render-process-gone', (_e, details) => report('crash', `The page's process ended: ${details.reason}`, `exit code ${details.exitCode}`));
    contents.on('unresponsive', () => report('hang', 'A page stopped responding.', contents.getURL()));
  });
  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && details.reason !== 'killed') report('crash', `${details.type} process ${details.reason}`, `exit code ${details.exitCode}`);
  });
} catch (error) {
  report('hook', `Katana's error hook couldn't load: ${error.message}`);
}

module.exports = { report };
