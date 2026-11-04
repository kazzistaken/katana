import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The app viewer's window watch, with Windows faked: one process snapshot
// and one walk over the windows per poll, whatever the number of apps.
const calls = { parents: 0, trees: [], windows: 0 };
const snapshot = () => new Map();
const fake = {
  available: true,
  processParents() {
    calls.parents += 1;
    return snapshot();
  },
  processTree(root, { parents } = {}) {
    calls.trees.push(parents);
    return new Set([root]);
  },
  startedAt: () => 1,
  windowsOf() {
    calls.windows += 1;
    return [];
  },
  windowRects: () => [],
  place() {},
  setToolWindow() {},
  alive: () => true,
  post() {},
  HWND_TOP: 0,
};
require.cache[require.resolve('../src/main/win32.js')] = { id: 'win32', filename: 'win32', loaded: true, exports: fake };
const { createAppView, pollDelay } = require('../src/main/appview.js');

{
  // quick while a window may be coming; calm once it's there; calmer unseen
  assert.equal(pollDelay({ windows: 0, sinceStart: 1000 }), 100);
  assert.equal(pollDelay({ windows: 0, sinceStart: 20000 }), 300);
  assert.equal(pollDelay({ windows: 1, sinceStart: 1000, sinceChange: 500 }), 100);
  assert.equal(pollDelay({ windows: 1, sinceStart: 9000, sinceChange: 8000, sinceUse: 1000 }), 200);
  assert.equal(pollDelay({ windows: 1, sinceStart: 9000, sinceChange: 8000 }), 1000);
  assert.equal(pollDelay({ windows: 2, sinceStart: 9000, sinceChange: 8000, unseen: true }), 2000);
}

if (process.platform === 'win32') {
  const wait = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'katana-poll-')), 'wait.cjs');
  fs.writeFileSync(wait, 'setTimeout(() => process.exit(0), 4000);');
  const view = createAppView({
    send() {},
    mainWindow: () => null,
    screen: { getAllDisplays: () => [], dipToScreenRect: (_d, r) => r, getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }) },
    trusted: () => true,
    // (Electron, standing in for the page's browser: a script that just waits.)
    exe: path.resolve('node_modules/electron/dist/electron.exe'),
    appPath: wait,
  });
  try {
    const a = await view.start({ taskId: 'a', cwd: os.tmpdir(), page: wait });
    const b = await view.start({ taskId: 'b', cwd: os.tmpdir(), page: wait });
    assert.ok(a.pid && b.pid, 'both started');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(calls.parents >= 3, `polled (${calls.parents})`);
    // each poll: one snapshot and one window walk for both apps
    assert.equal(calls.windows, calls.parents);
    assert.equal(calls.trees.length, calls.parents * 2);
    assert.ok(calls.trees.every((p) => p instanceof Map), 'trees built from the poll’s snapshot');
  } finally {
    view.killAll();
  }
  const after = calls.parents;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.parents, after, 'no polling once everything ended');
}

console.log('apppoll: ok');
