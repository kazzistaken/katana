// Dictation only ever puts finished words in the box: the real voice.js and mic.js in Electron,
// a recording through Chromium's fake mic, and stand-ins for the engines. Costs nothing, uses no key.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const speech = path.join(root, '.canary', 'test', 'mic.wav');
if (process.platform !== 'win32' || !fs.existsSync(electron) || !fs.existsSync(speech)) {
  console.log('dictation final skipped (needs Electron and .canary/test/mic.wav)');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-dictationfinal-'));
const voiceUrl = pathToFileURL(path.join(root, 'src', 'renderer', 'js', 'voice.js')).href;

fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
fs.writeFileSync(
  path.join(dir, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(dir, 'data'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 300, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => {
    const message = event.message;
    if (!message.startsWith('RESULT ')) return console.log(message);
    fs.writeFileSync(${JSON.stringify(path.join(dir, 'result.json'))}, message.slice(7));
    app.exit(0);
  });
  await win.loadFile(${JSON.stringify(path.join(dir, 'page.html'))});
});
setTimeout(() => app.exit(3), 90000);
`
);
fs.writeFileSync(
  path.join(dir, 'page.html'),
  `<!doctype html><textarea class="composer-input"></textarea><button class="mic-btn"></button>
<script type="module">
const on = {};
const subscribe = (name) => (callback) => { on[name] = callback; };
let engine = { ok: true, canary: true };
let heard = async () => ({ text: 'finished words here.' });
window.api = { voice: {
  start: async () => engine,
  stop: async () => true,
  canary: (clip) => heard(clip),
  clip: (clip) => heard(clip),
  audio: () => {},
  commit: () => {},
  onError: subscribe('error'), onText: subscribe('text'), onPartial: subscribe('partial'), onLive: subscribe('live'), onState: subscribe('state'),
} };
class FakeSocket {
  static OPEN = 1; static CONNECTING = 0;
  readyState = 1;
  constructor() { FakeSocket.last = this; }
  send() {} close() {}
}
window.WebSocket = FakeSocket;

const results = {};
try {
  const { initVoice } = await import(${JSON.stringify(voiceUrl)});
  const flashes = [];
  const voice = initVoice({ flash: (text) => flashes.push(text), showChat: () => {}, chatShown: () => true });
  const box = document.querySelector('.composer-input');
  const mic = document.querySelector('.mic-btn');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let seen = [];
  box.addEventListener('input', () => seen.push(box.value));

  /** Starts dictating into a box holding "before", and speaks for a moment, the live engine guessing. */
  async function speak(before = '', guess = 'rough guess') {
    box.value = before;
    seen = [];
    await voice.toggle();
    await wait(3000);
    on.live?.({ text: guess, settled: false });
    await wait(100);
  }
  const held = () => { let release; const gate = new Promise((resolve) => { release = resolve; }); return { gate, release }; };
  const heldReply = () => {
    const { gate, release } = held();
    heard = async () => { await gate; return { text: 'finished words here.' }; };
    return release;
  };

  // Words the live engine guesses, and the wait for the real ones, don't touch the box.
  {
    const release = heldReply();
    await speak();
    const stopped = voice.toggle();
    await wait(300);
    const out = { box: box.value, hearing: mic.classList.contains('is-hearing') };
    release();
    await stopped;
    results.finishedOnly = { out, end: box.value, seen, hearingAfter: mic.classList.contains('is-hearing') };
  }
  // What you type while a phrase is out stays, and the phrase lands after it.
  {
    const release = heldReply();
    await speak('Before.');
    const stopped = voice.toggle();
    await wait(300);
    box.value = 'Before. Typed';
    release();
    await stopped;
    results.typed = box.value;
  }
  // Sent while a phrase is out: what was sent doesn't come back, the phrase lands alone.
  {
    const release = heldReply();
    await speak('Sent already.');
    const stopped = voice.toggle();
    await wait(300);
    box.value = '';
    release();
    await stopped;
    results.sent = box.value;
  }
  // The real engine fails: the rough words are better than losing what you said.
  {
    heard = async () => ({ error: 'it broke' });
    await speak('', 'failed guess');
    await voice.toggle();
    results.failed = { end: box.value, flashes: [...flashes] };
  }
  // A phrase with nothing in it changes nothing, not even trailing space.
  {
    heard = async () => ({ text: '' });
    await speak('Keep this ');
    await voice.toggle();
    results.empty = box.value;
  }
  // OpenAI and Windows' engine: partial words are ignored, finished ones land.
  {
    engine = { ok: true, openai: true };
    box.value = '';
    seen = [];
    await voice.toggle();
    on.partial?.('half a thou');
    on.text('A whole thought.');
    await voice.toggle();
    results.streaming = { end: box.value, seen };
  }
  // Deepgram: the same.
  {
    engine = { ok: true, deepgramKey: 'stand-in' };
    box.value = '';
    seen = [];
    await voice.toggle();
    const say = (transcript, is_final) => FakeSocket.last.onmessage({ data: JSON.stringify({ is_final, channel: { alternatives: [{ transcript }] } }) });
    say('half a thou', false);
    say('a whole thought.', true);
    await voice.toggle();
    results.deepgram = { end: box.value, seen };
  }
} catch (error) {
  results.error = String(error?.stack || error);
}
console.log('RESULT ' + JSON.stringify(results));
</script>`
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(
  electron,
  [dir, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${speech}`, '--autoplay-policy=no-user-gesture-required'],
  { env, encoding: 'utf8', timeout: 120000 }
);
const resultFile = path.join(dir, 'result.json');
assert.ok(fs.existsSync(resultFile), `the page never reported (exit ${run.status}): ${run.stdout}${run.stderr}`);
const results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

assert.equal(results.error, undefined, results.error);
const FINISHED = 'Finished words here.';
assert.equal(results.finishedOnly.out.box, '', 'nothing in the box while the phrase is being heard');
assert.equal(results.finishedOnly.out.hearing, true, 'the mic says a phrase is being heard');
assert.equal(results.finishedOnly.end, FINISHED);
assert.equal(results.finishedOnly.hearingAfter, false, 'and stops saying so');
assert.deepEqual(results.finishedOnly.seen, [FINISHED], 'the box only ever held finished words');
assert.equal(results.typed, 'Before. Typed finished words here.', 'what you typed stays');
assert.equal(results.sent, FINISHED, 'what was sent does not come back');
assert.equal(results.failed.end, 'Failed guess', 'rough words when the real engine fails');
assert.ok(results.failed.flashes.some((text) => text.includes('it broke')), 'and it says why');
assert.equal(results.empty, 'Keep this ', 'an empty phrase changes nothing');
assert.deepEqual(results.streaming, { end: 'A whole thought.', seen: ['A whole thought.'] });
assert.deepEqual(results.deepgram, { end: 'A whole thought.', seen: ['A whole thought.'] });

console.log('dictation final ok');
