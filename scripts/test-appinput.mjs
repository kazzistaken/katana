import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WM, MK, pack, mouseMessage, wheelMessages, vkOf, keyMessages } = require('../src/main/appinput.js');

{
  // a point packs x low, y high; off the left or top stays 16-bit
  assert.equal(pack(10, 20), (20 << 16) | 10);
  assert.equal(pack(-1, 0), 0xffff);
}

{
  // presses, releases and double clicks for each button, with what's held
  assert.deepEqual(mouseMessage({ type: 'down', button: 0, buttons: 1 }), { msg: WM.LBUTTONDOWN, wParam: MK.LBUTTON });
  assert.deepEqual(mouseMessage({ type: 'down', button: 0, buttons: 0, detail: 2 }), { msg: WM.LBUTTONDBLCLK, wParam: MK.LBUTTON });
  assert.deepEqual(mouseMessage({ type: 'up', button: 0, buttons: 1 }), { msg: WM.LBUTTONUP, wParam: 0 });
  assert.deepEqual(mouseMessage({ type: 'down', button: 2, buttons: 2, ctrl: true }), { msg: WM.RBUTTONDOWN, wParam: MK.RBUTTON | MK.CONTROL });
  assert.deepEqual(mouseMessage({ type: 'up', button: 1, buttons: 0 }), { msg: WM.MBUTTONUP, wParam: 0 });
  assert.deepEqual(mouseMessage({ type: 'move', buttons: 1, shift: true }), { msg: WM.MOUSEMOVE, wParam: MK.LBUTTON | MK.SHIFT });
  assert.equal(mouseMessage({ type: 'down', button: 3 }), null);
}

{
  // a notch down (100 CSS px) is -120; sideways is its own message; nothing for no movement
  const [down] = wheelMessages({ deltaY: 100 });
  assert.equal(down.msg, WM.MOUSEWHEEL);
  assert.equal(down.wParam >> 16, -120);
  const [right] = wheelMessages({ deltaX: 50 });
  assert.equal(right.msg, WM.MOUSEHWHEEL);
  assert.equal(right.wParam >>> 16, 60);
  assert.equal(wheelMessages({ deltaY: 3, deltaMode: 1 })[0].wParam >> 16, -120);
  assert.deepEqual(wheelMessages({ deltaX: 0, deltaY: 0 }), []);
  assert.equal(wheelMessages({ deltaY: 100, ctrl: true })[0].wParam & 0xffff, MK.CONTROL);
}

{
  // keys by their place on the keyboard
  assert.equal(vkOf('KeyA'), 0x41);
  assert.equal(vkOf('Digit7'), 0x37);
  assert.equal(vkOf('Numpad3'), 0x63);
  assert.equal(vkOf('F1'), 0x70);
  assert.equal(vkOf('F12'), 0x7b);
  assert.equal(vkOf('ArrowLeft'), 0x25);
  assert.equal(vkOf('ShiftRight'), 0x10);
  assert.equal(vkOf('Fn'), 0);
}

const scan = (vk) => ({ 0x41: 0x1e, 0x0d: 0x1c, 0x25: 0x4b, 0x10: 0x2a, 0x12: 0x38 })[vk] || 0;

{
  // a letter: the key goes down with its scan code, then the character it typed
  const a = keyMessages({ type: 'down', code: 'KeyA', key: 'a' }, scan);
  assert.deepEqual(a.keys, [[WM.KEYDOWN, 0x41, 1 | (0x1e << 16)]]);
  assert.deepEqual(a.chars, [[WM.CHAR, 'a'.charCodeAt(0), 1 | (0x1e << 16)]]);
  // Shift: the page already knows it's a capital
  assert.equal(keyMessages({ type: 'down', code: 'KeyA', key: 'A', shift: true }, scan).chars[0][1], 'A'.charCodeAt(0));
  // held down: the repeat bit
  assert.ok(keyMessages({ type: 'down', code: 'KeyA', key: 'a', repeat: true }, scan).keys[0][2] & (1 << 30));
  // released: up, with the previous-state and transition bits
  const up = keyMessages({ type: 'up', code: 'KeyA', key: 'a' }, scan);
  assert.equal(up.keys[0][0], WM.KEYUP);
  assert.equal(up.keys[0][2], (1 | (0x1e << 16) | (1 << 30) | (1 << 31)) >>> 0);
  assert.deepEqual(up.chars, []);
}

