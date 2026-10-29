import { VISEMES, PARAMS, smoothstep } from './facecore.js';
import { textPhones, bare, isVowel } from './g2p.js';

/**
 * Her lips from what she says (face.js draws them; the tests run this in
 * Node): her words as phonemes (g2p.js), each phoneme a mouth shape
 * (facecore VISEMES), laid out in time, then blended the way a mouth
 * moves.
 *
 *   Timing   exact where the voice gives it (ElevenLabs' character times:
 *            fromAlignment; Windows' word boundaries: createWordTimer,
 *            which spreads each word's sounds by their usual lengths and
 *            learns how fast she's going); otherwise laid out by usual
 *            lengths and fitted to the sound itself (alignToEnvelope:
 *            dynamic time warping of the loudness she should have against
 *            the loudness she has). A live voice heard as it comes
 *            (createFollower) is followed: its words from the transcript,
 *            its pace from its loudness.
 *   Motion   mouthAt(): each sound pulls on her mouth with a strength that
 *            falls off either side of it (Cohen & Massaro's dominance
 *            model), her lips and her jaw separately, so sounds blend into
 *            each other: the lips round early for an oo, a k or t takes
 *            the vowel's lips, fast speech doesn't reach every shape, a
 *            stressed vowel holds. Her lips always close for m, b and p,
 *            and touch her teeth for f and v. Pauses relax to rest.
 *
 * Times are in seconds.
 */

/* ------------------------------ phonemes to shapes ------------------------------ */

const VISEME_OF = {
  AA: 'ah', AE: 'ae', AH: 'ae', AO: 'oh', UW: 'uw', UH: 'uw', IY: 'ee', IH: 'eh', EH: 'eh', ER: 'er',
  R: 'er', L: 'l', W: 'w', Y: 'ee', F: 'fv', V: 'fv', TH: 'th', DH: 'th', S: 'sz', Z: 'sz', SH: 'sh', ZH: 'sh', CH: 'sh', JH: 'sh',
  M: 'mbp', B: 'mbp', P: 'mbp', K: 'kg', G: 'kg', NG: 'kg', T: 'tdn', D: 'tdn', N: 'tdn',
};
// Gliding vowels: two shapes, in turn (how much of the vowel each takes).
const GLIDES = { AW: [['ah', 0.6], ['uw', 0.4]], AY: [['ah', 0.6], ['ee', 0.4]], EY: [['eh', 0.6], ['ee', 0.4]], OW: [['oh', 0.65], ['uw', 0.35]], OY: [['oh', 0.55], ['ee', 0.45]] };

/** A phoneme's mouth shapes: [[viseme, share of its time]]; h has none of its own (it takes the next vowel's). */
export function visemesOf(phone) {
  const p = bare(phone);
  if (GLIDES[p]) return GLIDES[p];
  if (p === 'HH') return [];
  return VISEME_OF[p] ? [[VISEME_OF[p], 1]] : [['rest', 1]];
}

// How long each sound usually lasts at an easy speaking pace.
const DUR = {
  AA: 0.13, AE: 0.13, AH: 0.09, AO: 0.13, AW: 0.16, AY: 0.16, EH: 0.1, ER: 0.12, EY: 0.14, IH: 0.075, IY: 0.11, OW: 0.14, OY: 0.17, UH: 0.08, UW: 0.12,
  B: 0.065, CH: 0.11, D: 0.055, DH: 0.045, F: 0.09, G: 0.07, HH: 0.06, JH: 0.095, K: 0.075, L: 0.065, M: 0.07, N: 0.06, NG: 0.075, P: 0.08, R: 0.06,
  S: 0.1, SH: 0.105, T: 0.065, TH: 0.085, V: 0.06, W: 0.06, Y: 0.055, Z: 0.08, ZH: 0.085,
};
/** A phoneme's usual length (s); unstressed vowels are shorter. */
export function phoneDuration(phone) {
  const p = bare(phone);
  const d = DUR[p] || 0.07;
  if (isVowel(phone) && phone.endsWith('0')) return d * (p === 'AH' || p === 'IH' ? 0.6 : 0.72);
  return d;
}
/** The pause after a word: a sentence's end, a comma's, or none. */
export const PAUSE = { stop: 0.34, comma: 0.17, '': 0 };

