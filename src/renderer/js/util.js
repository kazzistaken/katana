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
export function placeNear(node, anchor, { gap = 8 } = {}) {
  const edge = 8;
  const place = () => {
    if (!node.isConnected) return window.removeEventListener('resize', place);
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
  place();
  window.addEventListener('resize', place);
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
