import assert from 'node:assert/strict';
import { createStore, DEFAULT_SETTINGS } from '../src/renderer/js/store.js';

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
      settings: { theme: 'nord' },
      projects: [{ id: 'p', name: 'Shop', path: 'C:\\Shop', trustedAt: 1 }],
      chats: [{ id: 'c', projectId: 'p' }],
      tasks: [{ id: 't', projectId: 'p', sessionId: 'abc' }],
    })
  );
  await store.load();
  assert.equal(store.state.settings.theme, 'nord');
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

console.log('store ok');
