'use strict';

/**
 * Your mouse and keys in the app viewer's pane, as the Windows messages the
 * app's own window would have got (appview.js posts them). Pure, so
 * scripts/test-appinput.mjs checks it under Node.
 *
 * Mouse points arrive in the app's client pixels (the pane scales them).
 */

const WM = {
  MOUSEMOVE: 0x200,
  LBUTTONDOWN: 0x201,
  LBUTTONUP: 0x202,
  LBUTTONDBLCLK: 0x203,
  RBUTTONDOWN: 0x204,
  RBUTTONUP: 0x205,
  RBUTTONDBLCLK: 0x206,
  MBUTTONDOWN: 0x207,
  MBUTTONUP: 0x208,
  MBUTTONDBLCLK: 0x209,
  MOUSEWHEEL: 0x20a,
  MOUSEHWHEEL: 0x20e,
  KEYDOWN: 0x100,
  KEYUP: 0x101,
  CHAR: 0x102,
  SYSKEYDOWN: 0x104,
  SYSKEYUP: 0x105,
};

const MK = { LBUTTON: 0x1, RBUTTON: 0x2, SHIFT: 0x4, CONTROL: 0x8, MBUTTON: 0x10 };

/** Both 16-bit halves of a message parameter (negative coordinates kept as 16-bit). */
const pack = (low, high) => (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;

/** wParam for a mouse message: which buttons are held (DOM `buttons`), Shift and Ctrl. */
function mouseKeys({ buttons = 0, shift = false, ctrl = false } = {}) {
  let keys = 0;
  if (buttons & 1) keys |= MK.LBUTTON;
  if (buttons & 2) keys |= MK.RBUTTON;
  if (buttons & 4) keys |= MK.MBUTTON;
  if (shift) keys |= MK.SHIFT;
  if (ctrl) keys |= MK.CONTROL;
  return keys;
}

// DOM button number: 0 left, 1 middle, 2 right.
const BUTTONS = {
  0: [WM.LBUTTONDOWN, WM.LBUTTONUP, WM.LBUTTONDBLCLK, 1],
  1: [WM.MBUTTONDOWN, WM.MBUTTONUP, WM.MBUTTONDBLCLK, 4],
  2: [WM.RBUTTONDOWN, WM.RBUTTONUP, WM.RBUTTONDBLCLK, 2],
};

/**
 * A pointer event as { msg, wParam } (lParam is the point, in whichever
 * child window is under it). A second press in a row is a double click,
 * as Windows sends it. Null for what Windows has no message for.
 */
function mouseMessage(event) {
  const { type, button = 0, detail = 1 } = event;
  if (type === 'move') return { msg: WM.MOUSEMOVE, wParam: mouseKeys(event) };
  const names = BUTTONS[button];
  if (!names) return null;
  const [down, up, dbl, bit] = names;
  // The DOM's `buttons` is read after the change: make sure a press counts its own button.
  if (type === 'down') return { msg: detail === 2 ? dbl : down, wParam: mouseKeys({ ...event, buttons: (event.buttons || 0) | bit }) };
  if (type === 'up') return { msg: up, wParam: mouseKeys({ ...event, buttons: (event.buttons || 0) & ~bit }) };
  return null;
}

/**
 * A wheel turn as messages (lParam is the point on the screen). The pane's
 * deltas are CSS pixels, about 100 a notch; Windows counts 120 a notch,
 * up and right positive.
 */
function wheelMessages({ deltaX = 0, deltaY = 0, deltaMode = 0, ...mods }) {
  const unit = deltaMode === 1 ? 40 : deltaMode === 2 ? 120 * 3 : 1.2;
  const keys = mouseKeys(mods);
  const out = [];
  const dy = Math.round(-deltaY * unit);
  const dx = Math.round(deltaX * unit);
  if (dy) out.push({ msg: WM.MOUSEWHEEL, wParam: pack(keys, clamp16(dy)) });
  if (dx) out.push({ msg: WM.MOUSEHWHEEL, wParam: pack(keys, clamp16(dx)) });
  return out;
}

const clamp16 = (n) => Math.max(-32768, Math.min(32767, n));

/* ------------------------------ keyboard ------------------------------ */

// KeyboardEvent.code (the key's place on the keyboard) → virtual-key code.
const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, AltRight: 0x12,
  Pause: 0x13, CapsLock: 0x14, Escape: 0x1b, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  NumLock: 0x90, ScrollLock: 0x91,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
  BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
};

/** The virtual-key code for a key, or 0 for one Windows has none for. */
function vkOf(code = '') {
  if (VK[code]) return VK[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^Digit([0-9])$/.exec(code))) return 0x30 + Number(m[1]);
  if ((m = /^Numpad([0-9])$/.exec(code))) return 0x60 + Number(m[1]);
  if ((m = /^F([0-9]{1,2})$/.exec(code)) && m[1] >= 1 && m[1] <= 24) return 0x6f + Number(m[1]);
  return 0;
}

// Keys whose lParam carries the extended-key bit (the grey keys, the right-hand modifiers).
const EXTENDED = new Set([
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
  'NumpadEnter', 'NumpadDivide', 'ControlRight', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu', 'PrintScreen', 'NumLock',
]);

