// Task sessions (src/main/tasks.js): reading big transcripts a piece at a time, a resumed
// session read from where it was, a terminal's tail, permission dialogs vs Claude's own
// words, hook files cleaned up. A stand-in for Claude (a Node script in a real terminal);
// no real Claude session starts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTasks, readNew, tailLines, createTail, HISTORY_BYTES, READ_MAX } = require('../src/main/tasks.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await wait(50);
  }
  assert.fail(`timed out: ${what}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-tasks-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

/* ------------------ a growing file, a piece at a time ------------------ */
{
  const file = path.join(root, 'grow.jsonl');
  const written = [];
  let text = '';
  for (let i = 0; i < 400; i += 1) {
    // Lines of every size, one far longer than a single read, and some UTF-8.
    const line = JSON.stringify({ i, text: 'é✓'.repeat(i === 200 ? 700_000 : (i * 37) % 5000) });
    written.push(line);
    text += `${line}\n`;
  }
  fs.writeFileSync(file, `${text}{"partial":`);
  let offset = 0;
  let carry = null;
  const read = [];
  let looks = 0;
  for (;;) {
    const next = readNew(file, offset, carry);
    looks += 1;
    assert.ok(next.offset - offset <= READ_MAX, 'one look reads at most READ_MAX');
    read.push(...next.lines);
    offset = next.offset;
    carry = next.carry;
    if (!next.more) break;
  }
  assert.ok(looks > 2, 'a big backlog takes several looks');
  assert.deepEqual(read, written, 'every whole line, once, in order');
  // The last line ends later: it comes then.
  fs.appendFileSync(file, '1}\n');
  const rest = readNew(file, offset, carry);
  assert.deepEqual(rest.lines, ['{"partial":1}']);
  assert.equal(rest.carry, null);
  // Rewritten shorter: from the top.
  fs.writeFileSync(file, '{"a":1}\n');
  assert.deepEqual(readNew(file, rest.offset, null).lines, ['{"a":1}']);
}

/* ------------------------- a terminal's tail ------------------------- */
{
  const tail = createTail(1000);
  let all = '';
  for (let i = 0; i < 5000; i += 1) {
    const chunk = `${i}:${'x'.repeat(i % 97)}|`;
    tail.push(chunk);
    all += chunk;
    if (i % 777 === 0) assert.equal(tail.text(), all.slice(-1000));
  }
  assert.equal(tail.text(), all.slice(-1000));
  tail.push('end');
  assert.equal(tail.text(), (all + 'end').slice(-1000));
}

/* ---------- a session started with a fake Claude in a terminal ---------- */
const userData = path.join(root, 'ud');
const hooksDir = path.join(userData, 'hooks');
const project = path.join(root, 'proj');
fs.mkdirSync(hooksDir, { recursive: true });
fs.mkdirSync(project);
const transcript = path.join(root, 'session.jsonl');
const SESSION = '11111111-2222-3333-4444-555555555555';
// Its past: more than one history read takes, prompts and answers.
{
  const filler = 'lorem ipsum '.repeat(250);
  let past = '';
  for (let i = 0; past.length < HISTORY_BYTES * 1.5; i += 1) {
    past += `${JSON.stringify({ type: 'user', uuid: `old-u${i}`, timestamp: new Date(Date.now() - 3_600_000).toISOString(), message: { role: 'user', content: `question ${i}` } })}\n`;
    past += `${JSON.stringify({ type: 'assistant', uuid: `old-a${i}`, timestamp: new Date(Date.now() - 3_600_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i} ${filler}` }] } })}\n`;
  }
  fs.writeFileSync(transcript, past);
}
// Where the hooks said it is (as they did when it last ran).
fs.writeFileSync(path.join(hooksDir, 'transcripts.json'), JSON.stringify({ [SESSION]: transcript }));
// A hook file left by a session long gone.
fs.writeFileSync(path.join(hooksDir, 'gone.jsonl'), '{"event":"Stop"}\n');

// The stand-in: prints a reply that asks a question in words, then a real permission dialog,
// with its tool call in the transcript before (or, FAKE_ORDER=late, after) the dialog.
const fake = path.join(root, 'fake-claude.cjs');
fs.writeFileSync(
  fake,
  `const fs = require('fs'), path = require('path');
const T = process.env.FAKE_TRANSCRIPT, S = process.env.FAKE_SESSION, late = process.env.FAKE_ORDER === 'late';
const hook = (event) => fs.appendFileSync(path.join(process.env.XODE_HOOKS, process.env.XODE_TASK + '.jsonl'), JSON.stringify({ at: Date.now(), event, session: S, transcript: T }) + '\\n');
const line = (o) => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\\n');
const say = (text) => process.stdout.write(text.replace(/\\n/g, '\\r\\n'));
hook('SessionStart');
say(' Claude Code\\n\\n');
const tool = () => line({ type: 'assistant', uuid: 'new-1', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm x' } }] } });
const dialog = () => say(' Bash command\\n   rm x\\n\\n Do you want to proceed?\\n \\u276f 1. Yes\\n   2. No, and tell Claude what to do differently (esc)\\n');
setTimeout(() => say('\\u25cf All done. Do you want to create a PR?\\n\\n'), 300);
setTimeout(late ? dialog : tool, 1200);
setTimeout(late ? tool : dialog, 1500);
setInterval(() => {}, 1000);
`
);
process.env.FAKE_TRANSCRIPT = transcript;
process.env.FAKE_SESSION = SESSION;

const events = [];
const tasks = createTasks({
  hooksDir,
  settingsFile: path.join(hooksDir, 'settings.json'),
  send: (channel, payload) => events.push({ channel, payload, at: Date.now() }),
  found: () => ({ claude: { file: process.execPath, args: [fake] } }),
});
const of = (id, channel) => events.filter((e) => e.payload.id === id && e.channel === channel);
const printed = (id) => of(id, 'task:data').map((e) => e.payload.data).join('');

try {
  // Resumed with bypass on: its past isn't read again; Claude's words asking something aren't a dialog.
  const reply = tasks.start({ id: 'r', kind: 'claude', cwd: project, sessionId: SESSION, resume: true, bypass: true, cols: 100, rows: 30 });
  assert.equal(reply.started, true, JSON.stringify(reply));
  assert.ok(!fs.existsSync(path.join(hooksDir, 'gone.jsonl')), 'hook files of sessions no longer running are swept');
  await until(() => printed('r').includes('create a PR?'), 10000, 'the reply printed');
  await wait(500);
  assert.equal(of('r', 'task:ask').length, 0, 'a reply asking "Do you want to create a PR?" is not a permission question');
  await until(() => of('r', 'task:ask').length > 0, 10000, 'the real dialog seen');
  assert.equal(of('r', 'task:ask').length, 1);
  assert.equal(of('r', 'task:ask')[0].payload.need, 'permission');
  // Only what it added: the old lines are history.
  const lines = of('r', 'task:transcript').flatMap((e) => e.payload.lines);
  assert.deepEqual(lines.map((l) => l.uuid), ['new-1'], 'a resumed session is read from where it was');
  assert.ok(of('r', 'task:hook').some((e) => e.payload.event === 'SessionStart'));
  // Its tail: all it printed; a window starting to watch gets only what already went out.
  assert.match(tasks.tail('r'), /create a PR\?/);
  assert.ok(tasks.tail('r', { sent: true }).length <= tasks.tail('r').length);

  // The window opening the old task: the end of its transcript only, from where an exchange starts.
  const history = tasks.history(project, SESSION);
  const bytes = history.reduce((n, l) => n + JSON.stringify(l).length + 1, 0);
  assert.ok(bytes <= HISTORY_BYTES, `history is its end (${bytes} bytes)`);
  assert.equal(history[0].type, 'user', 'it starts at a prompt');
  assert.equal(history.at(-1).uuid, 'new-1');
  assert.ok(tailLines(transcript, 1000).lines.length >= 0);

  // Ended: its hook file goes.
  const hookFile = path.join(hooksDir, 'r.jsonl');
  assert.ok(fs.existsSync(hookFile));
  tasks.kill('r');
  await until(() => of('r', 'task:exit').length === 1, 10000, 'it ended');
  assert.ok(!fs.existsSync(hookFile), 'its hook file is deleted when the session ends');

  // The dialog drawn before its tool call reached the transcript: seen once the call is read.
  process.env.FAKE_ORDER = 'late';
  const late = tasks.start({ id: 'l', kind: 'claude', cwd: project, sessionId: SESSION, resume: true, bypass: true, cols: 100, rows: 30 });
  assert.equal(late.started, true);
  await until(() => of('l', 'task:ask').length > 0, 10000, 'the dialog seen once its tool call is read');
  assert.equal(of('l', 'task:ask').length, 1);
  tasks.kill('l');
  await until(() => of('l', 'task:exit').length === 1, 10000, 'it ended');

  // Bypass off: a dialog can come any time; Claude's words still aren't one.
  delete process.env.FAKE_ORDER;
  const off = tasks.start({ id: 'o', kind: 'claude', cwd: project, sessionId: SESSION, resume: true, bypass: false, cols: 100, rows: 30 });
  assert.equal(off.started, true);
  await until(() => printed('o').includes('create a PR?'), 10000, 'the reply printed');
  await wait(400);
  assert.equal(of('o', 'task:ask').length, 0);
  await until(() => of('o', 'task:ask').length === 1, 10000, 'the dialog seen');
  tasks.kill('o');
  await until(() => of('o', 'task:exit').length === 1, 10000, 'it ended');
} finally {
  tasks.killAll();
}

console.log('tasks ok');
