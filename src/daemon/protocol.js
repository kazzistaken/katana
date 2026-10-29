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
  'start', 'say', 'write', 'resize', 'stop', 'answered', 'kill', 'tail', 'running', 'quiet', 'history', 'snapshot', 'killAll', 'status', 'shutdown',
  // Katana, and a window answering one of her tool calls.
  'agentAsk', 'agentStop', 'agentSay', 'agentRemind', 'agentWatch', 'agentDrop', 'agentState', 'toolResult', 'screen',
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

// The daemon's own code: when any of it changes on disk, a running daemon is out of date.
const CODE = [
  path.join(__dirname, 'katanad.js'),
  path.join(__dirname, 'core.js'),
  path.join(__dirname, 'taskstate.js'),
  path.join(__dirname, 'protocol.js'),
  path.join(__dirname, 'agent.js'),
  path.join(__dirname, 'toolport.js'),
  path.join(__dirname, 'headless.js'),
  path.join(__dirname, 'notify.js'),
  path.join(__dirname, 'team.js'),
  path.join(__dirname, '..', 'main', 'apptooldefs.js'),
  path.join(__dirname, '..', 'main', 'mcp-app.cjs'),
  path.join(__dirname, '..', 'main', 'worktree.js'),
  path.join(__dirname, '..', 'main', 'tasks.js'),
  path.join(__dirname, '..', 'main', 'runargs.js'),
  path.join(__dirname, '..', 'main', 'claude.js'),
  path.join(__dirname, '..', 'main', 'shells.js'),
  path.join(__dirname, '..', 'main', 'statefile.js'),
  path.join(__dirname, '..', 'main', 'hook.cjs'),
  // The window's own code headless.js runs.
  path.join(__dirname, '..', 'renderer', 'js', 'store.js'),
  path.join(__dirname, '..', 'renderer', 'js', 'apptools.js'),
  path.join(__dirname, '..', 'renderer', 'js', 'transcript.js'),
];

function codeVersion() {
  const parts = CODE.map((file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  });
  return hash(parts.join('\0')).slice(0, 16);
}

/** Read whole lines off a socket, each a JSON message. */
function onMessages(socket, handle) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handle(message);
    }
  });
}

const sendLine = (socket, message) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
};

module.exports = { METHODS, pipePath, infoFile, codeVersion, onMessages, sendLine };
