import { el, icons, placeNear } from './util.js';
import { confirmDialog, promptDialog } from './dialog.js';
import { mountFace, FACE_CROP } from './face.js';

/**
 * The sidebar: window lights and New task on top, Katana (the agent you
 * talk to) under them, then every open task, newest first, across projects.
 * A task's dot says where it stands: hollow (idle), shining (working), filled (finished while you looked elsewhere), pulsing (it's
 * asking you something). Done tasks leave the list; the ··· menu can
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
  let showDone = false;
  let lastDrawn = '';

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
    menu?.remove();
    menu = null;
  }

  /** A menu at the pointer (right-click) or above an anchor (a button). */
  function openMenu(where, items) {
    closeMenu();
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
    menu.querySelector('button')?.focus();
  }

  document.addEventListener('pointerdown', (event) => {
    if (menu && !menu.contains(event.target)) closeMenu();
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

  // A tiny Katana: the same face, alive too (face.js).
  const avatar = mountFace(el('canvas', { class: 'avatar', width: '34', height: '34', 'aria-hidden': 'true' }), { crop: FACE_CROP }).element;
  const waitingCount = el('span', { class: 'side-agent-count' });
  const agent = el(
    'button',
    { class: 'side-agent', type: 'button', title: 'Talk to Katana: she starts tasks, watches them and tells you when they finish', onclick: () => ctx.openAgent() },
    avatar,
    el('span', { class: 'side-agent-name', text: 'Katana' }),
    waitingCount
  );
  const list = el('nav', { class: 'side-list', 'aria-label': 'Tasks' });

  const projectButton = el('button', { class: 'foot-project', type: 'button', title: 'Where new tasks run' });
  const usageFill = el('span');
  const usageText = el('span', { class: 'usage-text' });
  const usage = el('button', { class: 'usage', type: 'button' }, el('span', { class: 'usage-bar' }, usageFill), usageText);
  const more = el('button', { class: 'icon foot-more', type: 'button', title: 'More', 'aria-label': 'More', html: icons.more });
  const foot = el('div', { class: 'side-foot' }, projectButton, usage, more);
  root.replaceChildren(head, agent, list, foot);

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
      { label: 'Collapse the sidebar', hint: 'Ctrl+B', run: () => ctx.toggleRail() },
      { label: 'Add a folder…', run: addProject },
      '-',
      { label: 'Settings', hint: 'Ctrl+,', run: () => ctx.openSettings() },
    ])
  );

  /* ------------------------------ render ------------------------------ */

  function taskRow(chat) {
    const active = chat.id === ctx.current();
    const state = ctx.stateOf(chat.id);
    const dot = state === 'working' ? ' is-working' : state === 'needs' ? ' is-needs' : chat.unread ? ' is-unread' : '';
    const mark = el('span', { class: `task-dot${dot}`, 'aria-label': state === 'working' ? 'Working' : state === 'needs' ? ctx.activityOf(chat.id) : chat.unread ? 'Finished' : null });
    // While it works: a second line with what it's doing ("Thinking", "Run the tests").
    const doing = state === 'working' || state === 'needs' ? ctx.activityOf(chat.id) : '';
    return el(
      'button',
      {
        class: `side-task${active ? ' is-active' : ''}${chat.doneAt ? ' is-done' : ''}${doing ? ' has-sub' : ''}`,
        type: 'button',
        'data-chat': chat.id,
        title: `${chat.title} — ${store.project(chat.projectId)?.name || ''}${chat.kind !== 'claude' ? ` (${chat.kind})` : ''}${chat.worktree && !chat.merged ? ' · worktree' : ''}`,
        'aria-current': active ? 'page' : null,
        onclick: () => ctx.open(chat.id),
        oncontextmenu: (event) =>
          openMenu(event, [
            { label: 'Rename', run: () => renameTask(chat) },
            chat.doneAt ? { label: 'Reopen', run: () => store.markDone(chat.id, false) } : { label: 'Done', run: () => ctx.done(chat.id) },
            chat.worktree && !chat.merged ? { label: 'Merge', run: () => ctx.merge(chat.id) } : null,
            { label: 'Open terminal', run: () => (ctx.open(chat.id), ctx.showTerminal()) },
            '-',
            { label: 'Delete', danger: true, run: () => deleteTask(chat) },
          ]),
      },
      mark,
      el('span', { class: 'side-task-text' }, el('span', { class: 'side-task-title', text: chat.title }), doing ? el('span', { class: 'side-task-sub', text: doing }) : null)
    );
  }

  /** Where each row sits now, to slide rows that move (a finished task rises to the top). */
  const rowTops = () => new Map([...list.querySelectorAll('.side-task')].map((row) => [row.dataset.chat, row.getBoundingClientRect().top]));

  function slideMoved(before) {
    if (document.body.dataset.motion === 'off') return;
    for (const row of list.querySelectorAll('.side-task')) {
      const was = before.get(row.dataset.chat);
      if (was === undefined) continue;
      const shift = was - row.getBoundingClientRect().top;
      if (Math.abs(shift) < 1) continue;
      row.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], {
        duration: document.body.dataset.motion === 'reduced' ? 160 : 420,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
    }
  }

  function renderFoot() {
    const project = store.project(ctx.currentProject());
    projectButton.replaceChildren(el('span', { text: '›' }), project ? project.name : 'add a folder');
    // The plan's live 5-hour and weekly use, else the task's memory; the bar shows the fuller one.
    const used = ctx.usage(ctx.current());
    usage.hidden = !store.state.settings.showUsage || !used;
    if (!used) return;
    usageFill.style.width = `${Math.round(Math.min(1, used.share) * 100)}%`;
    usageText.textContent = used.text;
    usage.title = used.title;
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

  function render() {
    const before = rowTops();
    const open = store.openTasks().sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    const done = showDone ? store.state.tasks.filter((task) => task.doneAt).sort((a, b) => b.doneAt - a.doneAt) : [];
    // Rebuilding on every state change (a working task changes it constantly) swallows a click
    // whose press and release straddle the rebuild: only redraw when a row would look different.
    const rows = [...open, ...done].map((t) => [t.id, t.title, t.kind, t.projectId, t.unread, t.doneAt, t.merged, Boolean(t.worktree), ctx.stateOf(t.id), ctx.activityOf(t.id)]);
    const drawn = JSON.stringify([rows, ctx.current(), store.state.projects.length, document.body.dataset.rail, showDone, open.length]);
    if (drawn !== lastDrawn) {
      lastDrawn = drawn;
      list.replaceChildren(
        ...open.map(taskRow),
        ...(open.length ? [] : [el('p', { class: 'side-empty', text: store.state.projects.length ? 'No open tasks.' : 'Add a folder to start.' })]),
        ...(done.length ? [el('p', { class: 'side-section', text: 'Done' }), ...done.map(taskRow)] : [])
      );
      slideMoved(before);
    }
    renderFoot();
    agent.classList.toggle('is-active', ctx.viewType() === 'agent');
    const waiting = open.filter((t) => t.unread || ctx.stateOf(t.id) === 'needs').length;
    waitingCount.textContent = waiting ? String(waiting) : '';
    waitingCount.title = waiting ? `${waiting} waiting for you` : '';
  }

  store.on('change', render);
  render();
  return { render, renderFoot, addProject, removeProject };
}
