export const $ = (selector, root = document) => root.querySelector(selector);

/** Build an element: el('div', { class, text, html, onclick, ...attrs }, ...children). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

// Lucide icons and the real Claude mark (generated: scripts/build-icons.mjs).
export { icons } from './icons.js';

/**
 * Keep a fixed popup wholly in the window: above an anchor (else below, else
 * beside it), or at a point ({ x, y }: a right-click), flipped and clamped to
 * the edges. Sizes are measured as drawn, so a zoomed popup (larger text) fits
 * too; one taller than the window scrolls. It follows the window as it resizes.
 */
const placed = new Set();
const replaceAll = () => {
  for (const place of placed) place();
  if (!placed.size) window.removeEventListener('resize', replaceAll);
};

export function placeNear(node, anchor, { gap = 8 } = {}) {
  const edge = 8;
  let placedOnce = false;
  // One shared resize listener for every open popup; closed ones are dropped here, not kept forever.
  for (const other of placed) if (!other.node.isConnected) placed.delete(other);
  const place = () => {
    if (!node.isConnected) return placed.delete(place);
    if (node.classList.contains('is-leaving')) return;
    // Sizes are read as drawn, and an opening scale would read as zoom: end it first.
    if (placedOnce) for (const animation of node.getAnimations()) animation.finish();
    placedOnce = true;
    node.style.left = '0px';
    node.style.top = '0px';
    node.style.maxHeight = '';
    // CSS zoom scales left/top too: work in drawn pixels, then divide.
    const zoom = node.getBoundingClientRect().width / node.offsetWidth || 1;
    const room = window.innerHeight - edge * 2;
    if (node.offsetHeight * zoom > room) {
      node.style.maxHeight = `${room / zoom}px`;
      node.style.overflowY = 'auto';
    }
    const width = node.offsetWidth * zoom;
    const height = node.offsetHeight * zoom;
    const fitsX = (x) => x >= edge && x + width <= window.innerWidth - edge;
    const fitsY = (y) => y >= edge && y + height <= window.innerHeight - edge;
    let left;
    let top;
    if (!(anchor instanceof Element)) {
      left = fitsX(anchor.x) ? anchor.x : anchor.x - width;
      top = fitsY(anchor.y) ? anchor.y : anchor.y - height;
    } else {
      const box = anchor.getBoundingClientRect();
      left = box.left;
      top = box.top - height - gap;
      if (!fitsY(top)) top = box.bottom + gap;
      if (!fitsY(top)) {
        // No room above or below: beside it, bottoms lined up.
        top = box.bottom - height;
        left = fitsX(box.right + gap) ? box.right + gap : box.left - gap - width;
      }
    }
    left = Math.max(edge, Math.min(left, window.innerWidth - width - edge));
    top = Math.max(edge, Math.min(top, window.innerHeight - height - edge));
    node.style.left = `${left / zoom}px`;
    node.style.top = `${top / zoom}px`;
  };
  place.node = node;
  place();
  if (!placed.size) window.addEventListener('resize', replaceAll);
  placed.add(place);
  return place;
}

/* ---------------------------- macOS motion ---------------------------- */

// What floats on macOS 27, measured: spring(response 0.31, damping 0.81), 460 ms to rest. Same as --spring in macos.css.
export const SPRING = 'linear(0, 0.0408, 0.1377, 0.2611, 0.3914, 0.5159, 0.6276, 0.7232, 0.8018, 0.8642, 0.9122, 0.9478, 0.9732, 0.9906, 1.0018, 1.0085, 1.0119, 1.013, 1.0127, 1.0116, 1.01, 1.0083, 1.0067, 1.0052, 1.0039, 1.0028, 1.0019, 1.0013, 1.0008, 1.0004, 1)';
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Something closing: it shrinks away and fades, `swap` changes what it shows, and it comes
 * back. (A fade alone when motion is reduced.) Only after `delay` does it start to go.
 * Not macOS's measured window close, a 100 ms fade: too quick to feel like finishing anything.
 */
