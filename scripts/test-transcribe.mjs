import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import http from 'node:http';
import { createPauseDetector, wav } from '../src/renderer/js/mic.js';

const require = createRequire(import.meta.url);

/* ------------------- speech or not, chunk by chunk ------------------- */
{
  const sent = [];
  let commits = 0;
  const gate = createPauseDetector({ send: (chunk) => sent.push(chunk), commit: () => (commits += 1), chunkMs: 85 });
  const chunk = (level) => new Float32Array(2048).fill(level);
  // The room's own noise: nothing sent.
  for (let i = 0; i < 20; i += 1) gate.push(chunk(0.003));
  assert.equal(sent.length, 0);
  // Speech: the moment before it goes too (so no first word is cut), then each chunk.
  gate.push(chunk(0.2));
  assert.equal(sent.length, 5, 'four lead-in chunks and the first loud one');
  gate.push(chunk(0.2));
  assert.equal(sent.length, 6);
  // A short breath isn't a pause; 700 ms of quiet is.
  for (let i = 0; i < 4; i += 1) gate.push(chunk(0.003));
  assert.equal(commits, 0);
  for (let i = 0; i < 6; i += 1) gate.push(chunk(0.003));
  assert.equal(commits, 1);
  assert.equal(gate.speaking(), false);
  // Stopping mid-phrase sends what was said.
  gate.push(chunk(0.2));
  gate.end();
  assert.equal(commits, 2);
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
