'use strict';

/**
 * A web page in the viewer (an HTML file, a browser game), shown by this
 * same program started again with XODE2_PAGE (main.js hands over to here):
 * one window, sandboxed like a browser tab, that appview.js streams like
 * any app. Errors are reported quietly, as the hook does (apphook.cjs).
 * Katana's pipe (XODE2_PAGE_PIPE) sends `load <file>` and `reload`.
 *
 * A page is anyone's code (and the scripts it loads from the web), so it
 * gets less than a browser tab would: it's served from its own folder
 * under its own address (pagefiles.js), never as file://, so it can't read
 * your other files; every permission is refused but the few a game needs;
 * it can't leave its folder or open windows (web links go to your browser).
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { PAGE_SCHEME, PAGE_PERMISSIONS, pageAddress, broadRoot, servedFile, parseRange, samePage, openable } = require('./pagefiles');

const { app, BrowserWindow, session, protocol, shell } = electron;

// Its own data (a page's storage), never Katana's.
app.setPath('userData', process.env.XODE2_PAGE_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'katana-page-')));
// The hook's reports and its quiet error dialogs: the same for a page.
const { report } = require('./apphook.cjs');

// The page's own address: a real origin (modules, fetch, storage, video seeking work), files from its folder only.
protocol.registerSchemesAsPrivileged([{ scheme: PAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let win = null;
let file = path.resolve(process.env.XODE2_PAGE || '');
/** What's served now: { root, host, broad }. */
let site = null;

function show(next) {
  file = path.resolve(next);
  const { root, host, url } = pageAddress(file);
  site = { root, host, broad: broadRoot(root) };
  win?.setTitle(path.basename(file));
  return win?.loadURL(url).catch(() => {});
}

/** A file of the page's, from its folder; anything else is refused (and reported, as a missing file would be). */
async function serve(request) {
  const here = site;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Bad address', { status: 400 });
  }
  if (!here || url.host !== here.host) return new Response('Not this page', { status: 403 });
  const found = await servedFile(here.root, url.pathname, { broad: here.broad });
  if (!found) {
    const name = decodeURIComponent(url.pathname.split('/').pop() || '') || url.pathname;
    if (name !== 'favicon.ico') report('load-failed', `Couldn’t load ${name}: not a file in the page’s folder`, request.url);
    return new Response('Not found', { status: 404 });
  }
  try {
    const from = pathToFileURL(found).href;
    const fetchFile = (headers) => electron.net.fetch(from, { method: request.method, headers, bypassCustomProtocolHandlers: true });
    // Video and audio seek with byte ranges: answered as a web server would (206), else they can't.
    const asked = request.headers.get('range');
    const size = asked ? (await fs.promises.stat(found)).size : 0;
    const range = asked ? parseRange(asked, size) : null;
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const headers = new Headers(request.headers);
    headers.delete('range');
    if (range) headers.set('range', `bytes=${range.start}-${range.end}`);
    const got = await fetchFile(headers);
    const out = new Headers(got.headers);
    out.set('Accept-Ranges', 'bytes');
    if (!range) return new Response(got.body, { status: got.status, headers: out });
    out.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    out.set('Content-Length', String(range.end - range.start + 1));
    return new Response(got.body, { status: 206, headers: out });
  } catch (error) {
    report('load-failed', `Couldn’t load ${path.basename(found)}: ${error.message}`, request.url);
    return new Response('Unreadable', { status: 500 });
  }
}

// A web link the page opens goes to your browser, not more often than once a second (a page can't flood it).
let lastOutside = 0;
function openOutside(url) {
  if (!openable(url) || Date.now() - lastOutside < 1000) return;
  lastOutside = Date.now();
  shell.openExternal(url).catch(() => {});
}

/** Every permission refused but a game's few; no devices; no file:// at all. */
function lockDown(ses) {
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(PAGE_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => PAGE_PERMISSIONS.has(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.protocol.handle('file', () => new Response('Not for pages', { status: 403 }));
}

app.whenReady().then(() => {
  const ses = session.fromPartition('katana-page');
  lockDown(ses);
  lockDown(session.defaultSession);
  ses.protocol.handle(PAGE_SCHEME, serve);
  // A page's own files that don't load (a missing image or script): Chromium doesn't
  // report those as page errors. (Only here: in your app this would replace its own listener.)
  ses.webRequest.onErrorOccurred((details) => {
    if (details.error !== 'net::ERR_ABORTED') report('load-failed', `${details.error} loading ${details.url.split(/[\\/]/).pop()}`, details.url);
  });
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: path.basename(file),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    // A page's fullscreen fills this window (the viewer's pane), never your screen.
    fullscreenable: false,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  const contents = win.webContents;
  // It stays on its own page (and its folder's others); web links go to your browser.
  const leave = (event, url) => {
    const to = event.url || url;
    if (samePage(to, site?.host)) return;
    event.preventDefault();
    openOutside(to);
  };
  contents.on('will-navigate', leave);
  contents.on('will-redirect', leave);
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
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
