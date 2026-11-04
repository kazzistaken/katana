'use strict';

/**
 * How the app and katanad talk: one JSON message per line over a local
 * pipe (a named pipe on Windows, a socket file elsewhere), private to this
 * user's data folder. The first message must be hello with the daemon's
 * token, which it writes to <userData>/katanad.json with its pid and pipe.
 *
 *   → { id, method, params: [...] }      a call; ← { id, result } or { id, error }
 *   → { method, params }                  no id: nothing comes back
 *   ← { event, payload }                  something happened (core.js)
 *
 * hello says who's calling: { token, role: 'window' } for the app, whose
 * windows Katana's tool calls go to.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// What a window may ask of the daemon.
const METHODS = new Set([
  'start', 'say', 'write', 'resize', 'size', 'stop', 'answered', 'kill', 'tail', 'watch', 'unwatch', 'running', 'quiet', 'history', 'snapshot', 'killAll', 'status', 'shutdown',
  // Katana, and a window answering one of her tool calls.
  'agentAsk', 'agentStop', 'agentSay', 'agentRemind', 'agentWatch', 'agentDrop', 'agentState', 'toolResult', 'screen',
  // Whether the window's page can take her tool calls now (it loads, reloads, crashes).
  'windowReady',
  // Hierarchy mode's teams.
  'teamSnapshot', 'teamMode', 'teamStop',
]);

const hash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');

/** The pipe for this data folder: one daemon per user and app. */
function pipePath(userDataDir) {
  const key = hash(path.resolve(userDataDir).toLowerCase()).slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\katanad-${key}` : path.join(userDataDir, 'katanad.sock');
}

const infoFile = (userDataDir) => path.join(userDataDir, 'katanad.json');

// The daemon's own code: when any of it changes on disk, a running daemon is
// out of date. Found by following what katanad.js loads (require, import,
// import()), and the files it copies out or loads by a name it builds: the
// window modules headless.js imports (and everything those import).
const SRC = path.join(__dirname, '..');
const ROOTS = [
  path.join(__dirname, 'katanad.js'),
  path.join(SRC, 'main', 'hook.cjs'),
  path.join(SRC, 'main', 'mcp-app.cjs'),
];
// headless.js names them in a list ('store.js', …) under renderer/js.
const HEADLESS_LIST = /\[\s*((?:'[\w.-]+\.js'\s*,?\s*)+)\]\s*\.map\(\s*\(name\)\s*=>\s*import\(/;
const SPECIFIER = /(?:\brequire\(\s*|\bimport\(\s*|\bfrom\s+|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const file of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* next */
    }
  }
  return '';
}

let codeList = null;
/** Every file of the daemon's code (found once per process). */
function codeFiles() {
  if (codeList) return codeList;
  const seen = new Set();
  const queue = [...ROOTS];
  const headless = readText(path.join(__dirname, 'headless.js')).match(HEADLESS_LIST);
  // (Should that list ever read differently: the ones it has always had.)
  const names = headless ? [...headless[1].matchAll(/'([\w.-]+\.js)'/g)].map((m) => m[1]) : ['store.js', 'apptools.js', 'transcript.js'];
  for (const name of names) queue.push(path.join(SRC, 'renderer', 'js', name));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readText(file).matchAll(SPECIFIER)) {
      const found = resolveLocal(file, spec);
      // (Only ours: node_modules don't change under a running daemon.)
      if (found && found.startsWith(SRC + path.sep)) queue.push(found);
    }
  }
  codeList = [...seen].sort();
  return codeList;
}

function codeVersion() {
  const parts = codeFiles().map((file) => `${path.relative(SRC, file)}\0${readText(file)}`);
  return hash(parts.join('\0')).slice(0, 16);
}

/** Read whole lines off a socket, each a JSON message (only what just came is searched for a line's end). */
function onMessages(socket, handle) {
  let parts = []; // the start of a line not ended yet
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    let from = 0;
    let index;
    while ((index = chunk.indexOf('\n', from)) !== -1) {
      parts.push(chunk.slice(from, index));
      from = index + 1;
      const line = parts.length === 1 ? parts[0] : parts.join('');
      parts = [];
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handle(message);
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  });
}

const sendLine = (socket, message) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
};

module.exports = { METHODS, pipePath, infoFile, codeVersion, codeFiles, onMessages, sendLine };
