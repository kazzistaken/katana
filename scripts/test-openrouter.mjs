import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { wav, RATE } from '../src/renderer/js/mic.js';

const require = createRequire(import.meta.url);

// A phrase as a WAV clip: 24 kHz mono 16-bit, the samples after a 44-byte header.
{
  const clip = Buffer.from(wav([new Float32Array([0, 0.5, -0.5]), new Float32Array([1])]), 'base64');
  assert.equal(clip.toString('ascii', 0, 4), 'RIFF');
  assert.equal(clip.toString('ascii', 8, 12), 'WAVE');
  assert.equal(clip.readUInt16LE(22), 1, 'mono');
  assert.equal(clip.readUInt32LE(24), RATE);
  assert.equal(clip.readUInt16LE(34), 16);
  assert.equal(clip.readUInt32LE(40), 8, 'four samples, two bytes each');
  assert.equal(clip.length, 52);
  assert.equal(clip.readInt16LE(46), 0x3fff);
  assert.equal(clip.readInt16LE(50), 0x7fff);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-or-'));
// Sealing, as Windows would do it (here: reversible and visibly not plain).
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from([...s].reverse().join('')), decryptString: (b) => [...b.toString()].reverse().join('') };

// The key: kept sealed, read back, removed.
{
  const { createKeyStore } = require('../src/main/keystore.js');
  const keys = createKeyStore({ userDataDir: () => tmp, name: 'test', safeStorage });
  assert.equal(keys.has(), false);
  assert.equal(keys.set('sk-or-abc'), true);
  assert.ok(!fs.readFileSync(path.join(tmp, 'test.key'), 'utf8').includes('sk-or-abc'), 'not kept in plain text');
  assert.equal(keys.get(), 'sk-or-abc');
  assert.equal(keys.set(''), false);
  assert.equal(keys.has(), false);
}

// Hearing, against a stand-in OpenRouter.
{
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
      if (request.headers.authorization !== 'Bearer sk-or-good') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'No auth credentials found' } }));
      }
      if (request.url === '/api/v1/audio/transcriptions') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ text: ' Start a task to add tests. ', usage: { seconds: 2 } }));
      }
      response.writeHead(404);
      return response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.XODE2_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  const { createOpenRouter } = require('../src/main/openrouter.js');
  const router = createOpenRouter({ userDataDir: () => tmp, safeStorage });

  assert.match((await router.transcribe('UklGRg==')).error, /Add your OpenRouter key/);
  router.setKey('sk-or-good');
  assert.deepEqual(await router.transcribe('UklGRg=='), { text: 'Start a task to add tests.' });
  const asked = seen.at(-1);
  assert.equal(asked.auth, 'Bearer sk-or-good');
  assert.equal(asked.body.model, 'openai/gpt-4o-transcribe');
  assert.deepEqual(asked.body.input_audio, { data: 'UklGRg==', format: 'wav' });

  router.setKey('sk-or-bad');
  assert.match((await router.transcribe('UklGRg==')).error, /didn’t accept the key/);
  server.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('openrouter ok');
