'use strict';

/**
 * Katana — main process.
 *
 * One window. Each task is a real terminal session, run by katanad (the
 * background daemon, src/daemon) so the window can reload or close: interactive
 * Claude Code, Codex or a shell, only ever in folders the user trusted.
 * Katana, the agent above them, lives in katanad too (she works with no
 * window open); this process relays between her and the window, which
 * carries out her tool calls while it's open.
 */

// Started again to show a web page in the app viewer: only that (pagehost.js).
if (process.env.XODE2_PAGE) {
  require('./pagehost');
  return;
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell, screen, clipboard } = require('electron');
const { resolveClaude, existsInPath } = require('./claude');
const { codexModels } = require('./codex');
const { shellsFrom } = require('./shells');
const { createDaemonClient, inProcess } = require('./daemonclient');
const worktree = require('./worktree');
const { createVoice } = require('./voice');
const { runGuard } = require('./runargs');
const { readStateFile, loadStateFile, writeStateFileAsync, stateWriting, stateWritesDone, setAsideBad } = require('./statefile');
const { createKeyStore } = require('./keystore');
const { createTranscriber } = require('./transcribe');
const { createCanary } = require('./canary');
const { createPreview } = require('./preview');
const { createSlashCommands } = require('./slashcommands');
const { createOpenRouter } = require('./openrouter');
const { createAppView } = require('./appview');
const { createPlanUsage } = require('./planusage');

// Her data stays where it has always been (%APPDATA%\xodecode-v2: settings,
// tasks, conversations, keys), though the app is now called Katana: without
// this, Electron would move to a new, empty folder named after the app.
const DATA_FOLDER = 'xodecode-v2';
if (process.env.XODE2_USERDATA) app.setPath('userData', process.env.XODE2_USERDATA);
else app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER));

// Test mode from the environment, or from flags (`npm start -- --xode2-test`, for launchers that can't set it).
const flag = (name) => {
  const arg = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] || '1' : '';
};
// Set for everything this starts, as the environment would be.
if (!process.env.XODE2_TEST && flag('xode2-test')) process.env.XODE2_TEST = flag('xode2-test');
const TEST = process.env.XODE2_TEST || '';
const DEVPAGE = process.env.XODE2_DEVPAGE || flag('xode2-devpage');
// A look test that may start real (small) Claude runs: XODE2_LIVE=1, only when asked for.
const BLOCK_RUNS = Boolean(TEST) && process.env.XODE2_LIVE !== '1';

/** @type {BrowserWindow | null} */
let mainWindow = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0c0c0c',
    title: 'Katana',
    icon: path.join(__dirname, '..', '..', 'assets', 'katana.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.removeMenu();
  // The window (and its preload) never leaves Katana's own page: no new windows, no
  // navigating away (a link, a dropped file); web links open in your browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  // F5 anywhere (even inside the terminal): reload with the latest code.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5' && !input.control && !input.alt && !input.meta) {
      event.preventDefault();
      reloadApp();
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // The page going (reload, crash, close): her tool calls stop waiting on it (see pageGone).
  mainWindow.webContents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    if ((details?.isMainFrame ?? isMainFrame) && !(details?.isSameDocument ?? isInPlace)) pageGone();
  });
  mainWindow.webContents.on('render-process-gone', () => pageGone());
  mainWindow.on('closed', () => {
    mainWindow = null;
    pageGone();
  });
  // A test run may open one of the renderer's dev pages instead (XODE2_DEVPAGE=<name> opens <name>.html).
  const page = TEST && /^[\w-]+$/.test(DEVPAGE) ? `${DEVPAGE}.html` : 'index.html';
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', page));

  if (TEST === 'look') {
    const { runLookTest } = require('./looktest');
    mainWindow.webContents.once('did-finish-load', () => runLookTest(mainWindow));
  }
}

/* ------------------------------ window ------------------------------ */

