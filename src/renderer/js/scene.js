/**
 * Scene themes: a live picture painted behind the app. With Background on
 * Full screen (body[data-backdrop="window"]) it fills the whole window behind
 * both panels, which turn clear; on Just the chat it sits at the back of the
 * main panel (the chat, the terminal and Settings) and the sidebar stays as
 * Graphite draws it.
 *
 * One canvas, at the back of the window or of the main panel. Full motion runs at up to 60 fps
 * (20 when the window isn't focused), Reduced runs slower and calmer, Off
 * paints one still frame. Nothing is drawn while the window is hidden.
 *
 * The painting runs in a worker (sceneworker.js) on the canvas handed to it,
 * so a busy page (many tasks working) never makes the picture stutter, and
 * the picture never takes the page's time. The page only tells it what to
 * paint (createPainter's state). Where a worker can't start, it paints here.
 *
 * The active tasks live in the picture too (fleet.js): a lantern boat on the
 * lake, a lit window on the rooftop, a soft light over your own picture.
 */

import { createFleet } from './fleet.js';

const SCENES = {
  'night-lake': nightLake,
  'rooftop-rain': rooftopRain,
  // One of your own pictures (body[data-photo] names it).
  custom: customPhoto,
};
export const SCENE_THEMES = new Set(Object.keys(SCENES));

// The picture's file, last read: measuring it and painting it share the one read.
let opened = { src: '', file: null };
function pictureFile(src) {
  if (opened.src !== src) opened = { src, file: fetch(new URL(src, document.baseURI).href).then((reply) => reply.blob()) };
  return opened.file;
}

/** What this screen can show of a picture, in pixels: anything more only costs memory and time. */
const mostPixels = () => Math.min(3840, Math.ceil(Math.max(screen.width, screen.height) * Math.min(window.devicePixelRatio || 1, 1.5) * 1.1));

/**
 * A picture's file as an ImageBitmap, brought down to `most` pixels. Called in the
 * worker wherever there is one: a 6000 px photo takes a second or more to open.
 */
export async function decodePicture(file, most) {
  const full = await createImageBitmap(file);
  const fit = Math.min(1, most / Math.max(full.width, full.height));
  if (fit >= 1) return full;
  const small = await createImageBitmap(full, { resizeWidth: Math.round(full.width * fit), resizeHeight: Math.round(full.height * fit), resizeQuality: 'high' });
  full.close();
  return small;
}

/** Without a worker: on the page. */
const loadImage = async (src) => decodePicture(await pictureFile(src), mostPixels());

