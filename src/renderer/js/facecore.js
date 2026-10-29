import { FACE } from './katanaface.js';

/**
 * Katana's face as numbers, with no drawing in it (face.js draws it; the
 * tests run it in Node):
 *
 *   - her portrait as a continuous tone map, from the traced dots of her
 *     picture, softened so its own halftone doesn't fight ours, and with her
 *     mouth painted out (skin), since her lips are drawn here instead;
 *   - toneAt(): how lit any spot of her face is in a pose: her lips, teeth
 *     and the opening between them drawn from the mouth's shape, her jaw
 *     dropping with it, her lids coming down, her brows lifting;
 *   - her mouth shapes (visemes) and how they blend;
 *   - her voice's sound as shapes, when there are no words to go by
 *     (loudness and a rough guess at the vowel from its spectrum); words
 *     are lipsync.js's.
 *
 * Coordinates are her picture's own pixels (FACE.width × FACE.height).
 */

export const W = FACE.width;
export const H = FACE.height;
const { mouth: MOUTH, eyes: EYES, brows: BROWS } = FACE;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, v) {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** 1 inside [a, b], easing over `soft` at each edge; a band thinner than its edges fades. */
const band = (v, a, b, soft = 0.55) => (b <= a ? 0 : smoothstep(a - soft, a + soft, v) * (1 - smoothstep(b - soft, b + soft, v)));

/* ------------------------------ the portrait ------------------------------ */

/** A separable Gaussian blur of a w × h map. */
export function blur(src, w, h, sigma) {
  if (sigma < 0.3) return Float32Array.from(src);
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i += 1) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i += 1) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let i = -r; i <= r; i += 1) v += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let i = -r; i <= r; i += 1) v += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
      out[y * w + x] = v;
    }
  }
  return out;
}

/** How lit a spot of a tone map is, between its pixels (0 off the picture). */
export function sample(map, x, y) {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (xx, yy) => (xx >= 0 && yy >= 0 && xx < W && yy < H ? map[yy * W + xx] : 0);
  return lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
}

/** Where her lips meet, at x (the line slopes down to her left). */
const lipLine = (x) => MOUTH.y + (x - MOUTH.x) * MOUTH.slope;

let base0 = null;
/**
 * Her portrait as tones (0..1, W × H): the traced dots softened past their
 * own halftone grid, local contrast put back so her features stay sharp,
 * and her lips painted out with the skin around them.
 */
export function portrait() {
  if (base0) return base0;
  const raw = atob(FACE.dots);
  const dots = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) dots[i] = raw.charCodeAt(i) / 255;
  const soft = blur(dots, W, H, 1.7);
  const wide = blur(soft, W, H, 6);
  const map = new Float32Array(W * H);
  // Local contrast back, then a little more overall: her lit skin near white, her shadows clear.
  for (let i = 0; i < map.length; i += 1) map[i] = clamp01((soft[i] + 0.6 * (soft[i] - wide[i]) - 0.05) / 0.82) ** 0.9;
  // Her lips out: each column between the skin above them and below, feathered at the corners.
  const reach = MOUTH.rx + 7;
  for (let x = Math.floor(MOUTH.x - reach); x <= Math.ceil(MOUTH.x + reach); x += 1) {
    const f = 1 - smoothstep(MOUTH.rx - 1, reach, Math.abs(x - MOUTH.x));
    if (f <= 0) continue;
    const y0 = Math.floor(lipLine(x) - 7);
    const y1 = Math.ceil(lipLine(x) + 13);
    const top = map[y0 * W + x];
    const bottom = map[y1 * W + x];
    for (let y = y0 + 1; y < y1; y += 1) map[y * W + x] = lerp(map[y * W + x], lerp(top, bottom, (y - y0) / (y1 - y0)), f);
  }
  base0 = map;
  return map;
}

/** Her portrait softened for marks `spacing` pixels apart (a small face needs fewer, broader ones). */
export function portraitFor(spacing) {
  const sigma = Math.max(0, spacing * 0.42 - 0.6);
  return sigma < 0.3 ? portrait() : blur(portrait(), W, H, sigma);
}

/* ------------------------------ her mouth ------------------------------ */

