import assert from 'node:assert/strict';
import { createStore, DEFAULT_SETTINGS, NO_BACKGROUND_COLORS, flatColor } from '../src/renderer/js/store.js';
import { branchesUnderParents } from '../src/renderer/js/store.js';

function fakeApi(saved = null) {
  const api = {
    saves: [],
    state: {
      load: async () => saved,
      save: async (state) => {
        api.saves.push(JSON.parse(JSON.stringify(state)));
        return true;
      },
    },
  };
  return api;
}

{
  // load with no saved state gives the defaults and nothing else
  const store = createStore(fakeApi());
  await store.load();
  assert.deepEqual(store.state.settings, DEFAULT_SETTINGS);
  assert.equal(store.state.settings.taskModel, 'claude-opus-5-5');
  assert.deepEqual(store.state.projects, []);
  assert.deepEqual(store.state.tasks, []);
  assert.deepEqual(store.state.agent, { sessionId: '', messages: [], reminders: [], watches: [] });
}

{
  // addProject twice with the same folder returns the same project
  const store = createStore(fakeApi());
  await store.load();
  const a = store.addProject('C:\\Code\\Shop');
  const b = store.addProject('c:\\code\\shop\\');
  assert.equal(a.id, b.id);
  assert.equal(store.state.projects.length, 1);
  assert.equal(a.name, 'Shop');
  assert.equal(store.projectByName('shop').id, a.id);
}

{
  // a Claude task gets its own session id and runs in the project (or its worktree)
  const store = createStore(fakeApi());
  await store.load();
  const project = store.addProject('C:\\Code\\Shop');
  const task = store.newTask(project.id, { title: 'Fix the cart' });
  assert.equal(task.kind, 'claude');
  assert.match(task.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(task.cwd, 'C:\\Code\\Shop');
  assert.equal(task.model, 'claude-opus-5-5');
  const shell = store.newTask(project.id, { kind: 'shell' });
  assert.equal(shell.sessionId, '');
  const tree = { path: 'C:\\Code\\Shop\\.xode\\worktrees\\x', branch: 'xode/x', base: 'main', top: 'C:\\Code\\Shop' };
  assert.equal(store.newTask(project.id, { worktree: tree }).cwd, tree.path);
  // a branch: its own session, in the folder it came from, copying the other's conversation
  const branch = store.newTask(project.id, { cwd: tree.path, forkOf: task.sessionId });
  assert.equal(branch.cwd, tree.path);
  assert.equal(branch.worktree, null);
  assert.equal(branch.forkOf, task.sessionId);
  assert.notEqual(branch.sessionId, task.sessionId);
  assert.equal(task.forkOf, '');
}

{
  // open tasks are newest first; Done takes one out, reopening brings it back
  const store = createStore(fakeApi());
  await store.load();
  const project = store.addProject('C:\\Code\\Shop');
  const first = store.newTask(project.id);
  const second = store.newTask(project.id);
  second.updatedAt = first.updatedAt + 10;
  assert.deepEqual(store.openTasks().map((t) => t.id), [second.id, first.id]);
  store.markDone(second.id);
  assert.deepEqual(store.openTasks().map((t) => t.id), [first.id]);
  store.markDone(second.id, false);
  assert.equal(store.openTasks().length, 2);
}

{
  // deleting a task says so first; removing a project removes its tasks
  const store = createStore(fakeApi());
  await store.load();
  const project = store.addProject('C:\\Code\\Shop');
  const task = store.newTask(project.id);
  const seen = [];
  store.on('task-deleting', (id) => seen.push([id, Boolean(store.task(id))]));
  store.deleteTask(task.id);
  assert.deepEqual(seen, [[task.id, true]]);
  const other = store.newTask(project.id);
  store.removeProject(project.id);
  assert.equal(store.task(other.id), null);
  assert.equal(seen.length, 2);
}

{
  // the agent's messages and reminders are kept
  const store = createStore(fakeApi());
  await store.load();
  const heard = [];
  store.on('agent-message', (m) => heard.push(m.text));
  store.agentSay('user', 'start a task');
  store.agentSay('agent', 'Started it.');
  assert.deepEqual(heard, ['start a task', 'Started it.']);
  const reminder = store.addReminder(5, 'check the build');
  assert.ok(reminder.at > Date.now() + 4 * 60000);
  store.dropReminder(reminder.id);
  assert.deepEqual(store.state.agent.reminders, []);
}

{
  // saved state comes back, with missing fields filled in; old Manager chats are left behind
  const store = createStore(
    fakeApi({
      version: 1,
      settings: { theme: 'rooftop-rain' },
      projects: [{ id: 'p', name: 'Shop', path: 'C:\\Shop', trustedAt: 1 }],
      chats: [{ id: 'c', projectId: 'p' }],
      tasks: [{ id: 't', projectId: 'p', sessionId: 'abc' }],
    })
  );
  await store.load();
  assert.equal(store.state.settings.theme, 'rooftop-rain');
  assert.equal(store.state.settings.ding, true);
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.tasks[0].sessionId, 'abc');
  assert.equal(store.state.tasks[0].title, 'New task');
  assert.equal(store.state.chats, undefined);
}

