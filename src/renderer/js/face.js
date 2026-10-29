import { W, H, VISEMES, VISEME_NAMES, PARAMS, blendShape, restPose, toneAt, movingPart, portraitFor, spring, soundWeights, smoothstep } from './facecore.js';
import { textPhones } from './g2p.js';
import { layoutWords, fromAlignment, alignToEnvelope, envelopeOf, envAt, mouthAt, jawFrom, createWordTimer, createFollower, onSpeechCue } from './lipsync.js';
import { FACE } from './katanaface.js';
import { spectrum } from './meter.js';

/**
 * Katana, alive: her face drawn as marks (dots, plus and × marks, broad
 * dots where she's lit), sized and lit from her portrait (facecore.js), one
 * WebGL draw of points, crisp at any size since each mark is drawn at the
 * screen's own resolution, on a grid of whole pixels.
 *
 * She stays perfectly still in place: only her mouth, her blinks and her
 * eyes and brows move (worked out again on the CPU, a few thousand spots,
 * only when her pose changes). Listening, her eyes open a little wider and
 * her brows lift; thinking, a light crosses her face; speaking, her lips
 * are crimson (in the shader).
 *
 * Crisp: her canvas's backing store is exactly the device pixels it covers
 * (ResizeObserver's device-pixel box) and is shown pixel for pixel
 * (image-rendering: pixelated), each mark hard-edged on whole pixels.
 *
 * Her mouth says what she says (lipsync.js): the words she's saying as
 * sounds, timed by the voice where it can (ElevenLabs' character times,
 * Windows' word boundaries), else fitted to her voice's recording, else
 * (GPT-Live) followed as it's heard; her jaw opening with her voice's
 * loudness. With no words to go by, the sound of her voice alone (meter.js
 * spectrum: loudness and a guess at the vowel), else, when nothing can be
 * heard here, syllables of its own. Her shapes ease on springs, so nothing
 * snaps.
 *
 * One loop draws every face shown, at the screen's rate while anything
 * moves; it sleeps otherwise (waking for a blink, or every quarter second
 * to see if her state changed), and stops when nothing's shown or the
 * window is hidden. Animations (Settings) and the system's reduced motion
 * are kept: Reduced holds the thinking light still; Off is her still.
 *
 * mountFace(canvas, { crop }) draws her in a canvas; if WebGL can't, her
 * picture (img/katana-face.png) takes the canvas's place.
 */

const PICTURE = new URL('../img/katana-face.png', import.meta.url).href;
// The sidebar's square: her face's middle.
export const FACE_CROP = { x: 57, y: 70, w: 136, h: 136 };

const faces = new Set();
let source = () => ({});
let override = null;

/** Where her state comes from: () => ({ listening, thinking, speaking }). */
export function setFaceSource(fn) {
  source = fn;
  kick();
}

/** For the face lab: hold a mouth shape ({ viseme }) and/or a state ({ state: 'listening' | 'thinking' | 'speaking' | 'idle' }). */
export function faceOverride(next) {
  override = next;
  kick();
}

/* ------------------------------- her voice ------------------------------- */

/**
 * What she's saying now: { kind ('words' | 'clip' | 'stream'), now(ms, dt,
 * spec) → { segs, t, loud } (her sounds, the moment in them to show, how
 * loud she is then, or null), or null when there's nothing timed to show }.
 */
let track = null;
// Her lips a little ahead of the sound: a mouth shapes a sound before it's heard, and her springs take a moment.
const LEAD = 0.06;
const sec = (ms) => ms / 1000;

/** Her recording's loudness, frame by frame (decoded here, once). */
async function envelopeFor(bytes) {
  const data = bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const audio = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(data);
  let mono = audio.getChannelData(0);
  if (audio.numberOfChannels > 1) {
    mono = Float32Array.from(mono);
    for (let c = 1; c < audio.numberOfChannels; c += 1) audio.getChannelData(c).forEach((v, i) => (mono[i] += v));
  }
  return envelopeOf(mono, audio.sampleRate);
}

