'use strict';

/**
 * How to start the app in a task's folder for the viewer (appview.js):
 * which program, which arguments, and whether Chromium can be told to keep
 * painting while its window is hidden. Pure (no Electron, no disk), so
 * scripts/test-runplan.mjs checks it under Node.
 */

// Chromium stops drawing a window it thinks nobody can see; the viewer's
// window is off-screen, so an Electron app is started with these.
const KEEP_PAINTING = ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows'];

// This app's own name in its package.json: running it in itself needs its own data folder.
const SELF_NAMES = ['katana', 'xodecode-v2'];

/** A command line as words, "quoted parts" kept together. */
function splitArgs(line) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(line || '')))) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

// `electron .`, `electron ./app --flag`, `npx electron .`: nothing else in the script.
const PLAIN_ELECTRON = /^\s*(?:npx\s+)?electron(?:\.cmd)?(\s+[^&|;<>]*)?$/i;
// The script's last command is electron (`tsc && electron .`, `cross-env X=1 electron .`),
// so `npm run <script> -- <switches>` reaches it.
const ENDS_IN_ELECTRON = /(?:^|&&|\|\||;)\s*(?:cross-env\s+(?:\S+=\S*\s+)*)?(?:npx\s+)?electron(?:\.cmd)?(?:\s+[^&|;<>]*)?$/i;

const isElectronApp = (pkg) => Boolean(pkg && (pkg.devDependencies?.electron || pkg.dependencies?.electron));

/**
 * What to run: { file, args, shell, label, electron, keepsPainting, hooked, self }
 * or { error }. `command` is what the user or Katana typed (else the
 * folder's package.json decides); `electronExe` is the folder's own
 * Electron if it has one installed, else `bundledElectron` (this app's,
 * when run from source). `hook`: a script Electron loads before the app
 * (`-r`, apphook.cjs) to report its errors quietly; only an Electron
 * started directly can take it.
 */
function planRun({ command = '', pkg = null, electronExe = '', bundledElectron = '', hook = '' } = {}) {
  const self = Boolean(pkg && SELF_NAMES.includes(pkg.name));
  const electron = electronExe || bundledElectron;
  const direct = (rest, label) => {
    if (!electron) return { error: 'Electron isn’t installed in this folder. Run npm install first.' };
    const hookArgs = hook ? ['-r', hook] : [];
    return { file: electron, args: [...KEEP_PAINTING, ...hookArgs, ...rest], shell: false, label, electron: true, keepsPainting: true, hooked: Boolean(hook), self };
  };

  const typed = String(command || '').trim();
  if (typed) {
    if (PLAIN_ELECTRON.test(typed)) return direct(splitArgs(typed).slice(/^npx$/i.test(splitArgs(typed)[0]) ? 2 : 1), typed);
    // Anything else runs as typed, in the shell. An npm script that ends in electron gets the switches.
    const script = /^npm\s+(?:run\s+)?(start|[\w:-]+)\s*$/i.exec(typed);
    const body = script && pkg?.scripts?.[script[1]];
    if (body && ENDS_IN_ELECTRON.test(body)) return { file: `${typed} -- ${KEEP_PAINTING.join(' ')}`, args: [], shell: true, label: typed, electron: true, keepsPainting: true, self };
    return { file: typed, args: [], shell: true, label: typed, electron: /\belectron\b/i.test(typed), keepsPainting: false, self };
  }

  if (!pkg) return { error: 'There’s no package.json here. Give a command to run instead.' };
  const start = pkg.scripts?.start;
  if (start && PLAIN_ELECTRON.test(start)) {
    const words = splitArgs(start);
    return direct(words.slice(/^npx$/i.test(words[0]) ? 2 : 1), `npm start (${start.trim()})`);
  }
  if (start && ENDS_IN_ELECTRON.test(start)) {
    return { file: `npm start -- ${KEEP_PAINTING.join(' ')}`, args: [], shell: true, label: `npm start (${start.trim()})`, electron: true, keepsPainting: true, self };
  }
  if (start) return { file: 'npm start', args: [], shell: true, label: `npm start (${start.trim()})`, electron: isElectronApp(pkg), keepsPainting: false, self };
  if (isElectronApp(pkg)) return direct(['.'], 'electron .');
  return { error: 'package.json has no start script. Add one, or give a command to run.' };
}

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

module.exports = { planRun, planPage, runEnv, splitArgs, KEEP_PAINTING, SELF_NAMES };
