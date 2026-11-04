// state.json: written safely, with a backup; never written over when unreadable;
// headless tool calls one at a time (no lost writes); the daemon's cached read;
// the window's page taking over from headless and giving it up.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/renderer/js/store.js';

const require = createRequire(import.meta.url);
const statefile = require('../src/main/statefile.js');
const { createCore } = require('../src/daemon/core.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-state-'));
const dir = (name) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const asides = (d) => fs.readdirSync(d).filter((n) => n.includes('.unreadable-'));
const STATE = (project) => ({
  version: 2,
  settings: { currentProject: 'p1' },
  projects: [{ id: 'p1', name: 'proj', path: project, trustedAt: 1 }],
  tasks: [
    { id: 'task_a', projectId: 'p1', title: 'A', kind: 'shell', cwd: project },
    { id: 'task_b', projectId: 'p1', title: 'B', kind: 'shell', cwd: project },
    { id: 'task_c', projectId: 'p1', title: 'C', kind: 'shell', cwd: project },
  ],
});

/* --------------------------- statefile.js --------------------------- */
{
  const d = dir('file');
  const file = path.join(d, 'state.json');
  assert.deepEqual(statefile.loadStateFile(file), { state: null, from: 'none' });

  // Compact, and read back.
  statefile.writeStateFile(file, { version: 2, projects: [{ id: 'p1' }] });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('\n'));
  assert.equal(statefile.loadStateFile(file).from, 'file');
  // The next write keeps the one before as .bak.
  statefile.writeStateFile(file, { version: 2, projects: [{ id: 'p1' }, { id: 'p2' }] });
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).projects.length, 1);
  assert.ok(!fs.readdirSync(d).some((n) => n.endsWith('.tmp')), 'no temp file left');

  // Damaged: the backup is used, and the bad file is copied aside once (not on every read).
  fs.writeFileSync(file, '{"version":2,"projects":[{"id"');
  const loaded = statefile.loadStateFile(file);
  assert.equal(loaded.from, 'backup');
  assert.equal(loaded.state.projects[0].id, 'p1');
  statefile.loadStateFile(file);
  statefile.readStateFile(file);
  assert.equal(asides(d).length, 1);

  // Both damaged: an error, and readStateFile says null.
  fs.writeFileSync(`${file}.bak`, 'nope');
  const bad = statefile.loadStateFile(file);
  assert.equal(bad.state, null);
  assert.match(bad.error, /bad JSON/);
  assert.equal(statefile.readStateFile(file), null);

  // Start fresh: the bad file is moved aside (kept), then a new state can be written.
  const kept = statefile.setAsideBad(file);
  assert.ok(fs.existsSync(kept) && !fs.existsSync(file));
  statefile.writeStateFile(file, { version: 2 });
  assert.equal(statefile.loadStateFile(file).from, 'file');
}
{
  // Async writes: the latest of a burst wins, and quitting can wait for them.
  const d = dir('async');
  const file = path.join(d, 'state.json');
  const writes = [1, 2, 3, 4].map((n) => statefile.writeStateFileAsync(file, { version: 2, n }));
  assert.ok(statefile.stateWriting(file));
  await Promise.all(writes);
  await statefile.stateWritesDone(file);
  assert.ok(!statefile.stateWriting(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 4);
}
{
  // The cached reader: parsed once, read again when the file changes or when told.
  const d = dir('cache');
  const file = path.join(d, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, settings: { theme: 'rooftop-rain' } }));
  const reader = statefile.createStateReader(file);
  const first = reader.read();
  assert.equal(first.settings.theme, 'rooftop-rain');
  assert.equal(reader.read(), first, 'the same parse while the file is unchanged');
  // Another process writes it (a new file swapped in).
  statefile.writeStateFile(file, { version: 2, settings: { theme: 'night-lake' } });
  assert.equal(reader.read().settings.theme, 'night-lake');
  const again = reader.read();
  reader.invalidate();
  assert.notEqual(reader.read(), again, 'parsed again after invalidate');
}