/* ------------------------------ how each sound pulls ------------------------------ */

// [lips' strength, jaw's strength, reach before (s), reach after (s), how much of it is held]
const DOM = {
  vowel: [0.6, 0.8, 0.07, 0.07, 0.3],
  round: [0.9, 0.75, 0.13, 0.08, 0.35], // oo and oh: lips round early and stay
  w: [1.1, 0.6, 0.1, 0.05, 0.4],
  mbp: [1, 1, 0.05, 0.035, 0.5],
  fv: [0.95, 0.85, 0.05, 0.04, 0.5],
  sh: [0.85, 0.8, 0.09, 0.06, 0.4],
  sz: [0.45, 0.85, 0.06, 0.05, 0.4],
  th: [0.5, 0.75, 0.05, 0.05, 0.4],
  er: [0.7, 0.55, 0.08, 0.06, 0.3],
  l: [0.3, 0.5, 0.05, 0.05, 0.3],
  kg: [0.2, 0.45, 0.05, 0.05, 0.3],
  tdn: [0.25, 0.55, 0.05, 0.05, 0.3],
  glide: [0.5, 0.4, 0.06, 0.06, 0.2],
  hh: [0.06, 0.06, 0.04, 0.04, 0],
  sil: [1.2, 1.6, 0.035, 0.05, 0.8],
};
// Sounds her lips must make: closed for m/b/p, lip to teeth for f/v (and, in a pause, back to rest).
const CONTACT = { mbp: 1, fv: 0.85 };
const JAW = new Set(['open', 'teethTop', 'teethBot', 'tongue']);
const IS_JAW = PARAMS.map((p) => JAW.has(p));
const REST_T = PARAMS.map((p) => VISEMES.rest[p]);
const BASE = 0.015;

function classOf(v, phone) {
  if (v === 'rest') return 'sil';
  if (phone === 'HH') return 'hh';
  if (v === 'w') return 'w';
  if (v === 'uw' || v === 'oh') return 'round';
  if (phone === 'Y') return 'glide';
  if (DOM[v]) return v;
  return 'vowel';
}

/** A sound in time: { p (phoneme, or '' for silence), v (viseme), s, e, word, stress }, made ready for mouthAt. */
function ready(seg) {
  const cls = classOf(seg.v, bare(seg.p || ''));
  let [aL, aJ, rb, ra, hold] = DOM[cls];
  let jaw = 1;
  if (seg.stress === 1) {
    aL *= 1.25;
    aJ *= 1.2;
    hold = 0.55;
  } else if (seg.stress === 0) {
    aL *= 0.8;
    aJ *= 0.8;
    hold = 0.15;
    jaw = /^(AH|IH|UH)/.test(seg.p) ? 0.55 : 0.72;
  }
  const shape = VISEMES[seg.v] || VISEMES.rest;
  const T = PARAMS.map((p) => (p === 'open' ? shape[p] * jaw : shape[p]));
  const len = seg.e - seg.s;
  // Where her lips hold the contact: closing just before the sound, opening as it ends; a pause relaxes after the sound and lets go just before the next.
  const contact = cls === 'sil' ? 0.9 * smoothstep(0.08, 0.3, len) : CONTACT[seg.v] || 0;
  const span =
    cls === 'sil'
      ? [seg.s + 0.02, seg.s + Math.min(0.15, len * 0.5), seg.e - Math.min(0.1, len * 0.45), seg.e - 0.01]
      : [seg.s - 0.045, seg.s + Math.min(0.025, len * 0.35), seg.e - Math.min(0.02, len * 0.3), seg.e + 0.03];
  return Object.assign(seg, { c: (seg.s + seg.e) / 2, h: (hold * len) / 2, aL, aJ, rb, ra, T, contact, span });
}