/**
 * A mouth's shape, in her picture's pixels:
 *   open      how far her lips part, at the middle
 *   width     how wide, against her mouth at rest
 *   round     0 a lens-shaped opening, 1 a round one (and narrower)
 *   upper     her upper lip lifted off her teeth
 *   teethTop, teethBot   how much of her teeth show (0..1)
 *   tuck      her lower lip drawn up under her top teeth (f, v)
 *   press     her lips pressed together, thin (m, b, p)
 *   smile     her mouth's corners up
 *   full      how full her lips are (pushed out for o, thin for ee)
 *   tongue    her tongue's tip showing, up at her top teeth (l, t) or between them (th)
 */
const REST = { open: 0, width: 1, round: 0, upper: 0, teethTop: 0, teethBot: 0, tuck: 0, press: 0, smile: 0.08, full: 1, tongue: 0 };
export const PARAMS = Object.keys(REST);

// Her speech sounds' shapes (lipsync.js says which sound is which), then 'open' and 'smile' for her voice heard alone and her moods.
export const VISEMES = {
  rest: { ...REST },
  open: { ...REST, open: 5, teethTop: 0.3, width: 0.97 },
  ah: { ...REST, open: 12, width: 0.92, round: 0.25, teethTop: 0.8, teethBot: 0.4, full: 0.95 },
  ae: { ...REST, open: 9, width: 1.04, round: 0.1, teethTop: 0.8, teethBot: 0.35, smile: 0.2, full: 0.9 },
  eh: { ...REST, open: 6.5, width: 1.12, teethTop: 0.9, teethBot: 0.55, smile: 0.3, full: 0.85 },
  ee: { ...REST, open: 5.5, width: 1.25, teethTop: 1, teethBot: 1, smile: 0.55, full: 0.7 },
  oh: { ...REST, open: 9, width: 0.62, round: 1, teethTop: 0.15, full: 1.45, smile: 0 },
  uw: { ...REST, open: 3.2, width: 0.5, round: 1, full: 1.6, smile: 0 },
  er: { ...REST, open: 4, width: 0.74, round: 0.7, upper: 0.3, teethTop: 0.35, full: 1.3, smile: 0 },
  w: { ...REST, open: 1.6, width: 0.46, round: 1, full: 1.7, smile: 0 },
  l: { ...REST, open: 5.5, teethTop: 0.8, teethBot: 0.3, tongue: 0.85 },
  th: { ...REST, open: 3, width: 1.02, upper: 0.4, teethTop: 1, teethBot: 0.6, tongue: 1 },
  sz: { ...REST, open: 1.7, width: 1.12, upper: 0.3, teethTop: 1, teethBot: 1, smile: 0.3, full: 0.8 },
  sh: { ...REST, open: 2.8, width: 0.76, round: 0.6, upper: 0.9, teethTop: 1, teethBot: 0.9, full: 1.45, smile: 0 },
  fv: { ...REST, open: 0.6, upper: 2.6, teethTop: 1, tuck: 1, full: 1 },
  mbp: { ...REST, press: 1, width: 0.95, full: 0.5, smile: 0 },
  kg: { ...REST, open: 4.5, width: 0.98, teethTop: 0.5, teethBot: 0.3, full: 0.95 },
  tdn: { ...REST, open: 3.2, width: 1.03, teethTop: 0.8, teethBot: 0.5, tongue: 0.45 },
  smile: { ...REST, open: 2.6, width: 1.22, smile: 1, teethTop: 0.7, full: 0.8 },
};
export const VISEME_NAMES = Object.keys(VISEMES);
export const VISEME_LABELS = {
  rest: 'Rest', open: 'Slightly open', ah: 'Ah (father)', ae: 'A / uh (cat, cup)', eh: 'Eh / ih (bed, bit)', ee: 'Ee (see)', oh: 'Oh / aw (go, saw)', uw: 'Oo (you)',
  er: 'Er / r', w: 'W', l: 'L', th: 'Th', sz: 'S / z', sh: 'Sh / ch / j', fv: 'F / v', mbp: 'M / b / p', kg: 'K / g / ng', tdn: 'T / d / n', smile: 'Smile',
};

/** A mouth from weighted visemes ({ ah: 0.6, rest: 0.4 }): their shapes blended; nothing weighted is rest. */
export function blendShape(weights) {
  let total = 0;
  for (const name of VISEME_NAMES) total += Math.max(0, weights[name] || 0);
  const out = {};
  for (const p of PARAMS) out[p] = 0;
  if (total <= 1e-6) return { ...REST };
  for (const name of VISEME_NAMES) {
    const w = Math.max(0, weights[name] || 0) / total;
    if (!w) continue;
    for (const p of PARAMS) out[p] += VISEMES[name][p] * w;
  }
  return out;
}

