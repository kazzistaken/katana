import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCore } = require('../src/daemon/core.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await wait(50);
  }
  assert.fail(`timed out: ${what}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-away-'));
const userDataDir = path.join(root, 'ud');
const project = path.join(root, 'proj');
fs.mkdirSync(userDataDir);
fs.mkdirSync(project);
const stateFile = path.join(userDataDir, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({ version: 2, settings: { currentProject: 'p1' }, projects: [{ id: 'p1', name: 'proj', path: project, trustedAt: 1 }], tasks: [] }));
const saved = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const events = [];
const notes = [];
const sentToWindow = [];
const core = createCore({
  userDataDir,
  block: true, // no Claude here
  emit: (channel, payload) => events.push({ channel, payload }),
  notifier: (note) => notes.push(note),
  toWindow: (channel, payload) => {
    sentToWindow.push({ channel, payload });
    return true;
  },
});

/* ------------------------- no window open ------------------------- */
{
  const state = await core.tool('app_state', {});
  assert.equal(state.result.screen, 'No Katana window is open.');
  assert.deepEqual(state.result.folders.map((f) => f.name), ['proj']);

  // Settings change in the saved state, checked as in the window; her memory stays out of it.
  assert.deepEqual((await core.tool('set_setting', { key: 'theme', value: 'black' })).result, { theme: 'black' });
  assert.equal(saved().settings.theme, 'black');
  assert.equal(saved().agent, undefined);
  assert.match((await core.tool('set_setting', { key: 'theme', value: 'pink' })).error, /one of/);

  // A task, made the way the window makes one, and its session started.
  const made = await core.tool('new_task', { folder: 'proj', agent: 'shell', prompt: 'echo katana-away-ok', title: 'Away check' });
  const id = made.result.id;
  assert.equal(saved().tasks[0].id, id);
  assert.equal(saved().tasks[0].started, true);
  assert.ok(core.running().includes(id));
  const printed = () => events.filter((e) => e.channel === 'task:data' && e.payload.id === id).map((e) => e.payload.data).join('');
  await until(() => (printed().match(/katana-away-ok/g) || []).length >= 2, 15000, 'the shell printed it');
  assert.match((await core.tool('read_terminal', { task: id })).result.screen, /katana-away-ok/);

  // Done, with nobody looking: one quiet notification.
  await until(() => notes.length, 15000, 'a notification');
  assert.deepEqual(notes[0], { title: 'Away check', body: 'Finished.', sound: false });

  // Reminders are hers.
  assert.ok((await core.tool('remind', { minutes: 5, text: 'look at the page' })).result.id);
  assert.equal(core.agentState().reminders[0].text, 'look at the page');
  assert.equal((await core.tool('cancel_reminder', { reminder: 'look at' })).result.cancelled, 'look at the page');
  // And her recurring checks.
  assert.equal((await core.tool('watch', { every: 10, check: 'Is CI green?' })).result.every, 10);
  assert.equal((await core.tool('app_state', {})).result.checks[0].check, 'Is CI green?');
  assert.equal((await core.tool('cancel_watch', { watch: 'ci green' })).result.cancelled, 'Is CI green?');
  assert.equal(core.agentState().watches.length, 0);
  assert.match((await core.tool('cancel_watch', { watch: 'nope' })).error, /no check/);

  // What needs a screen says so.
  assert.match((await core.tool('show', { view: 'katana' })).error, /No Katana window is open/);
  assert.match((await core.tool('trust_folder', { path: project })).error, /confirm/);

  assert.deepEqual((await core.tool('finish_task', { task: id })).result, { done: true });
  assert.ok(saved().tasks[0].doneAt > 0);
  await until(() => !core.running().includes(id), 5000, 'its session ended');
  assert.equal(sentToWindow.length, 0, 'nothing went to a window');
}

/* ------------------------------ alerts ----------------------------- */
{
  // Done alerts close together are one; needs comes at once, with sound.
  notes.length = 0;
  core.alert({ level: 'done', title: 'Fix cart', body: 'Finished.', taskId: 't1' });
  core.alert({ level: 'done', title: 'Add tests finished', body: 'All green.', taskId: 't2' });
  core.alert({ level: 'needs', title: 'Login fix', body: 'Claude needs your permission to use Bash', taskId: 't3' });
  core.alert({ level: 'fyi', title: 'Nothing', body: 'never shown' });
  assert.deepEqual(notes, [{ title: 'Login fix', body: 'Claude needs your permission to use Bash', sound: true }]);
  await until(() => notes.length === 2, 8000, 'the done alerts, grouped');
  assert.deepEqual(notes[1], { title: '2 tasks finished', body: 'Fix cart, Add tests', sound: false });
}

/* ---------------------- with a window open ----------------------- */
{
  core.setWindows(1);
  // Alerts go to the window to play (it knows whether you're looking).
  core.alert({ level: 'reminder', title: 'Reminder', body: 'look at the page' });
  assert.deepEqual(events.at(-1), { channel: 'alert', payload: { level: 'reminder', title: 'Reminder', body: 'look at the page' } });
  assert.equal(notes.length, 2, 'no Windows notification from here while a window is open');
  const asked = core.tool('show', { view: 'katana' });
  await until(() => sentToWindow.length === 1, 2000, 'the window was asked');
  const { channel, payload } = sentToWindow[0];
  assert.equal(channel, 'tools:call');
  assert.equal(payload.name, 'show');
  core.toolResult(payload.callId, { shown: 'katana' });
  assert.deepEqual((await asked).result, { shown: 'katana' });

  // The window closes before answering: the call fails instead of hanging.
  const orphan = core.tool('app_state', {});
  await until(() => sentToWindow.length === 2, 2000, 'asked again');
  core.setWindows(0);
  assert.match((await orphan).error, /closed/);
}

core.close();
await wait(300);
fs.rmSync(root, { recursive: true, force: true });
console.log('headless ok');