export function closeDown(node, swap, delay = 0) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const away = node.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: still ? 'none' : 'scale(0.9)' },
    ],
    { duration: still ? 120 : 240, delay, easing: 'cubic-bezier(0.4, 0, 0.9, 0.6)', fill: 'forwards' }
  );
  const back = () => {
    swap();
    node.animate(
      [
        { opacity: 0, transform: still ? 'none' : 'scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: EASE_OUT }
    );
    away.cancel();
  };
  away.finished.then(back, back);
}

/** The macOS style at full motion: what the movement below is for. Everything else keeps its own quiet fades. */
export const motionOn = () => document.body.dataset.style === 'macos' && document.body.dataset.motion === 'full' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A popup opening, once it's placed: it springs out of what opened it, from almost nothing, as a
 * Mac's menus and popovers do. Going straight from one popup to another is a hard cut.
 */
export function popIn(node, anchor) {
  if (!motionOn()) return;
  const going = document.querySelectorAll('.pop.is-leaving');
  if (going.length) {
    for (const old of going) old.remove();
    return;
  }
  const box = node.getBoundingClientRect();
  const zoom = box.width / node.offsetWidth || 1;
  const from = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const x = Math.max(0, Math.min(box.width, (from.left + from.right) / 2 - box.left));
  const y = Math.max(0, Math.min(box.height, (from.top + from.bottom) / 2 - box.top));
  node.style.transformOrigin = `${x / zoom}px ${y / zoom}px`;
  node.animate([{ transform: 'scale(0.05)' }, { transform: 'none' }], { duration: 460, easing: SPRING });
  node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
}

/**
 * A popup going: back into what opened it in 133 ms, from wherever its opening had got to, then
 * it's removed (at once when there's no motion). To everything else it's gone already.
 */
export function leave(node) {
  if (!motionOn()) return node.remove();
  const drawn = getComputedStyle(node);
  const { transform, opacity } = drawn;
  for (const animation of node.getAnimations()) animation.cancel();
  node.classList.add('is-leaving');
  node.style.pointerEvents = 'none';
  node.inert = true;
  node.animate([{ transform }, { transform: 'scale(0.15)' }], { duration: 133, easing: 'linear(0, 0.21 25%, 0.35 37.5%, 0.53 50%, 0.66 62.5%, 0.85 80%, 1)', fill: 'forwards' });
  const fade = node.animate([{ opacity }, { opacity: 0 }], { duration: 133, easing: 'cubic-bezier(0, 0, 0.58, 1)', fill: 'forwards' });
  fade.onfinish = fade.oncancel = () => node.remove();
  // A hidden window doesn't play animations: it still has to go.
  setTimeout(() => node.remove(), 400);
  return undefined;
}

/**
 * The one highlight that glides to whatever is chosen, instead of each row having
 * its own. `host` is what it's placed in (positioned); `target()` finds the chosen
 * thing; it hides when that's scrolled out of `clip`.
 */
export function glider(host, target, { clip = null } = {}) {
  const node = el('span', { class: 'glide', 'aria-hidden': 'true' });
  let shown = false;
  // Where something sits in its layout, inside `host`. Not getBoundingClientRect: that includes any
  // slide still playing on the row (it would stop short and stay there), and is scaled by Larger text.
  const at = (thing) => {
    let [x, y, n] = [0, 0, thing];
    while (n && n !== host) {
      x += n.offsetLeft;
      y += n.offsetTop;
      const up = n.offsetParent;
      if (up && up !== host) {
        x -= up.scrollLeft;
        y -= up.scrollTop;
      }
      n = up;
    }
    return n === host ? [x, y] : null;
  };
  function place({ now = false } = {}) {
    const on = document.body.dataset.style === 'macos' ? target() : null;
    const spot = on?.offsetWidth ? at(on) : null;
    if (!spot) {
      node.classList.remove('is-on');
      shown = false;
      return;
    }
    const [w, h] = [on.offsetWidth, on.offsetHeight];
    const [x, y] = spot;
    // Scrolled partly out of its list, it's cut off at the list's edge along with the row.
    let cut = 'none';
    if (clip?.contains(on)) {
      const [, top] = at(clip) || [0, 0];
      const bottom = top + clip.clientHeight;
      const [over, under] = [Math.max(0, top - y), Math.max(0, y + h - bottom)];
      if (over >= h || under >= h) {
        node.classList.remove('is-on');
        shown = false;
        return;
      }
      if (over || under) cut = `inset(${over}px 0 ${under}px 0 round var(--r))`;
    }
    if (!shown || now) node.style.transition = 'none';
    node.style.transform = `translate(${x}px, ${y}px)`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    node.style.clipPath = cut;
    node.classList.add('is-on');
    if (!shown || now) {
      void node.offsetWidth;
      node.style.transition = '';
    }
    shown = true;
  }
  return { node, place };
}

/**
 * What runs forever (a working dot, the thinking dots) carries on where it was when the part of the
 * page it's in is redrawn, instead of starting over: a task's live message is redrawn as it works.
 */
export function keepInStep(root) {
  for (const part of root.querySelectorAll('.status-dot.is-working, .status-dot.is-needs, .thinking-dots')) {
    for (const running of part.getAnimations({ subtree: true })) running.startTime = 0;
  }
}

// Claude Code's spinner: every .spin on screen turns together.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let spinTimer = 0;

export function spinner(extraClass = '') {
  if (!spinTimer) {
    let frame = 0;
    let idle = 0;
    spinTimer = setInterval(() => {
      const nodes = document.querySelectorAll('.spin');
      // Nothing spinning for a while: stop the timer (the next spinner() starts it again).
      if (!nodes.length && ++idle > 8) {
        clearInterval(spinTimer);
        spinTimer = 0;
        return;
      }
      if (nodes.length) idle = 0;
      if (!nodes.length || document.body.dataset.motion === 'off' || document.hidden) return;
      frame = (frame + 1) % FRAMES.length;
      for (const node of nodes) node.textContent = FRAMES[frame];
    }, 120);
  }
  return el('span', { class: `spin ${extraClass}`.trim(), 'aria-hidden': 'true', text: '✻' });
}

/** 84_200 → "84k", 1_000_000 → "1M". */
export function tokens(n) {
  const value = Number(n) || 0;
  if (value >= 1e6) return `${Math.round(value / 1e5) / 10}M`.replace('.0M', 'M');
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}