/** h takes the shape of the vowel after it (or before, at a word's end). */
function resolve(segs) {
  for (let i = 0; i < segs.length; i += 1) {
    if (segs[i].v) continue;
    const next = segs.slice(i + 1, i + 4).find((s) => s.p && isVowel(s.p)) || segs.slice(Math.max(0, i - 3), i).reverse().find((s) => s.p && isVowel(s.p));
    segs[i].v = next ? next.v : 'ae';
  }
  return segs.map(ready);
}

const sound = (p, v, s, e, word) => ({ p, v, s, e, word, stress: isVowel(p) ? Number(p.at(-1)) || 0 : -1 });
const silence = (s, e, word = -1) => ({ p: '', v: 'rest', s, e, word, stress: -1 });

/** A phoneme as sounds from s to e (gliding vowels as two). */
function soundsOf(phone, s, e, word) {
  const parts = visemesOf(phone);
  if (!parts.length) return [sound(phone, null, s, e, word)];
  const out = [];
  let at = s;
  for (const [v, share] of parts) {
    const end = at + (e - s) * share;
    out.push(sound(phone, v, at, end, word));
    at = end;
  }
  return out;
}

/** A word's sounds spread over [s, e] by their usual lengths (a sentence's last syllable a little longer). */
function spread(word, k, s, e, out) {
  const lens = word.phones.map(phoneDuration);
  if (word.pause) {
    const last = word.phones.findLastIndex(isVowel);
    for (let i = Math.max(0, last); i < lens.length; i += 1) lens[i] *= 1.25;
  }
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let at = s;
  word.phones.forEach((p, i) => {
    const end = at + (lens[i] / total) * (e - s);
    out.push(...soundsOf(p, at, end, k));
    at = end;
  });
}

/** How long a word usually takes at `rate` (1 an easy pace), with or without its pause. */
export const wordLength = (word, rate = 1) => (word.phones.reduce((a, p) => a + phoneDuration(p), 0) * (word.pause ? 1.1 : 1)) / rate;
const pauseLength = (word, rate = 1) => PAUSE[word.pause] / rate;

/**
 * Words (textPhones) laid out by their usual lengths from `start`, at
 * `rate`, from word `from` on: { segs, starts (each word's start), end }.
 * `lead`: a moment of silence first, so her mouth leaves rest gently.
 */
export function layoutWords(words, { start = 0, rate = 1, from = 0, lead = 0.25, tail = 0.4 } = {}) {
  const segs = [];
  const starts = [];
  let t = start;
  if (lead) segs.push(silence(t - lead, t));
  for (let k = from; k < words.length; k += 1) {
    const len = wordLength(words[k], rate);
    starts[k] = t;
    spread(words[k], k, t, t + len, segs);
    t += len;
    const gap = pauseLength(words[k], rate);
    if (gap) segs.push(silence(t, t + gap, k));
    t += gap;
  }
  if (tail) segs.push(silence(t, t + tail));
  return { segs: resolve(segs), starts, end: t };
}

/** Words said with the times ElevenLabs gives each character: { characters, character_start_times_seconds, character_end_times_seconds }. */
export function fromAlignment(alignment) {
  const chars = alignment?.characters || [];
  const st = alignment?.character_start_times_seconds || [];
  const en = alignment?.character_end_times_seconds || [];
  if (!chars.length || st.length !== chars.length || en.length !== chars.length) return null;
  const words = textPhones(chars.join(''));
  if (!words.length) return null;
  const segs = [];
  let prev = Math.max(0, st[words[0].start] - 0.25);
  segs.push(silence(prev, st[words[0].start]));
  prev = st[words[0].start];
  words.forEach((w, k) => {
    const s = Math.max(prev, st[w.start]);
    const e = Math.max(s + 0.03, en[w.end - 1]);
    // A gap between words is a pause (else they run together).
    if (s - prev > 0.09) segs.push(silence(prev, s, k - 1));
    spread(w, k, s, e, segs);
    prev = e;
  });
  segs.push(silence(prev, prev + 0.4));
  return { segs: resolve(segs), words, end: prev };
}

