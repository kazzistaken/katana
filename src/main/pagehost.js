'use strict';

/**
 * A web page in the viewer (an HTML file, a browser game), shown by this
 * same program started again with XODE2_PAGE (main.js hands over to here):
 * one window, sandboxed like a browser tab, that appview.js streams like
 * any app. Errors are reported quietly, as the hook does (apphook.cjs).
 * Katana's pipe (XODE2_PAGE_PIPE) sends `load <file>` and `reload`.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

// Its own data (a page's storage), never Katana's.
app.setPath('userData', process.env.XODE2_PAGE_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'katana-page-')));
// The hook's reports and its quiet error dialogs: the same for a page.
const { report } = require('./apphook.cjs');

let win = null;
let file = path.resolve(process.env.XODE2_PAGE || '');

function show(next) {
  file = path.resolve(next);
  win?.setTitle(path.basename(file));
  return win?.loadFile(file).catch(() => {});
}

app.whenReady().then(() => {
  // A page's own files that don't load (a missing image or script): Chromium doesn't
  // report those as page errors. (Only here: in your app this would replace its own listener.)
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    if (details.error !== 'net::ERR_ABORTED') report('load-failed', `${details.error} loading ${details.url.split(/[\\/]/).pop()}`, details.url);
  });
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: path.basename(file),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  show(file);

  // Katana's word (a local pipe; stdin doesn't stay open in Electron here).
  if (!process.env.XODE2_PAGE_PIPE) return;
  const link = net.connect(process.env.XODE2_PAGE_PIPE);
  let rest = '';
  link.setEncoding('utf8');
  link.on('data', (chunk) => {
    rest += chunk;
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) {
      if (line === 'reload') win?.webContents.reloadIgnoringCache();
      else if (line.startsWith('load ')) show(line.slice(5));
    }
  });
  // Katana gone: so is the page.
  link.on('close', () => app.quit());
  link.on('error', () => {});
});

app.on('window-all-closed', () => app.quit());
