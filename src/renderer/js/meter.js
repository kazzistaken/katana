import { bandsOf } from './facecore.js';

/**
 * How loud Katana's voice is right now (0..1), and its spectrum, so her
 * mouth moves with what she actually says: her OpenRouter voice (an <audio>
 * element) or a GPT-Live call (its incoming stream) is measured here.
 * Windows' own voice can't be measured, but it tells the face its words
 * (face.js faceSpeech).
 */

let context = null;
let analyser = null;
let samples = null;
let freq = null;
const measured = new WeakSet();

function ensure() {
  if (analyser) return;
  context = new AudioContext();
  analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  samples = new Float32Array(analyser.fftSize);
}

/** Measure an <audio> element as it plays (it still plays out loud). */
export function meterElement(audio) {
  try {
    ensure();
    if (context.state === 'suspended') context.resume().catch(() => {});
    if (measured.has(audio)) return;
    measured.add(audio);
    const source = context.createMediaElementSource(audio);
    source.connect(analyser);
    source.connect(context.destination);
  } catch {
    /* no meter: the face makes its own syllables */
  }
}

/** Measure a sound made here (the face lab's vowels): `make(context)` returns its last node. */
export function meterNode(make) {
  ensure();
  if (context.state === 'suspended') context.resume().catch(() => {});
  const node = make(context);
  node.connect(analyser);
  node.connect(context.destination);
  return node;
}

/** Measure a stream someone else plays (a GPT-Live call's voice); returns a stop. */
export function meterStream(stream) {
  try {
    ensure();
    if (context.state === 'suspended') context.resume().catch(() => {});
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    return () => source.disconnect();
  } catch {
    return () => {};
  }
}

/** How loud it is now, 0..1. */
export const level = () => Math.min(1, rms() * 7);

/** Her playback's own level now (RMS, unscaled), for telling her echo from you (bargein.js). */
export function rms() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Her voice now: { level (0..1), bands (power in facecore BANDS) }, or null before anything's been measured. */
export function spectrum() {
  if (!analyser) return null;
  freq ||= new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freq);
  return { level: level(), bands: bandsOf(freq, context.sampleRate / analyser.fftSize) };
}
