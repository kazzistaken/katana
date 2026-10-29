'use strict';

/**
 * The app viewer: runs your own app (an Electron app, or Katana itself)
 * from a task's folder and shows it live in the viewer pane.
 *
 * The app runs as itself, a real process. Its windows are taken off the
 * taskbar and moved just off the edge of the screen, sized to the pane;
 * the page streams them (Windows window capture, the window's own picture
 * even where nothing can see it) and sends your mouse and keys back here,
 * where they're posted to the window as Windows would have (appinput.js).
 * Off-screen, not behind this window: Chromium sends a wheel turn to
 * whichever window is under the pointer, so a covered app never gets it.
 *
 *   - Top-level windows are tabs in the pane, sized to it (fixed-size ones
 *     keep their size). The newest is shown; closing it goes back.
 *   - Dialogs and popups (owned windows: a message box, a <select> list)
 *     are drawn over their window where they'd be, at their own size.
 *   - Pop out puts the windows back on screen as they were; pop in again.
 *
 * Electron apps are started with switches that keep them painting while
 * no one can see them (runplan.js); anything else may stop drawing.
 *
 * Web pages (HTML files, browser games) run here too, in a small browser
 * that is this program started again (pagehost.js): one viewer for both.
 *
 * Errors are never shown: the app's are reported quietly (apphook.cjs,
 * loaded into an Electron app before it; else read from what it prints;
 * a crash; an error dialog, closed unseen) and sent to the window as
 * 'app:error', which keeps them per task (renderer apperrors.js).
 *
 * Agents test here too: screenshots, clicks, typing and keys, in the
 * window's own pixels (Katana's tools, and each task's, through the window).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { nativeImage } = require('electron');
const w32 = require('./win32');
const { planRun, planPage, runEnv } = require('./runplan');
const { mouseMessage, wheelMessages, keyMessages, parseCombo, pack } = require('./appinput');
const { markedError, stderrError, crashError, lineSplitter } = require('./applog');

const OUTPUT_MAX = 256 * 1024;
const WS_THICKFRAME = 0x40000;
const MENU_CLASS = '#32768'; // native menus open at the real pointer: left alone
const DIALOG_CLASS = '#32770';
// The longest side of a screenshot an agent gets (larger is scaled down; its clicks scaled back up).
const SHOT_MAX = 1568;

/** The app's Electron, if the folder (or one above it) has it installed. */
function folderElectron(cwd) {
  let dir = cwd;
  for (let i = 0; i < 4 && dir; i += 1) {
    const pkg = path.join(dir, 'node_modules', 'electron');
    try {
      const rel = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
      const exe = path.join(pkg, 'dist', rel);
      if (fs.existsSync(exe)) return exe;
    } catch {
      /* not here */
    }
    const up = path.dirname(dir);
    dir = up === dir ? '' : up;
  }
  return '';
}