// Scan codes MapVirtualKey can't tell apart from the left-hand key.
const SCAN = { ShiftRight: 0x36 };

// What TranslateMessage would have typed for keys that aren't characters themselves.
const CONTROL_CHARS = { Enter: '\r', NumpadEnter: '\r', Tab: '\t', Backspace: '\b', Escape: '\x1b' };

/**
 * A key press or release as messages. `keys` are sent with Ctrl, Shift and
 * Alt held as they were (`mods`); `chars` are the WM_CHARs that follow,
 * posted, since Windows makes those from the keyboard layout and the page
 * already knows what the key typed (`key`). `scan` maps a virtual key to
 * its scan code (MapVirtualKey; injected so this stays pure).
 */
function keyMessages(event, scan = () => 0) {
  const { type, code = '', key = '', repeat = false, ctrl = false, shift = false, alt = false } = event;
  const vk = vkOf(code);
  if (!vk) return null;
  const sc = SCAN[code] || scan(vk) || 0;
  const ext = EXTENDED.has(code) ? 1 << 24 : 0;
  const altMsg = alt && !ctrl; // Alt alone makes system keys (Ctrl+Alt is AltGr)
  const base = 1 | (sc << 16) | ext | (altMsg ? 1 << 29 : 0);
  const mods = { ctrl, shift, alt };
  if (type === 'up') {
    return { keys: [[altMsg || code.startsWith('Alt') ? WM.SYSKEYUP : WM.KEYUP, vk, (base | (1 << 30) | (1 << 31)) >>> 0]], chars: [], mods };
  }
  if (type !== 'down') return null;
  const lParam = (base | (repeat ? 1 << 30 : 0)) >>> 0;
  const keys = [[altMsg || code.startsWith('Alt') ? WM.SYSKEYDOWN : WM.KEYDOWN, vk, lParam]];
  let typed = '';
  if (CONTROL_CHARS[code] && !ctrl && !alt) typed = CONTROL_CHARS[code];
  else if ([...key].length === 1 && (!(ctrl || alt) || (ctrl && alt))) typed = key;
  const chars = [...typed].flatMap((ch) => {
    const units = [];
    for (let i = 0; i < ch.length; i += 1) units.push([WM.CHAR, ch.charCodeAt(i), lParam]);
    return units;
  });
  return { keys, chars, mods };
}

// Key names an agent writes (any case) → KeyboardEvent code and key.
const NAMED = {
  enter: ['Enter', 'Enter'], return: ['Enter', 'Enter'], tab: ['Tab', 'Tab'], escape: ['Escape', 'Escape'], esc: ['Escape', 'Escape'],
  backspace: ['Backspace', 'Backspace'], delete: ['Delete', 'Delete'], del: ['Delete', 'Delete'], insert: ['Insert', 'Insert'],
  space: ['Space', ' '], home: ['Home', 'Home'], end: ['End', 'End'], pageup: ['PageUp', 'PageUp'], pagedown: ['PageDown', 'PageDown'],
  up: ['ArrowUp', 'ArrowUp'], down: ['ArrowDown', 'ArrowDown'], left: ['ArrowLeft', 'ArrowLeft'], right: ['ArrowRight', 'ArrowRight'],
  arrowup: ['ArrowUp', 'ArrowUp'], arrowdown: ['ArrowDown', 'ArrowDown'], arrowleft: ['ArrowLeft', 'ArrowLeft'], arrowright: ['ArrowRight', 'ArrowRight'],
};
const PUNCT = { ';': 'Semicolon', '=': 'Equal', ',': 'Comma', '-': 'Minus', '.': 'Period', '/': 'Slash', '`': 'Backquote', '[': 'BracketLeft', '\\': 'Backslash', ']': 'BracketRight', "'": 'Quote' };

/**
 * A key as an agent names it ("Enter", "Ctrl+A", "Shift+Tab", "F5", "a")
 * as { code, key, ctrl, shift, alt }, or null for one there's no key for.
 */
function parseCombo(combo) {
  const parts = String(combo || '').split('+').map((p) => p.trim());
  // "Ctrl++": the last + is the key.
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+');
  const name = parts.pop();
  const mods = { ctrl: false, shift: false, alt: false };
  for (const mod of parts.map((p) => p.toLowerCase())) {
    if (mod === 'ctrl' || mod === 'control' || mod === 'cmd' || mod === 'meta') mods.ctrl = true;
    else if (mod === 'shift') mods.shift = true;
    else if (mod === 'alt' || mod === 'option') mods.alt = true;
    else return null;
  }
  if (!name) return null;
  const lower = name.toLowerCase();
  if (NAMED[lower]) return { code: NAMED[lower][0], key: NAMED[lower][1], ...mods };
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return { code: name.toUpperCase(), key: name.toUpperCase(), ...mods };
  if (/^[a-z]$/i.test(name)) return { code: `Key${name.toUpperCase()}`, key: mods.shift ? name.toUpperCase() : name.toLowerCase(), ...mods };
  if (/^[0-9]$/.test(name)) return { code: `Digit${name}`, key: name, ...mods };
  if (PUNCT[name]) return { code: PUNCT[name], key: name, ...mods };
  return null;
}

module.exports = { WM, MK, pack, mouseKeys, mouseMessage, wheelMessages, vkOf, keyMessages, parseCombo };