/* ------------------------------ store.js ----------------------------- */
{
  // Unreadable: defaults on screen, nothing saved over it until the user starts fresh.
  const saves = [];
  let reset = 0;
  const store = createStore({
    state: {
      load: async () => ({ stateUnreadable: { message: 'bad JSON', file: 'x/state.json' } }),
      save: async (state) => saves.push(state),
      reset: async () => ((reset += 1), { kept: 'x/state.json.unreadable-1' }),
    },
  });
  const told = [];
  store.on('unreadable', (why) => told.push(why));
  await store.load();
  assert.deepEqual(told, [{ message: 'bad JSON', file: 'x/state.json' }]);
  assert.deepEqual(store.state.projects, []);
  store.addProject('C:\\Code\\Shop');
  store.setSetting('theme', 'rooftop-rain');
  await store.flush();
  await wait(300);
  assert.equal(saves.length, 0, 'nothing written over the unreadable file');
  assert.equal(await store.startFresh(), 'x/state.json.unreadable-1');
  assert.equal(reset, 1);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].projects[0].name, 'Shop');
  assert.equal(store.unreadable, null);
}
{
  // 'change' once for a burst, a microtask later; app errors save without a redraw.
  const saves = [];
  const store = createStore({ state: { load: async () => null, save: async (s) => saves.push(JSON.parse(JSON.stringify(s))) } });
  await store.load();
  const project = store.addProject('C:\\Code\\Shop');
  await wait(0);
  let changes = 0;
  store.on('change', () => (changes += 1));
  const task = store.newTask(project.id, { title: 'one' });
  store.patchTask(task.id, { title: 'two' });
  store.setSetting('theme', 'rooftop-rain');
  assert.equal(changes, 0, 'not in the middle of the burst');
  await Promise.resolve();
  assert.equal(changes, 1);
  await wait(0);
  assert.equal(changes, 1);
  store.addAppErrors(task.id, [{ kind: 'stderr', message: 'boom' }, { kind: 'stderr', message: 'boom' }, { kind: 'stderr', message: 'bang' }]);
  await wait(0);
  assert.equal(changes, 1, 'no redraw for app errors');
  await wait(300);
  const last = saves.at(-1).tasks.find((t) => t.id === task.id);
  assert.deepEqual(last.appErrors.map((e) => [e.message, e.count]), [['boom', 2], ['bang', 1]]);
}

/* ------------------------- headless, the daemon ------------------------ */
const project = dir('proj');
const userDataDir = dir('ud');
const stateFile = path.join(userDataDir, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify(STATE(project)));
const saved = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const notes = [];
const sentToWindow = [];
const core = createCore({
  userDataDir,
  block: true,
  emit: () => {},
  notifier: (note) => notes.push(note),
  toWindow: (channel, payload) => {
    sentToWindow.push({ channel, payload });
    return true;
  },
});