/* ------------------------------ fitting to the sound ------------------------------ */

/**
 * Her voice's loudness, `fps` a second: { fps, values } (0 her quietest,
 * 1 her loudest, on a log scale, as loudness is heard). From samples
 * (Float32Array, mono) at `sampleRate`.
 */
export function envelopeOf(samples, sampleRate, fps = 100) {
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const n = Math.floor(samples.length / hop);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const a = Math.max(0, i * hop - (hop >> 1));
    const b = Math.min(samples.length, i * hop + hop + (hop >> 1));
    for (let k = a; k < b; k += 1) sum += samples[k] * samples[k];
    db[i] = 10 * Math.log10(sum / Math.max(1, b - a) + 1e-10);
  }
  const sorted = Float32Array.from(db).sort();
  const q = (f) => sorted[Math.min(n - 1, Math.floor(f * n))] ?? -100;
  const peak = q(0.98);
  const floor = Math.max(q(0.05), peak - 45);
  const values = new Float32Array(n);
  if (n && peak - floor > 6) for (let i = 0; i < n; i += 1) values[i] = Math.min(1, Math.max(0, (db[i] - floor) / (peak - floor)));
  return { fps, values: smooth3(values) };
}

const smooth3 = (v) => v.map((x, i) => (v[Math.max(0, i - 1)] + 2 * x + v[Math.min(v.length - 1, i + 1)]) / 4);

/** The loudness of an envelope at t (s), between its frames. */
export function envAt(env, t) {
  const f = t * env.fps;
  const i = Math.floor(f);
  const v = env.values;
  if (i < 0 || i >= v.length) return 0;
  return v[i] + (v[Math.min(v.length - 1, i + 1)] - v[i]) * (f - i);
}

/** How loud each sound should be (on envelopeOf's scale): vowels loudest, hissing and stops' closures quiet. */
function loudnessOf(seg, t) {
  if (!seg.p) return 0;
  const p = bare(seg.p);
  if (isVowel(seg.p)) return seg.stress === 1 ? 0.95 : 0.82;
  if ('M N NG L R W Y'.split(' ').includes(p)) return 0.62;
  if ('V DH Z ZH JH'.split(' ').includes(p)) return 0.55;
  if ('F TH S SH CH HH'.split(' ').includes(p)) return 0.45;
  // A stop: quiet while closed, then its burst.
  return t < seg.s + (seg.e - seg.s) * 0.6 ? 0.15 : 0.45;
}

/** The loudness `segs` should have, frame by frame, over `length` frames. */
export function expectedCurve(segs, fps, length) {
  const out = new Float32Array(length);
  for (const seg of segs) {
    const a = Math.max(0, Math.round(seg.s * fps));
    const b = Math.min(length, Math.round(seg.e * fps));
    for (let i = a; i < b; i += 1) out[i] = Math.max(out[i], loudnessOf(seg, i / fps));
  }
  return smooth3(out);
}

/**
 * Sounds laid out by their usual lengths, moved to where they are in the
 * sound: first stretched over its voiced span, then warped (dynamic time
 * warping, kept near that stretch) so loud vowels, quiet closures and
 * pauses meet their likes in the envelope. Returns new sounds.
 */