/**
 * A recording of her about to play (`audio`, an <audio>): timed by
 * ElevenLabs' `alignment` when it came with one, else her words (`text`)
 * fitted to the recording's own loudness (`bytes`, its file). Its clock
 * is the recording's (so its playback rate, pauses and seeks are kept).
 */
function playClip(audio, { text = '', bytes = null, alignment = null } = {}) {
  const clip = { kind: 'clip', segs: fromAlignment(alignment)?.segs || null, env: null };
  clip.now = (_ms, _dt, spec) => {
    if (!clip.segs || audio.paused || audio.ended) return null;
    const t = audio.currentTime + LEAD;
    return { segs: clip.segs, t, loud: clip.env ? envAt(clip.env, t) : spec ? Math.min(1, spec.level * 1.5) : null };
  };
  if (bytes)
    envelopeFor(bytes)
      .then((env) => {
        clip.env = env;
        if (!clip.segs && text.trim()) clip.segs = alignToEnvelope(layoutWords(textPhones(text)).segs, env);
        kick();
      })
      .catch((error) => console.warn('[face] her recording couldn’t be read; following its sound', error?.message || error));
  audio.addEventListener('playing', kick);
  audio.addEventListener('ended', () => track === clip && (track = null));
  track = clip;
  kick();
}

// A live voice (GPT-Live): its words come as text a little ahead of the sound.
const follower = createFollower();
onSpeechCue((type, data = {}) => {
  if (type === 'clip' && data.audio) playClip(data.audio, data);
  else if (type === 'stream') {
    if (track?.kind !== 'stream') {
      follower.reset();
      track = {
        kind: 'stream',
        now(_ms, dt, spec) {
          const loud = spec ? Math.min(1, spec.level * 1.5) : 0;
          const t = follower.step(dt, loud);
          return t == null ? null : { segs: follower.segs(), t: t + LEAD, loud };
        },
      };
    }
    follower.add(data.text);
    kick();
  } else if (type === 'stream-end' && track?.kind === 'stream') {
    track = null;
    follower.reset();
  }
});

export const faceSpeech = {
  /** She starts saying `text` (Windows' voice, at `rate`): it tells each word as it says it. */
  begin(text, rate = 1) {
    const words = createWordTimer(String(text || ''), rate || 1);
    words.start(sec(performance.now()));
    track = { kind: 'words', words, now: (ms) => (sec(ms) < words.end() + 0.5 ? { segs: words.segs(), t: sec(ms) + LEAD, loud: null } : null) };
    kick();
  },
  /** She's saying the word at `index` now (a boundary event). */
  word(index) {
    if (track?.kind !== 'words') return;
    track.words.word(index, sec(performance.now()));
    kick();
  },
  end() {
    if (track?.kind === 'words') track.words.stop(sec(performance.now()));
    kick();
  },
  /** A recording of her about to play: see playClip (talk.js and the rest send it as a 'clip' cue). */
  play: (audio, info) => playClip(audio, info),
  /** What her mouth follows now, for the face lab: { kind, sounds (how many timed), mouth }. */
  info: () => ({ kind: track?.kind || null, sounds: (track?.kind === 'words' ? track.words.segs() : track?.kind === 'stream' ? follower.segs() : track?.segs || []).length, mouth: { ...drive.pose.mouth } }),
};

// Her own syllables, for a voice that can't be heard or timed here.
const BABBLE = layoutWords(textPhones('alright, I can start that for you now and tell you when it is done.'), { lead: 0, tail: 0 });

/* ------------------------------- her life ------------------------------- */

const s0 = (x = 0) => ({ x, v: 0 });
const drive = {
  last: 0,
  t: 0,
  w: Object.fromEntries(VISEME_NAMES.map((n) => [n, s0(n === 'rest' ? 1 : 0)])),
  listen: s0(),
  think: s0(),
  speak: s0(),
  brow: [s0(), s0()],
  wide: s0(),
  nextBlink: 0,
  blinkAt: -1e9,
  sweep: -80,
  sound: {},
  // Her mouth as her words shape it, on its own springs, and how much it's shown (against the shapes above).
  lip: Object.fromEntries(PARAMS.map((p) => [p, s0(VISEMES.rest[p])])),
  lipMix: s0(),
  pose: restPose(),
  settled: false,
  motion: 'full',
};

