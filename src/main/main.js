'use strict';

/**
 * Katana — main process.
 *
 * One window. Each task is a real terminal session, run by katanad (the
 * background daemon, src/daemon) so the window can reload or close: interactive
 * Claude Code, Codex or a shell, only ever in folders the user trusted.
 * Katana, the agent above them, lives in katanad too (she works with no
 * window open); this process relays between her and the window, which
 * carries out her tool calls while it's open. GPT-Live (live.js) can be
 * her voice: it listens and speaks, and hands anything to do to her.
 */

// Started again to show a web page in the app viewer: only that (pagehost.js).
if (process.env.XODE2_PAGE) {
  require('./pagehost');
  return;
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { resolveClaude, existsInPath } = require('./claude');
const { shellsFrom } = require('./shells');
const { createDaemonClient, inProcess } = require('./daemonclient');
const worktree = require('./worktree');
const { createVoice } = require('./voice');
const { runGuard } = require('./runargs');
const { readStateFile } = require('./statefile');
const { createLive } = require('./live');
const { createTranscriber } = require('./transcribe');
const { createOpenRouter } = require('./openrouter');
const { createElevenLabs } = require('./elevenlabs');
const { createAppView } = require('./appview');
const { createPlanUsage } = require('./planusage');

// Her data stays where it has always been (%APPDATA%\xodecode-v2: settings,
// tasks, conversations, keys), though the app is now called Katana: without
// this, Electron would move to a new, empty folder named after the app.
const DATA_FOLDER = 'xodecode-v2';
if (process.env.XODE2_USERDATA) app.setPath('userData', process.env.XODE2_USERDATA);
else app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER));

// Test mode from the environment, or from flags (`npm start -- --xode2-test --xode2-devpage=face-lab`, for launchers that can't set it).
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
  // F5 anywhere (even inside the terminal): reload with the latest code.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5' && !input.control && !input.alt && !input.meta) {
      event.preventDefault();
      reloadApp();
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // A test run may open one of the renderer's dev pages instead (XODE2_DEVPAGE=face-lab: every face Katana makes).
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

ipcMain.handle('state:load', () => readState());

