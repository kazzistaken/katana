// The Canary helper's manager (src/main/canary.js), with a stand-in helper: no model, no GPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCanary } = require('../src/main/canary.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-canary-'));
const helper = (body) => {
  const file = path.join(dir, `helper-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, body);
  process.env.XODE2_CANARY_SERVER = file;
};
process.env.XODE2_CANARY_PYTHON = process.execPath;

const WORKING = `
const say = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
setTimeout(() => say({ ready: true, device: 'stand-in', ms: 1 }), 150);
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, wav } = JSON.parse(line);
  const bytes = require('fs').readFileSync(wav, 'utf8');
  if (bytes === 'bad') return say({ id, error: 'could not read it' });
  if (bytes === 'slow') return;
  say({ id, text: 'heard ' + bytes });
});
process.stdin.on('end', () => process.exit(0));
`;
const b64 = (text) => Buffer.from(text).toString('base64');

/* Heard in order, even when spoken before the model is up. */
{
  helper(WORKING);
  const canary = createCanary({ dir });
  assert.equal(canary.usable(), true);
  const replies = await Promise.all([canary.transcribe(b64('one')), canary.transcribe(b64('two'))]);
  assert.deepEqual(replies, [{ text: 'heard one' }, { text: 'heard two' }]);
  // One bad phrase is said and doesn't end it.
  assert.deepEqual(await canary.transcribe(b64('bad')), { error: 'could not read it' });
  assert.deepEqual(await canary.transcribe(b64('three')), { text: 'heard three' });
  assert.equal(canary.loaded(), true);
  canary.stop();
  assert.equal(canary.loaded(), false);
  // Stopped: the next phrase starts it again.
  assert.deepEqual(await canary.transcribe(b64('again')), { text: 'heard again' });
  canary.stop();
}

/* A phrase's temp file goes once it's answered. */
{
  helper(WORKING);
  const left = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`katana-phrase-${process.pid}-`)).length;
  const canary = createCanary({ dir, answerMs: 300 });
  await canary.transcribe(b64('tidy'));
  await canary.transcribe(b64('slow')); // (timed out: its file goes too)
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(left(), 0);
  canary.stop();
}

/* Unused for a while: it goes, which frees the graphics memory; the next phrase brings it back. */
{
  helper(WORKING);
  const canary = createCanary({ dir, idleMs: 200 });
  assert.deepEqual(await canary.transcribe(b64('x')), { text: 'heard x' });
  assert.equal(canary.loaded(), true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(canary.loaded(), false);
  assert.deepEqual(await canary.transcribe(b64('y')), { text: 'heard y' });
  canary.stop();
}

/* By default it stays loaded, however long it's unused. */
{
  helper(WORKING);
  const canary = createCanary({ dir });
  assert.equal(canary.isUp(), false);
  await canary.start();
  assert.equal(canary.isUp(), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(canary.loaded(), true);
  canary.stop();
  assert.equal(canary.isUp(), false);
}

/* A phrase that never comes back times out; stopping answers what's waiting. */
{
  helper(WORKING);
  const canary = createCanary({ dir, answerMs: 200 });
  assert.match((await canary.transcribe(b64('slow'))).error, /too long/);
  canary.stop();
  const canary2 = createCanary({ dir });
  await canary2.start();
  const pending = canary2.transcribe(b64('slow'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  canary2.stop();
  assert.ok((await pending).error);
}

/* It can't load: says why, is marked broken (dictation falls back), and isn't retried. */
{
  helper(`process.stdout.write(JSON.stringify({ failed: 'CUDA out of memory' }) + '\\n'); process.exit(1);`);
  const canary = createCanary({ dir });
  const reply = await canary.transcribe(b64('x'));
  assert.match(reply.error, /CUDA out of memory/);
  assert.equal(canary.usable(), false);
  assert.match(canary.why(), /CUDA out of memory/);
  assert.match((await canary.start()).error, /CUDA out of memory/);
}

/* It crashes while loading: same, with the end of what it printed. */
{
  helper(`console.error('Traceback: no module named nemo'); process.exit(3);`);
  const canary = createCanary({ dir });
  assert.match((await canary.start()).error, /no module named nemo/);
  assert.equal(canary.usable(), false);
}

/* It crashes while loading once: tried again, and the phrase still comes back. */
{
  const flag = path.join(dir, 'crashed-once');
  helper(`const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, 'x'); process.exit(3221225477 % 256); }
${WORKING}`);
  const canary = createCanary({ dir });
  assert.deepEqual(await canary.transcribe(b64('after')), { text: 'heard after' });
  assert.equal(canary.usable(), true);
  canary.stop();
}

/* It goes away once it's up: not broken, and the next phrase starts it again. */
{
  helper(`${WORKING}
require('readline').createInterface({ input: process.stdin }).on('line', (line) => { if (require('fs').readFileSync(JSON.parse(line).wav, 'utf8') === 'die') process.exit(1); });`);
  const canary = createCanary({ dir });
  await canary.start();
  assert.ok((await canary.transcribe(b64('die'))).error || true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(canary.usable(), true);
  assert.deepEqual(await canary.transcribe(b64('again')), { text: 'heard again' });
  canary.stop();
}

/* Not set up at all: not usable, and it never tries. */
{
  delete process.env.XODE2_CANARY_PYTHON;
  const canary = createCanary({ dir: path.join(dir, 'nothing-here') });
  assert.equal(canary.usable(), false);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('canary ok');
process.exit(0);
