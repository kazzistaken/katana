import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import http from 'node:http';
import { createPauseDetector, wav } from '../src/renderer/js/mic.js';

const require = createRequire(import.meta.url);

/* ------------------- speech or not, chunk by chunk ------------------- */
// Noises and a voice, made up: the seed keeps them the same each run.
let seed = 7;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const noise = (level) => Float32Array.from({ length: 2048 }, () => random() * level);
let phase = 0;
let voiceAt = 0;
/** A voice: harmonics of a pitch that keeps moving, as a person's does. */
function voice(level = 0.2) {
  voiceAt += 1;
  const hz = 130 + 25 * Math.sin(voiceAt * 0.9);
  return Float32Array.from({ length: 2048 }, () => {
    phase += (2 * Math.PI * hz) / 24000;
    return level * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)) * (0.7 + 0.3 * Math.sin(voiceAt));
  });
}
function gateFor() {
  const seen = { sent: [], commits: 0 };
  seen.gate = createPauseDetector({ send: (chunk) => seen.sent.push(chunk), commit: () => (seen.commits += 1), chunkMs: 85 });
  return seen;
}
const during = (gate, count, make) => {
  for (let i = 0; i < count; i += 1) gate.push(make(i));
};

{
  const seen = gateFor();
  const { gate, sent } = seen;
  // The room's own noise: nothing sent.
  during(gate, 20, () => noise(0.003));
  assert.equal(sent.length, 0);
  // A voice has to last before it counts; then the moment before it goes too (so no first word is cut), then each chunk.
  during(gate, 2, () => voice());
  assert.equal(sent.length, 0);
  gate.push(voice());
  assert.equal(sent.length, 9, 'the lead-in and the voice so far');
  gate.push(voice());
  assert.equal(sent.length, 10);
  // A short breath isn't a pause; about 950 ms without a voice is.
  during(gate, 10, () => noise(0.003));
  assert.equal(seen.commits, 0);
  during(gate, 2, () => noise(0.003));
  assert.equal(seen.commits, 1);
  assert.equal(gate.speaking(), false);
  // Stopping mid-phrase sends what was said; stopping with nothing said sends nothing.
  during(gate, 3, () => voice());
  gate.end();
  assert.equal(seen.commits, 2);
  gate.end();
  assert.equal(seen.commits, 2);
}

/* Things that aren't you talking: nothing sent, however loud. */
{
  const click = () => {
    const chunk = noise(0.003);
    for (let i = 0; i < 300; i += 1) chunk[500 + i] += random() * 0.4 * Math.exp(-i / 50);
    return chunk;
  };
  const thump = () => Float32Array.from({ length: 2048 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 45 * i) / 24000) * Math.exp(-i / 800));
  let was = 0;
  const fan = () =>
    Float32Array.from({ length: 2048 }, () => {
      was = was * 0.9 + random() * 0.1;
      return was * 0.25;
    });
  let hummed = 0;
  const hum = () =>
    Float32Array.from({ length: 2048 }, () => {
      hummed += 1;
      return 0.05 * (Math.sin((2 * Math.PI * 120 * hummed) / 24000) + 0.5 * Math.sin((2 * Math.PI * 240 * hummed) / 24000));
    });
  for (const [name, make] of [
    ['typing', click],
    ['a desk being bumped', thump],
    ['a fan coming on', fan],
    ['a hum coming on', hum],
    ['breath', () => noise(0.15)],
  ]) {
    const seen = gateFor();
    during(seen.gate, 12, () => noise(0.003));
    during(seen.gate, 120, make);
    seen.gate.end();
    assert.equal(seen.sent.length, 0, name);
    assert.equal(seen.commits, 0, name);
  }
}

/* A burst of noise isn't a phrase. A voice after a fan comes on still is. */
{
  const seen = gateFor();
  during(seen.gate, 10, () => noise(0.003));
  during(seen.gate, 2, () => noise(0.5));
  during(seen.gate, 20, () => noise(0.003));
  assert.equal(seen.sent.length, 0);
  during(seen.gate, 50, () => noise(0.03));
  assert.equal(seen.sent.length, 0);
  during(seen.gate, 6, () => voice());
  assert.ok(seen.sent.length > 0, 'a voice over the fan');
}

/* Noise after you've stopped talking doesn't hold the phrase open. */
{
  const seen = gateFor();
  during(seen.gate, 10, () => noise(0.003));
  during(seen.gate, 12, () => voice());
  assert.equal(seen.gate.speaking(), true);
  during(seen.gate, 12, () => noise(0.2));
  assert.equal(seen.commits, 1);
}

/* Spoken the moment the mic opens: the first words aren't lost learning the room. */
{
  const seen = gateFor();
  during(seen.gate, 3, () => voice());
  assert.equal(seen.sent.length, 3);
}

/* --------------- the line to OpenAI, against a stand-in --------------- */

// The smallest WebSocket server that will do: text frames, one client.
function standIn(onMessage) {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    server.auth = req.headers.authorization;
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const reply = (json) => {
      const body = Buffer.from(JSON.stringify(json));
      const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([head, body]));
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const op = buffer[0] & 15;
        let length = buffer[1] & 127;
        let at = 2;
        if (length === 126) {
          length = buffer.readUInt16BE(2);
          at = 4;
        } else if (length === 127) {
          length = Number(buffer.readBigUInt64BE(2));
          at = 10;
        }
        if (buffer.length < at + 4 + length) return;
        const mask = buffer.subarray(at, at + 4);
        const body = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffer = buffer.subarray(at + 4 + length);
        if (op === 8) return socket.end();
        if (op === 1) onMessage(JSON.parse(body.toString('utf8')), reply);
      }
      return undefined;
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

{
  const got = [];
  const server = await standIn((message, reply) => {
    got.push(message);
    if (message.type === 'input_audio_buffer.commit') {
      reply({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: 'start a ' });
      reply({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: 'task' });
      setTimeout(() => reply({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: 'Start a task.' }), 50);
    }
  });
  process.env.XODE2_TRANSCRIBE_URL = `ws://127.0.0.1:${server.address().port}/v1/realtime?intent=transcription`;
  const { createTranscriber } = require('../src/main/transcribe.js');
  const sent = [];
  const t = createTranscriber({ apiKey: () => 'sk-test', send: (channel, payload) => sent.push([channel, payload]) });

  assert.deepEqual(await t.start(), { ok: true });
  assert.equal(server.auth, 'Bearer sk-test', 'the key goes in the header, from this process');
  t.append('AAAA');
  t.commit();
  // Stopping waits for the last phrase.
  await t.stop();
  const [update, append, commit] = got;
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.type, 'transcription');
  assert.equal(update.session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.equal(update.session.audio.input.turn_detection, null);
  assert.deepEqual(append, { type: 'input_audio_buffer.append', audio: 'AAAA' });
  assert.equal(commit.type, 'input_audio_buffer.commit');
  assert.deepEqual(sent, [
    ['voice:partial', 'start a '],
    ['voice:partial', 'start a task'],
    ['voice:text', 'Start a task.'],
  ]);
  assert.equal(t.active(), false);

  // No key: it says so, and nothing opens.
  const none = createTranscriber({ apiKey: () => '', send: () => {} });
  assert.equal((await none.start()).ok, false);
  server.close();
}

console.log('transcribe ok');
