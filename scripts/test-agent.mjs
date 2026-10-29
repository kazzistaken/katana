import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createAgent, parseReply } = require('../src/daemon/agent.js');

// Her answer in words; an older JSON answer's reply is still read; other JSON is just words.
assert.equal(parseReply('Started it.'), 'Started it.');
assert.equal(parseReply('{"reply":"On it.","actions":[{"type":"new_task"}]}'), 'On it.');
assert.equal(parseReply('The config is {"port": 3000}.'), 'The config is {"port": 3000}.');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-agent-'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One turn, in the daemon: told the situation, uses her tools, answers; away, a finished task's news is a notification.
{
  const userDataDir = path.join(tmp, 'a');
  fs.mkdirSync(userDataDir);
  const runs = [];
  let onEvent = null;
  const runner = {
    startRun: (options, fn) => {
      runs.push(options);
      onEvent = fn;
      return { started: true };
    },
    cancelRun: () => {},
  };
  const events = [];
  const notes = [];
  const state = {
    settings: { agentModel: 'claude-opus-5-5', agentEffort: 'low' },
    projects: [{ id: 'p', name: 'Shop', path: tmp }],
    tasks: [{ id: 'task_1', title: 'Fix cart', projectId: 'p', kind: 'claude', started: false }],
    // What the window kept before she moved: taken along the first time.
    agent: { sessionId: 'old-session', messages: [{ role: 'user', text: 'from before', at: 1 }], reminders: [] },
  };
  const agent = createAgent({
    userDataDir,
    readState: () => state,
    snapshot: () => [{ id: 'task_1', state: 'working', running: true }],
    emit: (channel, payload) => events.push({ channel, payload }),
    toolsConfig: async () => 'C:/u/katana-mcp.json',
    alert: (note) => notes.push(note),
    windowOpen: () => false,
    screen: () => ({ pane: 'chat', view: 'task', task: 'task_1', title: 'Fix cart', file: '' }),
    runner,
  });
  assert.deepEqual(agent.state().messages.map((m) => m.text), ['from before']);

  agent.ask({ text: 'start a task to add tests', askId: 'a1' });
  await wait(10);
  assert.equal(agent.status().busy, true);
  assert.match(runs[0].message, /^\[user\] start a task to add tests/);
  assert.match(runs[0].message, /task_1 "Fix cart" in Shop \(claude\) — working/);
  assert.match(runs[0].message, /Window: closed/);
  assert.match(runs[0].message, /On screen: task task_1 "Fix cart", its conversation/);
  assert.match(runs[0].cwd, /katana$/, 'she works in her own folder');
  assert.equal(runs[0].dirs[0], runs[0].cwd);
  assert.equal(runs[0].sessionId, 'old-session');
  assert.equal(runs[0].mcpConfig, 'C:/u/katana-mcp.json');
  assert.equal(runs[0].model, 'claude-opus-5-5');

  onEvent({ type: 'init', sessionId: 'sess-1' });
  onEvent({ type: 'tool', tool: 'mcp__katana__new_task' });
  assert.equal(agent.status().activity, 'new task');
  onEvent({ type: 'assistant', text: 'Let me start it.' });
  onEvent({ type: 'result', ok: true, result: 'Started it.' });
  assert.equal(agent.status().busy, false);
  assert.deepEqual(events.find((e) => e.channel === 'agent:reply').payload, { askId: 'a1', reply: 'Started it.', kind: 'user' });
  assert.deepEqual(agent.state().messages.map((m) => [m.role, m.text]).slice(-2), [['user', 'start a task to add tests'], ['agent', 'Started it.']]);
  assert.equal(notes.length, 0, 'a typed question answers on screen, not as an alert');

  // A task finished: her words about it are its one, quiet alert.
  agent.tell('finished', 'Task task_1 "Fix cart" finished.', 'Fix cart finished', 'task_1');
  await wait(10);
  assert.match(runs[1].message, /^\[finished\] Task task_1/);
  assert.equal(runs[1].sessionId, 'sess-1', 'she resumes her own session');
  onEvent({ type: 'result', ok: true, result: 'The cart fix is in; try it.' });
  assert.deepEqual(notes, [{ level: 'done', title: 'Fix cart finished', body: 'The cart fix is in; try it.', taskId: 'task_1' }]);

  // Reminders are hers to keep.
  const reminder = agent.remind(5, 'check the cart');
  assert.equal(agent.state().reminders[0].text, 'check the cart');
  agent.drop(reminder.id);
  assert.equal(agent.state().reminders.length, 0);

  agent.close();
  const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'agent.json'), 'utf8'));
  assert.equal(saved.sessionId, 'sess-1');
  assert.ok(saved.messages.some((m) => m.text === 'The cart fix is in; try it.'));
}