export function alignToEnvelope(segs, env) {
  const A = env?.values;
  const fps = env?.fps || 100;
  const M = A?.length || 0;
  const said = segs.filter((s) => s.p);
  if (M < 10 || !said.length) return segs;
  let a0 = A.findIndex((v) => v > 0.3);
  let a1 = A.findLastIndex((v) => v > 0.3);
  if (a0 < 0 || a1 <= a0) return segs;
  a0 = Math.max(0, a0 - 2);
  a1 = Math.min(M - 1, a1 + 3);
  const s0 = said[0].s;
  const s1 = said.at(-1).e;
  const k = (a1 - a0) / fps / Math.max(0.05, s1 - s0);
  const lin = (t) => a0 / fps + (t - s0) * k;
  const scaled = segs.map((s) => ({ ...s, s: lin(s.s), e: lin(s.e) }));
  const T = expectedCurve(scaled, fps, M);

  // Banded DTW: i (where the stretched sounds are) against j (where the sound is).
  const B = Math.max(25, Math.round(M * 0.15));
  const Wd = 2 * B + 1;
  const D = new Float32Array(M * Wd).fill(Infinity);
  const step = new Uint8Array(M * Wd);
  const dT = (i) => T[Math.min(M - 1, i + 1)] - T[Math.max(0, i - 1)];
  const dA = (j) => A[Math.min(M - 1, j + 1)] - A[Math.max(0, j - 1)];
  const at = (i, j) => (j - i + B >= 0 && j - i + B < Wd ? i * Wd + (j - i + B) : -1);
  const PEN = 0.03;
  for (let i = 0; i < M; i += 1) {
    const ti = T[i];
    const di = dT(i);
    for (let j = Math.max(0, i - B); j <= Math.min(M - 1, i + B); j += 1) {
      const c = Math.abs(ti - A[j]) + 0.6 * Math.abs(di - dA(j));
      const here = at(i, j);
      if (!i && !j) {
        D[here] = c;
        continue;
      }
      let best = Infinity;
      let how = 0;
      const diag = i && j ? at(i - 1, j - 1) : -1;
      const up = i ? at(i - 1, j) : -1;
      const left = j ? at(i, j - 1) : -1;
      if (diag >= 0 && D[diag] < best) (best = D[diag]), (how = 1);
      if (up >= 0 && D[up] + PEN < best) (best = D[up] + PEN), (how = 2);
      if (left >= 0 && D[left] + PEN < best) (best = D[left] + PEN), (how = 3);
      D[here] = best + c;
      step[here] = how;
    }
  }
  // Back from the end: for each frame of the stretch, where in the sound it fell.
  const sum = new Float64Array(M);
  const cnt = new Uint16Array(M);
  let i = M - 1;
  let j = M - 1;
  while (i >= 0 && j >= 0) {
    sum[i] += j;
    cnt[i] += 1;
    const how = step[at(i, j)];
    if (how === 1) (i -= 1), (j -= 1);
    else if (how === 2) i -= 1;
    else if (how === 3) j -= 1;
    else break;
  }
  const warp = new Float32Array(M);
  for (let n = 0, last = 0; n < M; n += 1) warp[n] = last = Math.max(last, cnt[n] ? sum[n] / cnt[n] : last);
  const map = (t) => {
    const f = t * fps;
    if (f <= 0) return t;
    if (f >= M - 1) return warp[M - 1] / fps + (t - (M - 1) / fps);
    const n = Math.floor(f);
    return (warp[n] + (warp[n + 1] - warp[n]) * (f - n)) / fps;
  };
  const out = scaled.map((s) => ({ ...s, s: map(s.s), e: map(s.e) }));
  // Nothing vanishes: every sound keeps a sliver of time.
  for (let n = 1; n < out.length; n += 1) {
    if (out[n].s < out[n - 1].s + 0.012) out[n].s = out[n - 1].s + 0.012;
    out[n - 1].e = Math.max(out[n - 1].s + 0.012, Math.min(out[n - 1].e, out[n].s));
    out[n].e = Math.max(out[n].e, out[n].s + 0.012);
  }
  return out.map((s) => ready({ p: s.p, v: s.v, s: s.s, e: s.e, word: s.word, stress: s.stress }));
}