/* ------------------------------- a pose ------------------------------- */

/**
 * A pose: { mouth (a shape), blink: [left, right] (0 open .. 1 shut; a
 * little below 0 is wide), brow: [left, right] (pixels raised) }.
 */
export const restPose = () => ({ mouth: { ...REST }, blink: [0, 0], brow: [0, 0] });

const MA = Math.atan(MOUTH.slope);
const MC = Math.cos(MA);
const MS = Math.sin(MA);

/** The box (in her picture's pixels) inside which a pose changes anything. */
export const MOVING = [
  { x0: MOUTH.x - MOUTH.rx * 2.4, x1: MOUTH.x + MOUTH.rx * 2.4, y0: MOUTH.y - MOUTH.rx * 2.4 * MOUTH.slope - 14, y1: MOUTH.y + MOUTH.rx * 2.4 * MOUTH.slope + 46 },
  ...EYES.map((e) => ({ x0: e.x - e.rx * 1.35, x1: e.x + e.rx * 1.35, y0: e.y - e.ry * 2.5, y1: e.y + e.ry * 2.1 })),
  ...BROWS.map((b) => ({ x0: b.x - b.rx * 1.65, x1: b.x + b.rx * 1.65, y0: b.y - b.ry * 2.3, y1: b.y + b.ry * 2.3 })),
];
export const moves = (x, y) => MOVING.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
/** Which part of her moves at a spot: 'mouth' (her mouth's shape alone), 'eyes' (her lids and brows), or null. */
export const movingPart = (x, y) => (!moves(x, y) ? null : x >= MOVING[0].x0 && x <= MOVING[0].x1 && y >= MOVING[0].y0 && y <= MOVING[0].y1 ? 'mouth' : 'eyes');

