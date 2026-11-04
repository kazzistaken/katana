import { el, icons, placeNear, popIn, leave, glider, motionOn, SPRING, EASE_OUT } from './util.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { branchesUnderParents, parentsAmong } from './store.js';

/**
 * The sidebar: window lights and New task on top, Katana (the agent you
 * talk to) under them, then every open task, newest first, across projects.
 * A task's dot says where it stands: hollow (idle), shining or circling (working), filled (finished while you looked elsewhere),
 * pulsing (it's asking you something). The same tasks are lit in the scene behind (fleet.js). Done tasks leave the list; the ··· menu can
 * show them. The footer names the project new tasks go into (click to
 * switch or add a folder) and how full the open task's memory is.
 */

const LIGHT = {
  close: '<svg viewBox="0 0 8 8"><path d="M2 2l4 4M6 2L2 6" /></svg>',
  min: '<svg viewBox="0 0 8 8"><path d="M1.5 4h5" /></svg>',
  max: '<svg viewBox="0 0 8 8"><path d="M4 1.5v5M1.5 4h5" /></svg>',
};

export function initSidebar(ctx) {
  const root = document.querySelector('#sidebar');
  const { store, api } = ctx;
  let menu = null;
  let menuAnchor = null; // the button that opened it: pressing that again closes it
  let showDone = false;

  /* ------------------------------ actions ----------------------------- */

  /** Pick a folder: the picker itself says "Trust this folder". */
  async function addProject() {
    const folder = await api.folder.pick();
    if (!folder) return null;
    const project = store.addProject(folder);
    store.setSetting('currentProject', project.id);
    ctx.newTask();
    return project;
  }

  const askFirst = (options) => (store.state.settings.confirmDeletes ? confirmDialog(options) : Promise.resolve(true));

  async function removeProject(project) {
    const ok = await askFirst({
      title: `Remove ${project.name}?`,
      body: 'Its tasks are deleted and the folder is no longer trusted. The folder itself is not touched.',
      ok: 'Remove',
      danger: true,
    });
    if (ok) store.removeProject(project.id);
    return ok;
  }

  async function renameTask(chat) {
    const title = await promptDialog({ title: 'Rename task', value: chat.title });
    if (title) store.patchTask(chat.id, { title, named: true });
  }

  async function deleteTask(chat) {
    const ok = await askFirst({ title: `Delete “${chat.title}”?`, body: 'Its messages are gone for good.', ok: 'Delete', danger: true });
    if (ok) store.deleteTask(chat.id);
  }

  /* ------------------------------- menu ------------------------------- */

  function closeMenu() {
    const had = menu;
    if (menu) leave(menu);
    menu = null;
    menuAnchor?.classList.remove('is-open');
    menuAnchor = null;
    // A menu holds the slid-out sidebar open; with it gone, the pointer decides again.
    if (had && !root.matches(':hover')) peekLater(false);
  }

  /** A menu at the pointer (right-click) or above an anchor (a button). */
  function openMenu(where, items) {
    if (menu && where === menuAnchor) return closeMenu();
    closeMenu();
    if (where instanceof Element) {
      menuAnchor = where;
      where.classList.add('is-open');
    }
    menu = el(
      'div',
      { class: 'pop', role: 'menu' },
      items.filter(Boolean).map((item) =>
        item === '-'
          ? el('div', { class: 'menu-sep', role: 'separator' })
          : el(
              'button',
              {
                class: `menu-item${item.danger ? ' is-danger' : ''}${item.on ? ' is-on' : ''}`,
                type: 'button',
                role: 'menuitem',
                title: item.title || null,
                onclick: () => {
                  closeMenu();
                  item.run();
                },
              },
              el('span', { text: item.label }),
              item.hint ? el('small', { text: item.hint }) : null
            )
      )
    );
    document.body.append(menu);
    if (where instanceof Event) {
      where.preventDefault();
      placeNear(menu, { x: where.clientX, y: where.clientY });
    } else placeNear(menu, where);
    popIn(menu, where instanceof Event ? { x: where.clientX, y: where.clientY } : where);
    menu.querySelector('button')?.focus();
  }

  document.addEventListener('pointerdown', (event) => {
    // (Not on its own button: that click decides, in openMenu.)
    if (menu && !menu.contains(event.target) && !menuAnchor?.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
    else if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = [...menu.querySelectorAll('button')];
      const at = items.indexOf(document.activeElement);
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });

  /* ------------------------------ parts ------------------------------- */

  const light = (kind, label, run) =>
    el('button', { class: `light light-${kind}`, type: 'button', title: label, 'aria-label': label, html: LIGHT[kind], onclick: run });

  const head = el(
    'div',
    { class: 'side-head' },
    el('div', { class: 'lights' }, light('close', 'Close', () => api.win.close()), light('min', 'Minimize', () => api.win.minimize()), light('max', 'Maximize', () => api.win.toggleMaximize())),
    el('button', { class: 'side-new', type: 'button', title: 'New task (Ctrl+N)', onclick: () => ctx.newTask() }, '+', el('span', { class: 'side-new-label', text: ' New task' }))
  );

  // A tiny Katana: the middle of her picture.
  const avatar = el('img', { class: 'avatar', src: 'img/katana-face.png', alt: '', 'aria-hidden': 'true' });
  const waitingCount = el('span', { class: 'side-agent-count' });
  const agent = el(
    'button',
    { class: 'side-agent', type: 'button', title: 'Katana: she starts tasks, watches them and tells you when they finish', onclick: () => ctx.openAgent() },
    avatar,
    el('span', { class: 'side-agent-name', text: 'Katana' }),
    waitingCount
  );
  // Between her and the tasks. Its own element: the list fades and scrolls, so nothing drawn on the list would hold still.
  const rule = el('div', { class: 'side-rule', 'aria-hidden': 'true' });
  const list = el('nav', { class: 'side-list', 'aria-label': 'Tasks' });

  const projectButton = el('button', { class: 'foot-project', type: 'button', title: 'Where new tasks run' });
  const usageFill = el('span');
  const usageText = el('span', { class: 'usage-text' });
  const usage = el('button', { class: 'usage', type: 'button' }, el('span', { class: 'usage-bar' }, usageFill), usageText);
  const more = el('button', { class: 'icon foot-more', type: 'button', title: 'More', 'aria-label': 'More', html: icons.more });
  // Beside the dots: collapses the sidebar, or keeps it open once it's collapsed.
  const collapse = el('button', { class: 'icon foot-collapse', type: 'button', onclick: () => ctx.toggleRail() });
  // (The macOS style's second line: the plan's use, under the task's context.)
  const planText = el('span', { class: 'usage-plan' });
  const foot = el('div', { class: 'side-foot' }, projectButton, usage, planText, collapse, more);
  // The selection: one highlight that glides from row to row.
  const pill = glider(root, () => root.querySelector('.side-task.is-active, .side-agent.is-active'), { clip: list });
  const slideActive = () => root.classList.contains('is-sliding');
  root.replaceChildren(pill.node, head, agent, rule, list, foot);
  list.addEventListener('scroll', () => pill.place({ now: true }), { passive: true });
  new ResizeObserver(() => slideActive() || pill.place({ now: true })).observe(root);

  projectButton.addEventListener('click', () => {
    const current = ctx.currentProject();
    openMenu(projectButton, [
      ...store.state.projects.map((project) => ({
        label: project.name,
        title: project.path,
        on: project.id === current,
        run: () => {
          store.setSetting('currentProject', project.id);
          if (!ctx.current()) ctx.newTask();
        },
      })),
      ...(store.state.projects.length ? ['-'] : []),
      { label: 'Add a folder…', run: addProject },
    ]);
  });

  usage.addEventListener('click', () => ctx.current() && ctx.showContext(usage));

  more.addEventListener('click', () =>
    openMenu(more, [
      { label: 'New task', hint: 'Ctrl+N', run: () => ctx.newTask() },
      { label: showDone ? 'Hide done tasks' : 'Show done tasks', run: () => ((showDone = !showDone), render()) },
      { label: 'Add a folder…', run: addProject },
      '-',
      { label: 'Settings', hint: 'Ctrl+,', run: () => ctx.openSettings() },
    ])
  );

  /* --------------------- collapsed: slides open on hover ------------------ */

  const PEEK_OPEN_MS = 120; // a pointer passing over on its way somewhere doesn't open it
  const PEEK_CLOSE_MS = 280; // nor does slipping off the edge for a moment close it
  const SLIDE_OPEN = { duration: 460, easing: SPRING };
  const SLIDE_CLOSE = { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }; // eases in and settles, with no bounce to catch the eye
  // What only the open sidebar has: it fades as the panel closes over it.
  const OPEN_ONLY = '.side-task-text, .side-agent-name, .side-agent-count, .side-new-label, .side-section, .side-rule, .side-empty, .lights, .foot-more, .usage, .usage-plan';
  const peeking = () => document.body.hasAttribute('data-peek');
  const folded = () => peeking() || document.body.hasAttribute('data-rail');
  let peekTimer = 0;
  let wanted = false; // slid out, or on its way there
  let slide = null; // what's moving: { parts, moved, railScroll }
  // Collapsed under a pointer that's still there: hover waits until it has left, or collapsing would undo itself.
  let armed = true;

  /** Where everything in the footer, the head and the list sits in the sidebar's current layout. */
  function places() {
    const zoom = root.getBoundingClientRect().width / root.offsetWidth || 1;
    const center = (node) => {
      const box = node.getBoundingClientRect();
      return [(box.x + box.width / 2) / zoom, (box.y + box.height / 2) / zoom, box.width / zoom];
    };
    const edge = list.getBoundingClientRect();
    const rows = new Map();
    for (const row of list.querySelectorAll('.side-task')) {
      const box = row.getBoundingClientRect();
      if (box.bottom < edge.top - 60 || box.top > edge.bottom + 60) continue; // (out of sight: nothing to see move)
      const dot = row.querySelector('.task-dot');
      if (dot) rows.set(row, center(dot));
    }
    const plus = head.querySelector('.side-new');
    const plusBox = plus.getBoundingClientRect();
    const plusStyle = getComputedStyle(plus);
    pill.place({ now: true });
    const { transform, width, height } = pill.node.style;
    return {
      rows,
      avatar: center(avatar),
      collapse: center(collapse),
      plus: { right: plusBox.right / zoom, y: (plusBox.y + plusBox.height / 2) / zoom, width: plusBox.width / zoom, height: plusBox.height / zoom, fontSize: plusStyle.fontSize },
      pill: pill.node.classList.contains('is-on') ? { transform, width, height } : null,
    };
  }

  const setDrawn = (rail) => {
    document.body.toggleAttribute('data-rail', rail);
    document.body.toggleAttribute('data-peek', !rail);
  };

  /** Everything stops where its layout says, and the sidebar's parts follow its width again. */
  function stopSlide() {
    if (!slide) return;
    for (const part of slide.parts) part.cancel();
    for (const child of root.children) {
      child.style.width = '';
      child.style.alignSelf = '';
    }
    slide = null;
  }

  /**
   * Out or back, as one motion. It stays drawn as the full sidebar the whole way, its parts held at
   * their full widths and clipped by the panel as it narrows; each thing that's in the rail too travels
   * to exactly where the rail has it, on the panel's own curve. So becoming the rail at the end moves
   * nothing, and its glass (the same as the rail's) never changes.
   */
  function slideTo(on) {
    clearTimeout(peekTimer);
    if (on === wanted) return;
    wanted = on;
    if (!motionOn()) {
      stopSlide();
      return ctx.setPeek(on);
    }
    // Turning around mid-way: everything carries on from where it is now.
    const midway = slide ? new Map(slide.moved.map((node) => [node, getComputedStyle(node)])) : null;
    const now = midway && new Map([...midway].map(([node, style]) => [node, { transform: style.transform, width: style.width, height: style.height, fontSize: style.fontSize }]));
    const fromWidth = parseFloat(getComputedStyle(root).width);
    stopSlide();
    root.classList.add('is-sliding');
    root.classList.toggle('is-closing', !on);
    ctx.setPeek(true);

    // Both layouts, measured without being painted.
    const scroll = list.scrollTop;
    setDrawn(true);
    list.scrollTop = scroll;
    const railScroll = list.scrollTop;
    const toWidthRail = root.offsetWidth;
    const rail = places();
    setDrawn(false);
    list.scrollTop = scroll;
    const full = places();
    const toWidthFull = root.offsetWidth;
    for (const child of root.children) {
      if (child === pill.node) continue;
      child.style.width = `${child.offsetWidth}px`;
      child.style.alignSelf = 'flex-start';
    }

    const timing = on ? SLIDE_OPEN : SLIDE_CLOSE;
    const parts = [];
    const moved = [];
    const move = (node, tucked, open) => {
      const end = on ? open : tucked;
      const start = now?.get(node) ? Object.fromEntries(Object.keys(end).map((key) => [key, now.get(node)[key]])) : on ? tucked : open;
      parts.push(node.animate([start, end], { ...timing, fill: 'both' }));
      moved.push(node);
    };
    const shift = (from, to, extra = '') => ({ transform: `translate(${to[0] - from[0]}px, ${to[1] - from[1]}px)${extra}` });
    const still = { transform: 'none' };
    for (const [row, at] of full.rows) if (rail.rows.has(row)) move(row, shift(at, rail.rows.get(row)), still);
    move(avatar, shift(full.avatar, rail.avatar, ` scale(${rail.avatar[2] / full.avatar[2]})`), still);
    move(collapse, shift(full.collapse, rail.collapse), still);
    // The New task button narrows to the rail's + against its right edge, where its layout keeps it.
    const plus = head.querySelector('.side-new');
    const plusSize = (box) => ({ width: `${box.width}px`, height: `${box.height}px`, fontSize: box.fontSize });
    move(plus, { ...shift([full.plus.right, full.plus.y], [rail.plus.right, rail.plus.y]), ...plusSize(rail.plus) }, { ...still, ...plusSize(full.plus) });
    if (full.pill && rail.pill) move(pill.node, rail.pill, full.pill);
    parts.push(root.animate({ width: [`${fromWidth}px`, `${on ? toWidthFull : toWidthRail}px`] }, { ...timing, fill: 'both' }));
    // Closing: the words go first. (Opening, they come back once there's room: labels-back in macos.css.)
    if (!on) for (const node of root.querySelectorAll(OPEN_ONLY)) parts.push(node.animate({ opacity: [getComputedStyle(node).opacity, 0] }, { duration: 170, easing: 'ease-out', fill: 'both' }));
    else for (const node of root.querySelectorAll('.side-section, .side-rule, .side-empty, .foot-more')) parts.push(node.animate({ opacity: [0, 1] }, { duration: 200, delay: 150, easing: 'ease', fill: 'both' }));

    slide = { parts, moved, railScroll };
    parts.at(-1).finished.catch(() => {});
    Promise.all(parts.map((part) => part.finished)).then(
      () => slideDone(slide),
      () => {} // (turned around or stopped: the next slide took over)
    );
  }

  function slideDone(done) {
    if (!done || done !== slide) return;
    const { railScroll } = done;
    stopSlide();
    if (!wanted) {
      ctx.setPeek(false);
      list.scrollTop = railScroll;
    }
    root.classList.remove('is-sliding', 'is-closing');
    pill.place({ now: true });
  }

  function peekLater(on) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      // Its menu is open: it stays until that's gone (closeMenu looks again).
      if (!on && menu) return;
      slideTo(on);
    }, on ? PEEK_OPEN_MS : PEEK_CLOSE_MS);
  }

  root.addEventListener('pointerover', (event) => {
    if (wanted) return clearTimeout(peekTimer);
    // (Dragging a selection across it isn't hovering. Nor is the rail's footer: its button stays where it is, to be pressed.)
    if (!folded() || !armed || event.buttons || (foot.contains(event.target) && !slide)) return clearTimeout(peekTimer);
    peekLater(true);
  });
  root.addEventListener('pointerleave', () => {
    armed = true;
    if (wanted) peekLater(false);
    else clearTimeout(peekTimer);
  });
  new MutationObserver(() => {
    if (document.body.hasAttribute('data-rail') && !slide) armed = !root.matches(':hover');
  }).observe(document.body, { attributes: true, attributeFilter: ['data-rail'] });

  /** Kept open while slid out: it holds its width while the chat makes room, rather than dropping to the slim one first. */
  function holdWidth() {
    clearTimeout(peekTimer);
    wanted = false;
    stopSlide();
    root.classList.remove('is-sliding', 'is-closing');
    root.classList.add('is-holding');
    setTimeout(() => root.classList.remove('is-holding'), 340);
  }

  /* ------------------------------ render ------------------------------ */

  const rows = new Map(); // task id → its row (kept and updated in place, never rebuilt per change)

  /* The active tasks, told to the scene (only when that changes): the ones at work, waiting, finished, or that you're on or pointing at. */
  let pointing = null;
  let shownTasks = [];
  let sceneKey = '';
  function tellScene() {
    const current = ctx.current();
    const agents = [];
    for (const task of shownTasks) {
      const live = ctx.stateOf(task.id);
      const state = live === 'working' || live === 'needs' ? live : task.unread ? 'unread' : 'idle';
      const hot = task.id === current || task.id === pointing;
      if (state !== 'idle' || hot) agents.push([task.id, state, hot]);
    }
    const key = agents.join('|');
    if (key === sceneKey) return;
    sceneKey = key;
    ctx.sceneAgents?.(agents);
  }

  function makeRow(id) {
    const mark = el('span', { class: 'task-dot' });
    const title = el('span', { class: 'side-task-title' });
    const branch = el('span', { class: 'branch-mark', title: 'Branched: it remembers the conversation it came from', html: icons.branch, hidden: true });
    const text = el('span', { class: 'side-task-text' }, el('span', { class: 'side-task-name' }, branch, title));
    const node = el('button', { type: 'button', 'data-chat': id }, mark, text);
    node.addEventListener('click', () => ctx.open(id));
    // Pointing at a task lifts its light in the scene.
    node.addEventListener('pointerenter', () => ((pointing = id), tellScene()));
    node.addEventListener('pointerleave', () => {
      if (pointing === id) pointing = null;
      tellScene();
    });
    node.addEventListener('contextmenu', (event) => {
      const task = store.task(id);
      if (!task) return;
      openMenu(event, [
        { label: 'Rename', run: () => renameTask(task) },
        // Claude only: a new task carrying this conversation, for something else.
        task.kind === 'claude' && task.started ? { label: 'Branch', title: 'A new task that starts from this conversation', run: () => ctx.branch(id) } : null,
        task.doneAt ? { label: 'Reopen', run: () => store.markDone(id, false) } : { label: 'Done', run: () => ctx.finishTask(id) },
        task.worktree && !task.merged ? { label: 'Merge', run: () => ctx.merge(id) } : null,
        { label: 'Open terminal', run: () => (ctx.open(id), ctx.showTerminal()) },
        '-',
        { label: 'Delete', danger: true, run: () => deleteTask(task) },
      ]);
    });
    return { node, mark, title, branch, text, sub: null, shown: {} };
  }

  /** Bring a row up to date, touching the DOM only where something differs. */
  function updateRow(row, chat, underParent) {
    const active = chat.id === ctx.current();
    const state = ctx.stateOf(chat.id);
    const dot = state === 'working' ? ' is-working' : state === 'needs' ? ' is-needs' : chat.unread ? ' is-unread' : '';
    // While it works: a second line with what it's doing ("Thinking", "Run the tests").
    const doing = state === 'working' || state === 'needs' ? ctx.activityOf(chat.id) : '';
    const want = {
      cls: `side-task${active ? ' is-active' : ''}${chat.doneAt ? ' is-done' : ''}${doing ? ' has-sub' : ''}${underParent ? ' is-branch' : ''}`,
      dot: `task-dot${dot}`,
      label: state === 'working' ? 'Working' : state === 'needs' ? doing : chat.unread ? 'Finished' : null,
      tip: `${chat.title} — ${store.project(chat.projectId)?.name || ''}${chat.kind !== 'claude' ? ` (${chat.kind})` : ''}${chat.worktree && !chat.merged ? ' · worktree' : ''}`,
      active,
      title: chat.title,
      doing,
    };
    const had = row.shown;
    if (had.cls !== want.cls) row.node.className = want.cls;
    if (had.dot !== want.dot) row.mark.className = want.dot;
    if (had.label !== want.label) want.label ? row.mark.setAttribute('aria-label', want.label) : row.mark.removeAttribute('aria-label');
    if (had.tip !== want.tip) row.node.title = want.tip;
    if (had.active !== want.active) active ? row.node.setAttribute('aria-current', 'page') : row.node.removeAttribute('aria-current');
    if (had.title !== want.title) row.title.textContent = want.title;
    row.branch.hidden = !chat.forkOf;
    if (had.doing !== want.doing) {
      if (!want.doing) {
        row.sub?.remove();
        row.sub = null;
      } else {
        if (!row.sub) row.text.append((row.sub = el('span', { class: 'side-task-sub' })));
        row.sub.textContent = want.doing;
      }
    }
    row.shown = want;
  }

  const empty = el('p', { class: 'side-empty' });
  const doneHead = el('p', { class: 'side-section', text: 'Done' });

  /** Where each row sits now, to slide rows that move (a finished task rises to the top). */
  const rowTops = () => new Map([...list.querySelectorAll('.side-task')].map((row) => [row.dataset.chat, row.getBoundingClientRect().top]));

  function slideMoved(before) {
    for (const row of list.querySelectorAll('.side-task')) {
      const was = before.get(row.dataset.chat);
      if (was === undefined) continue;
      const shift = was - row.getBoundingClientRect().top;
      if (Math.abs(shift) < 1) continue;
      // A row jumping up the list doesn't travel through the others (the words would run over each other): it fades in where it lands.
      if (motionOn() && Math.abs(shift) > row.offsetHeight * 1.5) {
        row.animate([{ opacity: 0, transform: `translateY(${Math.sign(shift) * 10}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE_OUT });
        continue;
      }
      row.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], {
        duration: document.body.dataset.motion === 'reduced' ? 160 : motionOn() ? 460 : 420,
        easing: motionOn() ? SPRING : 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
    }
  }

  function renderFoot() {
    const canPin = folded();
    if (collapse.dataset.pin !== String(canPin)) {
      collapse.dataset.pin = String(canPin);
      collapse.innerHTML = canPin ? icons.sideOpen : icons.sideClose;
      const label = canPin ? 'Keep the sidebar open (Ctrl+B)' : 'Collapse the sidebar (Ctrl+B)';
      collapse.title = label;
      collapse.setAttribute('aria-label', label);
    }
    const project = store.project(ctx.currentProject());
    const name = project ? project.name : '';
    // (No folder yet: the home screen asks for one, and the ··· menu has it too.)
    projectButton.hidden = !project;
    if (projectButton.dataset.name !== name) {
      projectButton.dataset.name = name;
      projectButton.replaceChildren(el('span', { text: '›' }), name);
    }
    // macOS: the task's memory, and under it the plan's live 5-hour and weekly use.
    // Classic: the plan's use, else the task's memory; the bar shows the fuller one.
    const macos = document.body.dataset.style === 'macos';
    const plan = macos && store.state.settings.showUsage ? ctx.planUsage() : null;
    planText.hidden = !plan;
    if (plan) {
      if (planText.textContent !== plan.short) planText.textContent = plan.short;
      if (planText.title !== plan.title) planText.title = plan.title;
    }
    const used = macos ? ctx.contextUsage(ctx.current()) : ctx.usage(ctx.current());
    usage.hidden = !store.state.settings.showUsage || !used;
    if (!used) return;
    const width = `${Math.round(Math.min(1, used.share) * 100)}%`;
    if (usageFill.style.width !== width) usageFill.style.width = width;
    // (The status line says "used"; here, under a meter, it goes without saying.)
    const label = used.short || used.text;
    if (usageText.textContent !== label) usageText.textContent = label;
    if (usage.title !== used.title) usage.title = used.title;
  }

  /**
   * What needs you comes first: waiting for you, then finished and not yet
   * seen, then working, then the rest; most recent first within each.
   */
  const rank = (task) => {
    const state = ctx.stateOf(task.id);
    if (state === 'needs') return 0;
    if (task.unread) return 1;
    if (state === 'working') return 2;
    return 3;
  };

  let drawn = false;
  let hadRows = false;
  let queued = 0;

  /** Render requests inside one frame become one render (a task's tool calls come in bursts). */
  function render() {
    if (!drawn) return draw(); // the first one is at once
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      draw();
    });
  }

  function draw() {
    drawn = true;
    const open = branchesUnderParents(store.openTasks().sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt));
    const done = showDone ? branchesUnderParents(store.state.tasks.filter((task) => task.doneAt).sort((a, b) => b.doneAt - a.doneAt)) : [];

    // Did the set or the order of rows change? Only then is anything measured (before touching the DOM) to slide it.
    const order = [...open.map((chat) => chat.id), ...(open.length ? [] : ['#empty']), ...(done.length ? ['#done', ...done.map((chat) => chat.id)] : [])];
    const nowOrder = [...list.children].map((node) => node.dataset.chat || (node === empty ? '#empty' : '#done'));
    const moved = order.length !== nowOrder.length || order.some((id, i) => id !== nowOrder[i]);
    // A row growing a second line (what it's doing) moves the ones under it too.
    const grew = open.some((chat) => {
      const live = ctx.stateOf(chat.id);
      return Boolean(rows.get(chat.id)?.shown.doing) !== Boolean((live === 'working' || live === 'needs') && ctx.activityOf(chat.id));
    });
    const slide = (moved || (grew && motionOn())) && document.body.dataset.motion !== 'off' && list.querySelector('.side-task') ? rowTops() : null;
    const added = [];

    // Rows of tasks that are gone are dropped; every other row is reused and updated where it stands.
    const keep = new Set([...open, ...done].map((chat) => chat.id));
    for (const [id, row] of rows) {
      if (keep.has(id)) continue;
      row.node.remove();
      rows.delete(id);
    }
    // A branch sits close under its parent (styles.css); one whose parent isn't listed with it stands alone.
    const underParents = new Set([open, done].flatMap((tasks) => tasks.filter(parentsAmong(tasks))));
    const want = [];
    const place = (chat) => {
      let row = rows.get(chat.id);
      if (!row) {
        rows.set(chat.id, (row = makeRow(chat.id)));
        added.push(row.node);
      }
      want.push(row.node);
      updateRow(row, chat, underParents.has(chat));
    };
    open.forEach(place);
    if (!open.length) {
      // (No folder yet: the home screen is already asking for one.)
      empty.textContent = store.state.projects.length ? 'No open tasks.' : '';
      want.push(empty);
    }
    if (done.length) {
      want.push(doneHead);
      done.forEach(place);
    }

    if (moved) {
      want.forEach((node, i) => {
        if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null);
      });
      while (list.children.length > want.length) list.lastElementChild.remove();
    }
    // (Measured before anything slides: it goes where the row ends up, gliding alongside it.)
    agent.classList.toggle('is-active', ctx.viewType() === 'agent');
    pill.place();
    if (slide) slideMoved(slide);
    // A new task arrives in the list.
    if (hadRows && motionOn()) {
      for (const node of added) node.animate([{ opacity: 0, transform: 'translateX(-12px) scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: SPRING });
    }
    hadRows = true;
    renderFoot();
    shownTasks = open;
    tellScene();
    const waiting = open.filter((t) => t.unread || ctx.stateOf(t.id) === 'needs').length;
    const count = waiting ? String(waiting) : '';
    if (waitingCount.textContent !== count) {
      waitingCount.textContent = count;
      waitingCount.title = waiting ? `${waiting} waiting for you` : '';
    }
  }

  store.on('change', render);
  render();
  return { render, renderFoot, addProject, removeProject, holdWidth };
}
