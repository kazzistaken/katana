import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-11-'));
const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };

// Her voice straight from ElevenLabs, against a stand-in: the audio, and when each character is said.
const seen = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    seen.push({ url: request.url, key: request.headers['xi-api-key'], body: JSON.parse(body) });
    if (request.headers['xi-api-key'] !== 'sk_good') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: { message: 'bad key' } }));
      return;
    }
    const chars = [...JSON.parse(body).text];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        audio_base64: Buffer.from('ID3fake').toString('base64'),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.05) },
        normalized_alignment: null,
      })
    );
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.XODE2_ELEVENLABS_URL = `http://127.0.0.1:${server.address().port}`;
delete process.env.ELEVENLABS_API_KEY;

const { createElevenLabs } = require('../src/main/elevenlabs.js');
const { VOICES } = require('../src/main/openrouter.js');
const eleven = createElevenLabs({ userDataDir: () => tmp, safeStorage });
assert.equal(eleven.hasKey(), false);
assert.match((await eleven.speak('Hi')).error, /ElevenLabs key/);

eleven.setKey('sk_bad');
assert.match((await eleven.speak('Hi')).error, /didn’t accept the key/);

eleven.setKey('sk_good');
const speech = await eleven.speak('Hi there', 'Aria');
assert.equal(Buffer.from(speech.audio, 'base64').toString(), 'ID3fake');
assert.equal(speech.type, 'audio/mpeg');
assert.equal(speech.alignment.characters.join(''), 'Hi there');
assert.equal(speech.alignment.character_start_times_seconds[2], 0.1);
const last = seen.at(-1);
assert.ok(last.url.startsWith(`/v1/text-to-speech/${VOICES.Aria}/with-timestamps`), last.url);
assert.equal(last.body.model_id, 'eleven_flash_v2_5');
assert.match((await eleven.speak('   ')).error, /Nothing/);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('elevenlabs: ok');