/* ------------------------------ the mouth at a moment ------------------------------ */

/** Find the first sound that could still pull at t. */
function firstNear(segs, t) {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].e < t - 0.4) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Her mouth's shape at t from timed sounds: each pulls on her lips and on
 * her jaw with its own strength, falling off before and after it; m, b, p
 * close her lips fully, f and v bring her lip to her teeth, however fast.
 */
export function mouthAt(segs, t) {
  const n = PARAMS.length;
  const acc = REST_T.map((v) => v * BASE);
  let wl = BASE;
  let wj = BASE;
  let closure = 0;
  let closer = null;
  for (let k = firstNear(segs, t); k < segs.length && segs[k].s < t + 0.45; k += 1) {
    const g = segs[k];
    const d = t - g.c;
    const dist = Math.abs(d) - g.h;
    const f = dist <= 0 ? 1 : Math.exp(-dist / (d < 0 ? g.rb : g.ra));
    if (f < 1e-3) continue;
    const L = g.aL * f;
    const J = g.aJ * f;
    for (let i = 0; i < n; i += 1) acc[i] += g.T[i] * (IS_JAW[i] ? J : L);
    wl += L;
    wj += J;
    if (g.contact) {
      const [a, b, c0, c1] = g.span;
      const c = smoothstep(a, b, t) * (1 - smoothstep(c0, c1, t)) * g.contact;
      if (c > closure) (closure = c), (closer = g);
    }
  }
  const out = {};
  for (let i = 0; i < n; i += 1) {
    let v = acc[i] / (IS_JAW[i] ? wj : wl);
    if (closer) v += (closer.T[i] - v) * closure;
    out[PARAMS[i]] = v;
  }
  return out;
}

/** How far her jaw opens for how loud she is (0..1): barely in a whisper, a little more at her loudest. */
export const jawFrom = (loud) => 0.42 + 0.68 * smoothstep(0.06, 0.85, loud);

/* ------------------------------ Windows' voice ------------------------------ */

/**
 * Words timed by a voice that reports each word as it starts (Windows'):
 * start(t) lays them all out; word(charIndex, t) puts that word at t and
 * the rest after it, at the pace she's been keeping (learnt from the
 * boundaries so far); stop(t) ends it. segs() is the timeline now.
 */
export function createWordTimer(text, rate = 1) {
  const words = textPhones(text);
  let segs = [];
  let pace = 1;
  let last = null;
  let end = 0;
  const from = (k, t, lead) => {
    for (const s of segs) if (s.e > t) s.e = Math.max(s.s, t);
    const lay = layoutWords(words, { start: t, rate: rate * pace, from: k, lead });
    segs = [...segs.filter((s) => s.e > s.s + 1e-4 && s.e > t - 1.5), ...lay.segs].sort((a, b) => a.s - b.s);
    end = lay.end;
  };
  return {
    words,
    start(t) {
      last = null;
      segs = [];
      from(0, t + 0.06, 0.25);
    },
    word(charIndex, t) {
      let k = words.findIndex((w) => charIndex < w.end);
      if (k < 0) return;
      if (last && k > last.k) {
        // How long those words "should" have taken, against how long they did: her pace.
        let expected = 0;
        for (let i = last.k; i < k; i += 1) expected += wordLength(words[i], rate * pace) + pauseLength(words[i], rate * pace);
        const took = t - last.t;
        if (took > 0.05) pace = Math.min(1.9, Math.max(0.55, pace * (1 + 0.6 * (expected / took - 1))));
      }
      last = { k, t };
      from(k, t, 0);
    },
    stop(t) {
      for (const s of segs) if (s.e > t) s.e = Math.max(s.s, t);
      segs = segs.filter((s) => s.e > s.s + 1e-4);
      segs.push(ready(silence(t, t + 0.4)));
      end = t;
    },
    segs: () => segs,
    end: () => end,
    pace: () => pace,
  };
}

