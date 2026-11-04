import assert from 'node:assert/strict';
import { createTaskClient } from '../src/renderer/js/taskclient.js';

// A fake window bridge: records what the client asks the daemon for.
const calls = [];
const api = {
  task: {
    onState() {},
    onTranscript() {},
    onExit() {},
    onLost() {},
    start: async (options) => (calls.push(['start', options]), { started: true }),
    say: async (id, text) => (calls.push(['say', id, text]), true),
  },
};
const store = { task: () => null, patchTask() {}, renameTask() {} };
const tasks = createTaskClient({ api, store });

// Not running: the message starts (resumes) the session as its first prompt, in the
// terminal's size. Never an empty start and then typing: a Claude Code session still
// starting up drops the Enter, and the message would sit unsent in its input box.
const task = { id: 't1', kind: 'claude', cwd: 'C:/repo', sessionId: 's1', started: true, title: 'Fix it' };
await tasks.send(task, 'and now the tests', { cols: 90, rows: 20 });
assert.deepEqual(calls.map((c) => c[0]), ['start']);
assert.equal(calls[0][1].prompt, 'and now the tests');
assert.equal(calls[0][1].cols, 90);
assert.equal(calls[0][1].rows, 20);

// Running: typed in.
calls.length = 0;
await tasks.send(task, 'one more thing');
assert.deepEqual(calls, [['say', 't1', 'one more thing']]);

console.log('taskclient ok');

{
  // A resumed session's new lines come before what it said earlier was read (the daemon reads
  // on from where it was): the earlier part (history, read once) still comes first.
  let onTranscript = null;
  const old = [
    { type: 'user', uuid: 'u1', message: { content: 'first question' } },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'first answer' }] } },
  ];
  const fresh = { type: 'user', uuid: 'u2', message: { content: 'second question' } };
  let reads = 0;
  const api2 = {
    task: {
      onState() {},
      onTranscript(fn) {
        onTranscript = fn;
      },
      onExit() {},
      onLost() {},
      history: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [...old, fresh];
      },
    },
  };
  const resumed = { id: 'r1', kind: 'claude', cwd: 'C:/repo', sessionId: 's1', started: true, title: 'Fix it' };
  const client = createTaskClient({ api: api2, store: { task: (id) => (id === 'r1' ? resumed : null), patchTask() {}, renameTask() {} } });
  onTranscript({ id: 'r1', lines: [fresh] });
  await client.load(resumed); // (the chat view opening it meanwhile: the same read)
  const texts = client.get('r1').transcript.entries.map((e) => e.text);
  assert.deepEqual(texts, ['first question', 'first answer', 'second question']);
  assert.equal(reads, 1, 'its history is read once');
  onTranscript({ id: 'r1', lines: [{ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'second answer' }] } }] });
  assert.equal(client.get('r1').transcript.entries.at(-1).text, 'second answer');
  console.log('taskclient resume ok');
}

{
  // A branch starts as an empty chat. Its session is a copy of its parent's (Claude remembers it),
  // but only what's said after the branch began shows, however the lines arrive.
  const asked = [];
  let onLines = () => {};
  const old = new Date(Date.now() - 60_000).toISOString();
  const copied = [
    { type: 'user', uuid: 'u1', timestamp: old, message: { content: 'the plan' } },
    { type: 'assistant', uuid: 'a1', timestamp: old, message: { id: 'm1', content: [{ type: 'text', text: 'the answer' }] } },
  ];
  const lines = { parent: copied, mine: [] };
  const api3 = {
    task: {
      onState() {},
      onTranscript(fn) {
        onLines = fn;
      },
      onExit() {},
      onLost() {},
      history: async (_cwd, sessionId) => (asked.push(sessionId), lines[sessionId] || []),
      start: async (options) => (asked.push(options), { started: true }),
    },
  };
  const branch = { id: 'b1', kind: 'claude', cwd: 'C:/repo', sessionId: 'mine', forkOf: 'parent', started: false, title: 'Plan', createdAt: Date.now() - 30_000 };
  const client = createTaskClient({ api: api3, store: { task: (id) => (id === 'b1' ? branch : null), patchTask: (_id, patch) => Object.assign(branch, patch), renameTask() {} } });
  const shown = () => client.get('b1').transcript.entries.map((e) => e.text);
  // Not started: nothing read, nothing shown (not even its parent's).
  await client.load(branch);
  assert.deepEqual(asked, []);
  assert.deepEqual(shown(), []);
  // Its first start makes the copy, and marks where its own chat begins.
  const before = Date.now();
  await client.start(branch, 'now the tests');
  assert.equal(asked.at(-1).forkFrom, 'parent');
  assert.equal(asked.at(-1).sessionId, 'mine');
  assert.equal(asked.at(-1).resume, false);
  assert.ok(branch.branchedAt >= before);
  // The copy comes through live: the copied lines (their own old times) are left out, the new one shows.
  lines.mine = [...copied, { type: 'user', uuid: 'u2', timestamp: new Date().toISOString(), message: { content: 'now the tests' } }];
  onLines({ id: 'b1', lines: lines.mine });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(shown(), ['now the tests']);
  // Read back later (a reload): the same.
  const again = createTaskClient({ api: api3, store: { task: (id) => (id === 'b1' ? branch : null), patchTask() {}, renameTask() {} } });
  await again.load(branch);
  assert.deepEqual(again.get('b1').transcript.entries.map((e) => e.text), ['now the tests']);
  // A branch from before this (no branchedAt): cut at when it was made.
  const older = { ...branch, branchedAt: 0 };
  const third = createTaskClient({ api: api3, store: { task: () => older, patchTask() {}, renameTask() {} } });
  await third.load(older);
  assert.deepEqual(third.get('b1').transcript.entries.map((e) => e.text), ['now the tests']);
  // An ordinary task (no forkOf) keeps every line.
  const plain = { ...branch, forkOf: '' };
  const fourth = createTaskClient({ api: api3, store: { task: () => plain, patchTask() {}, renameTask() {} } });
  await fourth.load(plain);
  assert.equal(fourth.get('b1').transcript.entries.length, 3);
  console.log('taskclient branch ok');
}