// F11 anywhere: true fullscreen (whole screen, over the taskbar) and back to
// the same size and place. Caught before any page sees it, in every web
// contents (the window, and any viewer inside it), so focus doesn't matter.
// Esc isn't used: the terminal, dialogs and voice already need it.
let lastFullScreenToggle = 0;
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.control || input.alt || input.meta || input.shift) return;
    event.preventDefault();
    // One press can reach a viewer and the window both: toggle once.
    if (input.isAutoRepeat || Date.now() - lastFullScreenToggle < 150 || !mainWindow) return;
    lastFullScreenToggle = Date.now();
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
});

ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  else if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow?.close());
// Her name was heard: the window comes up (from the taskbar, or behind other apps).
ipcMain.on('win:show', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

/* ------------------------------ state ------------------------------- */

const stateFile = () => path.join(app.getPath('userData'), 'state.json');

const readState = () => readStateFile(stateFile());

/*
 * Who writes state.json: the page while it's open, katanad (headless.js)
 * otherwise. The page takes over as it loads the state (katanad first
 * finishes its calls that change it) and gives it up as it reloads,
 * crashes or closes. Her tool calls go to the page only once it says it's
 * ready for them (tools:ready); ones that come while it loads wait here.
 */
let stateBlocked = false; // state.json and its .bak unreadable: nothing is saved over them until the user starts fresh
let pageTakesCalls = false;
let heldCalls = [];

function pageGone() {
  pageTakesCalls = false;
  heldCalls = [];
  // Once its last save (as it unloaded) is on disk: katanad reads the state from then on.
  stateWritesDone(stateFile()).finally(() => daemon.notify('windowReady', false));
}

ipcMain.handle('state:load', async () => {
  // (A reload: the page before it saved as it went; that write lands first.)
  await stateWritesDone(stateFile());
  await toDaemon('windowReady', true);
  const loaded = loadStateFile(stateFile());
  stateBlocked = Boolean(loaded.error);
  if (loaded.error) return { stateUnreadable: { message: loaded.error, file: stateFile() } };
  if (loaded.from === 'backup') console.log('[state] state.json could not be read; state.json.bak was loaded instead');
  return loaded.state;
});

ipcMain.handle('state:save', async (_event, state) => {
  if (stateBlocked) return { error: 'The saved state can’t be read, so it isn’t written over until you choose to start fresh.' };
  // Written beside it (flushed to disk), then swapped in: a crash mid-write can't corrupt it.
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return writeStateFileAsync(file, state);
});

// Start fresh after an unreadable state: that file is kept beside it, renamed (its new name).
ipcMain.handle('state:reset', () => {
  const kept = setAsideBad(stateFile());
  stateBlocked = false;
  return { kept };
});

ipcMain.on('tools:ready', () => {
  pageTakesCalls = true;
  const held = heldCalls;
  heldCalls = [];
  for (const call of held) send('tools:call', call);
});

// A save still being written finishes before the app quits.
let savedBeforeQuit = false;
app.on('will-quit', (event) => {
  if (savedBeforeQuit || !stateWriting(stateFile())) return;
  event.preventDefault();
  savedBeforeQuit = true;
  stateWritesDone(stateFile()).finally(() => app.quit());
});

/* ----------------------------- folders ------------------------------- */

// Choosing a folder here is what trusts it, so the picker says so.
ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Trust this folder',
    buttonLabel: 'Trust this folder',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

// Katana asked to trust a folder: the user says yes here, not her.
ipcMain.handle('folder:confirm', async (_event, folder) => {
  const value = String(folder || '');
  try {
    if (!fs.statSync(value).isDirectory()) return false;
  } catch {
    return false;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Trust this folder?',
    message: 'Katana wants to add this folder',
    detail: `${value}\n\nTasks will be able to read, change and run anything in it.`,
    buttons: ['Trust this folder', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
});

ipcMain.handle('folder:exists', (_event, folder) => {
  try {
    return fs.statSync(String(folder)).isDirectory();
  } catch {
    return false;
  }
});

ipcMain.handle('sys:claude', () => Boolean(resolveClaude()));
// The plan's live 5-hour and weekly use (what /usage shows); the token stays in main.
const planUsage = createPlanUsage();
ipcMain.handle('sys:plan-usage', () => planUsage.read());
ipcMain.handle('sys:info', () => ({
  version: app.getVersion(),
  claude: resolveClaude()?.file || '',
  dataDir: app.getPath('userData'),
  computer: os.hostname(),
  user: (() => {
    try {
      return os.userInfo().username;
    } catch {
      return '';
    }
  })(),
  system: `${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'} ${os.release()}`,
}));

// Settings → Your turn: start with Windows, so a finished task can always reach you.
ipcMain.handle('app:login', (_event, on) => {
  const options = { openAtLogin: Boolean(on) };
  // Run from source (npm start): Windows starts Electron with this app's folder.
  if (!app.isPackaged) Object.assign(options, { path: process.execPath, args: [app.getAppPath()] });
  app.setLoginItemSettings(options);
  return app.getLoginItemSettings(options).openAtLogin;
});

/* ------------------------------- files ------------------------------- */

// Files a reply names or a worker wrote, shown as chips: HTML opens in the
// app's viewer, media plays inline. Only these kinds are ever opened.
const VIEWABLE = /\.(html?|svg|png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|flac|pdf|md|markdown|txt)$/i;

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { path: file, name: path.basename(file), size: stat.size } : null;
  } catch {
    return null;
  }
}

/**
 * A page that's part of an app (Electron, Node, a bundler): a package.json
 * beside it or in a folder above it, up to the task's folder. Such a page
 * can't be opened by itself, so it isn't offered as one.
 */
function inApp(file, base) {
  const top = base ? path.resolve(String(base)).toLowerCase() : '';
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return true;
    const up = path.dirname(dir);
    if (!top || up === dir || !dir.toLowerCase().startsWith(top) || dir.toLowerCase() === top) return false;
    dir = up;
  }
}

