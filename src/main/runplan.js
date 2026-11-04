'use strict';

/**
 * How to start the browser for a web page (appview.js): which program and
 * arguments, and the environment it gets. Pure (no Electron, no disk), so
 * scripts/test-runplan.mjs checks it under Node.
 */

// Chromium stops drawing a window it thinks nobody can see; the viewer's
// window is off-screen, so an Electron app is started with these.
const KEEP_PAINTING = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];

/**
 * A web page (an HTML file, a browser game) in the viewer: this program
 * again as a small browser (pagehost.js, chosen by XODE2_PAGE in its
 * environment). `exe` is this program; `appPath` its code when run from
 * source (packaged, the program is its code).
 */
function planPage({ file, exe, appPath = '' }) {
  if (!file) return { error: 'Which page?' };
  if (!exe) return { error: 'There’s nothing to show pages with.' };
  const name = String(file).split(/[\\/]/).pop();
  return { file: exe, args: [...KEEP_PAINTING, ...(appPath ? [appPath] : [])], shell: false, label: name, electron: true, keepsPainting: true, hooked: true, self: false, page: String(file) };
}

// What a run mustn't inherit from this app: Electron-as-Node (set when an
// Electron app runs tools) and this app's own test switches.
const DROP_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|XODE2_[A-Z_]+)$/i;

/** The environment a run starts with. This app in itself gets its own data folder. */
function runEnv(env, { self = false, dataDir = '' } = {}) {
  const next = {};
  for (const [key, value] of Object.entries(env || {})) if (!DROP_ENV.test(key)) next[key] = value;
  if (self && dataDir) next.XODE2_USERDATA = dataDir;
  return next;
}

module.exports = { planPage, runEnv, KEEP_PAINTING };