ipcMain.handle('state:save', (_event, state) => {
  // Written beside it, then swapped in: a crash mid-write can't corrupt it.
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return true;
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

ipcMain.handle('file:reveal', (_event, file) => {
  if (!fileInfo(String(file || ''))) return false;
  shell.showItemInFolder(String(file));
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
    if (channel === 'daemon:lost') send('task:lost', {});
    else send(channel, payload);
  },
  log: (...parts) => console.log('[katanad]', ...parts),
};
const daemon = TEST && process.env.XODE2_DAEMON !== '1' ? inProcess({ ...daemonOptions, block: BLOCK_RUNS }) : createDaemonClient(daemonOptions);
// A task call that couldn't reach the daemon says why, instead of throwing.
const toDaemon = (method, ...params) => daemon.call(method, ...params).catch((error) => ({ error: error.message }));

ipcMain.handle('task:start', (_event, options = {}) => {
  if (BLOCK_RUNS) return { error: 'Tasks don’t start in test runs' };
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
    model: options.model || '',
    effort: options.effort || '',
    bypass: readState()?.settings?.bypassPermissions !== false,
    prompt: String(options.prompt || ''),
    // Hierarchy mode: this session leads a team (daemon/team.js).
    mode: options.mode === 'hierarchy' ? 'hierarchy' : 'single',
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
ipcMain.handle('task:running', () => toDaemon('running').then((ids) => (Array.isArray(ids) ? ids : [])));
ipcMain.handle('task:snapshot', () => toDaemon('snapshot').then((list) => (Array.isArray(list) ? list : [])));
ipcMain.handle('task:quiet', (_event, id) => toDaemon('quiet', String(id)));
// Hierarchy mode: every team as drawn, switching a task's mode, and ending a team's sessions.
ipcMain.handle('team:snapshot', () => toDaemon('teamSnapshot').then((list) => (Array.isArray(list) ? list : [])));
ipcMain.handle('team:mode', (_event, { id, mode } = {}) => toDaemon('teamMode', String(id), mode === 'hierarchy' ? 'hierarchy' : 'single'));
ipcMain.handle('team:stop', (_event, { id, forget } = {}) => toDaemon('teamStop', String(id), Boolean(forget)));
ipcMain.handle('task:history', (_event, { cwd, sessionId } = {}) => toDaemon('history', String(cwd || ''), String(sessionId || '')).then((lines) => (Array.isArray(lines) ? lines : [])));
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
ipcMain.handle('sys:found', () => ({ claude: Boolean(resolveClaude()), codex: Boolean(existsInPath('codex')) }));

/* ----------------------------- worktrees ------------------------------ */

const inTrusted = (folder) => !runGuard({ role: 'task', cwd: folder }, (readState()?.projects || []).map((project) => project.path));

ipcMain.handle('worktree:create', (_event, { project, title } = {}) =>
  inTrusted(project) ? worktree.create(String(project), String(title || '')) : { error: 'Not a trusted folder.' }
);
ipcMain.handle('worktree:merge', (_event, { tree, message } = {}) =>
  tree && inTrusted(tree.top) ? worktree.merge(tree, String(message || '')) : { error: 'Not a trusted folder.' }
);
ipcMain.handle('worktree:discard', (_event, { tree } = {}) => (tree && inTrusted(tree.top) ? worktree.discard(tree) : { error: 'Not a trusted folder.' }));
ipcMain.handle('worktree:changes', (_event, { tree } = {}) => (tree && inTrusted(tree.top) ? worktree.changes(tree) : { error: 'Not a trusted folder.' }));

/* ----------------------------- app viewer ----------------------------- */

// Your app, run from a task's folder and shown in the pane. Only in a trusted folder.
const appView = createAppView({
  send,
  mainWindow: () => mainWindow,
  screen,
  trusted: inTrusted,
  // Run from source, this is Electron itself: a folder with no Electron of its own can use it.
  bundledElectron: app.isPackaged ? '' : process.execPath,
  // Pages are shown by this program started again: its code, when run from source.
  exe: process.execPath,
  appPath: app.isPackaged ? '' : app.getAppPath(),
  userDataDir: () => app.getPath('userData'),
  log: (...parts) => console.log(...parts),
});
ipcMain.handle('app:start', (_event, { taskId, cwd, command, page } = {}) =>
  appView.start({ taskId, cwd: String(cwd || ''), command: String(command || ''), page: String(page || '') })
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
app.on('will-quit', () => appView.killAll());
process.on('exit', () => appView.killAll());

/* ------------------------------- voice -------------------------------- */

const voice = createVoice({ userDataDir: () => app.getPath('userData'), send, existsInPath });
const live = createLive({ userDataDir: () => app.getPath('userData') });
const transcriber = createTranscriber({ apiKey: () => live.key(), send, log: (...parts) => console.log('[dictation]', ...parts) });
const openrouter = createOpenRouter({ userDataDir: () => app.getPath('userData') });
const elevenlabs = createElevenLabs({ userDataDir: () => app.getPath('userData') });

// Dictation: Deepgram, OpenAI or OpenRouter, the first whose key is set; else Windows' own engine.
ipcMain.handle('voice:start', async () => {
  if (BLOCK_RUNS || voice.hasDeepgram()) return voice.start();
  if (live.hasKey()) {
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
// OpenRouter: a spoken phrase as text, and Katana's words as speech.
ipcMain.handle('voice:clip', (_event, wav) => (BLOCK_RUNS ? { error: 'Off in test runs' } : openrouter.transcribe(wav)));
// Her voice: ElevenLabs directly when its key is set (it says when each character is said, for her lips), else through OpenRouter.
ipcMain.handle('speech:say', async (_event, { text, voice: name } = {}) => {
  if (BLOCK_RUNS) return { error: 'Off in test runs' };
  if (elevenlabs.hasKey()) {
    const speech = await elevenlabs.speak(text, name);
    if (!speech.error || !openrouter.hasKey()) return speech;
    console.warn('[speech]', speech.error, '(using OpenRouter)');
  }
  return openrouter.speak(text, name);
});
ipcMain.handle('elevenlabs:has-key', () => elevenlabs.hasKey());
ipcMain.handle('elevenlabs:set-key', (_event, key) => elevenlabs.setKey(key));
ipcMain.handle('openrouter:has-key', () => openrouter.hasKey());
ipcMain.handle('openrouter:set-key', (_event, key) => openrouter.setKey(key));
ipcMain.on('voice:audio', (_event, audio) => transcriber.append(String(audio || '')));
ipcMain.on('voice:commit', () => transcriber.commit());
ipcMain.handle('voice:stop', async () => {
  voice.stop();
  // The last phrase comes back before it says it stopped.
  await transcriber.stop();
  send('voice:state', 'stopped');
  return true;
});

ipcMain.handle('live:has-key', () => live.hasKey());
ipcMain.handle('live:set-key', (_event, key) => live.setKey(key));
ipcMain.handle('live:start', (_event, options = {}) => (BLOCK_RUNS ? { error: 'GPT-Live is off in test runs' } : live.start(options)));

ipcMain.handle('shells:list', () => shells().map(({ id, label }) => ({ id, label })));

app.whenReady().then(() => {
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
  // The page that showed them is going: running apps end too (Run app starts them again).
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