/** How lit a spot of her face is (0..1) in a pose, on the tone map `map`. */
export function toneAt(map, x, y, pose) {
  const P = pose.mouth;
  let sx = x;
  let sy = y;
  let shade = 1;

  // Brows: the skin around each slides up (sampled from below).
  for (let i = 0; i < BROWS.length; i += 1) {
    const raise = pose.brow[i];
    if (!raise) continue;
    const b = BROWS[i];
    const dx = (x - b.x) / (b.rx * 1.6);
    const dy = (y - b.y) / (b.ry * 2.2);
    const r2 = dx * dx + dy * dy;
    if (r2 < 1) sy += raise * (1 - r2) * (1 - r2);
  }

  // Eyes: an upper lid comes down (the skin above slides down with it), a
  // lower one rises a little, and they meet in a lash line. Curved: it
  // closes most in the middle. Below 0 the eye opens a little wider.
  for (let i = 0; i < EYES.length; i += 1) {
    const blink = pose.blink[i];
    if (Math.abs(blink) < 0.01) continue;
    const e = EYES[i];
    const ex = (x - e.x) / e.rx;
    const ey = (sy - e.y) / e.ry;
    if (ex <= -1.3 || ex >= 1.3 || ey <= -2.4 || ey >= 2) continue;
    const b = blink * (1 - (ex / 1.3) ** 2);
    const upper = -1.2 + b * 1.5;
    const lower = 1.2 - Math.max(0, b) * 0.9;
    let from;
    if (ey < upper) from = -2.4 + ((ey + 2.4) * 1.2) / (upper + 2.4);
    else if (ey > lower) from = 2 - ((2 - ey) * 0.8) / (2 - lower);
    else from = lower - upper > 0.05 ? -1.2 + ((ey - upper) / (lower - upper)) * 2.4 : 0;
    sy = e.y + from * e.ry;
    if (b > 0.3) shade *= 1 - 0.88 * clamp01((b - 0.3) / 0.3) * clamp01(1 - Math.abs(ey - upper) / 0.35);
  }

  // The mouth, in its own frame: u along her lips, v down from where they meet.
  const dx = x - MOUTH.x;
  const dy = y - MOUTH.y;
  const u = dx * MC + dy * MS;
  const v = -dx * MS + dy * MC;
  const half = MOUTH.rx * P.width;
  const un = u / half;
  const wi = lerp(0.95, 0.62, P.round); // the opening's half-width, against the lips'
  const ui = un / wi;
  const prof = Math.abs(ui) < 1 ? (1 - ui * ui) ** lerp(1.1, 0.55, P.round) : 0;
  const openTop = P.open * 0.32 + P.upper * 1.3;
  const openBot = P.open * 0.68 * (1 - P.tuck * 0.85);
  // Her jaw drops with her lower lip; the chin follows, fading out toward her neck and cheeks.
  if (v > 0 && openBot > 0.01) {
    const hf = 1 - smoothstep(MOUTH.rx * 1.3, MOUTH.rx * 2.1, Math.abs(u));
    const vf = 1 - smoothstep(20, 40, v);
    const drop = openBot * hf * vf * smoothstep(-1, 3, v);
    sx -= drop * MS;
    sy -= drop * MC;
  }
  // Her upper lip lifting pulls the skin above it up a little.
  if (v < 0 && v > -12 && P.upper > 0.01) sy += P.upper * 0.8 * (1 + v / 12) * (1 - smoothstep(MOUTH.rx, MOUTH.rx * 1.5, Math.abs(u)));

  const skin = sample(map, sx, sy) * shade;
  if (Math.abs(un) > 1.3 || v < -10 || v > 18 + P.open) return clamp01(skin);

  // Her lips: the middle curves with a smile (corners up).
  const c = -P.smile * 4.5 * un * un + P.smile * 1.2;
  const top = c - openTop * prof;
  const bot = c + openBot * prof;
  const taper = Math.sqrt(Math.max(0, 1 - un * un));
  const upTh = 2.6 * P.full * (1 - 0.45 * P.press) * taper;
  const loTh = 3.8 * P.full * (1 - 0.45 * P.press) * (1 - 0.3 * P.tuck) * taper;
  const light = 1 - 0.2 * un; // lit from her right (the picture's left)
  let out = skin;
  // Upper lip: in shadow under her nose; lower: fuller, a highlight on it.
  const lit = Math.exp(-(((v - (bot + loTh * 0.45)) / Math.max(0.6, loTh * 0.3)) ** 2)) * taper;
  out = lerp(out, skin * (0.55 - 0.1 * P.press) * light, band(v, top - upTh, top));
  out = lerp(out, skin * (0.78 + 0.16 * lit - 0.12 * P.press - 0.2 * P.tuck) * light, band(v, bot, bot + loTh));
  // Pressed lips roll in and bulge the chin below them: a lit ridge, then a shadow.
  if (P.press > 0.01) {
    out = lerp(out, Math.min(1, skin * 1.15), P.press * band(v, bot + loTh, bot + loTh + 2.2, 0.7) * taper);
    out *= 1 - 0.35 * P.press * band(v, bot + loTh + 2.2, bot + loTh + 5, 0.9) * taper;
  }
  // The opening: dark, her teeth along its top (and bottom), her tongue low in a wide one.
  const gap = bot - top;
  const inOpen = band(v, top, bot, 0.45);
  if (inOpen > 0.001) {
    const across = 1 - smoothstep(0.65, 0.95, Math.abs(ui));
    // Teeth a little grey (in her mouth's shade), with dark between the rows, so they read against her skin.
    const upperTeeth = P.teethTop * band(v, top + 0.3, top + Math.min(2.4, gap * 0.42), 0.4) * across;
    const lowerTeeth = P.teethBot * band(v, bot - Math.min(1.7, gap * 0.28), bot - 0.2, 0.4) * across;
    const tongue = smoothstep(4, 8, P.open) * band(v, bot - gap * 0.45, bot - gap * 0.12, 0.8) * (1 - Math.abs(ui));
    let inside = Math.max(0.04, upperTeeth * 0.66 * light, lowerTeeth * 0.55 * light, tongue * 0.28);
    // Its tip, up at her top teeth (in front of them for th).
    if (P.tongue > 0.01) {
      const tip = P.tongue * band(v, top + 0.5, top + Math.min(gap - 0.2, 1.2 + 2.2 * P.tongue), 0.5) * (1 - smoothstep(0.2, 0.5, Math.abs(ui)));
      inside = lerp(inside, 0.42 * light, tip);
    }
    out = lerp(out, inside, inOpen);
  }
  // Where closed lips meet: a dark seam, longer and darker pressed.
  const seamLen = 1 - smoothstep(0.82 + 0.18 * P.press, 1.08 + 0.18 * P.press, Math.abs(un));
  const seam = (1 - smoothstep(0.2, 1.6, gap)) * Math.exp(-(((v - c) / (0.75 + 0.6 * P.press)) ** 2)) * seamLen;
  out *= 1 - seam * (0.82 + 0.15 * P.press) * (0.75 + 0.25 * light);
  // Her mouth's corners: a small shadow, deeper as she smiles.
  for (const side of [-1, 1]) {
    const cu = (un - side) * half;
    const cv = v - (c - P.smile * 0.6);
    out *= 1 - (0.3 + 0.35 * P.smile) * Math.exp(-(cu * cu) / 3 - (cv * cv) / 2.2);
  }
  return clamp01(out);
}