ipcMain.handle('file:stat', (_event, { paths = [], base = '' } = {}) => {
  const seen = new Set();
  const found = [];
  for (const raw of paths.slice(0, 40)) {
    const value = String(raw || '').trim();
    if (!VIEWABLE.test(value)) continue;
    const full = path.isAbsolute(value) ? path.normalize(value) : base ? path.resolve(String(base), value) : '';
    if (!full || seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    const info = fileInfo(full);
    if (info && /\.html?$/i.test(full)) info.app = inApp(full, base);
    if (info) found.push(info);
  }
  return found;
});

// Opens in the default app (a browser for HTML), never anything runnable.
ipcMain.handle('file:open', (_event, file) => {
  const value = String(file || '');
  if (!VIEWABLE.test(value) || !fileInfo(value)) return false;
  return shell.openPath(value).then((error) => !error);
});

// A document's words (Markdown, text) for the viewer to lay out itself.
const READABLE = /\.(md|markdown|txt)$/i;
ipcMain.handle('file:read', (_event, file) => {
  const value = String(file || '');
  const info = READABLE.test(value) ? fileInfo(value) : null;
  if (!info || info.size > 2_000_000) return null;
  return fs.readFileSync(value, 'utf8');
});

// A picture pasted or dropped into the prompt bar, kept where Claude can read
// it: the message carries its path. (Folder name matched by transcript.js.)
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
ipcMain.handle('image:save', (_event, { type = '', bytes } = {}) => {
  const ext = IMAGE_EXT[String(type)];
  if (!ext || !bytes || bytes.byteLength > 30_000_000) return null;
  const folder = path.join(app.getPath('userData'), 'xode-images');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});

// Your own backgrounds: a picture you choose, copied into the app's data folder
// (it keeps working if the original moves). { id, name, file } or null.
const BACKGROUND_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const backgroundsDir = () => path.join(app.getPath('userData'), 'backgrounds');
const BACKGROUND_MAX = 60_000_000;
const BACKGROUND_TOO_BIG = 'That picture is too big (60 MB at most).';
function keepBackground(fileName, ext, write) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(backgroundsDir(), { recursive: true });
  const file = path.join(backgroundsDir(), `${id}${ext}`);
  write(file);
  const name = path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, ' ').trim().slice(0, 40) || 'My background';
  return { id, name, file };
}
ipcMain.handle('background:add', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add a background',
    buttonLabel: 'Add background',
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
  });
  const source = result.canceled ? '' : result.filePaths[0] || '';
  if (!source || !BACKGROUND_EXT.test(source)) return null;
  const info = fileInfo(source);
  if (!info || info.size > BACKGROUND_MAX) return { error: BACKGROUND_TOO_BIG };
  return keepBackground(source, path.extname(source).toLowerCase(), (file) => fs.copyFileSync(source, file));
});