{
  // Ctrl+A is a shortcut, not typing: no character, Ctrl held for the key
  const sel = keyMessages({ type: 'down', code: 'KeyA', key: 'a', ctrl: true }, scan);
  assert.deepEqual(sel.chars, []);
  assert.deepEqual(sel.mods, { ctrl: true, shift: false, alt: false });
  // AltGr (Ctrl+Alt) types its character
  assert.equal(keyMessages({ type: 'down', code: 'KeyE', key: '€', ctrl: true, alt: true }, scan).chars[0][1], 0x20ac);
  // Alt alone: a system key
  const alt = keyMessages({ type: 'down', code: 'KeyF', key: 'f', alt: true }, scan);
  assert.equal(alt.keys[0][0], WM.SYSKEYDOWN);
  assert.ok(alt.keys[0][2] & (1 << 29));
  assert.deepEqual(alt.chars, []);
  assert.equal(keyMessages({ type: 'down', code: 'AltLeft', key: 'Alt', alt: true }, scan).keys[0][0], WM.SYSKEYDOWN);
}

{
  // Enter, Tab, Backspace and Esc type their control characters; arrows type nothing and are extended
  assert.equal(keyMessages({ type: 'down', code: 'Enter', key: 'Enter' }, scan).chars[0][1], 13);
  assert.equal(keyMessages({ type: 'down', code: 'Backspace', key: 'Backspace' }).chars[0][1], 8);
  assert.deepEqual(keyMessages({ type: 'down', code: 'Enter', key: 'Enter', ctrl: true }, scan).chars, []);
  const left = keyMessages({ type: 'down', code: 'ArrowLeft', key: 'ArrowLeft' }, scan);
  assert.deepEqual(left.chars, []);
  assert.ok(left.keys[0][2] & (1 << 24));
  // right Shift has its own scan code
  assert.equal((keyMessages({ type: 'down', code: 'ShiftRight', key: 'Shift', shift: true }, scan).keys[0][2] >> 16) & 0xff, 0x36);
  // an emoji arrives as two UTF-16 halves
  assert.equal(keyMessages({ type: 'down', code: 'KeyQ', key: '😀' }).chars.length, 2);
  // unknown keys: nothing
  assert.equal(keyMessages({ type: 'down', code: 'Fn', key: 'Fn' }), null);
}


{
  // keys as an agent names them
  const { parseCombo } = require('../src/main/appinput.js');
  assert.deepEqual(parseCombo('Enter'), { code: 'Enter', key: 'Enter', ctrl: false, shift: false, alt: false });
  assert.deepEqual(parseCombo('ctrl+a'), { code: 'KeyA', key: 'a', ctrl: true, shift: false, alt: false });
  assert.deepEqual(parseCombo('Ctrl+Shift+K'), { code: 'KeyK', key: 'K', ctrl: true, shift: true, alt: false });
  assert.equal(parseCombo('Shift+Tab').code, 'Tab');
  assert.equal(parseCombo('down').code, 'ArrowDown');
  assert.equal(parseCombo('F5').code, 'F5');
  assert.equal(parseCombo('7').code, 'Digit7');
  assert.equal(parseCombo('Ctrl+/').code, 'Slash');
  assert.equal(parseCombo('space').key, ' ');
  assert.equal(parseCombo('Hyper+A'), null);
  assert.equal(parseCombo('Ctrl+'), null);
  assert.equal(parseCombo('bogus'), null);
  // and through to the messages
  assert.equal(keyMessages({ type: 'down', ...parseCombo('Ctrl+A') }, scan).chars.length, 0);
}
console.log('appinput ok');
