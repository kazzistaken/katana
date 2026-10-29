import assert from 'node:assert/strict';
import {
  VISEMES, VISEME_NAMES, PARAMS, MOVING, blendShape, restPose, toneAt, sample, portrait, portraitFor,
  spring, soundWeights, bandsOf, BANDS, W, H,
} from '../src/renderer/js/facecore.js';
import { FACE } from '../src/renderer/js/katanaface.js';

const map = portrait();
const posed = (viseme, extra = {}) => ({ ...restPose(), mouth: { ...VISEMES[viseme] }, ...extra });
const top = (w) => Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];

// Her portrait: her picture's size, lit where her face is and dark around it.
{
  assert.equal(map.length, W * H);
  assert.ok(sample(map, 100, 140) > 0.7, 'her cheek is lit');
  assert.ok(sample(map, 5, 5) < 0.05, 'the corner is background');
  assert.equal(sample(map, -3, 40), 0);
  // A smaller face's map is softer, never brighter overall.
  const soft = portraitFor(8);
  assert.ok(Math.abs(soft.reduce((s, v) => s + v, 0) - map.reduce((s, v) => s + v, 0)) / map.length < 0.02);
}

// The visemes: each its own shape; blending is a weighted mix; nothing weighted is rest.
{
  assert.deepEqual(VISEME_NAMES, ['rest', 'open', 'ah', 'ae', 'eh', 'ee', 'oh', 'uw', 'er', 'w', 'l', 'th', 'sz', 'sh', 'fv', 'mbp', 'kg', 'tdn', 'smile']);
  const keys = new Set(VISEME_NAMES.map((n) => PARAMS.map((p) => VISEMES[n][p].toFixed(2)).join()));
  assert.equal(keys.size, VISEME_NAMES.length, 'every shape differs');
  assert.deepEqual(blendShape({ ah: 1 }), VISEMES.ah);
  assert.deepEqual(blendShape({}), VISEMES.rest);
  const half = blendShape({ ah: 1, oh: 1 });
  for (const p of PARAMS) assert.ok(Math.abs(half[p] - (VISEMES.ah[p] + VISEMES.oh[p]) / 2) < 1e-9, p);
  assert.ok(VISEMES.ah.open > VISEMES.open.open && VISEMES.open.open > VISEMES.rest.open);
  assert.ok(VISEMES.oh.width < VISEMES.rest.width && VISEMES.ee.width > VISEMES.rest.width);
}

// Her face in a pose: only her mouth, eyes and brows change, and with no seam where they meet the rest.
{
  const M = FACE.mouth;
  const rest = restPose();
  const dark = (pose) => toneAt(map, M.x, M.y + 2, pose);
  assert.ok(dark(posed('ah')) < 0.15, 'an open ah is dark inside');
  assert.ok(dark(posed('ah')) < dark(rest) - 0.3, 'darker than her closed mouth');
  // How much of her lip line is dark: a wide ee, a round narrow oh.
  const span = (pose) => {
    let n = 0;
    for (let x = M.x - 30; x <= M.x + 30; x += 0.5) if (toneAt(map, x, M.y + (x - M.x) * M.slope + 1, pose) < 0.3) n += 1;
    return n;
  };
  assert.ok(span(posed('ee')) > span(posed('oh')), `ee ${span(posed('ee'))} wider than oh ${span(posed('oh'))}`);
  // Blinking darkens the lash line over her eye's middle and changes the lid.
  const e = FACE.eyes[0];
  const shut = { ...rest, blink: [1, 1] };
  let changed = 0;
  for (let y = e.y - e.ry * 2; y < e.y + e.ry * 2; y += 1) if (Math.abs(toneAt(map, e.x, y, shut) - toneAt(map, e.x, y, rest)) > 0.05) changed += 1;
  assert.ok(changed >= 3, `a blink changes her eye (${changed} rows)`);
  // Raised brows move her brow.
  const b = FACE.brows[0];
  let moved = 0;
  for (let y = b.y - 8; y < b.y + 8; y += 1) moved += Math.abs(toneAt(map, b.x, y, { ...rest, brow: [2, 0] }) - toneAt(map, b.x, y, rest));
  assert.ok(moved > 0.1, 'a raised brow moves');
  // At rest and away from where she moves, a spot is just her portrait.
  assert.equal(toneAt(map, 60, 60, rest), sample(map, 60, 60));
  // The edges of every moving region look the same in any pose (no seam).
  const wild = { mouth: { ...VISEMES.ah, smile: 1, upper: 2 }, blink: [1, 1], brow: [2, -1] };
  for (const r of MOVING) {
    for (let t = 0; t <= 1; t += 0.05) {
      for (const [x, y] of [[r.x0 + (r.x1 - r.x0) * t, r.y0], [r.x0 + (r.x1 - r.x0) * t, r.y1], [r.x0, r.y0 + (r.y1 - r.y0) * t], [r.x1, r.y0 + (r.y1 - r.y0) * t]]) {
        // An edge inside another region (the eyes' tops are in the brows') may move with that one.
        if (MOVING.some((o) => o !== r && x > o.x0 && x < o.x1 && y > o.y0 && y < o.y1)) continue;
        assert.ok(Math.abs(toneAt(map, x, y, wild) - toneAt(map, x, y, rest)) < 0.02, `seam at ${x.toFixed(1)},${y.toFixed(1)}`);
      }
    }
  }
}

