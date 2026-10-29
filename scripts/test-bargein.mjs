import assert from 'node:assert/strict';
import { createBargeInDetector, features, heardWords, LEVELS } from '../src/renderer/js/bargein.js';

const RATE = 24000;
const CHUNK = 1024;
const CHUNK_MS = (CHUNK / RATE) * 1000;

// A steady random source, so every run hears the same room.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

let t = 0; // samples so far, so a voice continues smoothly from chunk to chunk
const chunk = (fn) => Float32Array.from({ length: CHUNK }, () => fn((t += 1) / RATE));
const hiss = (amp) => () => random() * amp;
// A voice: a 150 Hz fundamental and its harmonics, the way a vowel sounds.
const voice = (amp) => (s) => amp * (Math.sin(2 * Math.PI * 150 * s) + 0.5 * Math.sin(2 * Math.PI * 300 * s) + 0.3 * Math.sin(2 * Math.PI * 450 * s));
const mix = (...fns) => (s) => fns.reduce((sum, fn) => sum + fn(s), 0);
const click = () => {
  let i = 0;
  return () => ((i += 1) < 6 ? 0.8 * (i % 2 ? 1 : -1) : random() * 0.002);
};
const levelOf = (amp) => features(chunk(voice(amp))).level;

/** Feed `ms` of a sound; how many times it fired. */
function feed(detector, ms, fn, playback = 0) {
  let fired = 0;
  for (let at = 0; at < ms; at += CHUNK_MS) if (detector.push(chunk(fn), playback)) fired += 1;
  return fired;
}
const quietRoom = (detector) => feed(detector, 1500, hiss(0.002));

// Features: a voice is smooth and steady; hiss crosses zero all the time; a click is all peak.
{
  const v = features(chunk(voice(0.1)));
  assert.ok(v.level > 0.05 && v.zcr < 0.05 && v.crest < 4, JSON.stringify(v));
  assert.ok(features(chunk(hiss(0.1))).zcr > 0.4);
  assert.ok(features(chunk(click())).crest > 9);
  assert.deepEqual(features(new Float32Array(0)), { level: 0, zcr: 0, crest: 0 });
}

// Sustained speech fires, once per stretch.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  assert.equal(feed(d, 1500, voice(0.08)), 1);
  assert.equal(d.active(), true, 'still talking');
  feed(d, 300, hiss(0.002));
  assert.equal(d.active(), false, 'done talking');
}

// Short sounds don't: a cough-length burst, a click, keys being typed.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  assert.equal(feed(d, 200, voice(0.08)), 0, 'a 200 ms burst');
  assert.equal(feed(d, 500, hiss(0.002)), 0);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(d.push(chunk(click())), false, 'a click');
    feed(d, 60, hiss(0.002));
  }
}

// Breathing and hiss, however loud and long, aren't a voice.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  assert.equal(feed(d, 3000, hiss(0.15)), 0);
}

// Too quiet for the room: a murmur under its noise doesn't fire, the same voice louder does.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  feed(d, 2000, mix(voice(0.004), hiss(0.002)));
  assert.equal(feed(d, 1000, mix(voice(0.006), hiss(0.002))), 0, 'a murmur');
  assert.equal(feed(d, 1000, voice(0.08)), 1);
}

// Short dips between syllables don't break the speech up.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  let fired = 0;
  for (let i = 0; i < 6; i += 1) {
    fired += feed(d, 130, voice(0.08));
    fired += feed(d, 80, hiss(0.002));
  }
  assert.equal(fired, 1);
}

// Her own voice coming back through the speakers doesn't fire, however long she talks...
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  const her = levelOf(0.1);
  assert.equal(feed(d, 6000, mix(voice(0.03), hiss(0.002)), her), 0, 'her echo');
  // ...and the bar comes down near it (three times her echo), so you talking clearly over her does.
  assert.ok(d.threshold() < levelOf(0.03) * 3.3 && d.threshold() < levelOf(0.12), `threshold ${d.threshold()}`);
  assert.equal(feed(d, 1000, mix(voice(0.03), voice(0.12)), her), 1, 'you over her');
}

// Even a loud echo (speakers up, little echo cancellation) is learned before it fires.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  assert.equal(feed(d, 6000, voice(0.08), levelOf(0.1)), 0);
}

// Sensitivity: high fires on shorter speech than medium, medium than low.
{
  const fires = (sensitivity, ms) => {
    const d = createBargeInDetector({ sensitivity, chunkMs: CHUNK_MS });
    quietRoom(d);
    return feed(d, ms, voice(0.08)) + feed(d, 400, hiss(0.002));
  };
  assert.equal(fires('high', 340), 1);
  assert.equal(fires('medium', 340), 0);
  assert.equal(fires('medium', 450), 1);
  assert.equal(fires('low', 450), 0);
  assert.equal(fires('low', 600), 1);
  assert.ok(LEVELS.low.holdMs > LEVELS.medium.holdMs && LEVELS.medium.holdMs > LEVELS.high.holdMs);
  // An unknown one is medium.
  assert.equal(fires('loud', 450), 1);
}

// A false alarm (no words heard) raises the bar over that sound, then it falls back.
{
  const d = createBargeInDetector({ chunkMs: CHUNK_MS });
  quietRoom(d);
  const before = d.threshold();
  assert.equal(feed(d, 600, voice(0.03)), 1);
  d.reject();
  assert.ok(d.penalty() > 1);
  feed(d, 200, hiss(0.002));
  assert.equal(feed(d, 1500, voice(0.03)), 0, 'the same sound again');
  assert.equal(feed(d, 1500, voice(0.15)), 1, 'a real voice still gets through');
  feed(d, 60000, hiss(0.002));
  assert.ok(Math.abs(d.threshold() - before) < before * 0.1, 'the bar is back');
}

// The speech engine's word: real words, not fillers, phantoms or her own words echoed.
assert.equal(heardWords('Wait, stop, that’s the wrong folder.'), true);
assert.equal(heardWords('No'), true);
assert.equal(heardWords('Hang on.', 'The build finished and every test passed.'), true);
for (const text of ['', '   ', '...', 'Um.', 'Hmm, mm.', 'Thank you.', 'you', 'Thanks for watching!', 'Yeah.', 'okay']) assert.equal(heardWords(text), false, text);
assert.equal(heardWords('every test passed', 'The build finished and every test passed.'), false, 'her echo');
assert.equal(heardWords('build finished and', 'The build finished and every test passed.'), false, 'her echo');
assert.equal(heardWords('Stop, I meant the other build.', 'The build finished and every test passed.'), true);

console.log('bargein ok');

// The settings: on by default at medium; Katana can change them (set_setting), within reason.
{
  const { DEFAULT_SETTINGS } = await import('../src/renderer/js/store.js');
  const { checkSetting } = await import('../src/renderer/js/apptools.js');
  assert.equal(DEFAULT_SETTINGS.bargeIn, true);
  assert.equal(DEFAULT_SETTINGS.bargeInSensitivity, 'medium');
  assert.deepEqual(checkSetting('bargeIn', 'off'), { key: 'bargeIn', value: false });
  assert.deepEqual(checkSetting('bargeInSensitivity', 'high'), { key: 'bargeInSensitivity', value: 'high' });
  assert.match(checkSetting('bargeInSensitivity', 'max').error, /low, medium, high/);
}

console.log('bargein settings ok');