{
  // Calls at once: restart_task waits half a second inside its call; the others
  // must neither be lost nor undone by it writing back what it read.
  const results = await Promise.all([
    core.tool('restart_task', { task: 'task_a' }),
    core.tool('delete_task', { task: 'task_b' }),
    core.tool('rename_task', { task: 'task_c', title: 'Renamed' }),
    core.tool('set_setting', { key: 'theme', value: 'rooftop-rain' }),
    core.tool('new_task', { folder: 'proj', agent: 'shell', title: 'Fresh', effort: 'ultra-mega' }),
  ]);
  for (const r of results) assert.equal(r.error, undefined, r.error);
  const state = saved();
  const ids = state.tasks.map((t) => t.id);
  assert.ok(ids.includes('task_a'), 'the restarted task is still there');
  assert.ok(!ids.includes('task_b'), 'the deleted task stays deleted');
  assert.equal(state.tasks.find((t) => t.id === 'task_c').title, 'Renamed');
  assert.equal(state.settings.theme, 'rooftop-rain');
  const fresh = state.tasks.find((t) => t.title === 'Fresh');
  assert.ok(fresh, 'the new task is there');
  // Checked as the window checks it: an unknown effort isn't kept (a shell has none).
  assert.equal(fresh.effort, '');
  assert.equal(state.tasks.find((t) => t.id === 'task_a').started, true);
  core.killAll();
}
{
  // The daemon's cached read follows its own writes: notifications off, then an alert stays quiet.
  assert.equal((await core.tool('set_setting', { key: 'notifications', value: false })).error, undefined);
  core.alert({ level: 'needs', title: 'T', body: 'b' });
  assert.equal(notes.length, 0);
  // ... and another process's: on again.
  statefile.writeStateFile(stateFile, { ...saved(), settings: { ...saved().settings, notifications: true } });
  core.alert({ level: 'needs', title: 'T', body: 'b' });
  assert.equal(notes.length, 1);
}
{
  // Unreadable state (and no good backup): calls that change it refuse and write nothing.
  const good = fs.readFileSync(stateFile, 'utf8');
  fs.rmSync(`${stateFile}.bak`, { force: true });
  fs.writeFileSync(stateFile, '{ this is not json');
  const reply = await core.tool('set_setting', { key: 'theme', value: 'night-lake' });
  assert.match(reply.error, /can’t be read/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ this is not json', 'not written over');
  const before = asides(userDataDir).length;
  await core.tool('app_state', {});
  await core.tool('app_state', {});
  core.alert({ level: 'needs', title: 'T', body: 'b' });
  assert.equal(asides(userDataDir).length, before, 'not copied aside again on every read');
  // With a good backup, that is used.
  fs.writeFileSync(`${stateFile}.bak`, good);
  assert.equal((await core.tool('set_setting', { key: 'theme', value: 'night-lake' })).error, undefined);
  assert.equal(saved().settings.theme, 'night-lake');
  assert.ok(saved().tasks.some((t) => t.id === 'task_c'), 'the projects and tasks came from the backup');
}
{
  // Unknown tasks are refused by the calls that don't change the state, as in the window.
  assert.match((await core.tool('stop_task', { task: 'nope' })).error, /no task nope/);
  assert.match((await core.tool('press_keys', { task: 'nope', keys: ['enter'] })).error, /no task nope/);
}

/* ---------------------- the page takes over, gives up ---------------------- */
{
  core.setWindows(1);
  // A connected window whose page hasn't said anything: calls go to it (main holds them till it's ready).
  const first = core.tool('rename_task', { task: 'task_c', title: 'Via window' });
  await wait(20);
  assert.equal(sentToWindow.length, 1);
  // The page reloads before answering: that call fails at once, not in five minutes.
  await core.windowReady(false);
  assert.match((await first).error, /reloaded/);
  // While it reloads, calls are done here.
  assert.equal((await core.tool('rename_task', { task: 'task_c', title: 'Headless' })).error, undefined);
  assert.equal(saved().tasks.find((t) => t.id === 'task_c').title, 'Headless');
  assert.equal(sentToWindow.length, 1);
  // The page loads its state only once a headless call changing it has finished.
  const slow = core.tool('restart_task', { task: 'task_a' });
  await wait(50);
  let claimed = false;
  const claim = core.windowReady(true).then(() => (claimed = true));
  await wait(200);
  assert.equal(claimed, false, 'waits for the headless call');
  await claim;
  assert.equal((await slow).error, undefined);
  // Ready: calls go to the window again.
  const next = core.tool('app_state', {});
  await wait(20);
  assert.equal(sentToWindow.length, 2);
  core.toolResult(sentToWindow[1].payload.callId, { ok: 1 });
  assert.deepEqual((await next).result, { ok: 1 });
  core.setWindows(0);
}

core.killAll();
core.close();
await wait(300);
fs.rmSync(root, { recursive: true, force: true });
console.log('statefile ok');
