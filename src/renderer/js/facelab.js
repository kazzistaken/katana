import { mountFace, faceOverride, faceSpeech, faceTrouble, FACE_CROP } from './face.js';
import { VISEMES, VISEME_NAMES, VISEME_LABELS, restPose, toneAt, portrait } from './facecore.js';
import { meterNode } from './meter.js';
import { textPhones } from './g2p.js';
import { layoutWords, mouthAt } from './lipsync.js';

/**
 * The face lab (face-lab.html), opened in a test run: `npm start --
 * --xode2-test --xode2-devpage=face-lab` (or XODE2_TEST=1
 * XODE2_DEVPAGE=face-lab, or `node scripts/face-lab.mjs`, which adds a
 * throwaway data folder): her face big, cycling through every mouth shape
 * and then every state (idle, listening, thinking, speaking); each shape
 * held on its own; her mouth following Windows' voice (its word timing) and
 * following sounds (made-up vowels, through the same meter as her voice);
 * the sidebar's sizes, and her picture as the fallback; and a strip of her
 * mouth through a sentence, frame by frame, as lipsync.js shapes it.
 * window.faceLab lets a look test drive it.
 *
 * The held shapes and the strip are drawn here from her shape's tones
 * (facecore toneAt), not as marks: a page can only keep so many WebGL
 * canvases. Click one to see it on her face.
 */

const $ = (s) => document.querySelector(s);
const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
const canvas = (cls) => make('canvas', { className: cls });

const MOUTH_CROP = { x: 88, y: 138, w: 66, h: 66 };

// Her face, big, as on her screen.
const label = make('div', { className: 'lab-label' });
const big = mountFace(canvas('agent-portrait'));
$('#main').append(big.element, label);

