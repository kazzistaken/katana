import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pipeLines, startRun, parseClaudeLine } = require('../src/main/claude.js');
const { writeIfChanged } = require('../src/main/statefile.js');

{
  // the last line is kept even without a trailing newline
  const stream = Object.assign(new EventEmitter(), { setEncoding() {} });
  const lines = [];
  pipeLines(stream, (line) => lines.push(line));
  stream.emit('data', '{"a":1}\n{"type":"res');
  stream.emit('data', 'ult"}');
  stream.emit('end');
  assert.deepEqual(lines, ['{"a":1}', '{"type":"result"}']);
}

{
  // a start that can't spawn reports once, through its return value only
  const saved = process.env.PATH;
  process.env.PATH = '';
  const events = [];
  const reply = startRun({ runId: 'c:w1', role: 'worker', cwd: os.tmpdir(), message: 'x' }, (event) => events.push(event));
  process.env.PATH = saved;
  assert.match(reply.error, /not found/);
  assert.deepEqual(events, []);
}

{
  // the Manager's instructions file is only rewritten when they change
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-'));
  const file = path.join(dir, 'manager.md');
  assert.equal(writeIfChanged(file, 'one'), true);
  assert.equal(writeIfChanged(file, 'one'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  assert.equal(writeIfChanged(file, 'two'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // parseClaudeLine usage: how full the context window is
  const events = [];
  parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
      },
    }),
    (event) => events.push(event)
  );
  assert.deepEqual(events.at(-1), { type: 'usage', used: 122, out: 7, msgId: '' });
  parseClaudeLine(
    JSON.stringify({ type: 'result', is_error: false, result: 'ok', modelUsage: { m: { contextWindow: 1000000 } } }),
    (event) => events.push(event)
  );
  assert.deepEqual(events.find((e) => e.type === 'usage' && e.window === 1000000), { type: 'usage', window: 1000000 });
  assert.ok(events.some((e) => e.type === 'result'));
}

console.log('claude ok');