// A picture dropped on Settings, as its bytes (it may not be a file on disk: dragged from a browser).
const BACKGROUND_TYPE = { ...IMAGE_EXT, 'image/bmp': 'bmp', 'image/avif': 'avif' };
ipcMain.handle('background:save', (_event, { name = '', type = '', bytes } = {}) => {
  const fileName = path.basename(String(name));
  const ext = BACKGROUND_EXT.test(fileName) ? path.extname(fileName).toLowerCase() : BACKGROUND_TYPE[String(type)] ? `.${BACKGROUND_TYPE[String(type)]}` : '';
  if (!ext || !bytes) return { error: `${fileName || 'That'} isn’t a picture Katana can use.` };
  if (bytes.byteLength > BACKGROUND_MAX) return { error: BACKGROUND_TOO_BIG };
  return keepBackground(fileName, ext, (file) => fs.writeFileSync(file, Buffer.from(bytes)));
});

// Removing one deletes its copy (only ever a file in the backgrounds folder).
ipcMain.handle('background:remove', (_event, file) => {
  const target = path.resolve(String(file || ''));
  if (path.dirname(target).toLowerCase() !== path.resolve(backgroundsDir()).toLowerCase()) return false;
  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('file:reveal', (_event, file) => {
  if (!fileInfo(String(file || ''))) return false;
  shell.showItemInFolder(String(file));
  return true;
});

// Copy: a document's words (Markdown, text) onto the clipboard.
ipcMain.handle('file:copy', (_event, file) => {
  const value = String(file || '');
  const info = READABLE.test(value) ? fileInfo(value) : null;
  if (!info || info.size > 2_000_000) return false;
  clipboard.writeText(fs.readFileSync(value, 'utf8'));
  return true;
});

// Download: a copy of the file, saved where you pick (Downloads to start with).
ipcMain.handle('file:save', async (event, file) => {
  const value = String(file || '');
  const info = VIEWABLE.test(value) ? fileInfo(value) : null;
  if (!info) return false;
  const owner = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(owner, { defaultPath: path.join(app.getPath('downloads'), info.name) });
  if (canceled || !filePath) return false;
  if (path.resolve(filePath).toLowerCase() !== path.resolve(value).toLowerCase()) await fs.promises.copyFile(value, filePath);
  return true;
});

// Download: words from the page (a text box in a chat) as a new file, saved where you pick.
ipcMain.handle('file:saveText', async (event, { name, text } = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    defaultPath: path.join(app.getPath('downloads'), path.basename(String(name || 'text.md'))),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return false;
  await fs.promises.writeFile(filePath, String(text ?? ''));
  return true;
});

// What a web page is made of: when one of these changes beside it, it reloads.
const PAGE_PART = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|wasm|mp3|wav|mp4|webm)$/i;
const NOT_PAGE = /(^|[\\/])(node_modules|\.git|\.xode)([\\/]|$)/;

// The file in the viewer, watched: when an agent changes it, the view reloads.
// A page is watched with its whole folder (its styles, scripts and images).
let watched = null;
ipcMain.handle('file:watch', (_event, file) => {
  watched?.close();
  watched = null;
  const value = String(file || '');
  if (!value || !fileInfo(value)) return false;
  let timer = 0;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => send('file:changed', value), 250);
  };
  try {
    if (/\.html?$/i.test(value)) {
      const folder = path.dirname(value);
      // Not a whole drive or home folder: too much to watch.
      const tooBig = folder === path.parse(folder).root || path.resolve(folder) === path.resolve(os.homedir());
      watched = fs.watch(folder, { recursive: !tooBig }, (_type, name) => {
        if (name && PAGE_PART.test(name) && !NOT_PAGE.test(name)) changed();
      });
    } else {
      watched = fs.watch(value, changed);
    }
  } catch {
    return false;
  }
  return true;
});


/* ------------------------------- tasks -------------------------------- */

