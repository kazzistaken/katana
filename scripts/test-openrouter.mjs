import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { wav, RATE } from '../src/renderer/js/mic.js';
import { pieces } from '../src/renderer/js/talk.js';

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

// Her reply in pieces to say in turn: a short first one (it decides how soon she starts), then the rest.
assert.deepEqual(pieces('Started it. The cart fix is running on its own worktree, and I will tell you when it is done. Want me to open it?'), [
  'Started it.',
  'The cart fix is running on its own worktree, and I will tell you when it is done. Want me to open it?',
]);
assert.deepEqual(pieces('On it.'), ['On it.']);
assert.deepEqual(pieces('No full stop at the end'), ['No full stop at the end']);
assert.deepEqual(pieces(''), []);

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

// Hearing and speaking, against a stand-in OpenRouter.
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
      // ElevenLabs refused this one: Gemini's raw PCM (its rate in the type) instead.
      const sent = JSON.parse(body);
      if (sent.model.startsWith('elevenlabs/') && sent.input.includes('fall back')) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'busy' } }));
      }
      if (sent.model.startsWith('google/')) {
        response.writeHead(200, { 'Content-Type': 'audio/pcm;rate=24000;channels=1' });
        return response.end(Buffer.from([1, 0, 2, 0]));
      }
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return response.end(Buffer.from([0xff, 0xfb, 0x90, 0x44]));
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

  // Her voice: ElevenLabs, the voice by name.
  const speech = await router.speak('The cart fix is in.', 'Matilda');
  assert.equal(speech.type, 'audio/mpeg');
  assert.deepEqual([...Buffer.from(speech.audio, 'base64')], [0xff, 0xfb, 0x90, 0x44]);
  const said = seen.at(-1);
  assert.equal(said.url, '/api/v1/audio/speech');
  assert.equal(said.body.model, 'elevenlabs/eleven-flash-v2.5');
  assert.equal(said.body.voice, 'XrExE9yKIg1WjnnlVkGX');
  assert.equal(said.body.response_format, 'mp3');

  // ElevenLabs fails: Gemini's voice, its PCM wrapped as a WAV at its own rate.
  const fallback = await router.speak('Please fall back.', 'Matilda');
  assert.equal(seen.at(-1).body.model, 'google/gemini-3.8-flash-tts');
  assert.equal(fallback.type, 'audio/wav');
  const played = Buffer.from(fallback.audio, 'base64');
  assert.equal(played.toString('ascii', 0, 4), 'RIFF');
  assert.equal(played.readUInt32LE(24), 24000);
  assert.deepEqual([...played.subarray(44)], [1, 0, 2, 0]);
  assert.equal(said.body.input, 'The cart fix is in.');
  assert.equal((await router.speak('x', 'not-a-voice')).audio !== undefined, true);
  assert.equal(seen.at(-1).body.voice, '21m00Tcm4TlvDq8ikWAM', 'an unknown voice is Rachel');

  router.setKey('sk-or-bad');
  assert.match((await router.transcribe('UklGRg==')).error, /didn’t accept the key/);
  server.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('openrouter ok');
