/**
 * Ordered dithering (4×4 Bayer) for the app's pixel art (Katana's face is
 * face.js). dither(): `paint` draws greys on a small canvas; each of its
 * pixels becomes a `cell`-sized dot in the theme's text colour, or nothing.
 * Redrawn when the theme changes.
 */

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export function dither(canvas, { cell = 2, paint, phase = 0, gain = 1 }) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const cols = Math.max(1, Math.floor(width / cell));
  const rows = Math.max(1, Math.floor(height / cell));
  const source = document.createElement('canvas');
  source.width = cols;
  source.height = rows;
  const sctx = source.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, cols, rows);
  paint(sctx, cols, rows);
  const pixels = sctx.getImageData(0, 0, cols, rows).data;

  canvas.width = Math.round(cols * cell * ratio);
  canvas.height = Math.round(rows * cell * ratio);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text').trim() || '#ebebeb';
  const size = cell * ratio;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = (y * cols + x) * 4;
      // `gain` brightens the art; `phase` shifts the pattern so it shimmers.
      const light = Math.min(1, ((pixels[i] * 0.3 + pixels[i + 1] * 0.59 + pixels[i + 2] * 0.11) / 255) * gain);
      if (light > (BAYER[(y + phase) % 4][(x + phase * 3) % 4] + 0.5) / 16) ctx.fillRect(Math.round(x * size), Math.round(y * size), Math.ceil(size), Math.ceil(size));
    }
  }
}

/** The New task scene: a low sun over ridges, fading into the ground. */
export function paintScene(ctx, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#000');
  sky.addColorStop(0.62, '#4a4a4a');
  sky.addColorStop(1, '#000');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const sun = ctx.createRadialGradient(w * 0.68, h * 0.5, 0, w * 0.68, h * 0.5, h * 0.42);
  sun.addColorStop(0, '#fff');
  sun.addColorStop(0.5, '#d8d8d8');
  sun.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  const ridges = [
    { base: 0.62, amp: 0.1, freq: 2.1, shade: '#2c2c2c', phase: 0.4 },
    { base: 0.72, amp: 0.08, freq: 3.4, shade: '#1c1c1c', phase: 1.7 },
    { base: 0.84, amp: 0.05, freq: 5.2, shade: '#0d0d0d', phase: 2.9 },
  ];
  for (const ridge of ridges) {
    ctx.fillStyle = ridge.shade;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 1) {
      const t = x / w;
      const y = ridge.base + ridge.amp * Math.sin(t * Math.PI * ridge.freq + ridge.phase) * Math.cos(t * 3.1 + ridge.phase);
      ctx.lineTo(x, y * h);
    }
    ctx.lineTo(w, h);
    ctx.fill();
  }
}