function motionNow() {
  const set = document.body.dataset.motion || 'full';
  if (set === 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced';
  return set;
}

/** A blink: a quick close and a slower open (0 open .. 1 shut). */
function blinkAt(now) {
  if (!drive.nextBlink) drive.nextBlink = now + 1600;
  if (now >= drive.nextBlink) {
    drive.blinkAt = now;
    // Now and then a double blink, as people do.
    drive.nextBlink = now + (Math.random() < 0.15 ? 280 : 2600 + Math.random() * 4200);
  }
  const since = now - drive.blinkAt;
  if (since < 0 || since > 240) return 0;
  return since < 75 ? smoothstep(0, 75, since) : 1 - smoothstep(75, 240, since);
}

function update(now) {
  const dt = drive.last ? Math.min(0.1, (now - drive.last) / 1000) : 1 / 60;
  drive.last = now;
  drive.t += dt;
  const motion = (drive.motion = motionNow());
  const still = motion === 'off';
  const forced = override?.state;
  const st = forced ? { listening: forced === 'listening', thinking: forced === 'thinking', speaking: forced === 'speaking' } : source() || {};
  const spec = spectrum();
  const heard = Boolean(spec && spec.level > 0.03);
  // Her words, timed, when there are any to show (else, if she's speaking unheard, her own syllables).
  let lip = still || override?.viseme ? null : track?.now(now, dt, spec) || null;
  const timed = Boolean(lip);
  if (!lip && !still && !override?.viseme && !heard && st.speaking) lip = { segs: BABBLE.segs, t: sec(now) % BABBLE.end, loud: null };
  const speaking = Boolean(st.speaking) || heard || timed;

  const toward = (s, target, omega) => (still ? ((s.v = 0), (s.x = target)) : spring(s, target, dt, omega));
  toward(drive.listen, st.listening && !speaking ? 1 : 0, 9);
  toward(drive.think, st.thinking && !speaking ? 1 : 0, 7);
  toward(drive.speak, speaking ? 1 : 0, 9);

  // Her mouth's shapes now, then eased toward on springs.
  let target;
  if (override?.viseme) target = { [override.viseme]: 1 };
  else if (still || lip) target = { rest: 1 };
  else if (heard) target = soundWeights(spec, drive.sound, dt);
  else target = { rest: 1 - 0.3 * drive.listen.x - 0.35 * drive.think.x, smile: 0.3 * drive.listen.x, mbp: 0.35 * drive.think.x };
  const omega = speaking || override?.viseme ? 32 : 12;
  const weights = {};
  let moving = false;
  for (const name of VISEME_NAMES) {
    const s = drive.w[name];
    const goal = target[name] || 0;
    weights[name] = Math.max(0, toward(s, goal, omega));
    if (Math.abs(s.x - goal) > 0.002 || Math.abs(s.v) > 0.01) moving = true;
  }
  // Her words' mouth: its jaw opening with how loud she is; smaller and softer when motion is reduced.
  const reduced = motion === 'reduced';
  const said = lip ? mouthAt(lip.segs, lip.t) : VISEMES.rest;
  if (lip && lip.loud != null) said.open *= jawFrom(lip.loud);
  for (const p of PARAMS) {
    const s = drive.lip[p];
    const goal = reduced ? VISEMES.rest[p] + (said[p] - VISEMES.rest[p]) * 0.7 : said[p];
    toward(s, goal, lip ? (reduced ? 20 : 38) : 12);
    if (Math.abs(s.v) > 0.01) moving = true;
  }
  toward(drive.lipMix, lip ? 1 : 0, lip ? 30 : 10);
  const pose = drive.pose;
  const mouth = blendShape(weights);
  const mix = Math.min(1, drive.lipMix.x);
  if (mix > 0.001) for (const p of PARAMS) mouth[p] += (drive.lip[p].x - mouth[p]) * mix;
  pose.mouth = mouth;

  // Eyes: wider listening (her way of showing it), a little narrowed thinking; blinks unless she's still.
  toward(drive.wide, drive.listen.x * -0.22 + drive.think.x * 0.14, 8);
  const blink = still ? 0 : blinkAt(now);
  pose.blink[0] = pose.blink[1] = Math.min(1, blink + drive.wide.x);
  // Brows: up listening, one up and one down thinking, lifting on her voice's loud moments.
  const lift = heard ? smoothstep(0.45, 0.9, spec.level) * 0.9 : 0;
  toward(drive.brow[0], 1.9 * drive.listen.x + 1.1 * drive.think.x + lift, 10);
  toward(drive.brow[1], 1.9 * drive.listen.x - 0.5 * drive.think.x + lift, 10);
  pose.brow[0] = drive.brow[0].x;
  pose.brow[1] = drive.brow[1].x;

  // The thinking light crosses her face, with a rest between passes; held still when motion is reduced.
  if (motion === 'full' && drive.think.x > 0.01) drive.sweep = drive.sweep > 470 ? -80 : drive.sweep + dt * 150;
  else if (motion !== 'full') drive.sweep = 150;

  for (const s of [drive.listen, drive.think, drive.speak, drive.wide, drive.lipMix, ...drive.brow]) if (Math.abs(s.v) > 0.01) moving = true;
  drive.settled = !moving && !blink && !timed && !speaking;
}

/* ------------------------------- drawing ------------------------------- */

const VERT = `
attribute vec2 aDev;
attribute vec3 aSrc;
attribute float aTone;
uniform vec2 uRes;
uniform float uCell, uSweep, uSweepAmt, uLipRed;
uniform vec2 uMouth;
uniform vec3 uInk, uRedC;
varying float vB;
varying float vSeed;
varying vec3 vCol;
void main() {
  vec2 p = aDev;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  gl_PointSize = uCell;
  float seed = aSrc.z;
  float b = aTone;
  // Thinking: a soft diagonal light drifting across her, crimson at its heart.
  float d = (aSrc.x + aSrc.y) * 0.7071 - uSweep;
  float band = exp(-d * d / 420.0) * uSweepAmt;
  b += band * 0.35 * smoothstep(0.03, 0.25, b);
  vec3 col = mix(uInk, uRedC, band * 0.55);
  // Speaking: her lips crimson.
  vec2 lm = (aSrc.xy - uMouth) / vec2(19.0, 8.5);
  col = mix(col, uRedC, uLipRed * exp(-dot(lm, lm) * 1.6));
  vB = clamp(b, 0.0, 1.0);
  vSeed = seed;
  vCol = col;
}`;

const FRAG = `
precision highp float;
varying float vB;
varying float vSeed;
varying vec3 vCol;
uniform float uCell;
float box(vec2 q, vec2 h) {
  vec2 d = abs(q) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
void main() {
  float b = vB;
  if (b < 0.035) discard;
  // Too small for shapes (the sidebar): each mark is its square, as lit as her face there.
  if (uCell < 3.5) {
    gl_FragColor = vec4(vCol * b, b);
    return;
  }
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  // Hard edges: under a pixel of softening, so marks are sharp, not fuzzy.
  float px = 1.2 / uCell;
  float d;
  if (b < 0.3) {
    // In shadow: dots, bigger as it lightens.
    d = length(q) - mix(0.16, 0.5, sqrt(b / 0.3));
  } else if (b < 0.68) {
    // Half-lit: plus marks, a few turned to ×.
    float k = (b - 0.3) / 0.38;
    if (vSeed > 0.8) q = vec2(q.x + q.y, q.y - q.x) * 0.7071;
    float len = mix(0.55, 0.95, k);
    float th = mix(0.15, 0.27, k);
    d = min(box(q, vec2(len, th)), box(q, vec2(th, len)));
  } else {
    // Lit: broad soft-cornered squares, touching when brightest, so only a
    // small dark point is left where four meet (her picture's lit skin).
    float k = (b - 0.68) / 0.32;
    float r = mix(0.62, 1.04, k);
    float round = mix(0.3, 0.45, k);
    d = box(q, vec2(r - round)) - round;
  }
  float a = clamp(0.5 - d / px, 0.0, 1.0);
  gl_FragColor = vec4(vCol * mix(0.5, 1.0, b) * a, a);
}`;

function compile(gl) {
  const shader = (type, text) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, text);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  const u = {};
  for (const name of ['uRes', 'uCell', 'uSweep', 'uSweepAmt', 'uLipRed', 'uMouth', 'uInk', 'uRedC']) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u, aDev: gl.getAttribLocation(prog, 'aDev'), aSrc: gl.getAttribLocation(prog, 'aSrc'), aTone: gl.getAttribLocation(prog, 'aTone') };
}