{
  // a drive root keeps its separator ("C:" alone means somewhere else)
  const store = createStore(fakeApi());
  await store.load();
  assert.equal(store.addProject('C:\\').path, 'C:\\');
}

{
  // settings save (debounced) the whole state
  const api = fakeApi();
  const store = createStore(api);
  await store.load();
  store.setSetting('taskEffort', 'high');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(api.saves.at(-1).settings.taskEffort, 'high');
}

{
  // a colour theme saved before they were removed falls back to the first scene
  const store = createStore(fakeApi({ version: 2, settings: { theme: 'rose-pine' } }));
  await store.load();
  assert.equal(store.state.settings.theme, 'night-lake');
}

{
  // No background is off by default
  assert.equal(DEFAULT_SETTINGS.noBackground, false);
  // Saved back when it was a theme, it loads as the setting, over the first scene
  const store = createStore(fakeApi({ version: 2, settings: { theme: 'none' } }));
  await store.load();
  assert.equal(store.state.settings.noBackground, true);
  assert.equal(store.state.settings.theme, 'night-lake');
}

{
  // No background's colour: graphite by default, first in the row, #383838
  assert.equal(DEFAULT_SETTINGS.noBackgroundColor, 'graphite');
  assert.deepEqual(NO_BACKGROUND_COLORS.map((color) => color.id), ['graphite', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green']);
  assert.equal(flatColor(DEFAULT_SETTINGS).hex, '#383838');
  // A saved one stays; one that isn't in the row (or isn't even words) loads as graphite
  const load = async (noBackgroundColor) => {
    const store = createStore(fakeApi({ version: 2, settings: { noBackgroundColor } }));
    await store.load();
    return store.state.settings.noBackgroundColor;
  };
  assert.equal(await load('green'), 'green');
  assert.equal(await load('teal'), 'graphite');
  assert.equal(await load(7), 'graphite');
  // Secondary words stay readable on every one of them
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const color of NO_BACKGROUND_COLORS) assert.ok((luminance('#bcc0c4') + 0.05) / (luminance(color.hex) + 0.05) >= 4.5, color.id);
}

{
  // On and off, the theme is kept, a scene or one of your own
  const store = createStore(fakeApi({ version: 2, settings: { theme: 'custom:a', backgrounds: [{ id: 'a', name: 'A', file: 'a.jpg' }] } }));
  await store.load();
  assert.equal(store.state.settings.noBackground, false);
  store.setSetting('noBackground', true);
  assert.equal(store.state.settings.theme, 'custom:a');
  store.setSetting('noBackground', false);
  assert.equal(store.state.settings.theme, 'custom:a');
  // Saved on, it loads on, with its theme
  const again = createStore(fakeApi({ version: 2, settings: { theme: 'rooftop-rain', noBackground: true } }));
  await again.load();
  assert.equal(again.state.settings.noBackground, true);
  assert.equal(again.state.settings.theme, 'rooftop-rain');
  // Choosing a theme turns it off, so the theme shows
  again.setSetting('theme', 'night-lake');
  assert.equal(again.state.settings.noBackground, false);
  assert.equal(again.state.settings.theme, 'night-lake');
}


// A branch sits straight under its parent, whatever either is doing.
{
  const t = (id, sessionId, forkOf = '') => ({ id, sessionId, forkOf });
  const order = (list) => branchesUnderParents(list).map((task) => task.id).join(' ');
  assert.equal(order([t('a', 'sa'), t('b', 'sb')]), 'a b', 'no branches: as it was');
  assert.equal(order([t('branch', 'sx', 'sc'), t('a', 'sa'), t('c', 'sc')]), 'a c branch', 'a busy branch still goes under its parent');
  assert.equal(order([t('c', 'sc'), t('a', 'sa'), t('two', 'st', 'sc'), t('one', 'so', 'sc')]), 'c two one a', 'several, in the order given');
  assert.equal(order([t('leaf', 'sl', 'sm'), t('middle', 'sm', 'sr'), t('root', 'sr')]), 'root middle leaf', 'a branch of a branch');
  assert.equal(order([t('orphan', 'so', 'gone'), t('a', 'sa')]), 'orphan a', 'its parent is gone: stays where it was');
  assert.equal(order([t('x', 'sx', 'sy'), t('y', 'sy', 'sx')]), 'x y', 'a loop is still listed');
}

console.log('store ok');