function readPackage(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a window waits off-screen: beside the display Katana is on, on a
 * side with no other display (so the app keeps that display's scaling),
 * clear of any other window already waiting there (`taken`: another
 * run's, another Katana's). Overlapping, the wheel would go to the one on top.
 */
function parking(displays, home, size, taken = []) {
  const gap = 64;
  const sides = [
    [{ x: home.x - size.width - gap, y: home.y }, { x: -(size.width + gap), y: 0 }],
    [{ x: home.x + home.width + gap, y: home.y }, { x: size.width + gap, y: 0 }],
    [{ x: home.x, y: home.y - size.height - gap }, { x: 0, y: -(size.height + gap) }],
    [{ x: home.x, y: home.y + home.height + gap }, { x: 0, y: size.height + gap }],
  ];
  const clear = (at) => !displays.some((d) => intersects({ ...at, ...size }, d)) && !taken.some((t) => intersects({ ...at, ...size }, t));
  const walk = (start, step) => {
    for (let i = 0, at = start; i < 40; i += 1, at = { x: at.x + step.x, y: at.y + step.y }) if (clear(at)) return at;
    return null;
  };
  for (const [start, step] of sides) {
    if (displays.some((d) => intersects({ ...start, ...size }, d))) continue;
    const at = walk(start, step);
    if (at) return at;
  }
  // Surrounded: left of everything.
  const left = Math.min(...displays.map((d) => d.x));
  return walk({ x: left - size.width - gap, y: home.y }, { x: -(size.width + gap), y: 0 }) || { x: left - size.width - gap, y: home.y };
}

function createAppView({ send, mainWindow, screen, trusted, bundledElectron = '', exe = process.execPath, appPath = '', userDataDir = () => os.tmpdir(), log = () => {} }) {
  /** @type {Map<string, any>} task id → run */
  const runs = new Map();
  // The last pane size: an app an agent starts while you look elsewhere still gets a sensible size.
  let lastPane = null;
  let pipes = 0;

  /** The error hook, next to Katana's data (an app's Electron can't read it from inside this app's package). */
  function hookFile() {
    try {
      const target = path.join(userDataDir(), 'apphook.cjs');
      const code = fs.readFileSync(path.join(__dirname, 'apphook.cjs'), 'utf8');
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== code) fs.writeFileSync(target, code);
      return target;
    } catch (error) {
      log('[appview] hook', error.message);
      return '';
    }
  }

  /** Quietly kept for the task (the window asks about them on your next message). */
  function logError(taskId, entry) {
    if (entry) send('app:error', { taskId, entry: { ...entry, at: Date.now() } });
  }

  // Display bounds in screen pixels (each display at its own scaling).
  const physical = (rect) => screen.dipToScreenRect(null, rect);

  function state(run) {
    if (!run) return null;
    return {
      taskId: run.taskId,
      status: run.status,
      label: run.plan?.label || '',
      page: run.plan?.page || '',
      cwd: run.cwd,
      pid: run.child?.pid || 0,
      exitCode: run.exitCode,
      error: run.error || '',
      keepsPainting: Boolean(run.plan?.keepsPainting),
      self: Boolean(run.plan?.self),
      popped: run.popped,
      current: run.current,
      windows: [...run.windows.values()].filter((w) => w.shown).map((w) => ({
        hwnd: w.hwnd,
        title: w.title,
        kind: w.kind,
        owner: w.ownerTop || 0,
        client: { width: w.client.width, height: w.client.height },
        // The client area within what capture sends (the frame DWM draws), as fractions.
        crop: {
          x: (w.client.x - w.frame.x) / w.frame.width,
          y: (w.client.y - w.frame.y) / w.frame.height,
          width: w.client.width / w.frame.width,
          height: w.client.height / w.frame.height,
        },
        // A dialog or popup: where it sits over its window's client area (physical px).
        at: w.kind === 'layer' && w.ownerTop ? offsetIn(run, w) : null,
        sizeable: w.sizeable,
      })),
    };
  }

  const publish = (run) => send('app:state', state(run));

  function offsetIn(run, win) {
    const top = run.windows.get(win.ownerTop);
    if (!top) return { x: 0, y: 0 };
    return { x: win.client.x - top.client.x, y: win.client.y - top.client.y };
  }

  /* ------------------------------ output ------------------------------ */

  /** What it printed: errors are taken out and logged; the rest is kept for agents to read. */
  function take(run, text, stream) {
    const lines = run.split[stream](text);
    const kept = [];
    for (const line of lines) {
      const marked = markedError(line);
      if (marked) {
        logError(run.taskId, marked);
        continue;
      }
      if (stream === 'stderr' && !run.plan.hooked) logError(run.taskId, stderrError(line));
      if (stream === 'stderr') run.lastErr = [...run.lastErr.slice(-19), line];
      kept.push(line);
    }
    if (kept.length) output(run, `${kept.join('\n')}\n`);
  }

  function output(run, text) {
    run.output += text;
    if (run.output.length > OUTPUT_MAX) run.output = run.output.slice(-OUTPUT_MAX);
    run.pending += text;
    if (!run.flush) {
      run.flush = setTimeout(() => {
        run.flush = null;
        send('app:output', { taskId: run.taskId, text: run.pending });
        run.pending = '';
      }, 80);
    }
  }

  /* ------------------------------ starting ----------------------------- */

  const live = (run) => run && (run.status === 'starting' || run.status === 'running');

  /**
   * Runs a task's app (`command`, else its package.json), or shows a web
   * page (`page`). What's running already stays if it's the same thing;
   * something else running there is stopped first.
   */
  async function start({ taskId, cwd, command = '', page = '' } = {}) {
    taskId = String(taskId || '');
    if (!taskId) return { error: 'Which task?' };
    if (!w32.available) return { error: 'The app viewer needs Windows.' };
    if (!cwd || !fs.existsSync(cwd)) return { error: 'The task’s folder doesn’t exist.' };
    if (!trusted(cwd)) return { error: 'Apps only run in a trusted folder.' };
    const old = runs.get(taskId);
    if (live(old)) {
      if (page && old.plan.page) return navigate(old, page);
      if (!page && !old.plan.page && (!command || command === old.command)) return state(old);
      await stop(taskId);
    }

    let plan;
    if (page) {
      if (!fs.existsSync(page)) return failed(taskId, `There’s no page at ${page}.`);
      plan = planPage({ file: path.resolve(page), exe, appPath });
    } else {
      plan = planRun({ command, pkg: readPackage(cwd), electronExe: folderElectron(cwd), bundledElectron, hook: hookFile() });
    }
    if (plan.error) return failed(taskId, plan.error);

    // Katana in itself, or a page: their own data, never yours (nor your Katana's daemon).
    const dataDir = plan.self || plan.page ? fs.mkdtempSync(path.join(os.tmpdir(), plan.page ? 'katana-page-' : 'katana-run-')) : '';
    const env = runEnv(process.env, { self: plan.self, dataDir });
    let pipe = null;
    if (plan.page) {
      pipe = pagePipe();
      Object.assign(env, { XODE2_PAGE: plan.page, XODE2_PAGE_DATA: dataDir, XODE2_PAGE_PIPE: pipe.name });
    }
    const run = {
      taskId,
      cwd,
      command,
      plan,
      dataDir,
      child: null,
      status: 'starting',
      exitCode: null,
      error: '',
      output: old?.output ? `${old.output}\n` : '',
      pending: '',
      flush: null,
      split: { stdout: lineSplitter(), stderr: lineSplitter() },
      lastErr: [],
      pipe,
      windows: new Map(),
      order: [], // top-level windows, oldest first
      current: 0,
      pane: old?.pane || lastPane,
      popped: false,
      poll: null,
      started: Date.now(),
      tree: new Set(),
      hadFocus: Boolean(mainWindow()?.isFocused()),
    };
    runs.set(taskId, run);
    output(run, `▸ ${plan.label}  (${cwd})\n`);
    if (!plan.keepsPainting) output(run, '  Not started as an Electron app: if it stops drawing while hidden, use Pop out.\n');

    let child;
    try {
      child = spawn(plan.file, plan.args, { cwd, env, shell: plan.shell, windowsHide: plan.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      run.status = 'failed';
      run.error = error.message;
      logError(taskId, { kind: 'start-failed', message: error.message, detail: plan.label });
      publish(run);
      return state(run);
    }
    run.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => take(run, text, 'stdout'));
    child.stderr.on('data', (text) => take(run, text, 'stderr'));
    child.on('error', (error) => {
      run.error = error.message;
      logError(taskId, { kind: 'start-failed', message: error.message, detail: plan.label });
    });
    child.on('exit', (code, signal) => ended(run, code, signal));
    run.tree = new Set([child.pid]);
    schedule(run, 100);
    publish(run);
    return state(run);
  }

  /** It couldn't start: said to whoever asked, and logged with the task's errors. */
  function failed(taskId, message) {
    logError(taskId, { kind: 'start-failed', message });
    return { error: message };
  }

  /** The line a page's browser listens on (pagehost.js): `load <file>`, `reload`. */
  function pagePipe() {
    pipes += 1;
    const name = `\\\\.\\pipe\\katana-page-${process.pid}-${pipes}-${Date.now().toString(36)}`;
    const link = { name, socket: null, queue: [], server: null };
    link.server = net.createServer((socket) => {
      link.socket = socket;
      socket.on('error', () => {});
      for (const line of link.queue.splice(0)) socket.write(`${line}\n`);
    });
    link.server.on('error', (error) => log('[appview] page pipe', error.message));
    link.server.listen(name);
    link.say = (line) => (link.socket ? link.socket.write(`${line}\n`) : link.queue.push(line));
    link.close = () => {
      link.socket?.destroy();
      link.server.close();
    };
    return link;
  }

  /** Another page in the running page browser. */
  function navigate(run, page) {
    const file = path.resolve(page);
    if (!fs.existsSync(file)) return failed(run.taskId, `There’s no page at ${page}.`);
    if (file !== run.plan.page) {
      run.plan = { ...run.plan, page: file, label: path.basename(file) };
      run.pipe?.say(`load ${file}`);
      publish(run);
    }
    return state(run);
  }

  /** A page or app shown again after a change (a page reloads; an app is left alone). */
  function reload(taskId) {
    const run = runs.get(String(taskId || ''));
    if (live(run) && run.plan.page) run.pipe?.say('reload');
    return state(run);
  }

  function ended(run, code, signal) {
    if (runs.get(run.taskId) !== run) return;
    clearTimeout(run.poll);
    // The launcher (npm, a shell) can end while the app goes on: keep watching what it started.
    // Not for Katana in itself: what outlives it is its own daemon, which goes with it.
    const left = [...run.tree].filter((pid) => pid !== run.child.pid && alivePid(pid));
    if (left.length && !run.stopping && !run.plan.self) {
      run.orphans = new Set(left);
      schedule(run, 250);
      return;
    }
    finish(run, code, signal);
  }

  function finish(run, code, signal) {
    clearTimeout(run.poll);
    run.pipe?.close();
    // Ended by itself with a failure: a crash (stopping it isn't).
    if (!run.stopping) logError(run.taskId, crashError(code, signal, run.lastErr));
    // Whatever it started and left behind ends with it.
    if ([...run.tree, ...(run.orphans || [])].some((pid) => pid !== run.child?.pid && alivePid(pid))) killTree(run);
    run.status = run.stopping || code === 0 ? 'exited' : 'failed';
    run.exitCode = code;
    run.windows.clear();
    run.order = [];
    run.current = 0;
    output(run, `▪ ended${code != null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}\n`);
    cleanData(run);
    publish(run);
  }

  function cleanData(run) {
    if (!run.dataDir) return;
    const dir = run.dataDir;
    run.dataDir = '';
    // Its files may be held a moment after it ends.
    setTimeout(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }, () => {}), 800);
  }

  function alivePid(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ windows ------------------------------ */

  function schedule(run, ms) {
    clearTimeout(run.poll);
    run.poll = setTimeout(() => tick(run), ms);
  }

  function tick(run) {
    if (runs.get(run.taskId) !== run || run.status === 'exited' || run.status === 'failed') return;
    const root = run.child.pid;
    const tree = w32.processTree(root);
    for (const pid of run.orphans || []) for (const p of w32.processTree(pid)) tree.add(p);
    run.tree = tree;
    if (run.orphans && ![...tree].some(alivePid)) return finish(run, run.child.exitCode, null);

    const seen = new Set();
    let changed = false;
    for (const found of w32.windowsOf(tree)) {
      seen.add(found.hwnd);
      if (found.className === MENU_CLASS) continue;
      const known = run.windows.get(found.hwnd);
      if (known) {
        changed = refresh(run, known, found) || changed;
        continue;
      }
      adopt(run, found);
      changed = true;
    }
    for (const hwnd of [...run.windows.keys()]) {
      if (!seen.has(hwnd)) {
        forget(run, hwnd);
        changed = true;
      }
    }
    if (run.status === 'starting' && run.order.length) {
      run.status = 'running';
      changed = true;
    }
    if (changed) publish(run);
    // Quick while it's starting (a window waits on screen until it's moved), then calmer.
    schedule(run, Date.now() - run.started < 15000 ? 100 : 300);
  }

  function topOf(run, found) {
    let owner = found.owner;
    for (let i = 0; owner && i < 8; i += 1) {
      const known = run.windows.get(owner);
      if (known) return known.kind === 'top' ? known.hwnd : known.ownerTop;
      owner = 0;
    }
    return 0;
  }

  /** An error dialog the app put up (Electron's own, or an "Error" message box): logged and closed unseen. */
  function errorDialog(run, found) {
    if (found.className !== DIALOG_CLASS) return false;
    const words = w32.texts(found.hwnd);
    if (!/\berror\b/i.test(found.title) && !words.some((t) => /JavaScript error occurred/i.test(t))) return false;
    const message = words.filter((t) => t !== found.title && !/^(OK|Cancel|Copy|&?Close)$/i.test(t));
    logError(run.taskId, { kind: 'error-box', message: message[0] || found.title, detail: message.slice(1).join('\n') });
    w32.post(found.hwnd, 0x10 /* WM_CLOSE */, 0, 0);
    return true;
  }

  function adopt(run, found) {
    if (errorDialog(run, found)) return;
    const ownerTop = topOf(run, found);
    // Unowned, ordinary windows are the app's own; owned or tool windows are its dialogs and popups.
    const isTop = !found.owner && !found.tool && !found.noActivate;
    const win = {
      hwnd: found.hwnd,
      title: found.title,
      className: found.className,
      kind: isTop ? 'top' : 'layer',
      ownerTop: isTop ? 0 : ownerTop || run.current,
      sizeable: Boolean(found.style & WS_THICKFRAME),
      original: found.outer,
      outer: found.outer,
      frame: found.frame,
      client: found.client,
      shown: true,
      parked: null,
    };
    run.windows.set(win.hwnd, win);
    if (run.popped) return;
    if (isTop) {
      w32.setToolWindow(win.hwnd, true);
      run.order.push(win.hwnd);
      run.current = win.hwnd;
      fit(run, win);
      // A new window takes the keyboard from Katana: give it back.
      if (run.hadFocus) refocus();
    } else {
      placeLayer(run, win);
    }
  }

  function refocus() {
    const win = mainWindow();
    if (win && !win.isDestroyed() && !win.isFocused()) setTimeout(() => win.isDestroyed() || win.focus(), 50);
  }

  function forget(run, hwnd) {
    run.windows.delete(hwnd);
    run.order = run.order.filter((h) => h !== hwnd);
    if (run.current === hwnd) run.current = run.order.at(-1) || 0;
  }

  /** Reads a window's place again; true if anything the page draws changed. */
  function refresh(run, win, found) {
    const before = JSON.stringify([win.title, win.client, win.frame]);
    win.title = found.title;
    win.outer = found.outer;
    win.frame = found.frame;
    win.client = found.client;
    if (!run.popped) {
      if (win.kind === 'top' && win.parked && !near(found.outer, win.parked)) fit(run, win); // the app moved it: back off-screen
      if (win.kind === 'layer' && onScreen(found.outer)) placeLayer(run, win);
    }
    return before !== JSON.stringify([win.title, win.client, win.frame]);
  }

  const near = (a, b) => Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4;

  function displays() {
    return screen.getAllDisplays().map((d) => physical(d.bounds));
  }

  function homeDisplay() {
    const win = mainWindow();
    const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    return physical(display.bounds);
  }

  const onScreen = (rect) => displays().some((d) => intersects(rect, d));

  /** A top-level window: sized to the pane (if it can be) and moved off-screen. */
  function fit(run, win) {
    const extraW = win.outer.width - win.client.width;
    const extraH = win.outer.height - win.client.height;
    let width = win.outer.width;
    let height = win.outer.height;
    if (run.pane && win.sizeable) {
      width = Math.max(120, Math.round(run.pane.width * run.pane.dpr)) + extraW;
      height = Math.max(80, Math.round(run.pane.height * run.pane.dpr)) + extraH;
    }
    // Its own spot, clear of every other window waiting off-screen (this
    // app's others too), and on top of them: the wheel goes to whatever is
    // under the point. Off-screen, on top covers nothing you can see.
    const all = displays();
    const taken = w32.windowRects().filter((r) => r.hwnd !== win.hwnd && !all.some((d) => intersects(r, d)));
    const at = parking(all, homeDisplay(), { width, height }, taken);
    win.parked = at;
    w32.place(win.hwnd, { ...at, width, height }, { after: w32.HWND_TOP, size: true });
  }

  /** A dialog or popup: kept where it is relative to its window, which is off-screen too. */
  function placeLayer(run, win) {
    const top = run.windows.get(win.ownerTop);
    if (!top) return;
    // Centered over its window if it opened on screen (a message box centred on the display).
    const x = top.client.x + Math.max(0, Math.round((top.client.width - win.outer.width) / 2));
    const y = top.client.y + Math.max(0, Math.round((top.client.height - win.outer.height) / 3));
    w32.place(win.hwnd, { x, y, width: 0, height: 0 }, { after: w32.HWND_TOP, size: false });
  }

  /* ------------------------------- pane -------------------------------- */

  /** The pane's size in CSS pixels and the page's pixel ratio; null when it's hidden. */
  function pane({ taskId, width, height, dpr } = {}) {
    const run = runs.get(String(taskId || ''));
    if (!run) return;
    if (!(width > 0 && height > 0)) return;
    const next = { width: Math.round(width), height: Math.round(height), dpr: Number(dpr) || 1 };
    if (run.pane && run.pane.width === next.width && run.pane.height === next.height && run.pane.dpr === next.dpr) return;
    run.pane = next;
    lastPane = next;
    if (run.popped) return;
    for (const hwnd of run.order) {
      const win = run.windows.get(hwnd);
      if (win) fit(run, win);
    }
  }

  function select({ taskId, hwnd } = {}) {
    const run = runs.get(String(taskId || ''));
    if (!run || !run.windows.has(hwnd)) return null;
    run.current = hwnd;
    publish(run);
    return state(run);
  }

  /** Back on screen as they were (a normal window again), or into the pane again. */
  function popout(taskId) {
    const run = runs.get(String(taskId || ''));
    if (!run || !run.order.length) return null;
    run.popped = !run.popped;
    const home = homeDisplay();
    for (const hwnd of run.order) {
      const win = run.windows.get(hwnd);
      if (!win) continue;
      if (run.popped) {
        w32.setToolWindow(hwnd, false);
        const o = win.original;
        const back = onScreen(o) ? o : { x: home.x + 80, y: home.y + 80, width: o.width, height: o.height };
        w32.place(hwnd, back, { after: w32.HWND_TOP });
        win.parked = null;
      } else {
        w32.setToolWindow(hwnd, true);
        fit(run, win);
      }
    }
    if (run.popped && run.current) w32.raise(run.current);
    else refocus();
    publish(run);
    return state(run);
  }

  /* ------------------------------- input ------------------------------- */

  /**
   * Input from the pane for one window. Points are in its client pixels.
   * Events: { type: 'move'|'down'|'up', x, y, button, buttons, detail, ctrl, shift, alt },
   * { type: 'wheel', x, y, deltaX, deltaY, deltaMode, … }, { type: 'key', down, code, key, repeat, … }.
   */
  function input({ taskId, hwnd, events = [] } = {}) {
    const run = runs.get(String(taskId || ''));
    if (!run || run.popped || !run.windows.has(hwnd) || !w32.alive(hwnd)) return;
    for (const event of events) {
      try {
        deliver(run, hwnd, event);
      } catch (error) {
        log('[appview] input', error.message);
      }
    }
  }

  function deliver(run, hwnd, event) {
    if (event.type === 'move' || event.type === 'down' || event.type === 'up') {
      const message = mouseMessage(event);
      if (!message) return;
      const at = w32.childAt(hwnd, Math.round(event.x), Math.round(event.y));
      w32.post(at.hwnd, message.msg, message.wParam, pack(at.x, at.y));
      return;
    }
    if (event.type === 'wheel') {
      const point = w32.toScreen(hwnd, Math.round(event.x), Math.round(event.y));
      for (const message of wheelMessages(event)) w32.post(hwnd, message.msg, message.wParam, pack(point.x, point.y));
      return;
    }
    if (event.type === 'key') {
      const messages = keyMessages({ ...event, type: event.down ? 'down' : 'up' }, w32.scanCode);
      if (!messages) return;
      // The keyboard is where the app has it: this window, or a dialog of its own over it.
      const { focus, root } = w32.focusOf(hwnd);
      const owner = run.windows.get(root);
      const inDialog = owner?.kind === 'layer';
      const rootClass = (inDialog ? owner : run.windows.get(hwnd))?.className || '';
      if (/^Chrome_/.test(rootClass)) {
        // Chromium takes keys at its top-level window and finds its own focus.
        const target = inDialog ? root : hwnd;
        // Chromium reads Ctrl, Shift and Alt itself: sent with them held as
        // they are (posted, the app's own TranslateMessage would type a second
        // character); the characters the page typed, posted after.
        if (event.down) w32.sendWithModifiers(target, messages.keys, messages.mods);
        else for (const [msg, wParam, lParam] of messages.keys) w32.post(target, msg, wParam, lParam);
        for (const [msg, wParam, lParam] of messages.chars) w32.post(target, msg, wParam, lParam);
      } else {
        // A native dialog: posted, so its own loop (Enter, Tab) and TranslateMessage see them.
        const target = focus && (root === hwnd || inDialog) ? focus : hwnd;
        for (const [msg, wParam, lParam] of messages.keys) w32.post(target, msg, wParam, lParam);
      }
    }
  }

  /* --------------------------- stopping ---------------------------- */

  /**
   * Ends the app's processes: the ones seen while it ran, and what they
   * started since. One by one (taskkill /T would follow parent numbers
   * Windows may have reused); never Katana itself.
   */
  function killTree(run, wait = false) {
    const pids = new Set([run.child?.pid, ...run.tree, ...(run.orphans || [])].filter(Boolean));
    for (const pid of [...pids]) if (alivePid(pid)) for (const p of w32.processTree(pid)) pids.add(p);
    pids.delete(process.pid);
    const kill = wait ? spawnSync : spawn;
    for (const pid of pids) {
      if (!alivePid(pid)) continue;
      try {
        const child = kill('taskkill', ['/pid', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' });
        child?.on?.('error', () => {});
      } catch {
        /* gone */
      }
    }
  }

  /** Ends the app: its windows are asked to close, then whatever is left is ended. */
  function stop(taskId) {
    const run = runs.get(String(taskId || ''));
    if (!run || run.status === 'exited' || run.status === 'failed') return state(run);
    run.stopping = true;
    for (const hwnd of run.order) w32.post(hwnd, 0x10 /* WM_CLOSE */, 0, 0);
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (run.status === 'exited' || run.status === 'failed') return resolve(state(run));
        if (Date.now() - started > 1500) {
          killTree(run);
          setTimeout(() => {
            if (run.status !== 'exited' && run.status !== 'failed') finish(run, null, 'stopped');
            resolve(state(run));
          }, 600);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  async function restart(taskId) {
    const run = runs.get(String(taskId || ''));
    if (!run) return { error: 'Nothing has run here yet.' };
    await stop(taskId);
    return start({ taskId: run.taskId, cwd: run.cwd, command: run.command, page: run.plan?.page || '' });
  }

  /** Gone with its task: ended and forgotten. */
  function drop(taskId) {
    const run = runs.get(String(taskId || ''));
    if (!run) return;
    run.stopping = true;
    if (run.status === 'starting' || run.status === 'running') killTree(run);
    clearTimeout(run.poll);
    run.pipe?.close();
    cleanData(run);
    runs.delete(run.taskId);
  }

  /** Katana is closing: everything ends now. */
  function killAll() {
    for (const run of runs.values()) {
      run.stopping = true;
      clearTimeout(run.poll);
      if (run.status === 'starting' || run.status === 'running') killTree(run, true);
      if (run.dataDir) fs.rmSync(run.dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
    runs.clear();
  }

  /* ------------------------------ agents ------------------------------- */

  /** A running task's app, for an agent: its run and current window, or { error }. */
  function forAgent(taskId) {
    const run = runs.get(String(taskId || ''));
    if (!live(run)) return { error: 'Nothing is running in this task’s viewer. Start it with run_app.' };
    if (run.popped) return { error: 'The app is popped out of the viewer.' };
    const top = run.windows.get(run.current);
    if (!top || !w32.alive(top.hwnd)) return { error: 'It’s running, with no window open (yet).' };
    return { run, top };
  }

  /** The windows a screenshot shows, front last: the current one, then its dialogs and popups. */
  function shown(run, top) {
    return [top, ...[...run.windows.values()].filter((w) => w.kind === 'layer' && w.ownerTop === top.hwnd && w32.alive(w.hwnd))];
  }

  /**
   * What the app looks like now (its current window, with any dialog over
   * it), as a PNG an agent can see; its clicks are in this picture's pixels.
   */
  function screenshot(taskId) {
    const got = forAgent(taskId);
    if (got.error) return got;
    const { run, top } = got;
    const base = w32.capture(top.hwnd);
    if (!base) return { error: 'Windows wouldn’t give a picture of the window.' };
    for (const layer of shown(run, top).slice(1)) {
      const pic = w32.capture(layer.hwnd);
      const at = offsetIn(run, layer);
      if (pic) blit(base, pic, at.x, at.y);
    }
    let image = nativeImage.createFromBitmap(base.data, { width: base.width, height: base.height });
    const scale = Math.min(1, SHOT_MAX / Math.max(base.width, base.height));
    if (scale < 1) image = image.resize({ width: Math.round(base.width * scale), quality: 'good' });
    const size = image.getSize();
    run.shot = { scale: base.width / size.width };
    return { image: image.toPNG().toString('base64'), width: size.width, height: size.height, window: top.title, windows: run.order.length };
  }

  /** One picture onto another (BGRA rows), clipped. */
  function blit(onto, pic, left, top) {
    for (let y = 0; y < pic.height; y += 1) {
      const ty = top + y;
      if (ty < 0 || ty >= onto.height) continue;
      const x0 = Math.max(0, -left);
      const x1 = Math.min(pic.width, onto.width - left);
      if (x1 <= x0) continue;
      pic.data.copy(onto.data, (ty * onto.width + left + x0) * 4, (y * pic.width + x0) * 4, (y * pic.width + x1) * 4);
    }
  }

  /** A point in the last screenshot, as the window under it and a point in that window. */
  function target(run, top, x, y) {
    const scale = run.shot?.scale || 1;
    const px = Math.round(Number(x) * scale);
    const py = Math.round(Number(y) * scale);
    // Over a dialog or popup: that one (front first).
    for (const layer of shown(run, top).slice(1).reverse()) {
      const at = offsetIn(run, layer);
      if (px >= at.x && py >= at.y && px < at.x + layer.client.width && py < at.y + layer.client.height) return { hwnd: layer.hwnd, x: px - at.x, y: py - at.y };
    }
    return { hwnd: top.hwnd, x: px, y: py };
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function click(taskId, { x, y, button = 'left', double = false } = {}) {
    const got = forAgent(taskId);
    if (got.error) return got;
    const at = target(got.run, got.top, x, y);
    const b = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    const bit = [1, 4, 2][b];
    const act = (event) => deliver(got.run, at.hwnd, { x: at.x, y: at.y, ...event });
    act({ type: 'move', buttons: 0 });
    for (let i = 0; i < (double ? 2 : 1); i += 1) {
      act({ type: 'down', button: b, buttons: bit, detail: i + 1 });
      await pause(30);
      act({ type: 'up', button: b, buttons: 0 });
      await pause(30);
    }
    return { clicked: { x: Number(x), y: Number(y) }, button, double: Boolean(double) };
  }

  async function press(run, hwnd, combo) {
    const key = parseCombo(combo);
    if (!key) return false;
    deliver(run, hwnd, { type: 'key', down: true, ...key });
    await pause(20);
    deliver(run, hwnd, { type: 'key', down: false, ...key });
    await pause(20);
    return true;
  }

  async function keys(taskId, list = []) {
    const got = forAgent(taskId);
    if (got.error) return got;
    const names = Array.isArray(list) ? list : [list];
    const unknown = names.filter((k) => !parseCombo(k));
    if (unknown.length) return { error: `No key called ${unknown.join(', ')}. Use names like Enter, Tab, Escape, ArrowDown, Ctrl+A, F5.` };
    for (const name of names) await press(got.run, got.top.hwnd, name);
    return { pressed: names };
  }

  /** Text typed where the app has the keyboard (click a field first); new lines are Enter. */
  async function type(taskId, text = '') {
    const got = forAgent(taskId);
    if (got.error) return got;
    const { run, top } = got;
    const { focus, root } = w32.focusOf(top.hwnd);
    const inDialog = run.windows.get(root)?.kind === 'layer';
    const into = /^Chrome_/.test(top.className) ? (inDialog ? root : top.hwnd) : focus || top.hwnd;
    for (const ch of String(text)) {
      if (ch === '\n') await press(run, top.hwnd, 'Enter');
      else for (let i = 0; i < ch.length; i += 1) w32.post(into, 0x102 /* WM_CHAR */, ch.charCodeAt(i), 1);
    }
    await pause(30);
    return { typed: String(text).length };
  }

  async function scroll(taskId, { x, y, dy = 0, dx = 0 } = {}) {
    const got = forAgent(taskId);
    if (got.error) return got;
    const at = target(got.run, got.top, x, y);
    deliver(got.run, at.hwnd, { type: 'wheel', x: at.x, y: at.y, deltaX: Number(dx) || 0, deltaY: Number(dy) || 0, deltaMode: 0 });
    await pause(50);
    return { scrolled: { dx: Number(dx) || 0, dy: Number(dy) || 0 } };
  }

  return {
    start,
    stop,
    restart,
    drop,
    killAll,
    pane,
    select,
    popout,
    input,
    reload,
    screenshot,
    click,
    keys,
    type,
    scroll,
    state: (taskId) => state(runs.get(String(taskId || ''))),
    output: (taskId) => runs.get(String(taskId || ''))?.output || '',
    list: () => [...runs.values()].map(state),
  };
}

module.exports = { createAppView, parking, folderElectron };