export function initScene() {
  const panel = document.querySelector('.main');
  const chat = document.querySelector('#chat');
  let canvas = makeCanvas();
  panel.prepend(canvas);

  function makeCanvas() {
    const c = document.createElement('canvas');
    c.className = 'scene';
    c.setAttribute('aria-hidden', 'true');
    c.hidden = true;
    return c;
  }

  const motion = () => {
    const setting = document.body.dataset.motion || 'full';
    if (setting === 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced';
    return setting;
  };
  // Where the picture goes: the whole window, or the main panel.
  const whole = () => document.body.dataset.backdrop === 'window';
  const area = () => (whole() ? [window.innerWidth, window.innerHeight] : [panel.clientWidth, panel.clientHeight]);
  const wanted = () => {
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    const [w, h] = area();
    return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
  };

  // The painter: in a worker when one starts, else in this page.
  let painter = null;
  // A scene that broke stays hidden (until the theme changes).
  let broken = '';
  const stopped = () => {
    broken = (document.body.dataset.theme || '') + (document.body.dataset.photo || '');
    canvas.hidden = true;
  };
  function inPage() {
    const local = createPainter(canvas, { loadImage, onStop: stopped });
    return { update: (state) => local.update(state), stats: async () => ({ ...local.stats(), where: 'page' }) };
  }
  function inWorker() {
    if (!canvas.transferControlToOffscreen || typeof Worker !== 'function') return null;
    let worker;
    try {
      worker = new Worker(new URL('./sceneworker.js', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    const asked = [];
    worker.onmessage = async ({ data }) => {
      if (data.type === 'stopped') stopped();
      if (data.type === 'stats') asked.shift()?.({ ...data.stats, where: 'worker' });
      if (data.type === 'image') {
        const file = await pictureFile(data.src).catch(() => null);
        worker.postMessage({ type: 'image', src: data.src, file, most: mostPixels() });
      }
    };
    // The worker couldn't load: a fresh canvas (the old one belongs to it now), painted here.
    worker.onerror = (event) => {
      event.preventDefault?.();
      console.error('[scene] worker failed, painting in the page', event.message || '');
      worker.terminate();
      const fresh = makeCanvas();
      fresh.hidden = canvas.hidden;
      canvas.replaceWith(fresh);
      canvas = fresh;
      painter = inPage();
      last = null;
      sync();
    };
    return {
      update: (state) => worker.postMessage({ type: 'update', state }),
      stats: () => new Promise((resolve) => (asked.push(resolve), worker.postMessage({ type: 'stats' }))),
    };
  }
  painter = inWorker() || inPage();

  /** Moves the canvas when the Background setting changes; it's rebuilt at its new size on the next paint. */
  let rebuild = false;
  function mount() {
    const host = whole() ? document.body : panel;
    if (canvas.parentNode === host) return;
    host.prepend(canvas);
    rebuild = true;
  }

  /**
   * Where the floating panels are, in canvas pixels ([x, y, width, height, radius]):
   * a photograph is softened inside them and stays sharp around them. Only the
   * macOS style floats them over a whole-window picture.
   */
  function panelRects() {
    if (document.body.dataset.style !== 'macos' || !whole()) return [];
    const scale = wanted()[0] / Math.max(1, window.innerWidth);
    return [...document.querySelectorAll('.panel')].map((node) => {
      const box = node.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
      return [box.x, box.y, box.width, box.height, radius].map((v) => Math.round(v * scale * 10) / 10);
    });
  }

  // The tasks shown in the picture (setAgents), only in the macOS style.
  let agents = [];
  const macos = () => document.body.dataset.style === 'macos';

  /**
   * How far your own picture is brought down while you read over it, so words stay
   * readable on a bright one: its bright parts, taken from a tiny copy (as blurred
   * as it will be), are brought down to what the words need. A dark picture stays as it is.
   */
  let exposed = '';
  const brightness = new Map(); // picture -> how bright its bright parts are (measured once)
  async function measure(photo) {
    const [w, h] = [48, 30];
    const image = await createImageBitmap(await pictureFile(photo), { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const paint = c.getContext('2d', { willReadFrequently: true });
    paint.drawImage(image, 0, 0, w, h);
    image.close();
    const { data } = paint.getImageData(0, 0, w, h);
    const levels = [];
    for (let i = 0; i < data.length; i += 4) levels.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    levels.sort((a, b) => a - b);
    return levels[Math.floor(levels.length * 0.9)] || 1;
  }
  async function expose(photo) {
    exposed = photo;
    const style = document.body.style;
    if (!photo) {
      style.removeProperty('--scene-home-dim');
      return style.removeProperty('--scene-dim');
    }
    try {
      if (!brightness.has(photo)) brightness.set(photo, await measure(photo));
      const bright = brightness.get(photo);
      if (exposed !== photo) return undefined;
      style.setProperty('--scene-dim', Math.min(1, Math.max(0.3, READABLE_LEVEL / bright)).toFixed(3));
      // On the home screen, sharp and with larger words, it needs less: only a pale picture comes down at all.
      style.setProperty('--scene-home-dim', Math.min(1, Math.max(0.42, READABLE_HOME / bright)).toFixed(3));
    } catch (error) {
      console.error('[scene] could not measure the picture', error);
    }
    return undefined;
  }

  // What the painter was last told (only changes are sent).
  let last = null;
  function sync() {
    mount();
    const theme = SCENES[document.body.dataset.theme] ? document.body.dataset.theme : '';
    const photo = theme === 'custom' ? document.body.dataset.photo || '' : '';
    // No background: nothing is painted (the painter stops), but the panels keep the look they have over a scene, on flat grey (macos.css).
    if (theme || document.body.dataset.theme === 'none') document.body.dataset.scene = theme || 'none';
    else delete document.body.dataset.scene;
    canvas.hidden = !theme || broken === theme + photo;
    if (photo !== exposed) expose(photo);
    const state = { theme, photo, motion: motion(), size: wanted(), empty: area()[0] <= 0, hidden: document.hidden, focused: document.hasFocus(), rebuild, panels: panelRects(), calm: macos() && document.body.dataset.view === 'work', agents: macos() ? agents : [] };
    rebuild = false;
    if (last && Object.keys(state).every((key) => String(state[key]) === String(last[key]))) return;
    last = state;
    painter.update(state);
  }

  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-photo', 'data-motion', 'data-backdrop', 'data-style', 'data-rail', 'data-view'] });
  // Its size follows the panel or the window; a still frame is repainted when the chat comes back.
  new ResizeObserver(sync).observe(panel);
  new ResizeObserver(sync).observe(document.querySelector('.sidebar'));
  window.addEventListener('resize', sync);
  new MutationObserver(sync).observe(chat, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', sync);
  window.addEventListener('blur', sync);
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', sync);
  // Moved to a screen with another scale: the canvas follows it.
  const watchScale = () => window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => (sync(), watchScale()), { once: true });
  watchScale();
  sync();
  return {
    sync,
    stats: () => painter.stats(),
    /** The tasks to show: [[id, 'working' | 'needs' | 'unread' | 'idle', hot], ...]. */
    setAgents(list) {
      agents = list;
      sync();
    },
  };
}

// The level (0-255) a picture's bright parts may reach behind words (4.5:1 for the chat's text).
const READABLE_LEVEL = 74;
const READABLE_HOME = 118;

/**
 * Paints a scene on a canvas (a page's, or an OffscreenCanvas in a worker),
 * at the pace its motion setting asks for. `update` tells it what to paint:
 * { theme, motion: 'full' | 'reduced' | 'off', size: [w, h] in canvas pixels,
 * empty (nowhere to show it), hidden, focused, rebuild (moved: built again) }.
 */
export function createPainter(canvas, { loadImage: load, onStop = () => {} }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let state = { theme: '', photo: '', motion: 'full', size: [1, 1], empty: false, hidden: false, focused: true, panels: [], calm: false, agents: [] };
  const fleet = createFleet();
  let name = '';
  let scene = null;
  let incoming = null; // your own picture, still opening
  let raf = 0;
  let lastDraw = 0;
  let clock = 0; // scene seconds (runs slower in Reduced)
  let lastTick = 0;
  let resizeTimer = 0;
  const counted = { frames: 0, ms: 0 }; // frames painted and the time they took (stats)

  const shown = () => scene && !state.hidden && !state.empty;

  function build() {
    const [w, h] = state.size;
    canvas.width = w;
    canvas.height = h;
    scene.resize(w, h);
  }

  function paint() {
    if (!shown()) return;
    try {
      const t0 = performance.now();
      draw();
      counted.frames += 1;
      counted.ms += performance.now() - t0;
    } catch (error) {
      // A broken scene leaves the chat on the theme's plain panel instead of failing every frame.
      console.error('[scene] stopped', error);
      stop();
      scene = null;
      onStop();
    }
  }

  function draw() {
    const [w, h] = state.size;
    if (canvas.width !== w || canvas.height !== h) {
      // The first build is at once; while a resize is under way the old picture stretches until it settles.
      if (canvas.width <= 1) build();
      else {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = 0;
          canvas.width = 1; // rebuilt and redrawn by the paint below, in the same task
          paint();
        }, 160);
      }
    }
    scene.frame(ctx, clock, state.motion, state.panels, fleet.step(clock, state.motion === 'off'));
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const mode = state.motion;
    // (Out of focus behind what you're reading, nothing fine moves: half the frames are enough.)
    const interval = mode === 'reduced' ? 1000 / 24 : !state.focused ? 1000 / 20 : state.calm ? 1000 / 30 : 1000 / 60;
    if (now - lastDraw < interval - 2) return;
    const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
    lastTick = now;
    lastDraw = now;
    clock += dt * (mode === 'reduced' ? 0.45 : 1);
    paint();
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    lastTick = 0;
  }

  function update(next) {
    state = { ...state, ...next };
    if (next.agents) fleet.set(next.agents);
    if (next.rebuild) canvas.width = canvas.height = 1;
    // (Your own picture: another picture is another scene.)
    const want = state.theme === 'custom' ? `custom|${state.photo}` : state.theme;
    if (want !== name) {
      name = want;
      incoming = null;
      const make = SCENES[state.theme];
      const start = (next) => {
        stop();
        scene = next;
        canvas.width = canvas.height = 1;
        if (scene) clock = 40;
      };
      if (make === customPhoto && scene) {
        // Your own picture takes a moment to open: what's showing stays until it's ready, then it swaps in one frame.
        const next = make({
          size: state.size,
          loadImage: load,
          photo: state.photo,
          ready: () => {
            if (incoming !== next) return;
            incoming = null;
            start(next);
            update({});
          },
        });
        incoming = next;
      } else start(make ? make({ size: state.size, ready: () => state.motion === 'off' && paint(), loadImage: load, photo: state.photo }) : null);
    }
    if (!scene) return stop();
    if (state.motion === 'off') {
      stop();
      paint();
    } else if (!raf) {
      raf = requestAnimationFrame(tick);
    }
    return undefined;
  }

  /** Frames painted and the milliseconds spent on them, since the last call. */
  function stats() {
    const now = { ...counted, ms: +counted.ms.toFixed(1) };
    counted.frames = counted.ms = 0;
    return now;
  }

  return { update, stats };
}

/* ------------------------------ helpers ------------------------------ */

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1D noise in 0..1, `octaves` layers. */
function noise(seed) {
  const rand = random(seed);
  const values = Array.from({ length: 256 }, rand);
  const at = (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return values[i & 255] + (values[(i + 1) & 255] - values[i & 255]) * s;
  };
  return (x, octaves = 4) => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += at(x * freq + o * 31.7) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  };
}

/** Smooth 2D noise in 0..1, `octaves` layers. */
function noise2(seed) {
  const hash = (x, y) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const at = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  return (x, y, octaves = 3) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += at(x, y) * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2.07;
      y *= 2.07;
    }
    return sum / norm;
  };
}

const clamp01 = (t) => Math.min(1, Math.max(0, t));
const lerpTo = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/**
 * A grey in Graphite's own hue (styles.css): green a little above red and
 * blue above that, most in the mid-greys (#2e3336, #84888c) and least at
 * the ends (#0c0f10, #e6e9eb), so the night reads as the same graphite as
 * the panels around it. `v` is its red, 0-255.
 */
const grey = (v, a = 1) => {
  const lift = Math.sin((Math.PI * Math.min(255, Math.max(0, v))) / 255) ** 0.6;
  const c = (x) => Math.min(255, Math.round(x));
  return `rgba(${c(v)},${c(v + 3 + 2 * lift)},${c(v + 4 + 4 * lift)},${a})`;
};

// (In the worker there's no document: its layers are OffscreenCanvases.)
function layer(w, h) {
  const width = Math.max(1, Math.ceil(w));
  const height = Math.max(1, Math.ceil(h));
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** A photograph's grain, drawn over a whole scene. (`amount`: just enough on a blurred one that its gradients don't band.) */
const films = new Map(); // made once per size and amount: every scene at that size shares it
function film(W, H, amount = 0.035) {
  const key = `${W}x${H}x${amount}`;
  if (films.has(key)) return films.get(key);
  if ([...films.keys()].some((made) => !made.startsWith(`${W}x${H}x`))) films.clear();
  const finish = layer(W, H);
  films.set(key, finish);
  const c = finish.getContext('2d');
  const tile = layer(128, 128);
  const tc = tile.getContext('2d');
  const img = tc.createImageData(128, 128);
  const rand = random(5);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rand() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  tc.putImageData(img, 0, 0);
  c.globalAlpha = amount;
  c.fillStyle = c.createPattern(tile, 'repeat');
  c.fillRect(0, 0, W, H);
  return finish;
}

/**
 * A photograph softened smoothly, so it sits back behind the chat: scaled to the
 * size it's shown at first and blurred there (blurring a small picture and then
 * stretching it isn't smooth). Made once per size: the scene draws this copy
 * every frame at no extra cost.
 */
function softener() {
  let made = '';
  let copies = null;
  /** A finished layer as a bitmap where it can be: the graphics card takes it once and it's done. */
  const finished = (canvas) => canvas.transferToImageBitmap?.() || canvas;
  return (photo, W, H) => {
    const size = `${W}x${H}`;
    if (made === size) return copies;
    made = size;
    // (A little over the size that covers it: the picture breathes in and out.)
    const fit = Math.max(W / photo.width, H / photo.height) * 1.05;
    const w = Math.ceil(photo.width * fit);
    const h = Math.ceil(photo.height * fit);
    // (Worked out here, not on the graphics card, where it would hold up everything else on screen.)
    const page = () => {
      const canvas = layer(w, h);
      const c = canvas.getContext('2d', { willReadFrequently: true });
      c.imageSmoothingQuality = 'high';
      c.drawImage(photo, 0, 0, w, h);
      return [canvas, c];
    };
    const [sharp] = page();
    // (Sharp underneath: a blur fades out toward the picture's edges.)
    const [soft, c] = page();
    c.filter = `blur(${Math.max(W, H) * PHOTO_BLUR}px)`;
    c.drawImage(photo, 0, 0, w, h);
    copies = { sharp: finished(sharp), soft: finished(soft) };
    return copies;
  };
}
/** Runs `draw` only outside the panels: the photograph sharp in the strip around them. */
function outsidePanels(ctx, panels, W, H, draw) {
  if (!panels?.length) return;
  const outside = new Path2D();
  outside.rect(0, 0, W, H);
  for (const [x, y, w, h, r] of panels) outside.roundRect(x, y, w, h, r);
  ctx.save();
  ctx.clip(outside, 'evenodd');
  draw();
  ctx.restore();
}
const PHOTO_BLUR = 0.0018; // of the longer side of what it's shown on
const PHOTO_GRAIN = 0.01;

/** A soft horizontal smudge of mist, to be stretched over a scene. */
function mistSprite() {
  const fog = layer(256, 64);
  const fc = fog.getContext('2d');
  fc.translate(128, 32);
  fc.scale(4, 1);
  const fg = fc.createRadialGradient(0, 0, 0, 0, 0, 32);
  fg.addColorStop(0, 'rgba(190,196,202,0.55)');
  fg.addColorStop(1, 'rgba(190,196,202,0)');
  fc.fillStyle = fg;
  fc.fillRect(-32, -32, 64, 64);
  return fog;
}

/** A soft point of light. */
function glowSprite(size = 64) {
  const sprite = layer(size, size);
  const c = sprite.getContext('2d');
  const m = size / 2;
  const g = c.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(240,244,248,0.5)');
  g.addColorStop(1, 'rgba(240,244,248,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  return sprite;
}

/** Where the main panel starts, in canvas pixels (0 when the picture is only behind it). */
const mainFrom = (panels) => (panels?.length ? panels[panels.length - 1][0] : 0);

/** A task that needs you pulses, slowly enough to notice from the corner of your eye. */
const pulseAt = (t, seed = 0) => 0.5 + 0.5 * Math.sin(t * 2.6 + seed);

function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
}

/* ---------------------------- Night lake ----------------------------- */

/*
 * A mountain lake under a crescent moon, in black and white: stars over a
 * near-black sky, thin cloud drifting past the moon, moonlit mountains on the
 * left with mist in the valleys, a pine forest along the shore, and still
 * water that mirrors it all through slow ripples, with a column of moonlight
 * glittering on it. Mist drifts through the valleys and fog over the water;
 * fireflies blink along the shore; a rowboat with a lantern drifts across;
 * now and then a fish jumps, geese cross the moon, a satellite glides over
 * or a star falls.
 */

// Night lake's land takes a moment to draw: kept for the next time at the same size.
const landCache = { key: '', land: null };

function nightLake() {
  let W = 0;
  let H = 0;
  let u = 1; // one unit at a 900px-tall panel
  let horizon = 0;
  let moon = { x: 0, y: 0, r: 0 };
  let upper;
  let upperCtx;
  let sky;
  let land;
  let waterTint;
  let finish;
  let moonDisc;
  let fog;
  let wisps = [];
  let stars = [];
  let glints = [];
  let ripples = [];
  let meteor = null;
  let nextMeteor = 50;
  let spark;
  const boatLayers = new Map(); // size -> a layer to draw a boat on
  let mirror = null;
  let mirrorCtx = null;
  let flies = [];
  let rings = [];
  let nextRing = 6;
  let flock = null;
  let nextFlock = 30;
  let satellite = null;
  let nextSatellite = 20;
  let landJob = null;
  let landSince = -Infinity; // when the land appeared, for its fade in

  function resize(w, h) {
    W = w;
    H = h;
    u = Math.max(0.5, H / 900);
    horizon = Math.round(H * 0.66);
    // Over the main panel, not behind the sidebar: its light on the water falls where it can be seen.
    moon = { x: W * 0.3, y: H * 0.1, r: Math.max(9, 17 * u) };
    upper = layer(W, horizon);
    upperCtx = upper.getContext('2d');
    buildSky();
    buildLand();
    buildWater();
    buildFinish();
    buildSprites();
    buildLife();
  }

  /* ----------------------------- build ------------------------------- */

  function buildSky() {
    sky = layer(W, horizon);
    const c = sky.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, grey(5));
    g.addColorStop(0.45, grey(9));
    g.addColorStop(0.8, grey(17));
    g.addColorStop(1, grey(26));
    c.fillStyle = g;
    c.fillRect(0, 0, W, horizon);
    // The moon lights the air around it.
    c.globalCompositeOperation = 'screen';
    const glow = c.createRadialGradient(moon.x, moon.y, 0, moon.x, moon.y, H * 0.6);
    glow.addColorStop(0, grey(200, 0.16));
    glow.addColorStop(0.25, grey(160, 0.06));
    glow.addColorStop(1, grey(160, 0));
    c.fillStyle = glow;
    c.fillRect(0, 0, W, horizon);
  }

  /**
   * The land as real terrain: a heightfield of ridged noise seen from a little
   * above the water, marched column by column from the shore outwards so
   * nearer ridges hide farther ones. Each point is lit by the moon (from the
   * upper left) by its slope; it is snow, bare rock or forest by its height and
   * steepness; and it fades into the night air with distance, with mist lying
   * in the low ground. Drawn once per size.
   */
  function* terrain(c) {
    const Wt = Math.min(W, 1400); // columns marched; wider canvases stretch it
    const sx = W / Wt;
    const f = H * 1.05; // focal length in pixels
    const fx = f / sx; // per marched column
    const camH = 6; // eye height over the water
    const shoreZ = 60;
    const eye = horizon - (camH * f) / shoreZ; // so the nearest shore sits on `horizon`
    const ridgeN = noise2(9);
    const rangeN = noise2(19);
    const hillN = noise2(29);
    const treeN = noise2(39);
    const snowN = noise2(49);
    const shoreN = noise(59);
    const ridged = (n, x, z, oct) => {
      let sum = 0;
      let amp = 1;
      let norm = 0;
      let weight = 1;
      for (let o = 0; o < oct; o++) {
        // A ridge, rounded a little at the crest (a knife edge is thinner than a step of the march).
        const d = 2 * n(x, z, 1) - 1;
        let s = (1.08 - Math.sqrt(d * d + 0.006)) / 1.08;
        s *= s * weight;
        weight = clamp01(s * 1.8);
        sum += s * amp;
        norm += amp;
        amp *= 0.52;
        x *= 2.03;
        z *= 2.03;
      }
      return sum / norm;
    };
    const shoreAt = (x) => shoreZ + 55 * shoreN(x / 260 + 2, 2);
    const rockN = noise2(69);
    const height = (x, z) => {
      const a = x / z; // the direction it's seen in: -0.7 at the left edge
      const oct = z < 350 ? 6 : z < 800 ? 5 : 4;
      const massif = smooth(0.32, -0.45, a) * smooth(220, 420, z) * smooth(1100, 800, z);
      const range = smooth(700, 1000, z) * smooth(2000, 1600, z) * (0.5 + 0.5 * smooth(0.7, -0.3, a));
      let h = 0;
      if (massif > 0.002) h += massif * 175 * (0.06 + ridged(ridgeN, x / 240, z / 240, oct));
      if (range > 0.002) h += range * 270 * (0.08 + ridged(rangeN, x / 330 + 5, z / 330, oct));
      // Low wooded hills along the shore.
      h += 30 * smooth(shoreZ, shoreZ + 140, z) * smooth(600, 250, z) * hillN(x / 110, z / 110, 3);
      // The shore wanders in and out: bays of open water between the headlands.
      const shore = shoreAt(x);
      h *= smooth(shore, shore + 70, z);
      // Forest: a fuzzy crown of treetops over the lower ground, gone in the distance.
      const trees = smooth(80, 45, h) * smooth(700, 250, z) * smooth(0, 3, h);
      if (trees > 0) h += trees * 1.6 * treeN(x / 1.6, z / 1.6, 2);
      return h;
    };

    // Depths marched: closer together near the shore, where a step covers more of the picture.
    const zs = [];
    for (let z = shoreZ; z < 2300; z += 0.25 + z * 0.0026) zs.push(z);
    const K = zs.length;
    // Heights are worked out only when needed (most of the far land is hidden behind the near).
    const grid = new Float32Array(K * (Wt + 2)).fill(NaN);
    const hAt = (k, i) => {
      const at = k * (Wt + 2) + i + 1;
      let h = grid[at];
      if (h !== h) h = grid[at] = height(((i - Wt / 2) * zs[k]) / fx, zs[k]);
      return h;
    };
    // The highest the land could be at each depth: a point that couldn't rise above what's
    // already drawn in its column isn't worked out at all.
    const tallest = zs.map((z) => smooth(220, 420, z) * smooth(1100, 800, z) * 186 + smooth(700, 1000, z) * smooth(2000, 1600, z) * 292 + 32);

    const L = [-0.68, 0.58, -0.45];
    const ll = Math.hypot(...L);
    const lx = L[0] / ll;
    const ly = L[1] / ll;
    const lz = L[2] / ll;
    const rows = horizon;
    const img = c.createImageData(Wt, rows);
    const data = img.data;
    const put = (x, y, v, a = 255) => {
      const k = (y * Wt + x) * 4;
      const lift = Math.sin((Math.PI * Math.min(255, Math.max(0, v))) / 255) ** 0.6;
      data[k] = v;
      data[k + 1] = v + 3 + 2 * lift;
      data[k + 2] = v + 4 + 4 * lift;
      data[k + 3] = a;
    };
    const shade = (i, k) => {
      const z = zs[k];
      const x = ((i - Wt / 2) * z) / fx;
      const h = hAt(k, i);
      if (h < 0.05) return lerpTo(17, 28, 1 - Math.exp(-(z - shoreZ) / 900)); // open water in a bay
      const dx = (2 * z) / fx;
      const hx = (hAt(k, i + 1) - hAt(k, i - 1)) / dx;
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(K - 1, k + 1);
      const hz = (hAt(k1, i) - hAt(k0, i)) / Math.max(0.01, zs[k1] - zs[k0]);
      const nl = Math.hypot(hx, 1, hz);
      const ny = 1 / nl;
      const lam = Math.max(0, (-hx * lx + ly - hz * lz) / nl);
      const steep = 1 - ny;
      const snowLine = 85 + 60 * snowN(x / 160, z / 160, 2);
      const forest = smooth(85, 50, h) * smooth(0.6, 0.3, steep);
      // Rock in bands and blocks; snow lies broken across it, thickest where it's flatter.
      const rock = rockN(x / 9, h / 3.5 + z / 40, 3);
      const snow = smooth(snowLine, snowLine + 30, h) * smooth(0.8, 0.4, steep + (rock - 0.5) * 0.5);
      let albedo = lerpTo(0.2 + 0.2 * rock, 0.085, forest);
      albedo = lerpTo(albedo, 0.95, snow);
      // Forest is dark and evenly so; rock and snow show the shape of the land.
      let v = 230 * albedo * lerpTo(0.12 + 0.88 * lam, 0.45 + 0.4 * lam, forest);
      // The night air between: farther is fainter, and mist lies in the low ground.
      v = lerpTo(v, 30, 1 - Math.exp(-(z - shoreZ) / 1500));
      v = lerpTo(v, 62, 0.4 * smooth(22, 0, h) * smooth(shoreZ + 40, 400, z));
      return v;
    };

    for (let i = 0; i < Wt; i++) {
      if (i % 4 === 0) yield;
      let ybuf = rows; // the lowest row still open in this column
      let vPrev = -1;
      for (let k = 0; k < K; k++) {
        const z = zs[k];
        if (eye - ((tallest[k] - camH) * f) / z >= ybuf) continue;
        const sy = eye - ((hAt(k, i) - camH) * f) / z;
        if (sy >= ybuf) continue;
        const v = shade(i, k);
        const from = Math.max(0, Math.ceil(sy));
        const to = Math.min(rows, Math.ceil(ybuf));
        // Blend down the run from this point's shade to the nearer one below it.
        for (let y = from; y < to; y++) {
          const t = vPrev < 0 || to - from < 2 ? 0 : (y - from) / (to - from);
          const grain = (((i * 73856093) ^ (y * 19349663)) & 255) / 255 - 0.5;
          put(i, y, lerpTo(v, vPrev, t) + grain * 5);
        }
        ybuf = sy;
        vPrev = v;
        if (ybuf <= 0) break;
        // Nothing farther can rise above this any more.
        if (k + 1 < K && ybuf < eye - ((292 + 186 + 32 - camH) * f) / zs[k + 1] && zs[k + 1] > 1100) break;
      }
      // Soften the skyline: the pixel the crest cuts through is partly covered.
      const edge = Math.ceil(ybuf) - 1;
      if (edge >= 0 && vPrev >= 0 && ybuf > 0) put(i, edge, vPrev, 255 * (Math.ceil(ybuf) - ybuf));
    }
    const tmp = layer(Wt, rows);
    tmp.getContext('2d').putImageData(img, 0, 0);
    c.imageSmoothingQuality = 'high';
    c.drawImage(tmp, 0, 0, W, rows);
  }

  /**
   * A spruce, as it stands against the night: a thin leader at the top, then
   * whorls of drooping branches that get longer toward the ground, each a
   * little different, some missing.
   */
  function spruce(c, x, base, h, rand) {
    const w = h * (0.2 + rand() * 0.1);
    const lean = (rand() - 0.5) * h * 0.04;
    const t = Math.max(0.6 * u, h * 0.018);
    c.beginPath();
    c.moveTo(x - t * 0.8, base);
    c.lineTo(x + lean - t * 0.3, base - h);
    c.lineTo(x + lean + t * 0.3, base - h);
    c.lineTo(x + t * 0.8, base);
    c.fill();
    const whorls = 12 + Math.floor(rand() * 9);
    for (let i = 1; i <= whorls; i++) {
      const p = i / whorls; // 0 at the top
      const y = base - h + h * 0.94 * p;
      const cx = x + lean * (1 - p);
      const reach = w * 0.5 * (0.12 + 0.88 * Math.pow(p, 0.85));
      for (const side of [-1, 1]) {
        if (rand() < 0.1 && p > 0.2) continue;
        const len = reach * (0.7 + rand() * 0.55);
        const droop = len * (0.18 + rand() * 0.25);
        const thick = t * (1.2 + p * 2.2);
        c.beginPath();
        c.moveTo(cx, y - thick);
        c.quadraticCurveTo(cx + side * len * 0.55, y - thick * 0.4, cx + side * len, y + droop);
        c.quadraticCurveTo(cx + side * len * 0.45, y + thick * 1.6, cx, y + thick * 2.2);
        c.fill();
      }
    }
  }

  /** The shore in front: spruce in clumps with clearings between, taller toward the mountains. */
  function shoreTrees(c) {
    const rand = random(83);
    const n = noise(84);
    const trees = [];
    for (let x = -12 * u; x < W + 12 * u; x += (2.5 + rand() * 4) * u) {
      const clump = n(x / W * 7, 3);
      if (clump < 0.42 && rand() < 0.85) continue;
      const tall = H * (0.022 + 0.05 * smooth(W * 0.9, W * 0.05, x)) * (0.55 + 0.9 * clump) * (0.7 + rand() * 0.6);
      trees.push({ x, h: tall, seed: Math.floor(rand() * 1e6) });
    }
    // Moonlight catching their left edges, then the trees over it.
    c.fillStyle = grey(180, 0.07);
    for (const t of trees) spruce(c, t.x - 0.8 * u, horizon + 1, t.h, random(t.seed));
    c.fillStyle = grey(5);
    for (const t of trees) spruce(c, t.x, horizon + 1, t.h, random(t.seed));
  }

  /**
   * The land is drawn a slice at a time between frames (it takes most of a
   * second), and fades in when it's done; the same size again uses the last.
   */
  function buildLand() {
    landJob = null;
    if (landCache.key === `${W}x${H}`) {
      land = landCache.land;
      landSince = -Infinity;
      return;
    }
    // Until it's ready, the land from before (another size) stands in, stretched.
    landJob = drawLand(!land);
  }

  function* drawLand(fadeIn) {
    const next = layer(W, horizon + 2);
    const c = next.getContext('2d');
    yield* terrain(c);
    yield;
    // Low mist along the far shore, for the nearest trees to stand dark against.
    const mist = c.createLinearGradient(0, horizon - H * 0.08, 0, horizon);
    mist.addColorStop(0, grey(120, 0));
    mist.addColorStop(0.75, grey(120, 0.2));
    mist.addColorStop(1, grey(120, 0.1));
    c.fillStyle = mist;
    c.fillRect(0, horizon - H * 0.08, W, H * 0.08);
    yield;
    shoreTrees(c);
    landCache.key = `${W}x${H}`;
    landCache.land = next;
    land = next;
    landSince = fadeIn ? null : -Infinity; // null: stamped with the scene's time on the next frame
  }

  /** Works on the land for a few milliseconds (all of it for a still frame). */
  function workOnLand(still) {
    if (!landJob) return;
    const until = performance.now() + (still ? Infinity : 10);
    while (performance.now() < until) {
      if (landJob.next().done) {
        landJob = null;
        if (still) landSince = -Infinity;
        return;
      }
    }
  }

  function buildWater() {
    const depth = H - horizon;
    waterTint = layer(W, depth);
    const c = waterTint.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, depth);
    g.addColorStop(0, grey(4, 0.2));
    g.addColorStop(0.3, grey(4, 0.45));
    g.addColorStop(1, grey(2, 0.72));
    c.fillStyle = g;
    c.fillRect(0, 0, W, depth);
  }

  function buildFinish() {
    finish = film(W, H);
  }

  function buildSprites() {
    // The crescent: a lit disc with a second disc taken out of it, the dark part faintly lit by the earth.
    const r = moon.r;
    const size = Math.ceil(r * 2 + 4);
    moonDisc = layer(size, size);
    const c = moonDisc.getContext('2d');
    const m = size / 2;
    c.fillStyle = grey(160, 0.07);
    c.beginPath();
    c.arc(m, m, r, 0, Math.PI * 2);
    c.fill();
    const lit = layer(size, size);
    const lc = lit.getContext('2d');
    const g = lc.createRadialGradient(m - r * 0.4, m - r * 0.2, 0, m, m, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.8, grey(236));
    g.addColorStop(1, grey(200));
    lc.fillStyle = g;
    lc.beginPath();
    lc.arc(m, m, r, 0, Math.PI * 2);
    lc.fill();
    lc.globalCompositeOperation = 'destination-out';
    lc.beginPath();
    lc.arc(m + r * 0.42, m - r * 0.3, r * 0.94, 0, Math.PI * 2);
    lc.fill();
    c.drawImage(lit, 0, 0);

    fog = mistSprite();

    spark = layer(32, 32);
    const sc = spark.getContext('2d');
    const sg = sc.createRadialGradient(16, 16, 0, 16, 16, 16);
    sg.addColorStop(0, 'rgba(255,255,255,1)');
    sg.addColorStop(0.18, 'rgba(240,244,246,0.6)');
    sg.addColorStop(1, 'rgba(240,244,246,0)');
    sc.fillStyle = sg;
    sc.fillRect(0, 0, 32, 32);
  }

  function wisp(rand, w, h) {
    const sprite = layer(w + h * 4, h * 4);
    const c = sprite.getContext('2d');
    const count = Math.round((w / h) * 6);
    for (let i = 0; i < count; i++) {
      const p = rand();
      // Two or three thicker knots along the wisp, thin between.
      const env = Math.sin(Math.PI * p) * (0.45 + 0.55 * Math.abs(Math.sin(p * Math.PI * 2.5 + w)));
      const rx = h * (0.6 + rand() * 1.4) * (0.3 + env);
      const x = h * 2 + p * w;
      const y = h * 2 + (rand() - 0.5) * h * env;
      c.save();
      c.translate(x, y);
      c.scale(1, 0.22 + rand() * 0.15);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, grey(170, 0.1 + rand() * 0.08));
      g.addColorStop(1, grey(170, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, rx, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    return sprite;
  }

  function buildLife() {
    const rand = random(131);
    stars = [];
    for (let i = 0; i < 260; i++) {
      const y = Math.pow(rand(), 1.3) * horizon * 0.7;
      const bright = rand() < 0.06;
      stars.push({
        x: rand() * W,
        y,
        r: (bright ? 1.3 : 0.5 + rand() * 0.7) * u,
        a: (bright ? 0.9 : 0.25 + rand() * 0.5) * (1 - y / (horizon * 0.75)),
        f: 0.4 + rand() * 2,
        p: rand() * 6.28,
      });
    }
    wisps = [];
    for (let i = 0; i < 7; i++) {
      const h = (10 + rand() * 16) * u;
      const sprite = wisp(rand, W * (0.12 + rand() * 0.2), h);
      wisps.push({ sprite, y: horizon * (0.04 + rand() * 0.45) - sprite.height / 2, x0: rand() * (W + sprite.width), speed: (2 + rand() * 4) * u });
    }
    const depth = H - horizon;
    glints = [];
    for (let i = 0; i < 380; i++) {
      const p = Math.pow(rand(), 0.8);
      glints.push({ p, d: p * depth, g: gauss(rand), f: 0.8 + rand() * 2.6, ph: rand() * 6.28, drift: rand() * 6.28 });
    }
    ripples = [];
    for (let i = 0; i < 60; i++) {
      const p = Math.pow(rand(), 1.3);
      ripples.push({ p, d: p * depth, x: rand(), len: 40 + rand() * 160, speed: (rand() - 0.5) * 6, a: 0.025 + rand() * 0.045 });
    }
    flies = [];
    for (let i = 0; i < 22; i++) {
      flies.push({
        x: rand() * W,
        y: horizon - H * (0.005 + rand() * 0.07),
        ax: (6 + rand() * 22) * u,
        ay: (3 + rand() * 10) * u,
        fx: 0.08 + rand() * 0.2,
        fy: 0.1 + rand() * 0.25,
        ph: rand() * 6.28,
        blink: 0.2 + rand() * 0.4,
        size: (6 + rand() * 6) * u,
      });
    }
    meteor = null;
    rings = [];
    flock = null;
    satellite = null;
  }

  /* ----------------------------- frame ------------------------------- */

  function drawUpper(t) {
    const c = upperCtx;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.drawImage(sky, 0, 0);

    for (const s of stars) {
      const a = s.a * (0.6 + 0.4 * Math.sin(t * s.f + s.p));
      if (a < 0.03) continue;
      c.fillStyle = grey(232, a.toFixed(3));
      c.fillRect(s.x, s.y, s.r, s.r);
    }

    drawMeteor(c, t);
    drawSatellite(c, t);

    // The moon, with a soft halo that breathes very slightly.
    const breath = 0.92 + 0.08 * Math.sin(t * 0.3);
    c.globalCompositeOperation = 'lighter';
    const halo = c.createRadialGradient(moon.x, moon.y, moon.r * 0.8, moon.x, moon.y, moon.r * 9);
    halo.addColorStop(0, grey(210, 0.22 * breath));
    halo.addColorStop(0.3, grey(190, 0.06 * breath));
    halo.addColorStop(1, grey(190, 0));
    c.fillStyle = halo;
    c.fillRect(moon.x - moon.r * 9, moon.y - moon.r * 9, moon.r * 18, moon.r * 18);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(moonDisc, moon.x - moonDisc.width / 2, moon.y - moonDisc.height / 2);

    // Thin cloud drifting across, brighter as it passes the moon.
    c.globalCompositeOperation = 'screen';
    for (const w of wisps) {
      const span = W + w.sprite.width;
      const x = ((w.x0 + t * w.speed) % span) - w.sprite.width;
      const near = Math.max(0, 1 - Math.abs(x + w.sprite.width / 2 - moon.x) / (W * 0.4)) * Math.max(0, 1 - Math.abs(w.y + w.sprite.height / 2 - moon.y) / (H * 0.25));
      c.globalAlpha = 0.4 + near * 0.9;
      c.drawImage(w.sprite, x, w.y);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';

    drawGeese(c, t);

    if (land) {
      if (landSince === null) landSince = t;
      c.globalAlpha = smooth(0, 1.2, t - landSince);
      c.drawImage(land, 0, 0, W, horizon + 2);
      c.globalAlpha = 1;
    }

    // Mist drifting through the valleys, at different heights and speeds.
    c.globalCompositeOperation = 'screen';
    for (let i = 0; i < 6; i++) {
      const w = W * (0.35 + (i % 3) * 0.15);
      const speed = (2.5 + i * 0.9) * u * (i % 2 ? 1 : -1);
      const span = W + w;
      const x = ((((W * i * 0.23 + t * speed) % span) + span) % span) - w * 0.5;
      const y = horizon - H * (0.04 + (i % 3) * 0.045);
      c.globalAlpha = 0.09 + 0.05 * Math.sin(t * 0.05 + i * 1.3);
      c.drawImage(fog, x, y - 10 * u, w, (18 + (i % 3) * 10) * u);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /** Now and then a skein of geese, crossing in front of the moon. */
  function drawGeese(c, t) {
    if (!flock && t > nextFlock) {
      const rand = random(Math.floor(t * 613));
      const birds = [];
      const count = 5 + Math.floor(rand() * 6);
      for (let i = 0; i < count; i++) {
        const row = Math.ceil(i / 2);
        const side = i % 2 ? 1 : -1;
        birds.push({ dx: row * 13 * u + rand() * 4 * u, dy: side * row * 5.5 * u + (rand() - 0.5) * 3 * u, ph: rand() * 6.28, f: 4 + rand() * 1.5, s: (3.4 + rand() * 1.2) * u });
      }
      flock = { start: t, y: moon.y + (rand() - 0.4) * moon.r * 2.5, speed: (32 + rand() * 12) * u, tilt: (rand() - 0.5) * 0.12, birds };
    }
    if (!flock) return;
    const head = W + 30 * u - (t - flock.start) * flock.speed;
    if (head < -160 * u) {
      flock = null;
      nextFlock = t + 50 + Math.random() * 60;
      return;
    }
    c.strokeStyle = grey(4, 0.92);
    c.lineWidth = 1.3 * u;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const b of flock.birds) {
      const x = head + b.dx;
      const y = flock.y + b.dy + (x - moon.x) * flock.tilt + Math.sin(t * 0.7 + b.ph) * 1.5 * u;
      const wing = Math.sin(t * b.f + b.ph);
      const tipY = y - wing * b.s * 0.6;
      c.beginPath();
      c.moveTo(x - b.s, tipY);
      c.quadraticCurveTo(x - b.s * 0.45, y - b.s * 0.2 - wing * b.s * 0.15, x, y);
      c.quadraticCurveTo(x + b.s * 0.45, y - b.s * 0.2 - wing * b.s * 0.15, x + b.s, tipY);
      c.stroke();
    }
  }

  /** A satellite: a faint point moving steadily across the top of the sky. */
  function drawSatellite(c, t) {
    if (!satellite && t > nextSatellite) {
      const rand = random(Math.floor(t * 331));
      const leftward = rand() < 0.5;
      satellite = { start: t, y0: horizon * (0.03 + rand() * 0.25), y1: horizon * (0.05 + rand() * 0.3), from: leftward ? W * 1.02 : -W * 0.02, to: leftward ? -W * 0.02 : W * 1.02, life: 32 + rand() * 18 };
    }
    if (!satellite) return;
    const age = (t - satellite.start) / satellite.life;
    if (age >= 1) {
      satellite = null;
      nextSatellite = t + 60 + Math.random() * 90;
      return;
    }
    const x = satellite.from + (satellite.to - satellite.from) * age;
    const y = satellite.y0 + (satellite.y1 - satellite.y0) * age;
    c.fillStyle = grey(230, (0.55 * Math.min(1, age * 8, (1 - age) * 8)).toFixed(3));
    c.fillRect(x, y, 1.3 * u, 1.3 * u);
  }

  function drawMeteor(c, t) {
    if (!meteor && t > nextMeteor) {
      const rand = random(Math.floor(t * 977));
      meteor = { start: t, x: W * (0.3 + rand() * 0.6), y: horizon * (0.05 + rand() * 0.25), len: (120 + rand() * 160) * u, angle: Math.PI * (0.78 + rand() * 0.1), life: 0.9 + rand() * 0.5 };
    }
    if (!meteor) return;
    const age = (t - meteor.start) / meteor.life;
    if (age >= 1) {
      meteor = null;
      nextMeteor = t + 45 + Math.random() * 75;
      return;
    }
    const travel = meteor.len * 1.6 * age;
    const hx = meteor.x + Math.cos(meteor.angle) * travel;
    const hy = meteor.y + Math.sin(meteor.angle) * travel;
    const tail = meteor.len * Math.min(1, age * 3);
    const tx = hx - Math.cos(meteor.angle) * tail;
    const ty = hy - Math.sin(meteor.angle) * tail;
    const fade = Math.sin(Math.PI * age);
    const g = c.createLinearGradient(hx, hy, tx, ty);
    g.addColorStop(0, `rgba(255,255,255,${0.9 * fade})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.strokeStyle = g;
    c.lineWidth = 1.2 * u;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(hx, hy);
    c.lineTo(tx, ty);
    c.stroke();
  }

  function drawWater(ctx, t, panels, boats) {
    const depth = H - horizon;
    // The reflection: everything above, mirrored and bent by the ripples. Drawn at half size and
    // brought back up, so it's as soft as a reflection is, with no steps between the rows.
    // Ripples repeat evenly on the water, so on screen they bunch up toward the far shore.
    const rw = Math.ceil(W / 2);
    const rh = Math.ceil(depth / 2);
    if (!mirror || mirror.width !== rw || mirror.height !== rh) {
      mirror = layer(rw, rh);
      mirrorCtx = mirror.getContext('2d', { alpha: false });
    }
    for (let row = 0; row < rh; row++) {
      const d = row * 2;
      const src = Math.max(0, horizon - 1 - (d + 2));
      const phase = (900 * u) / (d + 10 * u);
      const amp = 0.4 * u + d * 0.022;
      const off = amp * (0.65 * Math.sin(phase + t * 1.2) + 0.35 * Math.sin(phase * 2.3 - t * 0.9 + 1.7));
      mirrorCtx.drawImage(upper, 0, src, W, 2, (off - amp) / 2, row, (W + amp * 2) / 2, 1);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mirror, 0, horizon, W, depth);
    ctx.drawImage(waterTint, 0, horizon);

    ctx.globalCompositeOperation = 'lighter';
    // The moon's path: a faint column, then the glitter on it, brightest nearest you.
    ctx.save();
    ctx.translate(moon.x, horizon + depth);
    ctx.scale(1, depth / (moon.r * 4));
    const column = ctx.createRadialGradient(0, 0, 0, 0, 0, moon.r * 4);
    column.addColorStop(0, grey(200, 0.1));
    column.addColorStop(1, grey(200, 0));
    ctx.fillStyle = column;
    ctx.fillRect(-moon.r * 4, -moon.r * 4, moon.r * 8, moon.r * 4);
    ctx.restore();

    for (const g of glints) {
      const s = Math.sin(t * g.f + g.ph);
      if (s <= 0.3) continue;
      const width = moon.r * 0.6 + g.d * 0.16;
      const x = moon.x + g.g * width * 0.5 + Math.sin(t * 0.3 + g.drift) * (0.5 + g.d * 0.015) * u;
      const a = Math.pow((s - 0.3) / 0.7, 3) * Math.exp(-g.g * g.g * 0.4) * (0.25 + g.p * 0.75);
      if (a < 0.02) continue;
      const len = (2.5 + g.d * 0.07) * u;
      const tall = Math.max(1.5, (1 + g.p * 1.6) * u);
      // (A soft dash of light, not a hard little bar.)
      ctx.globalAlpha = Math.min(1, a * 1.5);
      ctx.drawImage(spark, x - len, horizon + g.d - tall, len * 2, tall * 2);
    }
    ctx.globalAlpha = 1;

    // Ripples catching what light there is, and the darker troughs between.
    for (const r of ripples) {
      const len = r.len * (0.3 + r.p * 1.2) * u;
      const x = ((r.x * W + t * r.speed * u) % (W + len) + W + len) % (W + len) - len;
      ctx.fillStyle = grey(150, r.a);
      ctx.fillRect(x, horizon + r.d, len, Math.max(1, (0.5 + r.p) * u));
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const r of ripples) {
      const len = r.len * 1.5 * (0.3 + r.p * 1.2) * u;
      const x = ((r.x * W * 1.7 - t * r.speed * 0.6 * u) % (W + len) + W + len) % (W + len) - len;
      ctx.fillStyle = `rgba(0,0,0,${(r.a * 3).toFixed(3)})`;
      ctx.fillRect(x, horizon + r.d + (2 + r.p * 6) * u, len, Math.max(1, (0.8 + r.p * 2) * u));
    }

    drawRings(ctx, t, depth);
    drawBoats(ctx, t, depth, panels, boats);

    // A thin line of light where the water meets the shore.
    ctx.fillStyle = grey(170, 0.12);
    ctx.fillRect(0, horizon, W, Math.max(1, 0.8 * u));

    // Fog creeping over the water.
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 5; i++) {
      const w = W * (0.5 + i * 0.1);
      const x = ((W * i * 0.37 + t * (1.5 + i * 0.8) * u) % (W + w)) - w * 0.6;
      ctx.globalAlpha = 0.14 + 0.06 * Math.sin(t * 0.06 + i * 2);
      ctx.drawImage(fog, x, horizon - 6 * u + i * depth * 0.05, w, (16 + i * 8) * u);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Now and then a fish jumps: a splash, then rings spreading on the water. */
  function drawRings(ctx, t, depth) {
    if (t > nextRing) {
      const rand = random(Math.floor(t * 997));
      rings.push({ start: t, x: W * (0.25 + rand() * 0.7), p: 0.08 + Math.pow(rand(), 0.8) * 0.8 });
      nextRing = t + 5 + rand() * 10;
    }
    rings = rings.filter((r) => t - r.start < 6);
    ctx.globalCompositeOperation = 'lighter';
    for (const r of rings) {
      const age = t - r.start;
      const y = horizon + r.p * depth;
      const near = 0.4 + r.p; // nearer rings look bigger and rounder
      for (let j = 0; j < 3; j++) {
        const a = age - j * 0.45;
        if (a <= 0) continue;
        const rx = a * 9 * u * near;
        const alpha = 0.3 * Math.pow(1 - age / 6, 2) * (1 - j * 0.25);
        ctx.strokeStyle = grey(210, alpha.toFixed(3));
        ctx.lineWidth = Math.max(0.6, 0.8 * u);
        ctx.beginPath();
        ctx.ellipse(r.x, y, rx, rx * (0.08 + r.p * 0.22), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (age < 0.5) {
        const up = Math.sin((age / 0.5) * Math.PI);
        ctx.fillStyle = grey(235, (0.6 * (1 - age * 2)).toFixed(3));
        for (let k = -2; k <= 2; k++) ctx.fillRect(r.x + k * 2.2 * u * near * up, y - (6 - Math.abs(k) * 2) * u * near * up, Math.max(1, 0.8 * u), Math.max(1, 0.8 * u));
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Who's on the water, farthest first. Katana's own boat is always out, drifting across;
   * each active task is another boat with its lantern lit (see fleet.js).
   */
  function drawBoats(ctx, t, depth, panels, boats) {
    const from = mainFrom(panels);
    const span = W - from;
    const lap = W + 120 * u;
    const own = { p: 0.36, x: ((W * 0.5 + t * 2.2 * u) % (W * 1.3)) - W * 0.15, light: 1, shown: 1, flare: 0, rowing: 0, seed: 0 };
    const all = [own];
    for (const boat of boats) {
      const p = 0.1 + 0.62 * boat.out;
      const home = from + span * (0.06 + 0.88 * boat.across);
      // Rows at the pace of how near it is, and comes round again out of sight.
      const x = ((home + boat.travel * (3 + p * 7) * u + 60 * u) % lap) - 60 * u;
      all.push({ p, x, light: boat.light, shown: Math.min(1, boat.light * 3), flare: boat.flare, rowing: boat.rowing, seed: boat.seed });
    }
    all.sort((a, b) => a.p - b.p);
    for (const boat of all) drawBoat(ctx, t, depth, boat);
  }

  /** A rowboat with a lantern; the lantern's light trembles on the water below it. A boat that's rowing leaves a wake; one that needs you flares and sends rings out. */
  function drawBoat(ctx, t, depth, { p, x, light, shown, flare, rowing, seed }) {
    const s = (8 + p * 18) * u;
    const y = horizon + depth * p + Math.sin(t * 0.8 + seed) * 0.4 * u;
    const tilt = Math.sin(t * 0.6 + seed) * 0.03;
    const flicker = (0.85 + 0.1 * Math.sin(t * 9.3 + seed) * Math.sin(t * 2.7) + 0.05 * Math.sin(t * 23 + seed)) * light;
    const pulse = flare * pulseAt(t, seed);
    const lx = x + s * 1.05;
    const ly = y - s * 1.35;
    // The hull's reflection, and the lantern's: a wavering column of light under it.
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, -0.7);
    ctx.globalAlpha = 0.4 * shown;
    ctx.fillStyle = grey(3);
    boatHull(ctx, s);
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
    // The wake, opening out behind it.
    if (rowing > 0.03) {
      ctx.strokeStyle = grey(210, (0.16 * rowing * shown).toFixed(3));
      ctx.lineWidth = Math.max(0.6, 0.7 * u);
      ctx.beginPath();
      for (const side of [-1, 1]) {
        ctx.moveTo(x - s * 1.25, y);
        ctx.lineTo(x - s * 4.5, y + side * s * 0.34);
      }
      ctx.stroke();
    }
    // Rings going out from a boat that's waiting for you.
    if (flare > 0.03) {
      ctx.lineWidth = Math.max(0.7, 0.9 * u);
      const near = 0.4 + p;
      for (let j = 0; j < 3; j++) {
        const age = ((t * 0.42 + seed + j / 3) % 1 + 1) % 1;
        const rx = s * (1 + age * 7) * near;
        ctx.strokeStyle = grey(225, (0.42 * flare * (1 - age) ** 2).toFixed(3));
        ctx.beginPath();
        ctx.ellipse(lx, y, rx, rx * (0.08 + p * 0.2), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (let k = 0; k < 14; k++) {
      const ky = y + 2 * u + k * 2.4 * u;
      const kx = lx + Math.sin(t * 2.6 + k * 1.3 + seed) * (0.5 + k * 0.35) * u;
      const len = (2 + k * 0.45) * u;
      ctx.fillStyle = grey(235, (0.4 * (1 - k / 14) * flicker * (0.6 + 0.4 * Math.sin(t * 4 + k))).toFixed(3));
      ctx.fillRect(kx - len / 2, ky, len, Math.max(1, 0.7 * u));
    }
    // A pool of lantern light on the water around the boat, for it to stand dark against.
    ctx.save();
    ctx.translate(lx, y);
    ctx.scale(1, 0.18);
    ctx.globalAlpha = Math.min(1, (0.26 + 0.34 * pulse) * flicker);
    ctx.drawImage(spark, -s * 5, -s * 5, s * 10, s * 10);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // The boat, someone sitting in it, and the lantern on its pole at the bow,
    // drawn on their own layer so the lantern can light just them.
    const size = Math.ceil(s * 4);
    let sprite = boatLayers.get(size);
    if (!sprite) boatLayers.set(size, (sprite = layer(size, size)));
    const bc = sprite.getContext('2d');
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.clearRect(0, 0, size, size);
    bc.translate(size / 2, size * 0.7);
    bc.rotate(tilt);
    bc.fillStyle = grey(3);
    boatHull(bc, s);
    bc.beginPath();
    bc.ellipse(-s * 0.25, -s * 0.62, s * 0.2, s * 0.32, 0, 0, Math.PI * 2);
    bc.arc(-s * 0.25, -s * 1.05, s * 0.13, 0, Math.PI * 2);
    bc.fill();
    bc.fillRect(s * 0.98, -s * 1.35, Math.max(1, 0.12 * s), s * 1.1);
    // Pulling on the oars.
    if (rowing > 0.03) {
      const stroke = t * 1.7 + seed;
      bc.strokeStyle = grey(3);
      bc.lineWidth = Math.max(0.8, 0.09 * s);
      bc.lineCap = 'round';
      bc.beginPath();
      bc.moveTo(-s * 0.2, -s * 0.72);
      bc.lineTo(-s * 0.25 + Math.cos(stroke) * s * 0.95 * rowing, s * 0.04 - Math.max(0, Math.sin(stroke)) * s * 0.26);
      bc.stroke();
    }
    // The lantern catches the gunwale and the side of the rower facing it.
    bc.globalCompositeOperation = 'source-atop';
    const lit = bc.createRadialGradient(s * 1.05, -s * 1.35, 0, s * 1.05, -s * 1.35, s * 2.2);
    lit.addColorStop(0, grey(200, 0.75 * flicker));
    lit.addColorStop(1, grey(190, 0));
    bc.fillStyle = lit;
    bc.fillRect(-s * 2, -s * 2, s * 4, s * 2.2);
    bc.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = shown;
    ctx.drawImage(sprite, x - size / 2, y - size * 0.7);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, 0.9 * flicker);
    ctx.drawImage(spark, lx - s * 0.5, ly - s * 0.5, s, s);
    // Its halo, wide enough to stay a soft light when the scene is out of focus behind the chat.
    const halo = s * (5 + 5 * pulse);
    ctx.globalAlpha = Math.min(1, (0.25 + 0.4 * pulse) * flicker);
    ctx.drawImage(spark, lx - halo / 2, ly - halo / 2, halo, halo);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function boatHull(ctx, s) {
    ctx.beginPath();
    ctx.moveTo(-s * 1.3, -s * 0.35);
    ctx.quadraticCurveTo(-s * 0.2, -s * 0.22, s * 1.25, -s * 0.42);
    ctx.quadraticCurveTo(s * 0.9, 0, s * 0.2, 0);
    ctx.lineTo(-s * 0.9, 0);
    ctx.quadraticCurveTo(-s * 1.2, -s * 0.1, -s * 1.3, -s * 0.35);
    ctx.fill();
  }

  /** Fireflies blinking along the shore, over the trees' feet and the water's edge. */
  function drawFlies(ctx, t) {
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flies) {
      const on = Math.sin(t * f.blink + f.ph);
      if (on < 0.55) continue;
      const a = Math.pow((on - 0.55) / 0.45, 2);
      const x = f.x + Math.sin(t * f.fx + f.ph) * f.ax;
      const y = f.y + Math.cos(t * f.fy + f.ph * 1.3) * f.ay;
      ctx.globalAlpha = 0.75 * a;
      ctx.drawImage(spark, x - f.size / 2, y - f.size / 2, f.size, f.size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // The scene's clock doesn't start at zero: the first events are timed from the first frame.
  let begun = false;

  function frame(ctx, t, mode, panels, boats = []) {
    if (!begun) {
      begun = true;
      nextRing = t + 3;
      nextFlock = t + 14;
      nextSatellite = t + 25;
      nextMeteor = t + 35;
    }
    workOnLand(mode === 'off');
    drawUpper(t);
    ctx.drawImage(upper, 0, 0);
    drawWater(ctx, t, panels, boats);
    drawFlies(ctx, t);
    ctx.drawImage(finish, 0, 0);
  }

  return { resize, frame };
}

/* --------------------------- Rooftop rain ---------------------------- */

/*
 * A city rooftop at night in the rain, from a photograph (img/rooftop-rain.jpg),
 * brought to life: rain falling in three depths, brightest where the wall lamp
 * catches it; drops splashing on the wet roof; the lamp's glow and its
 * reflection quivering in the puddles; the city's windows glinting through
 * the rain and now and then going dark; low cloud dragging across; and, once
 * in a long while, lightning behind the clouds.
 */

const ROOF = {
  src: 'img/rooftop-rain.jpg',
  lamp: [88, 326], // the wall lamp, in the photograph's pixels
  glare: [[86, 600], [150, 640], [96, 700]], // its reflections on the wet roof
  // The wet floor, as a quad: far left, far right, near right, near left.
  floor: [[86, 488], [352, 488], [262, 752], [72, 752]],
  city: { top: 340, horizon: 400 },
};

function rooftopRain({ ready, loadImage }) {
  let W = 0;
  let H = 0;
  let u = 1;
  let photo = null;
  let lights = [];
  let drops = [];
  let splashes = [];
  let finish;
  let glow;
  let fog;
  let darkWindow;
  const soften = softener();
  let flash = null;
  let nextFlash = 0; // set on the first frame: never straight away

  loadImage(ROOF.src)
    .then((image) => {
      photo = image;
      findLights();
      ready();
    })
    .catch((error) => console.error('[scene] no photograph', error));

  // Where the photograph sits: covering the panel, breathing in and out very slowly.
  let view = { s: 1, ox: 0, oy: 0 };
  function place(t) {
    if (!photo) return;
    const zoom = 1.025 + 0.015 * Math.sin((t * Math.PI * 2) / 120);
    const s = Math.max(W / photo.width, H / photo.height) * zoom;
    view = { s, ox: (W - photo.width * s) / 2, oy: (H - photo.height * s) / 2 };
  }
  const sx = (x) => view.ox + x * view.s;
  const sy = (y) => view.oy + y * view.s;

  /** The lit windows: small bright spots over the city, found in the photograph itself. */
  function findLights() {
    const c = layer(photo.width, photo.height).getContext('2d', { willReadFrequently: true });
    c.drawImage(photo, 0, 0);
    const { data, width, height } = c.getImageData(0, 0, photo.width, photo.height);
    const at = (x, y) => data[(y * width + x) * 4];
    const found = [];
    for (let y = ROOF.city.horizon - 30; y < height - 4; y += 1) {
      for (let x = 250; x < width - 4; x += 1) {
        // Not the roof in the foreground, nor the lamp.
        if (x < 640 && y > 460) continue;
        const v = at(x, y);
        if (v < 150) continue;
        let peak = true;
        for (let dy = -2; dy <= 2 && peak; dy++) for (let dx = -2; dx <= 2; dx++) if (at(x + dx, y + dy) > v) peak = false;
        if (peak) found.push({ x, y, v });
      }
    }
    found.sort((a, b) => b.v - a.v);
    const rand = random(17);
    lights = [];
    for (const f of found) {
      if (lights.length >= 90) break;
      if (lights.some((l) => Math.abs(l.x - f.x) < 5 && Math.abs(l.y - f.y) < 5)) continue;
      lights.push({ ...f, f: 0.3 + rand() * 1.2, ph: rand() * 6.28, cycle: 30 + rand() * 60, off: rand() < 0.35 ? 4 + rand() * 12 : 0, start: rand() });
    }
  }

  function resize(w, h) {
    W = w;
    H = h;
    u = Math.max(0.5, H / 900);
    finish = film(W, H, PHOTO_GRAIN);
    fog = mistSprite();
    // A window going dark, as soft as the city around it.
    darkWindow = layer(32, 32);
    const dc = darkWindow.getContext('2d');
    const dg = dc.createRadialGradient(16, 16, 0, 16, 16, 16);
    dg.addColorStop(0, 'rgba(30,31,33,1)');
    dg.addColorStop(0.45, 'rgba(30,31,33,0.75)');
    dg.addColorStop(1, 'rgba(30,31,33,0)');
    dc.fillStyle = dg;
    dc.fillRect(0, 0, 32, 32);
    glow = glowSprite();

    const rand = random(29);
    drops = [];
    // Far, middle and near rain: the nearer, the longer, brighter and faster.
    const depths = [
      { n: 420, len: [7, 13], speed: [520, 640], a: 0.1, w: 0.7 },
      { n: 220, len: [14, 24], speed: [760, 900], a: 0.15, w: 0.9 },
      { n: 60, len: [30, 54], speed: [1050, 1300], a: 0.2, w: 1.3 },
    ];
    for (const [k, d] of depths.entries()) {
      for (let i = 0; i < d.n; i++) {
        drops.push({
          k,
          x: rand() * W * 1.3 - W * 0.15,
          y: rand() * H,
          len: (d.len[0] + rand() * (d.len[1] - d.len[0])) * u,
          speed: (d.speed[0] + rand() * (d.speed[1] - d.speed[0])) * u,
        });
      }
    }
    splashes = [];
    for (let i = 0; i < 46; i++) splashes.push({ period: 0.5 + rand() * 0.9, ph: rand() * 10, seed: Math.floor(rand() * 1e6) });
  }

  function drawRain(ctx, t) {
    const wind = 0.13 + 0.05 * Math.sin(t * 0.17) + 0.03 * Math.sin(t * 0.61);
    const lampX = sx(ROOF.lamp[0]);
    const lampY = sy(ROOF.lamp[1]);
    const reach = 190 * view.s;
    const depths = [
      { a: 0.1, w: 0.7 },
      { a: 0.15, w: 0.9 },
      { a: 0.2, w: 1.3 },
    ];
    ctx.lineCap = 'round';
    for (const [k, d] of depths.entries()) {
      const lit = [];
      ctx.beginPath();
      for (const r of drops) {
        if (r.k !== k) continue;
        const span = H + r.len;
        const y = ((r.y + t * r.speed) % span) - r.len;
        const x = r.x + (y + r.len) * wind;
        ctx.moveTo(x, y);
        ctx.lineTo(x - r.len * wind, y - r.len);
        if (Math.hypot(x - lampX, y - lampY) < reach) lit.push(x, y, r.len);
      }
      ctx.strokeStyle = `rgba(214,220,226,${d.a})`;
      ctx.lineWidth = d.w * u;
      ctx.stroke();
      // Rain the lamp catches.
      if (lit.length) {
        ctx.beginPath();
        for (let i = 0; i < lit.length; i += 3) {
          ctx.moveTo(lit[i], lit[i + 1]);
          ctx.lineTo(lit[i] - lit[i + 2] * wind, lit[i + 1] - lit[i + 2]);
        }
        ctx.strokeStyle = `rgba(255,255,255,${d.a * 2.4})`;
        ctx.stroke();
      }
    }
  }

  function drawSplashes(ctx, t) {
    const [a, b, c, d] = ROOF.floor;
    ctx.lineWidth = Math.max(0.6, 0.8 * u);
    for (const sp of splashes) {
      const phase = (t + sp.ph) / sp.period;
      const cycle = Math.floor(phase);
      const age = phase - cycle;
      const rand = random(sp.seed + cycle * 7919);
      const across = rand();
      const down = Math.pow(rand(), 0.7);
      const left = [a[0] + (d[0] - a[0]) * down, a[1] + (d[1] - a[1]) * down];
      const right = [b[0] + (c[0] - b[0]) * down, b[1] + (c[1] - b[1]) * down];
      const x = sx(left[0] + (right[0] - left[0]) * across);
      const y = sy(left[1] + (right[1] - left[1]) * across);
      const size = (1.5 + down * 4.5) * view.s;
      const fade = (1 - age) * (1 - age);
      // A ring spreading on the water, flattened by the angle we see it at.
      ctx.strokeStyle = `rgba(220,226,232,${(0.32 * fade).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, size * (0.4 + age * 2.2), size * (0.12 + age * 0.6), 0, 0, Math.PI * 2);
      ctx.stroke();
      // And the first instant: a crown of spray.
      if (age < 0.25) {
        const up = Math.sin((age / 0.25) * Math.PI);
        ctx.fillStyle = `rgba(235,240,244,${(0.5 * (1 - age * 4)).toFixed(3)})`;
        for (let k = -1; k <= 1; k++) ctx.fillRect(x + k * size * 0.6 * up, y - size * 1.4 * up * (k ? 0.7 : 1), Math.max(1, 0.7 * u), Math.max(1, 0.7 * u));
      }
    }
  }

  function drawLights(ctx, t) {
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      const x = sx(l.x);
      const y = sy(l.y);
      const into = ((t / l.cycle + l.start) % 1) * l.cycle;
      // Some windows go dark for a while, then come back on.
      if (l.off && into < l.off) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.85 * Math.min(1, into * 4, (l.off - into) * 4);
        ctx.drawImage(darkWindow, x - 5 * view.s, y - 5 * view.s, 10 * view.s, 10 * view.s);
        ctx.globalCompositeOperation = 'lighter';
        continue;
      }
      // The rest glint as the rain passes in front of them.
      const a = (0.12 + 0.14 * Math.sin(t * l.f + l.ph) + 0.08 * Math.sin(t * l.f * 3.1 + l.ph)) * (l.v / 255);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      const size = (7 + (l.v / 255) * 8) * view.s;
      ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    // The wall lamp, fizzing a little in the wet, and its light quivering in the puddles.
    const buzz = 0.85 + 0.1 * Math.sin(t * 13) * Math.sin(t * 3.7) + (Math.sin(t * 0.9) > 0.995 ? -0.4 : 0);
    const lx = sx(ROOF.lamp[0]);
    const ly = sy(ROOF.lamp[1]);
    ctx.globalAlpha = 0.35 * buzz;
    ctx.drawImage(glow, lx - 70 * view.s, ly - 70 * view.s, 140 * view.s, 140 * view.s);
    ctx.globalAlpha = 0.5 * buzz;
    ctx.drawImage(glow, lx - 12 * view.s, ly - 12 * view.s, 24 * view.s, 24 * view.s);
    for (const [i, [gx, gy]] of ROOF.glare.entries()) {
      for (let k = 0; k < 7; k++) {
        const wob = Math.sin(t * (2.3 + k * 0.7) + i * 2 + k);
        const a = 0.1 * Math.max(0, wob) * buzz;
        if (a < 0.01) continue;
        ctx.globalAlpha = a;
        const w = (18 + k * 5) * view.s;
        ctx.drawImage(glow, sx(gx) - w / 2 + wob * 6 * view.s, sy(gy) + (k - 3) * 5 * view.s, w, 3 * view.s);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Each active task is a window lit up across the city; one that needs you flares through the rain. */
  function drawTaskWindows(ctx, t, panels, boats) {
    if (!boats.length || !lights.length) return;
    const from = mainFrom(panels);
    ctx.globalCompositeOperation = 'lighter';
    for (const boat of boats) {
      // Its window: one the main panel shows, the same one for as long as the task is lit.
      let at = (boat.slot * 23 + 5) % lights.length;
      for (let tries = 0; tries < lights.length && sx(lights[at].x) < from + 24; tries++) at = (at + 7) % lights.length;
      const l = lights[at];
      const x = sx(l.x);
      const y = sy(l.y);
      const pulse = boat.flare * pulseAt(t, boat.seed);
      const breath = 0.86 + 0.14 * Math.sin(t * 1.1 + boat.seed);
      const size = (14 + 8 * boat.light) * view.s;
      ctx.globalAlpha = Math.min(1, 0.8 * boat.light * breath);
      ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      const halo = (44 + 66 * pulse) * view.s;
      ctx.globalAlpha = Math.min(1, boat.light * (0.2 + 0.26 * pulse) * breath);
      ctx.drawImage(glow, x - halo / 2, y - halo / 2, halo, halo);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawCloud(ctx, t) {
    // Low cloud dragging across the sky, and haze over the city below it.
    ctx.globalCompositeOperation = 'screen';
    const top = sy(ROOF.city.top);
    for (let i = 0; i < 6; i++) {
      const w = W * (0.6 + i * 0.12);
      const x = ((W * i * 0.29 + t * (5 + i * 2) * u) % (W + w)) - w * 0.6;
      const y = top * (0.08 + i * 0.15);
      ctx.globalAlpha = 0.09 + 0.05 * Math.sin(t * 0.05 + i * 1.9);
      ctx.drawImage(fog, x, y, w, top * (0.25 + (i % 3) * 0.08));
    }
    const horizon = sy(ROOF.city.horizon);
    for (let i = 0; i < 3; i++) {
      const w = W * (0.7 + i * 0.2);
      const x = ((W * i * 0.41 - t * (2 + i) * u) % (W + w) + W + w) % (W + w) - w * 0.6;
      ctx.globalAlpha = 0.12;
      ctx.drawImage(fog, x, horizon - 30 * view.s + i * 12 * view.s, w, 50 * view.s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawFlash(ctx, t, calm) {
    if (calm) return;
    if (!nextFlash) nextFlash = t + 20 + Math.random() * 25;
    if (!flash && t > nextFlash) {
      const rand = random(Math.floor(t * 131));
      flash = { start: t, x: W * (0.4 + rand() * 0.5), pulses: [[0, 0.08], [0.16, 0.12], [0.36, 0.3]] };
    }
    if (!flash) return;
    const age = t - flash.start;
    if (age > 0.9) {
      flash = null;
      nextFlash = t + 40 + Math.random() * 70;
      return;
    }
    let e = 0;
    for (const [at, len] of flash.pulses) if (age >= at && age < at + len) e = Math.max(e, 1 - (age - at) / len);
    if (e <= 0) return;
    ctx.globalCompositeOperation = 'screen';
    const top = sy(ROOF.city.horizon);
    const g = ctx.createRadialGradient(flash.x, top * 0.35, 0, flash.x, top * 0.35, W * 0.7);
    g.addColorStop(0, `rgba(235,240,246,${0.5 * e})`);
    g.addColorStop(1, 'rgba(235,240,246,0)');
    ctx.fillStyle = g;
    // The whole height: the glow fades out by its own radius, so it has no edge.
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(235,240,246,${0.05 * e})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(ctx, t, mode, panels, boats = []) {
    ctx.fillStyle = '#060707';
    ctx.fillRect(0, 0, W, H);
    if (!photo) return;
    place(t);
    const { soft, sharp } = soften(photo, W, H);
    ctx.drawImage(soft, view.ox, view.oy, photo.width * view.s, photo.height * view.s);
    outsidePanels(ctx, panels, W, H, () => ctx.drawImage(sharp, view.ox, view.oy, photo.width * view.s, photo.height * view.s));
    drawFlash(ctx, t, mode === 'reduced');
    drawCloud(ctx, t);
    drawLights(ctx, t);
    drawTaskWindows(ctx, t, panels, boats);
    drawSplashes(ctx, t);
    drawRain(ctx, t);
    ctx.drawImage(finish, 0, 0);
  }

  return { resize, frame };
}

/* --------------------------- Your own picture ---------------------------- */

/*
 * One of your own backgrounds: the picture covers the panel, breathing in and
 * out very slowly, softened (inside the floating panels), with the film's grain. Its colours and brightness
 * are kept.
 */

const OPENED_PHOTOS = 4; // kept ready, so going back to one is instant
const openedPhotos = new Map(); // picture -> { photo, soften }, the latest last

function openPhoto(src, loadImage) {
  const kept = openedPhotos.get(src);
  if (kept) {
    openedPhotos.delete(src);
    openedPhotos.set(src, kept);
    return Promise.resolve(kept);
  }
  return loadImage(src).then((photo) => {
    const opened = { photo, soften: softener() };
    openedPhotos.set(src, opened);
    for (const old of openedPhotos.keys()) {
      if (openedPhotos.size <= OPENED_PHOTOS) break;
      openedPhotos.delete(old); // (Scenes still drawing it hold on to it; the memory goes with them.)
    }
    return opened;
  });
}

function customPhoto({ photo: src, ready, loadImage, size }) {
  let W = 0;
  let H = 0;
  let photo = null;
  let soften = null;
  let finish;
  let glow;

  openPhoto(src, loadImage)
    .then((opened) => {
      photo = opened.photo;
      soften = opened.soften;
      // (Softened before it's shown: the first frame costs no more than the rest.)
      soften(photo, size[0], size[1]);
      ready();
    })
    .catch((error) => console.error('[scene] no picture', error));

  function resize(w, h) {
    W = w;
    H = h;
    finish = film(W, H, PHOTO_GRAIN);
    glow = glowSprite();
  }

  /** Each active task: a soft light drifting low over the picture. */
  function drawLights(ctx, t, panels, boats) {
    if (!boats.length) return;
    const u = Math.max(0.5, H / 900);
    const from = mainFrom(panels);
    ctx.globalCompositeOperation = 'lighter';
    for (const boat of boats) {
      const x = from + (W - from) * (0.06 + 0.88 * boat.across) + Math.sin(t * 0.13 + boat.seed) * 18 * u;
      const y = H * (0.58 + 0.34 * boat.out) + Math.cos(t * 0.17 + boat.seed) * 9 * u;
      const pulse = boat.flare * pulseAt(t, boat.seed);
      const size = (16 + 12 * boat.light) * u;
      ctx.globalAlpha = Math.min(1, boat.light);
      ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
      const halo = (60 + 90 * pulse) * u;
      ctx.globalAlpha = Math.min(1, boat.light * (0.3 + 0.4 * pulse));
      ctx.drawImage(glow, x - halo / 2, y - halo / 2, halo, halo);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(ctx, t, _mode, panels, boats = []) {
    ctx.fillStyle = '#060707';
    ctx.fillRect(0, 0, W, H);
    if (!photo) return;
    const zoom = 1.03 + 0.015 * Math.sin((t * Math.PI * 2) / 140);
    const s = Math.max(W / photo.width, H / photo.height) * zoom;
    const x = (W - photo.width * s) / 2;
    const y = (H - photo.height * s) / 2;
    const { soft, sharp } = soften(photo, W, H);
    ctx.drawImage(soft, x, y, photo.width * s, photo.height * s);
    outsidePanels(ctx, panels, W, H, () => ctx.drawImage(sharp, x, y, photo.width * s, photo.height * s));
    drawLights(ctx, t, panels, boats);
    ctx.drawImage(finish, 0, 0);
  }

  return { resize, frame };
}
