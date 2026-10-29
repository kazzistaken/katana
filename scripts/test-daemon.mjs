import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTaskStates } = require('../src/daemon/taskstate.js');
const { pipePath, infoFile, onMessages, sendLine } = require('../src/daemon/protocol.js');
const { createDaemonClient } = require('../src/main/daemonclient.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await wait(50);
  }
  assert.fail(`timed out: ${what}`);
}

/* ----------------------- where a task stands ----------------------- */
{
  const seen = [];
  const states = createTaskStates({ emit: (u) => seen.push(u) });
  const last = () => seen.at(-1);

  // A first message: working at once; Claude's Stop hook: finished.
  states.started('a', { kind: 'claude', prompt: 'fix it' });
  assert.equal(last().state, 'working');
  states.hook('a', { event: 'PreToolUse', tool: 'Bash', desc: 'Run the tests' });
  assert.equal(last().tool.desc, 'Run the tests');
  states.hook('a', { event: 'Stop' });
  assert.equal(last().state, 'idle');
  assert.equal(last().finished, true);
  assert.ok(last().finishedAt > 0);

  // A permission question: needs you, with its words; answered: back to work.
  states.said('a');
  states.hook('a', { event: 'Notification', message: 'Claude needs your permission to use Bash' });
  assert.equal(last().state, 'needs');
  assert.equal(last().need, 'permission');
  assert.match(last().message, /permission/);
  states.answered('a');
  assert.equal(last().state, 'working');
  assert.equal(last().message, '');

  // Asked again, answered in the terminal: the tool running (PostToolUse) says so too, clock kept.
  states.hook('a', { event: 'Notification', message: 'Claude needs your permission to use Write' });
  assert.equal(last().state, 'needs');
  const clock = states.get('a').since;
  states.hook('a', { event: 'PostToolUse', tool: 'Write' });
  assert.equal(last().state, 'working');
  assert.equal(last().since, clock);

  // Its own question tool: asking you (with the question), not a permission; answered, back to work.
  states.hook('a', { event: 'PreToolUse', tool: 'AskUserQuestion', detail: 'Which database should I use?' });
  assert.equal(last().state, 'needs');
  assert.equal(last().need, 'asking');
  assert.equal(last().message, 'Which database should I use?');
  states.hook('a', { event: 'Notification', message: 'Claude needs your permission to use AskUserQuestion' });
  assert.equal(last().need, 'asking', 'still its question, not a permission');
  states.ask('a', 'Claude wants permission for its next step.');
  assert.equal(last().need, 'asking');
  states.hook('a', { event: 'PostToolUse', tool: 'AskUserQuestion' });
  assert.equal(last().state, 'working');
  assert.equal(last().need, '');
  states.ask('a', 'Claude Code asks whether you trust this folder.', 'permission');
  assert.equal(last().need, 'permission');
  states.answered('a');

  // Esc: the transcript says interrupted (no Stop hook): stopped, not finished.
  states.stopping('a');
  states.transcript('a', [{ type: 'user', timestamp: new Date().toISOString(), message: { content: '[Request interrupted by user]' } }]);
  assert.equal(last().state, 'idle');
  assert.equal(last().finished, false);
  assert.equal(last().stopped, true);

  // An API error (a limit, an outage) ends the turn with no Stop hook: not stuck working.
  states.hook('a', { event: 'UserPromptSubmit' });
  assert.equal(last().state, 'working');
  states.transcript('a', [{ type: 'assistant', isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }]);
  assert.equal(last().state, 'idle');

  // A shell: working from a message until its terminal goes quiet.
  states.started('s', { kind: 'shell' });
  states.said('s');
  assert.equal(last().state, 'working');
  states.quiet('s', 100);
  assert.equal(last().state, 'working');
  states.get('s').since -= 5000;
  states.quiet('s', 5000);
  assert.equal(last().state, 'idle');
  assert.equal(last().finished, true);

  // The session ending mid-turn isn't "finished".
  states.said('s');
  states.exited('s');
  assert.equal(last().state, 'idle');
  assert.equal(last().finished, false);
  assert.equal(last().running, false);

  assert.deepEqual(states.snapshot().map((t) => t.id).sort(), ['a', 's']);
  states.forget('a');
  states.forget('s');
}

/* --------------- the daemon itself, with a real shell --------------- */
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katanad-'));
  const userDataDir = path.join(root, 'ud');
  const project = path.join(root, 'proj');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(userDataDir, 'state.json'), JSON.stringify({ version: 2, settings: {}, projects: [{ id: 'p', name: 'proj', path: project }], tasks: [] }));

  const events = [];
  const options = { userDataDir, onEvent: (channel, payload) => events.push({ channel, payload }) };
  let client = createDaemonClient(options);
  const hello = await client.connect();
  assert.ok(hello.pid > 0 && hello.pid !== process.pid, 'it runs on its own');

  // Only trusted folders.
  assert.match((await client.call('start', { id: 'x', kind: 'shell', cwd: root })).error, /not a trusted folder/);

  const started = await client.call('start', { id: 't1', kind: 'shell', cwd: project, cols: 100, rows: 30 });
  assert.equal(started.started, true);
  await wait(1200);
  await client.call('say', 't1', 'echo katana-daemon-ok');
  const printed = () => events.filter((e) => e.channel === 'task:data' && e.payload.id === 't1').map((e) => e.payload.data).join('');
  await until(() => (printed().match(/katana-daemon-ok/g) || []).length >= 2, 15000, 'the shell printed it');
  await until(() => events.some((e) => e.channel === 'task:state' && e.payload.id === 't1' && e.payload.finished), 15000, 'the shell went quiet: finished');

  // "F5": this window's line goes, a new one comes. The task is still there.
  client.close();
  await wait(300);
  client = createDaemonClient(options);
  const again = await client.connect();
  assert.equal(again.pid, hello.pid, 'the same daemon');
  const snapshot = await client.call('snapshot');
  const t1 = snapshot.find((t) => t.id === 't1');
  assert.equal(t1.running, true);
  assert.equal(t1.state, 'idle');
  assert.ok(t1.finishedAt > 0);
  assert.match(await client.call('tail', 't1'), /katana-daemon-ok/);

  // A wrong token gets nothing.
  const refused = await new Promise((resolve) => {
    const line = net.connect(pipePath(userDataDir), () => sendLine(line, { id: 1, method: 'hello', params: { token: 'nope' } }));
    onMessages(line, (message) => resolve(message));
    line.on('error', () => resolve({ error: 'closed' }));
  });
  assert.ok(refused.error);

  // A second daemon for the same folder leaves at once.
  const second = spawn(process.execPath, [path.join('src', 'daemon', 'katanad.js'), userDataDir], { stdio: 'ignore' });
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(code, 0);
  assert.equal((await client.call('status')).pid, hello.pid);

  // It won't leave while a task runs, unless told to; then its info file goes too.
  assert.equal((await client.call('shutdown', {})).ok, false);
  await client.call('killAll');
  await until(() => events.some((e) => e.channel === 'task:exit' && e.payload.id === 't1'), 5000, 'the shell ended');
  await wait(200);
  assert.equal((await client.call('shutdown', {})).ok, true);
  await until(() => !fs.existsSync(infoFile(userDataDir)), 5000, 'the daemon left');
  await until(() => events.some((e) => e.channel === 'daemon:lost'), 3000, 'the line dropped');
  client.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('daemon ok');