let shellList = null;
const shells = () => (shellList = shellList || shellsFrom(existsInPath));

// The tasks live in katanad (src/daemon), not here: reloading or closing the
// window leaves them running. Test runs keep them in this process (unless
// XODE2_DAEMON=1, to try the daemon itself).
const daemonOptions = {
  userDataDir: app.getPath('userData'),
  onEvent(channel, payload) {
    if (channel === 'daemon:lost') {
      send('task:lost', {});
      // A new daemon doesn't know the page is ready: it's told (which reconnects).
      if (pageTakesCalls) setTimeout(() => pageTakesCalls && toDaemon('windowReady', true), 500);
    } else if (channel === 'tools:call' && !pageTakesCalls) heldCalls.push(payload);
    else send(channel, payload);
  },
  log: (...parts) => console.log('[katanad]', ...parts),
};
const daemon = TEST && process.env.XODE2_DAEMON !== '1' ? inProcess({ ...daemonOptions, block: BLOCK_RUNS }) : createDaemonClient(daemonOptions);
// A task call that couldn't reach the daemon says why, instead of throwing.
const toDaemon = (method, ...params) => daemon.call(method, ...params).catch((error) => ({ error: error.message }));

// How a Claude task runs: 'single', 'hierarchy' (a team) or 'subagents' (one session delegating to its sub-agents).
const modeOf = (mode) => (mode === 'hierarchy' || mode === 'subagents' ? mode : 'single');
ipcMain.handle('task:start', (_event, options = {}) => {
  // (A stress run's Claude tasks are scripts/fake-claude.cjs: those may start.)
  if (BLOCK_RUNS && !(process.env.XODE2_FAKE_CLAUDE && (options.kind || 'claude') === 'claude')) return { error: 'Tasks don’t start in test runs' };
  // Only in a trusted folder: checked here and again in the daemon.
  const trusted = (readState()?.projects || []).map((project) => project.path);
  const refused = runGuard({ role: 'task', cwd: options.cwd }, trusted);
  if (refused) return { error: refused };
  return toDaemon('start', {
    id: String(options.id || ''),
    kind: ['claude', 'codex', 'shell'].includes(options.kind) ? options.kind : 'claude',
    cwd: options.cwd,
    sessionId: options.sessionId || '',
    resume: Boolean(options.resume),
    // A branch: the session whose conversation it starts from.
    forkFrom: String(options.forkFrom || ''),
    model: options.model || '',
    effort: options.effort || '',
    bypass: readState()?.settings?.bypassPermissions !== false,
    prompt: String(options.prompt || ''),
    // Hierarchy mode: this session leads a team (daemon/team.js); sub-agents: it delegates to its own (runargs.js).
    mode: modeOf(options.mode),
    title: String(options.title || ''),
    cols: options.cols,
    rows: options.rows,
  });
});
ipcMain.handle('task:say', (_event, { id, text } = {}) => toDaemon('say', String(id), text));
ipcMain.on('task:write', (_event, { id, data } = {}) => daemon.notify('write', String(id), data));
ipcMain.on('task:resize', (_event, { id, cols, rows } = {}) => daemon.notify('resize', String(id), cols, rows));
ipcMain.handle('task:stop', (_event, id) => toDaemon('stop', String(id)));
ipcMain.handle('task:answered', (_event, id) => toDaemon('answered', String(id)));
ipcMain.handle('task:kill', (_event, id) => toDaemon('kill', String(id)));
ipcMain.handle('task:tail', (_event, id) => toDaemon('tail', String(id)).then((tail) => (typeof tail === 'string' ? tail : '')));
// A terminal opened on a task: its output (task:data) comes to the window from now on, and what it printed so far.
// (A daemon still running older code has no watch: it sends every task's output anyway; its tail, then.)
ipcMain.handle('task:watch', (_event, id) =>
  daemon
    .watch(String(id))
    .catch(() => toDaemon('tail', String(id)))
    .then((tail) => (typeof tail === 'string' ? tail : ''))
);
ipcMain.on('task:unwatch', (_event, id) => daemon.unwatch(String(id)));
ipcMain.handle('task:running', () => toDaemon('running').then((ids) => (Array.isArray(ids) ? ids : [])));
ipcMain.handle('task:snapshot', () => toDaemon('snapshot').then((list) => (Array.isArray(list) ? list : [])));
ipcMain.handle('task:quiet', (_event, id) => toDaemon('quiet', String(id)));
// Hierarchy mode: every team as drawn, switching a task's mode, and ending a team's sessions.
ipcMain.handle('team:snapshot', () => toDaemon('teamSnapshot').then((list) => (Array.isArray(list) ? list : [])));
ipcMain.handle('team:mode', (_event, { id, mode } = {}) => toDaemon('teamMode', String(id), modeOf(mode)));
ipcMain.handle('team:stop', (_event, { id, forget } = {}) => toDaemon('teamStop', String(id), Boolean(forget)));
ipcMain.handle('task:history', (_event, { cwd, sessionId, kind, id } = {}) => toDaemon('history', String(cwd || ''), String(sessionId || ''), kind === 'codex' ? 'codex' : 'claude', String(id || '')).then((lines) => (Array.isArray(lines) ? lines : [])));
// Settings → About: the background process, and stopping every task in it.
ipcMain.handle('daemon:status', async () => {
  const status = await toDaemon('status');
  return status?.error ? status : { ...status, stale: daemon.stale() };
});
ipcMain.handle('daemon:stop-all', () => toDaemon('killAll'));