// Theme colours, read when the theme changes.
const colours = { theme: null, ink: [0.92, 0.92, 0.92], red: [0.8, 0.2, 0.33], tile: false };
function rgb(css) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}
function readColours() {
  const theme = document.body.dataset.theme || '';
  if (colours.theme === theme) return false;
  colours.theme = theme;
  // On the light theme her marks would come out dark: she keeps her own dark tile, as in her picture.
  colours.tile = theme === 'light';
  const root = getComputedStyle(document.documentElement);
  colours.ink = rgb(colours.tile ? '#ececec' : getComputedStyle(document.body).getPropertyValue('--text').trim() || '#ebebeb');
  // Her crimson, lifted a little so it reads on the dark.
  const red = rgb(root.getPropertyValue('--crimson').trim() || '#a3153a');
  colours.red = red.map((c) => c + (1 - c) * 0.3);
  return true;
}

const maps = new Map();
const mapFor = (spacing) => {
  const key = Math.round(spacing * 4) / 4;
  if (!maps.has(key)) maps.set(key, portraitFor(key));
  return maps.get(key);
};

/**
 * Her marks for a canvas `dw` × `dh` device pixels: one per cell of a grid
 * of whole pixels, covering the canvas with her picture (or `crop` of it).
 * Moving ones first, her mouth's then her eyes' and brows', so only what
 * moved is worked out and sent again.
 */