/* ------------------------------ a live voice ------------------------------ */

/**
 * A voice heard as it comes (GPT-Live), its words arriving as text a little
 * ahead: add(text) as it arrives; each frame step(dt, loudness) moves along
 * the words while she's heard (and holds, or skips to the next pause, while
 * she's quiet; a syllable's onset pulls the nearest vowel to it) and gives
 * the time to show on segs(), or null when there are no words for what's
 * heard (the face then follows the sound alone).
 */
export function createFollower() {
  let text = '';
  let done = 0;
  let segs = [];
  let end = 0;
  let pos = 0;
  let rate = 1;
  let quiet = 0;
  let starved = 0;
  let prev = 0;

  function take(final) {
    // Only whole words (what's after the last space may still be growing).
    const cut = final ? text.length : Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n')) + 1;
    if (cut <= done) return;
    const words = textPhones(text.slice(done, cut));
    if (!final && words.length && !/[.!?…,;:]\s*$/.test(text.slice(done, cut))) words.at(-1).pause = '';
    done = cut;
    if (!words.length) return;
    const start = Math.max(end, pos);
    const lay = layoutWords(words, { start, lead: segs.length ? 0 : 0.2, tail: 0 });
    segs = [...segs.filter((s) => s.e > pos - 1), ...lay.segs];
    end = lay.end;
  }

  return {
    add(delta) {
      text += String(delta || '');
      take(false);
    },
    flush: () => take(true),
    reset() {
      text = '';
      done = 0;
      segs = [];
      end = pos = 0;
      rate = 1;
      quiet = starved = prev = 0;
    },
    segs: () => segs,
    step(dt, loud) {
      const voiced = loud > 0.06;
      if (pos >= end - 1e-3) {
        // Heard with no words for it yet: when they come, she's that far into them.
        if (voiced) starved += dt;
        prev = loud;
        return null;
      }
      if (starved) {
        pos = Math.min(end, pos + starved * rate);
        starved = 0;
      }
      const onset = prev < 0.15 && loud >= 0.25;
      prev = loud;
      if (voiced || quiet < 0.12) pos += dt * rate;
      if (voiced) {
        quiet = 0;
        if (onset) {
          const next = segs.find((s) => s.stress >= 0 && s.s > pos - 0.03 && s.s < pos + 0.25);
          if (next) {
            if (next.s > pos + 0.04) rate = Math.min(1.6, rate * 1.04);
            pos = Math.max(pos, next.s - 0.01);
          } else rate = Math.max(0.7, rate * 0.98);
        }
      } else {
        quiet += dt;
        // Quiet a while: to the pause it's likely in.
        const reach = quiet > 0.6 ? 1.5 : quiet > 0.12 ? 0.4 : 0;
        if (reach) {
          const pause = segs.find((s) => !s.p && s.s >= pos - 0.01 && s.s < pos + reach);
          if (pause) pos = Math.max(pos, pause.s + 0.02);
        }
      }
      pos = Math.min(pos, end);
      return pos;
    },
  };
}

/* ------------------------------ cues ------------------------------ */

// Where her voice is played (app.js, talk.js, live.js) tells her face what's said; face.js listens.
const cues = new Set();
/** Listen for cues: fn(type, data); returns a stop. */
export function onSpeechCue(fn) {
  cues.add(fn);
  return () => cues.delete(fn);
}
/**
 * Tell her face: 'clip' { audio (an <audio> about to play), text, bytes
 * (its file, ArrayBuffer), alignment (ElevenLabs', or none) }; 'stream'
 * { text } (a live voice's words as they come); 'stream-end'.
 */
export function speechCue(type, data) {
  for (const fn of cues) {
    try {
      fn(type, data);
    } catch (error) {
      console.warn('[lipsync]', error);
    }
  }
}