/* ------------------------------- Katana -------------------------------- */

// She lives in katanad; the window talks to her through these.
ipcMain.handle('agent:ask', (_event, options = {}) => toDaemon('agentAsk', options));
ipcMain.handle('agent:stop', () => toDaemon('agentStop'));
ipcMain.handle('agent:say', (_event, { role, text, extra } = {}) => toDaemon('agentSay', role, text, extra));
ipcMain.handle('agent:remind', (_event, { minutes, text } = {}) => toDaemon('agentRemind', minutes, text));
ipcMain.handle('agent:watch', (_event, { every, check, hours } = {}) => toDaemon('agentWatch', every, check, hours));
ipcMain.handle('agent:drop', (_event, id) => toDaemon('agentDrop', id));
ipcMain.handle('agent:state', () => toDaemon('agentState'));
ipcMain.on('agent:screen', (_event, shown) => daemon.notify('screen', shown));
// The window carried out one of her tool calls.
ipcMain.on('tools:result', (_event, { callId, result, error } = {}) => daemon.notify('toolResult', callId, result, error));
// What's installed; with Codex, the models it offers (its own cache).
ipcMain.handle('sys:found', () => {
  const codex = Boolean(existsInPath('codex'));
  return { claude: Boolean(resolveClaude()), codex, codexModels: codex ? codexModels() : [] };
});

/* ----------------------------- worktrees ------------------------------ */

const inTrusted = (folder) => !runGuard({ role: 'task', cwd: folder }, (readState()?.projects || []).map((project) => project.path));

ipcMain.handle('worktree:create', (_event, { project, title } = {}) =>
  inTrusted(project) ? worktree.create(String(project), String(title || '')) : { error: 'Not a trusted folder.' }
);
ipcMain.handle('worktree:merge', (_event, { tree, message } = {}) =>
  tree && inTrusted(tree.top) ? worktree.merge(tree, String(message || '')) : { error: 'Not a trusted folder.' }
);
ipcMain.handle('worktree:discard', (_event, { tree } = {}) => (tree && inTrusted(tree.top) ? worktree.discard(tree) : { error: 'Not a trusted folder.' }));
// A deleted task's worktree (or a removed project's): the project may already be untrusted by now, so worktree.cleanup itself only touches <top>/.xode/worktrees/* and xode/* branches.
ipcMain.handle('worktree:cleanup', (_event, { tree } = {}) => worktree.cleanup(tree));
ipcMain.handle('worktree:changes', (_event, { tree } = {}) => (tree && inTrusted(tree.top) ? worktree.changes(tree) : { error: 'Not a trusted folder.' }));

/* ----------------------------- app viewer ----------------------------- */