function buildField(dw, dh, crop) {
  const c = crop || { x: 0, y: 0, w: W, h: H };
  const fit = Math.max(dw / c.w, dh / c.h);
  const ox = (dw - c.w * fit) / 2 - c.x * fit;
  const oy = (dh - c.h * fit) / 2 - c.y * fit;
  // About two of her picture's pixels a mark; a tiny face (the sidebar's) is a mark a pixel.
  const cell = Math.max(1, Math.min(10, Math.round(fit * 2.1)));
  const spacing = cell / fit;
  const map = mapFor(spacing);
  const pose = restPose();
  const parts = { mouth: [], eyes: [], still: [] };
  for (let j = 0; j * cell < dh; j += 1) {
    for (let i = 0; i * cell < dw; i += 1) {
      const cx = (i + 0.5) * cell;
      const cy = (j + 0.5) * cell;
      const sx = (cx - ox) / fit;
      const sy = (cy - oy) / fit;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const part = movingPart(sx, sy) || 'still';
      const tone = part === 'still' ? toneAt(map, sx, sy, pose) : 0;
      if (part === 'still' && tone < 0.035) continue;
      // A steady random number per spot of her face.
      const h = Math.sin(Math.floor(sx * 3) * 12.9898 + Math.floor(sy * 3) * 78.233) * 43758.5453;
      parts[part].push([cx, cy, sx, sy, h - Math.floor(h), tone]);
    }
  }
  const all = [...parts.mouth, ...parts.eyes, ...parts.still];
  const data = new Float32Array(all.length * 5);
  const tone = new Float32Array(all.length);
  all.forEach((p, k) => {
    data.set(p.slice(0, 5), k * 5);
    tone[k] = p[5];
  });
  const mouth = parts.mouth.length;
  const groups = [
    { from: 0, to: mouth, key: mouthKey, last: '' },
    { from: mouth, to: mouth + parts.eyes.length, key: eyesKey, last: '' },
  ];
  return { cell, fit, spacing, map, data, tone, count: all.length, groups };
}

// What a pose looks like, to the resolution her marks can show: unchanged, nothing is worked out again.
const r = (v, k = 50) => Math.round(v * k);
const mouthKey = ({ mouth: m }) => `${r(m.open, 20)},${r(m.width)},${r(m.round)},${r(m.upper, 20)},${r(m.teethTop)},${r(m.teethBot)},${r(m.tuck)},${r(m.press)},${r(m.smile)},${r(m.full)},${r(m.tongue)}`;
const eyesKey = (p) => `${r(p.blink[0])},${r(p.blink[1])},${r(p.brow[0], 20)},${r(p.brow[1], 20)}`;