// Springs: they reach the target smoothly, without overshooting.
{
  const s = { x: 0, v: 0 };
  let max = 0;
  let prev = 0;
  let step = 0;
  for (let i = 0; i < 120; i += 1) {
    spring(s, 1, 1 / 60, 30);
    max = Math.max(max, s.x);
    step = Math.max(step, s.x - prev);
    prev = s.x;
  }
  assert.ok(Math.abs(s.x - 1) < 1e-3 && max <= 1 + 1e-6, 'settles without overshoot');
  assert.ok(step < 0.25, `no snap (${step.toFixed(3)} a frame)`);
}

// Sound to mouth shapes: loud and dark is o, middle is ah, bright is ee, hiss is f; quiet is rest; a sudden drop is lips closing.
{
  const loud = 0.8;
  assert.equal(top(soundWeights({ level: loud, bands: [10, 1, 0.1, 0.05] })), 'oh');
  assert.equal(top(soundWeights({ level: loud, bands: [3, 4, 0.5, 0.1] })), 'ah');
  // Quieter, the same vowel is a smaller opening (and mostly closed).
  const quiet = soundWeights({ level: 0.25, bands: [3, 4, 0.5, 0.1] });
  assert.ok(quiet.open > quiet.ah && quiet.rest > 0.5);
  assert.equal(top(soundWeights({ level: loud, bands: [2, 1, 4, 0.5] })), 'ee');
  assert.equal(top(soundWeights({ level: 0.2, bands: [0.1, 0.2, 0.5, 2] })), 'fv');
  assert.equal(top(soundWeights({ level: 0, bands: [0, 0, 0, 0] })), 'rest');
  const memory = {};
  soundWeights({ level: 0.9, bands: [3, 4, 0.5, 0.1] }, memory);
  assert.equal(top(soundWeights({ level: 0.01, bands: [0, 0, 0, 0] }, memory)), 'mbp');
  for (let i = 0; i < 120; i += 1) soundWeights({ level: 0 }, memory);
  assert.equal(top(soundWeights({ level: 0 }, memory)), 'rest', 'and then rest');
  const w = soundWeights({ level: loud, bands: [2, 3, 1, 0.3] });
  assert.ok(Math.abs(Object.values(w).reduce((s, v) => s + v, 0) - 1) < 1e-6);
}

// Spectrum to bands: each bin's power lands in its band.
{
  const hz = 100;
  const db = new Float32Array(100).fill(-Infinity);
  db[5] = 0; // 500 Hz
  db[30] = -10; // 3 kHz
  db[60] = -20; // 6 kHz
  db[95] = 0; // 9.5 kHz: past the last band
  const bands = bandsOf(db, hz);
  assert.equal(bands.length, BANDS.length - 1);
  assert.deepEqual(bands.map((b) => +b.toFixed(3)), [1, 0, 0.1, 0.01]);
}

console.log('face: ok');
