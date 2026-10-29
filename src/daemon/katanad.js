'use strict';

/**
 * katanad: the background process that owns every task, so reloading or
 * closing the app's window never ends one. The app starts it when it isn't
 * running (Electron's own runtime as Node, so node-pty loads as it is) and
 * connects over a local pipe (protocol.js); any number of windows can.
 *
 * One per data folder: a second one finds the pipe taken and leaves. It
 * goes away on its own once nothing has run and no window has been
 * connected for a while, or when asked to (shutdown).
 *
 *   ELECTRON_RUN_AS_NODE=1 electron src/daemon/katanad.js <userData>
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createCore } = require('./core');
const { METHODS, pipePath, infoFile, codeVersion, onMessages, sendLine } = require('./protocol');

const IDLE_EXIT_MS = 10 * 60_000;
const LOG_MAX = 1_000_000;

const userDataDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(userDataDir, { recursive: true });
const logFile = path.join(userDataDir, 'katanad.log');
const token = crypto.randomBytes(24).toString('hex');
const version = codeVersion();
const pipe = pipePath(userDataDir);
const STARTED = Date.now();
const clients = new Set();
let lastBusy = Date.now();

function log(...parts) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, `${logFile}.old`);
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {
    /* nowhere to say it */
  }
}

process.on('uncaughtException', (error) => log('uncaught', error.stack || error.message));
process.on('unhandledRejection', (error) => log('unhandled', error?.stack || String(error)));

// Windows (the app) among the clients, the latest last: Katana's tool calls go to that one.
const windows = [];
const countWindows = () => core.setWindows(windows.length);

const core = createCore({
  userDataDir,
  log,
  // A test run that keeps Claude away (main checks it too, for tasks).
  block: Boolean(process.env.XODE2_TEST) && process.env.XODE2_LIVE !== '1',
  emit(event, payload) {
    for (const client of clients) sendLine(client, { event, payload });
  },
  toWindow(event, payload) {
    const window = windows.at(-1);
    if (!window) return false;
    sendLine(window, { event, payload });
    return true;
  },
});

function quit(code = 0) {
  log('exit', code);
  try {
    // Only our own info file: a newer daemon may have written its own.
    const info = JSON.parse(fs.readFileSync(infoFile(userDataDir), 'utf8'));
    if (info.pid === process.pid) fs.rmSync(infoFile(userDataDir), { force: true });
  } catch {
    /* already gone */
  }
  core.close();
  process.exit(code);
}

const handlers = {
  ...core,
  status: () => ({ pid: process.pid, version, running: core.running().length, clients: clients.size, since: STARTED }),
  /** Leave: when nothing runs, or with `force`, ending every task. */
  shutdown({ force = false } = {}) {
    if (core.running().length && !force) return { ok: false, running: core.running().length };
    setTimeout(() => quit(0), 50);
    return { ok: true };
  },
};

const server = net.createServer((socket) => {
  let authed = false;
  socket.on('error', () => {});
  socket.on('close', () => {
    clients.delete(socket);
    const index = windows.indexOf(socket);
    if (index >= 0) windows.splice(index, 1);
    countWindows();
    lastBusy = Date.now();
  });
  onMessages(socket, async (message) => {
    const { id, method, params } = message;
    if (!authed) {
      const hello = Array.isArray(params) ? params[0] : params;
      if (method === 'hello' && hello?.token === token) {
        authed = true;
        clients.add(socket);
        if (hello.role === 'window') {
          windows.push(socket);
          countWindows();
        }
        sendLine(socket, { id, result: handlers.status() });
      } else {
        sendLine(socket, { id, error: 'not allowed' });
        socket.destroy();
      }
      return;
    }
    if (!METHODS.has(method)) {
      if (id !== undefined) sendLine(socket, { id, error: `no method ${method}` });
      return;
    }
    try {
      const result = await handlers[method](...(Array.isArray(params) ? params : [params]));
      if (id !== undefined) sendLine(socket, { id, result: result ?? null });
    } catch (error) {
      log('call failed', method, error.stack || error.message);
      if (id !== undefined) sendLine(socket, { id, error: error.message });
    }
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    // Another daemon has it already (or, off Windows, a stale socket file).
    if (process.platform !== 'win32') {
      const probe = net.connect(pipe);
      probe.on('connect', () => {
        probe.destroy();
        process.exit(0);
      });
      probe.on('error', () => {
        fs.rmSync(pipe, { force: true });
        server.listen(pipe);
      });
      return;
    }
    process.exit(0);
  }
  log('server', error.stack || error.message);
  process.exit(1);
});

server.listen(pipe, () => {
  // Written beside it, then swapped in: a window never reads half of it.
  const file = infoFile(userDataDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, token, version, pipe, started: STARTED }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  log('listening', pipe, 'pid', process.pid, 'version', version);
});

// Nothing running and nobody looking for a while: leave.
setInterval(() => {
  // (A reminder or a check still waiting needs the daemon to be here when it comes due.)
  const waiting = core.agentState();
  if (clients.size || core.running().length || waiting.reminders.length || waiting.watches.length) lastBusy = Date.now();
  else if (Date.now() - lastBusy > IDLE_EXIT_MS) quit(0);
}, 30_000);