// Your app, run from a task's folder and shown in the pane. Only in a trusted folder.
const appView = createAppView({
  send,
  mainWindow: () => mainWindow,
  screen,
  trusted: inTrusted,
  // Run from source, this is Electron itself: a folder with no Electron of its own can use it.
  // Pages are shown by this program started again: its code, when run from source.
  exe: process.execPath,
  appPath: app.isPackaged ? '' : app.getAppPath(),
  userDataDir: () => app.getPath('userData'),
  log: (...parts) => console.log(...parts),
});
ipcMain.handle('app:start', (_event, { taskId, cwd, page } = {}) =>
  appView.start({ taskId, cwd: String(cwd || ''), page: String(page || '') })
);
ipcMain.handle('app:reload', (_event, taskId) => appView.reload(taskId));
// An agent testing the app: what it looks like, and its hands.
ipcMain.handle('app:screenshot', (_event, taskId) => appView.screenshot(taskId));
ipcMain.handle('app:click', (_event, { taskId, ...options } = {}) => appView.click(taskId, options));
ipcMain.handle('app:keys', (_event, { taskId, keys } = {}) => appView.keys(taskId, keys));
ipcMain.handle('app:type', (_event, { taskId, text } = {}) => appView.type(taskId, String(text ?? '')));
ipcMain.handle('app:scroll', (_event, { taskId, ...options } = {}) => appView.scroll(taskId, options));
ipcMain.handle('app:stop', (_event, taskId) => appView.stop(taskId));
ipcMain.handle('app:restart', (_event, taskId) => appView.restart(taskId));
ipcMain.handle('app:state', (_event, taskId) => appView.state(taskId));
ipcMain.handle('app:output', (_event, taskId) => appView.output(taskId));
ipcMain.handle('app:select', (_event, { taskId, hwnd } = {}) => appView.select({ taskId, hwnd: Number(hwnd) }));
ipcMain.handle('app:popout', (_event, taskId) => appView.popout(taskId));
ipcMain.handle('app:drop', (_event, taskId) => appView.drop(taskId));
ipcMain.on('app:pane', (_event, size) => appView.pane(size || {}));
ipcMain.on('app:input', (_event, { taskId, hwnd, events } = {}) => appView.input({ taskId, hwnd: Number(hwnd), events: Array.isArray(events) ? events : [] }));
// However Katana ends (closed, relaunched, quit), the apps end with it.
app.on('will-quit', () => {
  appView.killAll();
  canary.stop();
});
process.on('exit', () => appView.killAll());

/* ------------------------------- voice -------------------------------- */

const voice = createVoice({ userDataDir: () => app.getPath('userData'), send, existsInPath });
// The OpenAI key, for dictation: it stays in this process; the window only learns whether there is one.
const openai = createKeyStore({ userDataDir: () => app.getPath('userData'), name: 'openai', env: 'OPENAI_API_KEY' });
const transcriber = createTranscriber({ apiKey: () => openai.get(), send, log: (...parts) => console.log('[dictation]', ...parts) });
const openrouter = createOpenRouter({ userDataDir: () => app.getPath('userData') });

const canary = createCanary({ log: (...parts) => console.log('[dictation]', ...parts) });
// Canary hears a phrase after you pause: this keeps rough words, unseen, should hearing a phrase fail.
const preview = createPreview({ userDataDir: () => app.getPath('userData'), send, log: (...parts) => console.log('[dictation]', ...parts) });
// (It costs nothing and stays on this PC, but a test run still has to ask: XODE2_CANARY=1.)
const canaryAllowed = () => (!BLOCK_RUNS || process.env.XODE2_CANARY === '1') && canary.usable();
let canaryFailureSaid = '';