/**
 * Her moving marks that changed in a pose. Small faces' marks cover several
 * of her picture's pixels: each is averaged over four spots of it, so her
 * lips' fine lines don't flicker. Returns whether anything changed.
 */
function poseField(f, pose, gl, buffer) {
  const q = f.spacing / 4;
  const fine = f.spacing > 3;
  let changed = false;
  for (const g of f.groups) {
    const key = g.key(pose);
    if (key === g.last || g.to === g.from) continue;
    g.last = key;
    changed = true;
    for (let k = g.from; k < g.to; k += 1) {
      const x = f.data[k * 5 + 2];
      const y = f.data[k * 5 + 3];
      f.tone[k] = fine ? (toneAt(f.map, x - q, y - q, pose) + toneAt(f.map, x + q, y - q, pose) + toneAt(f.map, x - q, y + q, pose) + toneAt(f.map, x + q, y + q, pose)) / 4 : toneAt(f.map, x, y, pose);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, g.from * 4, f.tone.subarray(g.from, g.to));
  }
  return changed;
}

function setup(face) {
  const gl = face.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) throw new Error('WebGL is not available');
  face.gl = gl;
  face.prog = compile(gl);
  face.statics = gl.createBuffer();
  face.tones = gl.createBuffer();
  face.field = null;
  face.size = '';
  face.lost = false;
}

function paint(face, now) {
  const { gl, canvas } = face;
  // Exactly the device pixels the canvas covers (else its CSS size × the pixel ratio, from its unrounded box).
  const ratio = window.devicePixelRatio || 1;
  const box = canvas.getBoundingClientRect();
  const dw = face.dev?.[0] || Math.max(1, Math.round(box.width * ratio));
  const dh = face.dev?.[1] || Math.max(1, Math.round(box.height * ratio));
  const size = `${dw}x${dh}`;
  let fresh = readColours() || face.theme !== colours.theme;
  face.theme = colours.theme;
  if (face.size !== size) {
    canvas.width = dw;
    canvas.height = dh;
    face.size = size;
    face.field = buildField(dw, dh, face.crop);
    gl.bindBuffer(gl.ARRAY_BUFFER, face.statics);
    gl.bufferData(gl.ARRAY_BUFFER, face.field.data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, face.tones);
    gl.bufferData(gl.ARRAY_BUFFER, face.field.tone, gl.DYNAMIC_DRAW);
    fresh = true;
  }
  const f = face.field;
  if (poseField(f, face.pose || drive.pose, gl, face.tones)) fresh = true;
  const full = drive.motion === 'full';
  // What moves on its own, frame to frame: only the thinking light (else she's drawn only when her pose or state changes).
  face.animated = full && drive.think.x > 0.01;
  if (!fresh && !face.animated && drive.settled && face.drawn) return;
  face.drawn = true;

  const { u } = face.prog;
  gl.viewport(0, 0, dw, dh);
  if (colours.tile) gl.clearColor(0.05, 0.05, 0.05, 1);
  else gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(face.prog.prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, face.statics);
  gl.enableVertexAttribArray(face.prog.aDev);
  gl.vertexAttribPointer(face.prog.aDev, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(face.prog.aSrc);
  gl.vertexAttribPointer(face.prog.aSrc, 3, gl.FLOAT, false, 20, 8);
  gl.bindBuffer(gl.ARRAY_BUFFER, face.tones);
  gl.enableVertexAttribArray(face.prog.aTone);
  gl.vertexAttribPointer(face.prog.aTone, 1, gl.FLOAT, false, 4, 0);

  gl.uniform2f(u.uRes, dw, dh);
  gl.uniform1f(u.uCell, f.cell);
  gl.uniform1f(u.uSweep, drive.sweep);
  gl.uniform1f(u.uSweepAmt, drive.think.x * (full ? 1 : 0.45));
  gl.uniform1f(u.uLipRed, drive.speak.x * 0.6);
  gl.uniform2f(u.uMouth, FACE.mouth.x, FACE.mouth.y + 1.5);
  gl.uniform3fv(u.uInk, colours.ink);
  gl.uniform3fv(u.uRedC, colours.red);
  gl.drawArrays(gl.POINTS, 0, f.count);
}

/* -------------------------------- the loop -------------------------------- */

let raf = 0;
let timer = 0;
let drawnAt = 0;
const FRAME_MS = 1000 / 61; // 60 a second is smooth for her; a faster screen doesn't make her work harder

export function kick() {
  if (raf) return;
  clearTimeout(timer);
  timer = 0;
  raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  if (document.hidden) return;
  if (now - drawnAt < FRAME_MS) {
    raf = requestAnimationFrame(frame);
    return;
  }
  drawnAt = now;
  const shown = [...faces].filter((f) => f.gl && !f.lost && f.visible && f.canvas.isConnected && f.canvas.clientWidth > 0);
  if (!shown.length) return;
  update(now);
  let busy = !drive.settled;
  for (const face of shown) {
    try {
      paint(face, now);
    } catch (error) {
      fallback(face, error);
    }
    busy ||= face.animated;
  }
  if (busy) raf = requestAnimationFrame(frame);
  else timer = setTimeout(kick, drive.motion === 'off' ? 250 : Math.max(16, Math.min(250, drive.nextBlink - performance.now())));
}

document.addEventListener('visibilitychange', () => !document.hidden && kick());
new MutationObserver(kick).observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });

// Why she was last shown as her picture instead (the face lab shows it).
export const faceTrouble = { last: '' };

/** Her picture instead, when she can't be drawn. */
function fallback(face, error) {
  if (face.element !== face.canvas) return;
  faceTrouble.last = String(error?.message || error);
  console.warn('[face] drawn from her picture instead:', faceTrouble.last);
  const img = document.createElement('img');
  img.src = PICTURE;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.className = `${face.canvas.className} face-picture`;
  img.style.cssText = face.canvas.style.cssText;
  if (face.crop) {
    // The same middle of her face as the drawing shows.
    const { x, y, w, h } = face.crop;
    img.style.objectViewBox = `inset(${y}px ${W - x - w}px ${H - y - h}px ${x}px)`;
  }
  face.element = img;
  face.gl = null;
  face.canvas.replaceWith(img);
}

/**
 * Draw Katana in `canvas` (sized by CSS). `crop`: a part of her picture to
 * fill it with (FACE_CROP for a small square); `viseme`: hold that mouth
 * shape whatever she's doing (the face lab); `picture`: start as her
 * picture (the lab's check of the fallback). Returns { element (the canvas,
 * or her picture in its place), drawn ('marks' | 'picture'), destroy }.
 */
export function mountFace(canvas, { crop = null, viseme = null, picture = false } = {}) {
  const face = { canvas, element: canvas, crop, visible: true, gl: null, pose: viseme ? { ...restPose(), mouth: { ...VISEMES[viseme] } } : null };
  if (picture) fallback(face, new Error('asked for her picture'));
  else {
    try {
      setup(face);
    } catch (error) {
      fallback(face, error);
    }
  }
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    face.lost = true;
    // Back soon, or her picture.
    setTimeout(() => face.lost && fallback(face, new Error('WebGL context lost')), 3000);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      setup(face);
      kick();
    } catch (error) {
      fallback(face, error);
    }
  });
  const resize = new ResizeObserver((entries) => {
    const dev = entries.at(-1).devicePixelContentBoxSize?.[0];
    face.dev = dev ? [dev.inlineSize, dev.blockSize] : null;
    kick();
  });
  try {
    resize.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    resize.observe(canvas);
  }
  const seen = new IntersectionObserver((entries) => {
    face.visible = entries.at(-1).isIntersecting;
    kick();
  });
  seen.observe(canvas);
  faces.add(face);
  kick();
  return {
    get element() {
      return face.element;
    },
    get drawn() {
      return face.gl ? 'marks' : 'picture';
    },
    destroy() {
      faces.delete(face);
      resize.disconnect();
      seen.disconnect();
    },
  };
}