/** Her mouth in a shape, its tones drawn straight into a canvas `size` CSS pixels square. */
function drawMouth(cnv, mouth, size) {
  const px = Math.round(size * (window.devicePixelRatio || 1));
  cnv.width = cnv.height = px;
  cnv.style.width = cnv.style.height = `${size}px`;
  const g = cnv.getContext('2d');
  const img = g.createImageData(px, px);
  const pose = { ...restPose(), mouth };
  const map = portrait();
  for (let j = 0; j < px; j += 1) {
    for (let i = 0; i < px; i += 1) {
      const v = toneAt(map, MOUTH_CROP.x + ((i + 0.5) / px) * MOUTH_CROP.w, MOUTH_CROP.y + ((j + 0.5) / px) * MOUTH_CROP.h, pose);
      const k = (j * px + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(v * 236);
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cnv;
}

// Every mouth shape, held: her mouth up close.
const cards = new Map();
for (const name of VISEME_NAMES) {
  const card = make('div', { className: 'lab-card' });
  card.append(drawMouth(canvas(''), VISEMES[name], 110), VISEME_LABELS[name]);
  card.addEventListener('click', () => lab.viseme(name));
  cards.set(name, card);
  $('#grid').append(card);
}

// The sidebar's sizes, and her picture as the fallback.
for (const [size, opts, text] of [
  [34, { crop: FACE_CROP }, '34 px (sidebar)'],
  [30, { crop: FACE_CROP }, '30 px (rail)'],
  [68, { crop: FACE_CROP }, '68 px'],
  [150, {}, '150 px'],
  [34, { crop: FACE_CROP, picture: true }, 'picture, 34 px'],
  [150, { picture: true }, 'picture, 150 px'],
]) {
  const c = canvas('');
  c.style.width = `${size}px`;
  c.style.height = opts.crop ? `${size}px` : `${Math.round((size * 250) / 220)}px`;
  const fig = make('figure');
  fig.append(c, make('figcaption', { textContent: text }));
  $('#sizes').append(fig);
  mountFace(c, opts);
}

/* ------------------------------- controls ------------------------------- */

// What the cycle shows, in order.
const STATES = ['idle', 'listening', 'thinking', 'speaking'];
const STEPS = [...VISEME_NAMES.map((viseme) => ({ viseme, ms: 1100 })), ...STATES.map((s) => ({ state: s, ms: 2600 }))];

let cycling = 0;
let state = 'idle';
let shape = null;

function show() {
  faceOverride(shape || state !== 'idle' ? { viseme: shape, state: state === 'idle' ? null : state } : null);
  label.title = faceTrouble.last;
  label.textContent = (big.drawn === 'picture' ? `[picture: ${faceTrouble.last}] ` : '') + (shape ? VISEME_LABELS[shape] : state === 'idle' ? 'Idle (blinks)' : state[0].toUpperCase() + state.slice(1));
  for (const [name, card] of cards) card.classList.toggle('is-on', name === shape);
  for (const b of document.querySelectorAll('[data-state]')) b.setAttribute('aria-pressed', String(b.dataset.state === state));
}

const lab = {
  viseme(name) {
    lab.cycle(false);
    shape = name || null;
    show();
  },
  state(name) {
    lab.cycle(false);
    shape = null;
    state = name || 'idle';
    show();
  },
  /** Every mouth shape, then every state (held longer: they move), round and round; `step` shows which. */
  cycle(on = true) {
    clearTimeout(cycling);
    cycling = 0;
    if (!on) return;
    let i = 0;
    const next = () => {
      const step = STEPS[i++ % STEPS.length];
      shape = step.viseme || null;
      state = step.state || 'idle';
      lab.step = step;
      show();
      cycling = setTimeout(next, step.ms);
    };
    next();
  },
  step: null,
  /** Windows' voice says it; her mouth follows its words. */
  say(text = 'Hi, I’m Katana. I can start a task for you, watch it, and tell you when it’s done.') {
    lab.state('idle');
    if (!('speechSynthesis' in window)) return;
    const words = new SpeechSynthesisUtterance(text);
    words.rate = 1.05;
    words.addEventListener('start', () => faceSpeech.begin(text, words.rate));
    words.addEventListener('boundary', (event) => event.name === 'word' && faceSpeech.word(event.charIndex, event.charLength));
    words.addEventListener('end', () => faceSpeech.end());
    speechSynthesis.cancel();
    speechSynthesis.speak(words);
  },
  /**
   * Her mouth through `text`, a frame every `step` seconds, as lipsync.js
   * shapes it (laid out at an easy pace): each frame with its time and the
   * sound being said.
   */
  strip(text = SAMPLE, step = 0.04) {
    const { segs, end } = layoutWords(textPhones(text));
    const row = $('#strip');
    row.replaceChildren();
    $('#strip-text').value = text;
    for (let t = 0; t <= end + 0.08; t += step) {
      const seg = segs.find((g) => g.s <= t && t < g.e);
      const fig = make('figure');
      fig.append(drawMouth(canvas(''), mouthAt(segs, t), 64), make('figcaption', { textContent: `${Math.round(t * 1000)} ${seg?.p ? `${seg.p}·${seg.v}` : '—'}` }));
      row.append(fig);
    }
    return { frames: row.children.length, seconds: end };
  },
  /** Words with no voice: laid out at a voice's pace (as before Windows' first word arrives). */
  mime(text = 'Hello there, how are you? Fine, thanks, and you? I am Katana.') {
    lab.state('idle');
    faceSpeech.begin(text, 1);
  },
  /** Made-up vowels (a, o, ee, s, m…) through her voice's meter: her mouth follows the sound alone. */
  vowels() {
    lab.state('idle');
    // Each: formants (Hz), how loud, how long (s); 0 formants is hiss.
    const plan = [
      ['ah', [800, 1200], 0.5, 0.45], ['', null, 0, 0.12], ['oh', [450, 800], 0.45, 0.45], ['', null, 0, 0.12],
      ['ee', [280, 2400], 0.45, 0.45], ['', null, 0, 0.12], ['s', 'hiss', 0.25, 0.35], ['', null, 0, 0.12], ['ah', [750, 1150], 0.5, 0.3], ['', null, 0, 0.08], ['oo', [300, 700], 0.4, 0.45],
    ];
    meterNode((ctx) => {
      const out = ctx.createGain();
      out.gain.value = 0.6;
      let t = ctx.currentTime + 0.05;
      for (const [, formants, loud, len] of plan) {
        if (loud) {
          const env = ctx.createGain();
          env.gain.setValueAtTime(0, t);
          env.gain.linearRampToValueAtTime(loud, t + 0.04);
          env.gain.setValueAtTime(loud, t + len - 0.05);
          env.gain.linearRampToValueAtTime(0, t + len);
          env.connect(out);
          if (formants === 'hiss') {
            const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
            const data = noise.getChannelData(0);
            for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
            const src = ctx.createBufferSource();
            src.buffer = noise;
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 4800;
            src.connect(hp).connect(env);
            src.start(t);
          } else {
            const voice = ctx.createOscillator();
            voice.type = 'sawtooth';
            voice.frequency.value = 190;
            for (const [i, f] of formants.entries()) {
              const bp = ctx.createBiquadFilter();
              bp.type = 'bandpass';
              bp.frequency.value = f;
              bp.Q.value = 6;
              const g = ctx.createGain();
              g.gain.value = i ? 1.6 : 2.4;
              voice.connect(bp).connect(g).connect(env);
            }
            voice.start(t);
            voice.stop(t + len);
          }
        }
        t += len;
      }
      return out;
    });
  },
};
// Her voice's hooks, for a look test (play a recording, see what her mouth follows).
lab.speech = faceSpeech;
window.faceLab = lab;
const SAMPLE = 'Hi, I’m Katana. Maybe we can fix the build for you now.';

const button = (text, onclick, data = {}) => {
  const b = make('button', { type: 'button', textContent: text, onclick });
  Object.assign(b.dataset, data);
  return b;
};
$('#bar').append(
  ...STATES.map((s) => button(s[0].toUpperCase() + s.slice(1), () => lab.state(s), { state: s })),
  make('span', { className: 'sep' }),
  button('Cycle shapes + states', () => lab.cycle(!cycling)),
  button('Say (Windows voice)', () => lab.say()),
  button('Mime words', () => lab.mime()),
  button('Mime the strip', () => lab.mime($('#strip-text').value)),
  button('Vowel sounds', () => lab.vowels()),
  make('span', { className: 'sep' }),
  button('Theme', () => (document.body.dataset.theme = document.body.dataset.theme === 'light' ? 'graphite' : 'light')),
  button('Motion: full', (e) => {
    const next = { full: 'reduced', reduced: 'off', off: 'full' }[document.body.dataset.motion || 'full'];
    document.body.dataset.motion = next;
    e.target.textContent = `Motion: ${next}`;
  })
);
$('#strip-text').addEventListener('change', (e) => lab.strip(e.target.value));
show();
lab.cycle(true);
lab.strip();
