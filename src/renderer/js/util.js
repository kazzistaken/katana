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

/** Keep an element in the viewport, placed above (or below) an anchor. */
export function placeNear(node, anchor, { gap = 8 } = {}) {
  const box = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  let top = box.top - height - gap;
  if (top < 8) top = box.bottom + gap;
  const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
  node.style.left = `${left}px`;
  node.style.top = `${Math.min(top, window.innerHeight - height - 8)}px`;
}

// Claude Code's spinner: every .spin on screen turns together.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let spinTimer = 0;

export function spinner(extraClass = '') {
  if (!spinTimer) {
    let frame = 0;
    spinTimer = setInterval(() => {
      const nodes = document.querySelectorAll('.spin');
      if (!nodes.length || document.body.dataset.motion === 'off') return;
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