// Dictation: Canary on this PC when it's set up; else Deepgram, OpenAI or OpenRouter, the first whose key is set; else Windows' own engine.
ipcMain.handle('voice:start', async () => {
  if (canaryAllowed()) {
    const loading = !canary.isUp();
    canary.start().then((reply) => {
      if (!reply.ok) send('voice:error', `${reply.error} Using another engine next time.`);
    });
    preview.start();
    return { ok: true, canary: true, ...(loading ? { notice: 'Loading Canary. What you say now is heard once it’s up.' } : {}) };
  }
  const fellBack = canary.why();
  if (fellBack && fellBack !== canaryFailureSaid) {
    canaryFailureSaid = fellBack;
    send('voice:error', `Canary isn’t available (${fellBack}). Using another engine.`);
  }
  if (BLOCK_RUNS || voice.hasDeepgram()) return voice.start();
  if (openai.has()) {
    const reply = await transcriber.start();
    if (reply.ok) return { ok: true, openai: true };
    // OpenAI unreachable: the next one, and say why.
    if (openrouter.hasKey()) return { ok: true, openrouter: true, notice: `${reply.error} Using OpenRouter instead.` };
    const fallback = await voice.start();
    return { ...fallback, notice: `${reply.error} Using Windows’ speech engine instead.` };
  }
  if (openrouter.hasKey()) return { ok: true, openrouter: true };
  return voice.start();
});
// OpenRouter: a spoken phrase as text.
ipcMain.handle('voice:clip', (_event, wav) => (BLOCK_RUNS ? { error: 'Off in test runs' } : openrouter.transcribe(wav)));
// It takes minutes to load: started in the background once the app is open, ready when you first dictate.
app.whenReady().then(() =>
  setTimeout(() => {
    if (!canaryAllowed()) return;
    canary.start();
    preview.prepare();
  }, 5000)
);
ipcMain.handle('voice:canary', (_event, wav) => (canaryAllowed() || canary.loaded() ? canary.transcribe(wav) : { error: 'Canary isn’t available.' }));
ipcMain.handle('openai:has-key', () => openai.has());
ipcMain.handle('openai:set-key', (_event, key) => openai.set(key));
ipcMain.handle('openrouter:has-key', () => openrouter.hasKey());
ipcMain.handle('openrouter:set-key', (_event, key) => openrouter.setKey(key));
ipcMain.on('voice:audio', (_event, audio) => transcriber.append(String(audio || '')));
ipcMain.on('voice:commit', () => transcriber.commit());
ipcMain.handle('voice:stop', async () => {
  voice.stop();
  preview.stop();
  // The last phrase comes back before it says it stopped.
  await transcriber.stop();
  send('voice:state', 'stopped');
  return true;
});

ipcMain.handle('shells:list', () => shells().map(({ id, label }) => ({ id, label })));
// Your own Claude Code commands and skills, for the / menu.
const ownCommands = createSlashCommands();
ipcMain.handle('commands:list', (_event, cwd) => ownCommands(String(cwd || '')));

/** Once at startup: `git worktree prune` in each project's repo, and sweep leftover worktree folders no saved task uses. */
async function tidyWorktrees() {
  const state = readState();
  if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.projects)) return;
  const keep = state.tasks.map((task) => task?.worktree?.path).filter(Boolean);
  for (const project of state.projects) await worktree.pruneStale(String(project?.path || ''), keep);
}

app.whenReady().then(() => {
  tidyWorktrees().catch((error) => console.log('[worktrees]', error.message));
  daemon.connect().catch((error) => console.log('[katanad]', error.message));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* ------------------------------ reload ------------------------------- */

const STARTED = Date.now();

/** Whether this process's own code (src/main) changed since it started. */
function mainCodeChanged() {
  try {
    return fs
      .readdirSync(__dirname)
      .some((name) => name.endsWith('.js') && fs.statSync(path.join(__dirname, name)).mtimeMs > STARTED);
  } catch {
    return false;
  }
}

/**
 * Reload with the latest code. Tasks and Katana live in katanad and carry
 * on; what belongs to the page (dictation) ends first. The page is
 * reloaded; if the main process's own code changed too, the whole app
 * restarts instead, since a reload can't pick that up.
 */
function reloadApp() {
  voice.stop();
  // The page that showed them is going: what's in the browser ends too.
  appView.killAll();
  transcriber.stop();
  if (mainCodeChanged()) {
    app.relaunch();
    app.exit(0);
    return;
  }
  mainWindow?.webContents.reloadIgnoringCache();
}

// Closing the window leaves the tasks and Katana running in katanad (in a test run they end).
app.on('window-all-closed', () => {
  appView.killAll();
  daemon.close();
  voice.stop();
  transcriber.stop();
  app.quit();
});

module.exports = { send, TEST };
