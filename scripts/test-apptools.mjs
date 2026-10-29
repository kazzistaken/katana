import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppTools as windowTools, checkSetting, keyBytes } from '../src/renderer/js/apptools.js';

const require = createRequire(import.meta.url);
const { TOOLS } = require('../src/main/apptooldefs.js');
const { createToolPort } = require('../src/daemon/toolport.js');
const here = dirname(fileURLToPath(import.meta.url));

// Every tool has a name, a description and an object schema; the window carries out each one.
{
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length > 10, t.name);
    assert.equal(t.inputSchema.type, 'object');
    for (const key of t.inputSchema.required) assert.ok(key in t.inputSchema.properties, `${t.name}.${key}`);
  }
  const handled = windowTools({ api: {}, store: {}, tasks: {}, ctx: {} }).names();
  assert.deepEqual([...handled].sort(), [...names].sort());
}

// Settings are checked before they change: known keys, right types, real choices.
{
  assert.deepEqual(checkSetting('theme', 'black'), { key: 'theme', value: 'black' });
  assert.match(checkSetting('theme', 'pink').error, /one of/);
  assert.deepEqual(checkSetting('ding', 'off'), { key: 'ding', value: false });
  assert.deepEqual(checkSetting('ding', true), { key: 'ding', value: true });
  assert.deepEqual(checkSetting('agentModel', 'opus'), { key: 'agentModel', value: 'claude-opus-5-5' });
  assert.match(checkSetting('taskModel', 'gpt').error, /opus, sonnet, haiku/);
  assert.deepEqual(checkSetting('terminalFontSize', '40'), { key: 'terminalFontSize', value: 24 });
  assert.match(checkSetting('currentProject', 'x').error, /no setting/);
  assert.match(checkSetting('nonsense', 1).error, /no setting/);
  assert.match(checkSetting('shell', 'zsh', { shells: [{ value: '' }, { value: 'pwsh' }] }).error, /shell is one of/);
  assert.deepEqual(checkSetting('liveVoiceName', 'cedar'), { key: 'liveVoiceName', value: 'cedar' });
}

// Keys for a terminal: named ones as their bytes, the rest as typed.
assert.deepEqual(keyBytes(['1', 'enter', 'Down', 'esc', 'ctrl+c', 'yes']), ['1', '\r', '\x1b[B', '\x1b', '\x03', 'yes']);

