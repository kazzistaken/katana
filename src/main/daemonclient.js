'use strict';

/**
 * The app's line to katanad (src/daemon), the background process that owns
 * the tasks. connect() finds the running daemon (its pipe and token are in
 * <userData>/katanad.json) or starts one and waits for it. A daemon running
 * older code than what's on disk is replaced, but only while nothing runs
 * in it: a task is never ended to update the daemon.
 *
 * call(method, ...params) answers; notify() sends and forgets. The daemon's
 * events go to onEvent(channel, payload); onEvent('daemon:lost') when the
 * line drops (it crashed or was stopped), and the next call reconnects.
 *
 * In test runs (inProcess) the same core runs inside the app instead.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { infoFile, codeVersion, onMessages, sendLine } = require('../daemon/protocol');
const { cleanEnv } = require('./claude');

const START_MS = 8000;
const CALL_MS = 20_000;
const DAEMON = path.join(__dirname, '..', 'daemon', 'katanad.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDaemonClient({ userDataDir, onEvent, log = () => {} }) {
  let socket = null;
  let connecting = null;
  let status = null;
  let nextId = 0;
  const pending = new Map();

  function readInfo() {
    try {
      return JSON.parse(fs.readFileSync(infoFile(userDataDir), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Open the line to the daemon named in katanad.json and say hello: its status. */
  function open() {
    const info = readInfo();
    if (!info?.pipe || !info.token) return Promise.reject(new Error('no daemon'));
    return new Promise((resolve, reject) => {
      const line = net.connect(info.pipe);
      const fail = (error) => {
        line.destroy();
        reject(error);
      };
      line.once('error', fail);
      line.once('connect', () => {
        line.off('error', fail);
        line.on('error', () => {});
        onMessages(line, (message) => {
          if (message.event) return onEvent(message.event, message.payload);
          const item = pending.get(message.id);
          if (!item) return undefined;
          pending.delete(message.id);
          clearTimeout(item.timer);
          return message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
        });
        line.on('close', () => {
          if (socket !== line) return;
          socket = null;
          status = null;
          for (const [id, item] of pending) {
            clearTimeout(item.timer);
            item.reject(new Error('The background process stopped.'));
            pending.delete(id);
          }
          onEvent('daemon:lost', {});
        });
        socket = line;
        request('hello', { token: info.token, role: 'window' }).then(resolve, (error) => {
          socket = null;
          fail(error);
        });
      });
    });
  }

  /** Start a daemon (Electron's runtime as Node), not tied to this app's life. */
  function launch() {
    log('starting katanad');
    const child = spawn(process.execPath, [DAEMON, userDataDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1' }),
    });
    child.on('error', (error) => log('katanad failed to start', error.message));
    child.unref();
  }

  async function openOrLaunch() {
    try {
      return await open();
    } catch {
      launch();
    }
    const until = Date.now() + START_MS;
    while (Date.now() < until) {
      await wait(150);
      try {
        return await open();
      } catch {
        /* not up yet */
      }
    }
    throw new Error('The background process (katanad) didn’t start. See katanad.log in the data folder.');
  }

  /**
   * Whether a restart loses nothing: no task working or asking, and no shell
   * or Codex session open (a dev server, say). An idle Claude session may
   * close: it resumes its conversation when written to again.
   */
  async function safeToReplace() {
    const list = await request('snapshot').catch(() => null);
    if (!Array.isArray(list)) return false;
    return list.every((t) => !t.running || (t.kind === 'claude' && t.state === 'idle'));
  }

  async function connect() {
    if (socket && status) return status;
    if (!connecting) {
      connecting = (async () => {
        let hello = await openOrLaunch();
        // Older code than ours, and nothing in it that a restart would lose: swap it for a fresh one.
        if (hello.version !== codeVersion() && (await safeToReplace())) {
          log('katanad is out of date; restarting it');
          await request('shutdown', { force: true }).catch(() => {});
          socket?.destroy();
          socket = null;
          await wait(250);
          hello = await openOrLaunch();
        }
        status = hello;
        return hello;
      })().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  function request(method, ...params) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('not connected'));
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`katanad didn’t answer ${method}`));
      }, CALL_MS);
      pending.set(id, { resolve, reject, timer });
      sendLine(socket, { id, method, params });
      return undefined;
    });
  }

  return {
    connect,
    async call(method, ...params) {
      await connect();
      return request(method, ...params);
    },
    notify(method, ...params) {
      if (socket && status) sendLine(socket, { method, params });
      else connect().then(() => socket && sendLine(socket, { method, params }), () => {});
    },
    /** Whether the running daemon is behind the code on disk (it updates once idle). */
    stale: () => Boolean(status && status.version !== codeVersion()),
    close() {
      socket?.end();
      socket = null;
      status = null;
    },
  };
}

/** The daemon's core inside the app (test runs): the same calls, no pipe. */
function inProcess({ userDataDir, onEvent, block = true }) {
  const { createCore } = require('../daemon/core');
  const core = createCore({
    userDataDir,
    emit: onEvent,
    block,
    toWindow: (channel, payload) => {
      onEvent(channel, payload);
      return true;
    },
  });
  core.setWindows(1);
  const status = () => ({ pid: process.pid, version: codeVersion(), running: core.running().length, clients: 1, inProcess: true });
  const handlers = { ...core, status, shutdown: () => ({ ok: false }) };
  return {
    connect: async () => status(),
    call: async (method, ...params) => handlers[method](...params),
    notify: (method, ...params) => handlers[method](...params),
    stale: () => false,
    close: () => core.close(),
  };
}

module.exports = { createDaemonClient, inProcess };
