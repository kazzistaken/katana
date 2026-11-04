'use strict';

/**
 * The sidebar's collapse button and hover-to-open, with a real mouse (a look
 * test; scripts/test-sidebarpeek.mjs starts it). Screenshots go to XODE2_OUT.
 */

const assert = require('node:assert/strict');

module.exports = async ({ run, shot, wait, win }) => {
  const mouse = async (x, y) => {
    // Two moves: a pointer only "enters" once it has been somewhere else.
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(30);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: x + 1, y });
    await wait(30);
  };
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(60);
  };
  const box = (selector) => run(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n || !n.getClientRects().length) return null; const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const has = (attr) => run(`document.body.hasAttribute(${JSON.stringify(attr)})`);
  const middle = (b) => [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
  const settle = () => wait(1000);

  win.show();
  win.focus();
  // Your real mouse passing over this window would count as hovering too; only the test's own does now.
  win.setIgnoreMouseEvents(true);
  await run(`(() => { const { store } = window.__x2; const p = store.addProject(${JSON.stringify(process.env.PEEK_PROJ)}); store.setSetting('currentProject', p.id); for (const title of ['Fix the login page', 'Add a dark palette', 'Write the release notes']) { const t = store.newTask(p.id); store.patchTask(t.id, { title, named: true }); } })()`);
  await settle();

  // Open: the button sits just left of the three dots, on the same line.
  const collapse = await box('.foot-collapse');
  const more = await box('.foot-more');
  assert.ok(collapse, 'there is a collapse button');
  assert.ok(more, 'the three dots are there');
  assert.ok(collapse.x + collapse.w <= more.x, 'collapse is left of the dots');
  assert.ok(more.x - (collapse.x + collapse.w) < 12, 'collapse is beside the dots');
  assert.ok(Math.abs(collapse.y + collapse.h / 2 - (more.y + more.h / 2)) < 2, 'same line');
  await shot('1-open');

  // Press it: collapsed, and it stays collapsed under a pointer that hasn't left.
  await mouse(...middle(collapse));
  await click(...middle(collapse));
  await settle();
  assert.equal(await has('data-rail'), true, 'the button collapses it');
  assert.equal(await run(`window.__x2.store.state.settings.rail`), true, 'and that is saved');
  assert.equal(await box('.foot-more'), null, 'the rail has no three dots');
  const railButton = await box('.foot-collapse');
  assert.ok(railButton, 'the rail keeps the button');
  const rail = await box('.sidebar');
  const main = await box('.main');
  assert.ok(rail.w < 80, `rail is slim (${rail.w})`);
  await mouse(900, 400);
  await wait(500);
  await shot('2-rail');

  // Hover: it slides out over the chat, which doesn't move or resize.
  const firstRow = await box('.side-task');
  await mouse(...middle(firstRow));
  await wait(220);
  const part = await box('.sidebar');
  await settle();
  const out = await box('.sidebar');
  assert.equal(await has('data-peek'), true, 'hovering opens it');
  assert.equal(await has('data-rail'), false, 'drawn in full while open');
  assert.ok(out.w > 200, `full width (${out.w})`);
  assert.ok(part.w < out.w, `it slides rather than jumps (${part.w} on the way to ${out.w})`);
  assert.deepEqual(await box('.main'), main, 'the chat does not move or resize');
  const onTop = await run(`document.elementFromPoint(${Math.round(rail.x + rail.w + 60)}, 300)?.closest('.sidebar') != null`);
  assert.equal(onTop, true, 'it floats over the chat');
  assert.ok(await box('.foot-more'), 'the dots are back while it is open');
  await shot('3-peek');
  await run(`window.__x2.store.setSetting('darkMode', true)`);
  await wait(300);
  await shot('3-peek-dark');
  assert.equal(await has('data-peek'), true, 'a look change leaves it open');
  await run(`window.__x2.store.setSetting('darkMode', false)`);
  await wait(300);

  // Its menu holds it open; the pointer leaving doesn't close it until the menu goes.
  const dots = await box('.foot-more');
  await mouse(...middle(dots));
  await click(...middle(dots));
  await wait(200);
  await mouse(900, 400);
  await wait(800);
  assert.equal(await has('data-peek'), true, 'open while its menu is');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await settle();
  assert.equal(await has('data-peek'), false, 'closes with the menu');

  // Mouse away: back to the rail, chat still untouched.
  assert.equal(await has('data-rail'), true, 'back to the rail');
  await settle();
  assert.ok((await box('.sidebar')).w < 80, 'slim again');
  assert.deepEqual(await box('.main'), main, 'the chat still has not moved');

  // Out and back is one motion: the same glass throughout, and nothing jumps.
  await run(`window.__x2.ctx.open(window.__x2.store.state.tasks?.[0]?.id ?? [...document.querySelectorAll('.side-task')][0]?.dataset.id)`).catch(() => {});
  await settle();
  await run(`(() => {
    const side = document.querySelector('.sidebar');
    const dot = document.querySelector('.side-task .task-dot');
    const frames = (window.__frames = []);
    const look = () => {
      const c = getComputedStyle(side);
      frames.push({ w: side.getBoundingClientRect().width, x: dot.getBoundingClientRect().x, y: dot.getBoundingClientRect().y, blur: c.backdropFilter, tint: c.backgroundColor, rail: document.body.hasAttribute('data-rail') });
      window.__framing = requestAnimationFrame(look);
    };
    look();
  })()`);
  await mouse(...middle(firstRow));
  await settle();
  const opening = await run(`window.__frames.splice(0)`);
  await mouse(900, 400);
  await wait(1400);
  const closing = await run(`(cancelAnimationFrame(window.__framing), window.__frames.splice(0))`);
  const looks = new Set([...opening, ...closing].map((f) => `${f.blur} ${f.tint}`));
  assert.equal(looks.size, 1, `the glass never changes: ${[...looks].join(' / ')}`);
  assert.notEqual([...looks][0].split(' ')[0], 'none', 'and it is blurred');
  const steps = (frames, key) => frames.slice(1).map((f, i) => f[key] - frames[i][key]);
  const widths = closing.map((f) => f.w);
  assert.ok(Math.min(...widths) >= rail.w - 1, `it never goes narrower than the rail (${Math.min(...widths)})`);
  assert.ok(steps(closing, 'w').every((d) => d <= 0.5), `closing only ever narrows: ${widths.map(Math.round).join(' ')}`);
  // (Rail or not, the dots stay near the panel's left: a few pixels in all, gradually, one way.)
  const dotSteps = steps(closing, 'x');
  assert.ok(dotSteps.every((d) => d >= -0.5) || dotSteps.every((d) => d <= 0.5), `the dots go one way: ${closing.map((f) => Math.round(f.x)).join(' ')}`);
  assert.ok(dotSteps.every((d) => Math.abs(d) < 6), `the dots glide: ${closing.map((f) => Math.round(f.x)).join(' ')}`);
  const flip = closing.findIndex((f) => f.rail);
  assert.ok(flip >= 0 && Math.abs(closing[flip].w - rail.w) < 2, `it reaches the rail's width before becoming the rail (${closing[flip]?.w})`);
  assert.ok(Math.abs(closing[flip].x - closing[flip - 1].x) < 1.5, 'the dots do not jump when it does');
  assert.ok(Math.abs(closing[flip].y - closing[flip - 1].y) < 1.5, 'nor up or down');
  assert.ok(steps(opening, 'y').every((d) => Math.abs(d) < 12), `rows glide when it opens: ${opening.map((f) => Math.round(f.y)).join(' ')}`);

  // Leaving and coming back mid-slide just turns around.
  await mouse(...middle(firstRow));
  await settle();
  await mouse(900, 400);
  await wait(420);
  await mouse(...middle(firstRow));
  await settle();
  assert.equal(await has('data-peek'), true, 'coming back reopens it');
  assert.ok((await box('.sidebar')).w > 200, 'in full');
  await mouse(900, 400);
  await settle();
  assert.equal(await has('data-rail'), true);
  assert.ok((await box('.sidebar')).w < 80);

  // A brush past doesn't open it.
  await mouse(...middle(firstRow));
  await mouse(900, 400);
  await wait(400);
  assert.equal(await has('data-peek'), false, 'a quick pass does not open it');

  // Ctrl+B with the pointer inside: collapsing isn't undone by the hover.
  await run(`window.__x2.ctx.toggleRail()`);
  await settle();
  await mouse(100, 300);
  await run(`window.__x2.ctx.toggleRail()`);
  await settle();
  assert.equal(await has('data-rail'), true, 'Ctrl+B collapses');
  assert.equal(await has('data-peek'), false, 'and hover does not reopen it under the same pointer');
  await mouse(900, 400);
  await wait(200);

  // Footer of the rail: no hover-open, so the button can be pressed where it is.
  await mouse(...middle(railButton));
  await wait(500);
  assert.equal(await has('data-peek'), false, 'the button itself does not slide away');
  await click(...middle(railButton));
  await settle();
  assert.equal(await has('data-rail'), false, 'pressing it in the rail keeps it open');
  assert.equal(await run(`window.__x2.store.state.settings.rail`), false, 'saved');
  assert.ok((await box('.sidebar')).w > 200, 'full width');
  assert.ok((await box('.main')).x > main.x + 100, 'the chat makes room');

  // Pinning from the slid-out state: no jump to slim on the way.
  await mouse(900, 400);
  await run(`window.__x2.ctx.toggleRail()`);
  await settle();
  await mouse(...middle(firstRow));
  await settle();
  assert.equal(await has('data-peek'), true);
  await run(`window.__x2.ctx.toggleRail()`);
  await wait(40);
  const pinning = await box('.sidebar');
  assert.ok(pinning.w > 200, `stays wide while the chat makes room (${pinning.w})`);
  await settle();
  assert.equal(await has('data-peek'), false);
  assert.equal(await has('data-rail'), false);
  assert.ok((await box('.main')).x > main.x + 100, 'the chat made room');
  await shot('4-pinned');
};