// The whole path: Claude's MCP client → mcp-app.cjs → the daemon's port → where it's routed → back.
{
  const calls = [];
  // Where it goes (a window, or headless): answers every call as they would.
  const route = async (name, args) => {
    calls.push({ name, args });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return name === 'stop_task' ? { error: 'There’s no task t9.' } : { result: { echoed: args } };
  };
  const tools = createToolPort({ route });
  const { url, token } = await tools.start();

  const server = spawn(process.execPath, [join(here, '..', 'src', 'main', 'mcp-app.cjs')], { env: { ...process.env, KATANA_TOOLS_URL: url, KATANA_TOOLS_TOKEN: token } });
  const replies = new Map();
  let buffer = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      replies.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      replies.set(id, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'katana');
  assert.ok(init.result.capabilities.tools);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await rpc('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));

  const ok = await rpc('tools/call', { name: 'new_task', arguments: { prompt: 'fix it', folder: 'shop' } });
  assert.equal(ok.result.isError, false);
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { echoed: { prompt: 'fix it', folder: 'shop' } });
  assert.deepEqual(calls.at(-1), { name: 'new_task', args: { prompt: 'fix it', folder: 'shop' } });

  const failed = await rpc('tools/call', { name: 'stop_task', arguments: { task: 't9' } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /no task t9/);

  const unknown = await rpc('tools/call', { name: 'format_disk', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.equal(calls.length, 2, 'an unknown tool goes nowhere');

  // Without the token the port says no.
  const refused = await fetch(`${url}/tools`).then((r) => r.status);
  assert.equal(refused, 401);

  server.stdin.end();
  tools.close();
}

// The app viewer: run_app opens the task and runs its app (or a page), waits for a window; output and errors by lines.
{
  const opened = [];
  const ran = [];
  let state = null;
  const errors = [{ kind: 'console', message: 'Boom', detail: 'game.js:3', count: 2, at: 1 }];
  const tasks = { t1: { id: 't1', title: 'Shop', cwd: 'C:/code/shop', appErrors: errors }, t2: { id: 't2', title: 'Game', cwd: 'C:/code/game', appErrors: [] } };
  const store = { task: (id) => tasks[id] || null };
  let current = 't1';
  const ctx = {
    current: () => current,
    open: (id) => opened.push(id),
    runApp: async (id, options) => {
      ran.push([id, options]);
      state = { label: 'npm start (electron .)', page: options.page || '', cwd: 'C:/code/shop', status: 'starting', exitCode: null, windows: [] };
      // its window comes up a moment later
      setTimeout(() => (state = { ...state, status: 'running', windows: [{ kind: 'top', title: 'Shop' }, { kind: 'layer', title: '' }] }), 60);
      return { ...state, taskId: id };
    },
    stopApp: async () => ({ ...state, status: 'exited' }),
    appState: () => state,
    appOutput: () => 'one\ntwo\nthree',
  };
  const calls = [];
  const appview = {
    screenshot: async (id) => (calls.push(['shot', id]), { image: 'iVBORw0KGgo=', width: 800, height: 600, window: 'Shop' }),
    click: async (id, o) => (calls.push(['click', id, o]), { clicked: { x: o.x, y: o.y } }),
    type: async (id, text) => (calls.push(['type', id, text]), { typed: text.length }),
    keys: async (id, keys) => (calls.push(['keys', id, keys]), { pressed: keys }),
    scroll: async (id, o) => (calls.push(['scroll', id, o]), { scrolled: o }),
  };
  const tools = windowTools({ api: { appview }, store, tasks: {}, ctx });
  const none = await tools.call('read_app_output', {});
  assert.match(none.none, /run_app/);
  assert.deepEqual(await tools.call('stop_app', {}), { already: 'No app has run beside that task.' });

  // Katana: shown, and answered once its window is up
  const started = await tools.call('run_app', { command: 'npm run dev' });
  assert.deepEqual(opened, ['t1']);
  assert.deepEqual(ran, [['t1', { command: 'npm run dev', page: '', show: true }]]);
  assert.equal(started.running, 'npm start (electron .)');
  assert.equal(started.status, 'running');
  assert.deepEqual(started.windows, ['Shop']);

  // a task's own session testing while you look at another task: not put on your screen
  current = 't2';
  await tools.call('run_app', { task: 't1', page: 'C:/code/shop/index.html', from: 'task' });
  assert.deepEqual(opened, ['t1'], 'the screen stays where you are');
  assert.deepEqual(ran.at(-1), ['t1', { command: '', page: 'C:/code/shop/index.html', show: false }]);
  current = 't1';

  // its output, and the errors it logged (waiting for the user's next message)
  const out = await tools.call('read_app_output', { lines: 2 });
  assert.equal(out.output, 'two\nthree');
  assert.deepEqual(out.windows, ['Shop']);
  assert.deepEqual(out.errors, [{ kind: 'console', message: 'Boom', detail: 'game.js:3', count: 2 }]);

  // seeing it and using it: straight to the viewer, on the right task
  assert.equal((await tools.call('app_screenshot', {})).image, 'iVBORw0KGgo=');
  await tools.call('app_click', { x: 10, y: 20, double: true });
  await tools.call('app_type', { text: 'hi\n' });
  await tools.call('app_key', { keys: ['Ctrl+A', 'Backspace'] });
  await tools.call('app_scroll', { task: 't2', x: 5, y: 5, dy: 300 });
  assert.deepEqual(calls, [
    ['shot', 't1'],
    ['click', 't1', { x: 10, y: 20, button: 'left', double: true }],
    ['type', 't1', 'hi\n'],
    ['keys', 't1', ['Ctrl+A', 'Backspace']],
    ['scroll', 't2', { x: 5, y: 5, dy: 300, dx: 0 }],
  ]);
  // the viewer's refusal is the tool's error
  appview.screenshot = async () => ({ error: 'Nothing is running in this task’s viewer. Start it with run_app.' });
  await assert.rejects(tools.call('app_screenshot', {}), /run_app/);

  assert.equal((await tools.call('stop_app', {})).status, 'exited');
  await assert.rejects(tools.call('run_app', { task: 'nope' }), /no task nope/);
  // a refusal (an untrusted folder) is the tool's error
  ctx.runApp = async () => ({ error: 'Apps only run in a trusted folder.' });
  await assert.rejects(tools.call('run_app', {}), /trusted folder/);
  // it ended straight away: said so
  ctx.runApp = async (id) => ((state = { label: 'x', status: 'failed', exitCode: 1, windows: [] }), { ...state, taskId: id });
  await assert.rejects(tools.call('run_app', {}), /ended right away \(exit code 1\)/);
}

// A task's own session reaches only the viewer tools, only for its own task, with its own token.
{
  const { VIEW_TOOLS } = require('../src/main/apptooldefs.js');
  assert.deepEqual(VIEW_TOOLS.map((t) => t.name), ['run_app', 'stop_app', 'read_app_output', 'app_screenshot', 'app_click', 'app_type', 'app_key', 'app_scroll']);
  for (const t of VIEW_TOOLS) assert.ok(!('task' in t.inputSchema.properties), t.name);
  const routed = [];
  const port = createToolPort({ route: async (name, args) => (routed.push([name, args]), { result: { ok: true } }) });
  const { url, token } = await port.start();
  const post = (auth, path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const t1 = port.viewToken('task_1');
  const listed = await fetch(`${url}/view/tools`, { headers: { Authorization: `Bearer ${t1}` } }).then((r) => r.json());
  assert.equal(listed.length, VIEW_TOOLS.length);
  // its own task, whatever it asks for
  assert.deepEqual(await post(t1, '/view/call', { name: 'app_click', args: { x: 1, y: 2, task: 'task_2' } }), [200, { result: { ok: true } }]);
  assert.deepEqual(routed.at(-1), ['app_click', { x: 1, y: 2, task: 'task_1', from: 'task' }]);
  // not Katana's other tools
  assert.match((await post(t1, '/view/call', { name: 'delete_task', args: {} }))[1].error, /no tool/);
  // a token for one task isn't another's; a made-up one is nothing; Katana's own doesn't open /view
  const forged = `task_2.${t1.split('.')[1]}`;
  assert.equal((await post(forged, '/view/call', { name: 'stop_app' }))[0], 401);
  assert.equal((await post(`task_1.${'0'.repeat(64)}`, '/view/call', { name: 'stop_app' }))[0], 401);
  assert.equal((await post(token, '/view/call', { name: 'stop_app' }))[0], 401);
  // and a task's token doesn't open Katana's tools
  assert.equal((await post(t1, '/call', { name: 'app_state' }))[0], 401);
  assert.equal(routed.length, 1);
  port.close();
}

// A task's MCP server (mcp-app.cjs with its viewer token): only the viewer tools, and a screenshot comes back as an image.
{
  const port = createToolPort({ route: async (name) => (name === 'app_screenshot' ? { result: { image: 'iVBORw0KGgo=', width: 2, height: 1, window: 'Shop' } } : { result: { ok: true } }) });
  const { url } = await port.start();
  const server = spawn(process.execPath, [join(here, '..', 'src', 'main', 'mcp-app.cjs')], { env: { ...process.env, KATANA_TOOLS_URL: url, KATANA_TOOLS_TOKEN: '', KATANA_VIEW_TOKEN: port.viewToken('task_1') } });
  const replies = new Map();
  let buffer = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      replies.get(message.id)?.(message);
    }
  });
  let next = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      next += 1;
      replies.set(next, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
  assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'katana-viewer');
  assert.ok((await rpc('tools/list', {})).result.tools.some((t) => t.name === 'app_screenshot'));
  const shot = await rpc('tools/call', { name: 'app_screenshot', arguments: {} });
  assert.deepEqual(shot.result.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(shot.result.content[1].text), { width: 2, height: 1, window: 'Shop' });
  server.stdin.end();
  port.close();
}

console.log('apptools ok');