// Stop: what was waiting is answered "Stopped." too.
{
  const userDataDir = path.join(tmp, 'b');
  fs.mkdirSync(userDataDir);
  const events = [];
  const agent = createAgent({
    userDataDir,
    readState: () => ({ settings: {}, projects: [], tasks: [] }),
    snapshot: () => [],
    emit: (channel, payload) => events.push({ channel, payload }),
    toolsConfig: async () => '',
    alert: () => {},
    windowOpen: () => true,
    runner: { startRun: () => ({ started: true }), cancelRun: () => {} },
  });
  agent.ask({ text: 'one', askId: 'x1' });
  agent.ask({ text: 'two', askId: 'x2' });
  await wait(10);
  agent.stop();
  const replies = events.filter((e) => e.channel === 'agent:reply').map((e) => [e.payload.askId, e.payload.error]);
  assert.deepEqual(replies.sort(), [['x1', 'Stopped.'], ['x2', 'Stopped.']]);
  assert.equal(agent.status().busy, false);
  agent.close();
}

// A turn that fails before it starts (its tools config throws): an error, not busy forever.
{
  const userDataDir = path.join(tmp, 'throws');
  fs.mkdirSync(userDataDir);
  const events = [];
  const agent = createAgent({
    userDataDir,
    readState: () => ({ settings: {}, projects: [], tasks: [] }),
    snapshot: () => [],
    emit: (channel, payload) => events.push({ channel, payload }),
    toolsConfig: async () => {
      throw new Error('no config');
    },
    alert: () => {},
    windowOpen: () => true,
    runner: { startRun: () => ({ started: true }), cancelRun: () => {} },
  });
  agent.ask({ text: 'hi', askId: 't1' });
  await wait(20);
  assert.equal(agent.status().busy, false, 'not busy after the turn failed');
  assert.deepEqual(events.filter((e) => e.channel === 'agent:reply').map((e) => [e.payload.askId, e.payload.error]), [['t1', 'no config']]);
  agent.close();
}

// A recurring check: quiet while NOT YET, then told once, and it ends.
{
  const userDataDir = path.join(tmp, 'c');
  fs.mkdirSync(userDataDir);
  const runs = [];
  let onEvent = null;
  const events = [];
  const notes = [];
  const agent = createAgent({
    userDataDir,
    readState: () => ({ settings: {}, projects: [], tasks: [] }),
    snapshot: () => [],
    emit: (channel, payload) => events.push({ channel, payload }),
    toolsConfig: async () => '',
    alert: (note) => notes.push(note),
    windowOpen: () => false,
    runner: {
      startRun: (options, fn) => {
        runs.push(options);
        onEvent = fn;
        return { started: true };
      },
      cancelRun: () => {},
    },
  });
  const item = agent.watch(10, 'Is CI green on main?');
  assert.equal(agent.state().watches[0].check, 'Is CI green on main?');

  // The first look is right away; a look already under way isn't queued twice.
  agent.tick();
  agent.tick();
  await wait(10);
  assert.equal(runs.length, 1);
  assert.match(runs[0].message, /^\[check\] Check chk_\w+ \(every 10 min; looked 0 times so far\): Is CI green on main\?/);
  assert.match(runs[0].message, /Checks: chk_\w+ "Is CI green on main\?" every 10 min/);
  onEvent({ type: 'result', ok: true, result: 'NOT YET' });
  assert.equal(agent.status().busy, false);
  assert.equal(agent.state().messages.length, 0, 'nothing said while it isn’t met');
  assert.equal(notes.length, 0);
  assert.equal(agent.state().watches[0].checks, 1);

  // Not due again until its interval has passed.
  agent.tick();
  await wait(10);
  assert.equal(runs.length, 1);
  agent.tick(Date.now() + 10 * 60000 + 1);
  await wait(10);
  assert.equal(runs.length, 2);
  assert.match(runs[1].message, /looked 1 times so far/);

  // A failed look stays quiet (a few in a row would end it).
  onEvent({ type: 'result', ok: false, result: 'network down' });
  assert.equal(agent.state().messages.length, 0);
  assert.equal(agent.state().watches[0].fails, 1);

  // Met: told once, with sound, and it's gone.
  agent.tick(Date.now() + 20 * 60000 + 1);
  await wait(10);
  onEvent({ type: 'result', ok: true, result: 'CI is green on main.' });
  assert.deepEqual(agent.state().messages.map((m) => [m.role, m.text]), [['agent', 'CI is green on main.']]);
  assert.deepEqual(notes, [{ level: 'reminder', title: 'Check', body: 'CI is green on main.' }]);
  assert.equal(agent.state().watches.length, 0);
  assert.deepEqual(events.filter((e) => e.channel === 'agent:reply').map((e) => e.payload.reply), ['', '', 'CI is green on main.']);
  assert.ok(!agent.state().watches.some((w) => w.id === item.id));

  // One that never comes true gives up after its hours, and says so.
  agent.watch(5, 'Is the deploy done?', 1);
  agent.tick(Date.now() + 36e5 + 1);
  assert.equal(agent.state().watches.length, 0);
  assert.match(notes.at(-1).body, /stopped checking after an hour.*Is the deploy done\?/);

  // Cancelled while she looks: nothing more is said.
  const other = agent.watch(5, 'Is the PR merged?');
  agent.tick();
  await wait(10);
  agent.drop(other.id);
  onEvent({ type: 'result', ok: true, result: 'It got merged.' });
  assert.ok(!agent.state().messages.some((m) => m.text === 'It got merged.'));

  // Kept in agent.json.
  agent.watch(15, 'Is the release out?');
  agent.close();
  const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'agent.json'), 'utf8'));
  assert.equal(saved.watches[0].check, 'Is the release out?');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent ok');