/* ------------------------------- smoothing ------------------------------- */

/**
 * A critically damped spring toward `target` (no overshoot, no snapping):
 * `s` is { x, v }, `omega` how quick (per second).
 */
export function spring(s, target, dt, omega) {
  const step = Math.min(dt, 0.05);
  const f = 1 + 2 * step * omega;
  const oo = omega * omega;
  const v = (s.v + step * oo * (target - s.x)) / (f + step * step * oo);
  s.x += step * v;
  s.v = v;
  return s.x;
}

/* ------------------------- sound to mouth shapes ------------------------- */

/** The bands spectrum() measures, in Hz: her voice's body, the vowel's second formant, brightness, hiss. */
export const BANDS = [150, 900, 2200, 4500, 9000];
const tri = (v, a, b, c) => (v <= a || v >= c ? 0 : v < b ? (v - a) / (b - a) : (c - v) / (c - b));

/**
 * Mouth shapes from her voice's sound: `level` (0..1, loud) and `bands`
 * (power in each BANDS range). Loudness opens her mouth; where the sound's
 * weight sits guesses the vowel: low and dark is a rounded o/oo, middle an
 * ah, bright an ee, mostly hiss an f/s; a sudden drop mid-speech is her
 * lips closing (m, b, p). `memory` ({}) carries what was loud recently.
 */
export function soundWeights({ level = 0, bands = [0, 0, 0, 0] } = {}, memory = {}, dt = 1 / 60) {
  const loud = clamp01(level);
  memory.peak = Math.max(loud, (memory.peak || 0) * Math.exp(-dt / 0.25));
  const total = bands.reduce((s, b) => s + b, 0);
  if (loud < 0.04 || total <= 0) {
    // Quiet right after sound: lips pressed for a moment, else at rest.
    const closing = clamp01((memory.peak - loud) * 2.5) * (loud < 0.04 ? 1 : 0);
    return { mbp: closing * 0.8, rest: 1 - closing * 0.8 };
  }
  const [low, mid, high, hiss] = bands.map((b) => b / total);
  // The sound's centre of weight, in kHz.
  const centre = low * 0.5 + mid * 1.5 + high * 3.3 + hiss * 6.5;
  const fric = smoothstep(0.3, 0.55, hiss) * (1 - smoothstep(0.55, 0.9, loud));
  const vowel = 1 - fric;
  const open = smoothstep(0.04, 0.6, loud);
  const w = {
    oh: vowel * Math.max(tri(centre, 0, 0.55, 1.1), centre < 0.55 ? 1 : 0) * open,
    ah: vowel * tri(centre, 0.7, 1.3, 2.0) * smoothstep(0.35, 0.75, loud),
    open: vowel * tri(centre, 0.7, 1.3, 2.0) * (1 - smoothstep(0.35, 0.75, loud)) + vowel * 0.15,
    ee: vowel * Math.max(tri(centre, 1.5, 2.4, 4), centre >= 2.4 ? smoothstep(4.5, 3, centre) : 0) * open,
    fv: fric,
  };
  const sum = Object.values(w).reduce((s, x) => s + x, 0) || 1;
  const amount = Math.max(open, fric);
  for (const k of Object.keys(w)) w[k] = (w[k] / sum) * amount;
  w.rest = 1 - amount;
  return w;
}

/** Bands from a byte-free spectrum: `db` per bin (an AnalyserNode's getFloatFrequencyData), `hz` per bin. */
export function bandsOf(db, hz) {
  const out = new Array(BANDS.length - 1).fill(0);
  for (let i = 1; i < db.length; i += 1) {
    const f = i * hz;
    if (f < BANDS[0] || f >= BANDS.at(-1)) continue;
    let b = 0;
    while (f >= BANDS[b + 1]) b += 1;
    if (Number.isFinite(db[i])) out[b] += 10 ** (db[i] / 10);
  }
  return out;
}
