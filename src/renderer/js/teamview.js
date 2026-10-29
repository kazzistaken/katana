import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { el } from './util.js';
import { theme, FONT } from './terminal.js';
import { LEADER, doing as describe } from './teamclient.js';

/**
 * The >_ view of a task in hierarchy mode: its team as a tree. The Leader
 * (the task's own session) on top, the 2 Verifiers in a row below it, the
 * 4 Workers below them, joined by lines (lit while that member works).
 * Each node shows its role, state and subtask over a live mini terminal:
 * the session's real screen, scaled down. Click one to open it full size
 * and type into it; ← Team goes back.
 *
 * A member's terminal is made once its session has started, and kept: it
 * moves between its node and the full-size view, the session sized to match.
 */

// The size sessions run at while they're shown as nodes (members start at it: core.js).
const MINI = { cols: 80, rows: 24 };
const MINI_FONT = 10;
const STATES = { idle: 'idle', working: 'working', done: 'done', failed: 'failed' };

export function initTeamView(ctx, root) {
  const { store, api, tasks, team } = ctx;
  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wires.setAttribute('class', 'team-wires');
  wires.setAttribute('aria-hidden', 'true');
  const rows = { leader: el('div', { class: 'team-row is-leader' }), verifiers: el('div', { class: 'team-row is-verifiers' }), workers: el('div', { class: 'team-row is-workers' }) };
  const tree = el('div', { class: 'team-tree' }, wires, rows.leader, rows.verifiers, rows.workers);
  const fullLabel = el('span', { class: 'team-full-label' });
  const fullState = el('span', { class: 'team-full-state' });
  const fullHost = el('div', { class: 'team-full-host' });
  const full = el(
    'div',
    { class: 'team-full', hidden: true },
    el('header', { class: 'team-full-bar' }, el('button', { class: 'key-btn is-quiet', type: 'button', text: '← Team', title: 'Back to the team', onclick: () => collapse() }), fullLabel, fullState),
    fullHost
  );
  const node = el('div', { class: 'team', hidden: true }, tree, full);
  root.append(node);

  const terms = new Map(); // session id -> { wrap, term, fit, ready, early, stamp }
  const nodes = new Map(); // member key -> { box, screen, stateEl, subEl }
  let shown = null; // task id
  let open = null; // session id shown full size

  /* ----------------------------- terminals ----------------------------- */

  function ensure(id) {
    if (terms.has(id)) return terms.get(id);
    const wrap = el('div', { class: 'team-term' });
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: MINI_FONT,
      lineHeight: 1.15,
      cols: MINI.cols,
      rows: MINI.rows,
      cursorBlink: false,
      scrollback: 4000,
      theme: theme(),
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const entry = { wrap, term, fit, ready: false, early: [], stamp: null, sized: '' };
    terms.set(id, entry);
    term.open(wrap);
    term.onData((data) => {
      if (open === id) api.task.write(id, data);
    });
    replay(id, entry);
    return entry;
  }

  /** What the session printed so far (it may have started before this window). */
  async function replay(id, entry) {
    entry.ready = false;
    const tail = await api.task.tail(id);
    entry.term.reset();
    if (tail) entry.term.write(tail);
    for (const chunk of entry.early) entry.term.write(chunk);
    entry.early = [];
    entry.ready = true;
    entry.term.write('', () => rescale(id));
  }

  api.task.onData(({ id, data }) => feed(id, data));

  function feed(id, data) {
    const entry = terms.get(id);
    if (!entry) return;
    if (entry.ready) entry.term.write(data, () => rescale(id));
    else entry.early.push(data);
  }

  /** A running session is sized like its mini terminal (once per run), so what it prints lines up. */
  function sizeSession(id, entry) {
    const running = tasks.get(id).running;
    if (!running) entry.sized = '';
    else if (open !== id && entry.sized !== 'mini') {
      entry.sized = 'mini';
      api.task.resize(id, MINI.cols, MINI.rows);
    }
  }

  /**
   * A node's terminal at its screen's width, moved up so the row with the
   * cursor (the newest output; Claude Code's prompt) is in view.
   */
  function scale(id) {
    const entry = terms.get(id);
    if (!entry || open === id) return;
    const screen = entry.wrap.parentElement;
    const inner = entry.wrap.querySelector('.xterm-screen');
    if (!screen || !inner || !inner.offsetWidth) return;
    const s = screen.clientWidth / inner.offsetWidth;
    const row = (inner.offsetHeight / entry.term.rows) * s;
    const shown = (entry.term.buffer.active.cursorY + 1) * row;
    const shift = Math.min(0, screen.clientHeight - 6 - shown);
    entry.wrap.style.transform = `translate(0, ${shift}px) scale(${s})`;
  }

  const queued = new Set();
  function rescale(id) {
    if (queued.has(id)) return;
    queued.add(id);
    requestAnimationFrame(() => {
      queued.delete(id);
      scale(id);
    });
  }

  /* ------------------------------- nodes ------------------------------- */

  function makeNode(key, label, role) {
    const stateEl = el('span', { class: 'team-state' });
    const subEl = el('span', { class: 'team-sub' });
    const screen = el('div', { class: 'team-screen' });
    const box = el(
      'button',
      { class: `team-node is-${role}`, type: 'button', 'data-key': key, onclick: () => expand(key) },
      el('span', { class: 'team-head' }, el('span', { class: 'team-role', text: label }), stateEl),
      subEl,
      screen
    );
    const item = { box, screen, stateEl, subEl };
    nodes.set(key, item);
    return item;
  }

  rows.leader.append(makeNode('leader', LEADER.label, 'leader').box);
  for (const n of [1, 2]) rows.verifiers.append(makeNode(`v${n}`, `Verifier ${n}`, 'verifier').box);
  for (const n of [1, 2, 3, 4]) rows.workers.append(makeNode(`w${n}`, `Worker ${n}`, 'worker').box);

  const sessionOf = (key) => (key === 'leader' ? shown : `${shown}--${key}`);

  /** The leader, from its session: working (or asking you), done with its last turn, or idle before its first. */
  function leaderView() {
    const t = tasks.get(shown);
    const task = store.task(shown);
    const busy = t.state === 'working' || t.state === 'needs';
    const doing = t.state === 'needs' ? tasks.waiting(shown) : busy ? (t.tool ? describe(t.tool) : 'Planning') : task?.started ? (t.running ? 'Waiting for your next message' : 'Not running') : 'Starts with your first message';
    return { state: busy ? 'working' : task?.started ? 'done' : 'idle', needs: t.state === 'needs', subtask: doing, started: Boolean(task?.started) || t.running };
  }

  function render() {
    if (!shown) return;
    const view = team.get(shown);
    const members = new Map((view?.members || []).map((m) => [m.key, m]));
    for (const [key, item] of nodes) {
      const m = key === 'leader' ? leaderView() : members.get(key) || { state: 'idle', subtask: '' };
      const state = STATES[m.state] || 'idle';
      item.box.dataset.state = state;
      item.box.classList.toggle('is-needs', Boolean(m.needs));
      item.stateEl.replaceChildren(el('span', { class: `status-dot${state === 'working' ? (m.needs ? ' is-needs' : ' is-working') : state === 'failed' ? ' is-failed' : ''}`, 'aria-hidden': 'true' }), m.needs ? 'needs you' : m.merged ? 'merged' : m.verdict && key[0] === 'w' && state !== 'working' ? `${state} · ${m.verdict}` : state);
      const sub = key === 'leader' ? m.subtask : m.subtask || (key[0] === 'v' ? 'Checks a worker’s work when the Leader asks' : 'Starts when the Leader assigns work');
      item.subEl.textContent = sub;
      item.subEl.title = [sub, m.branch, m.note].filter(Boolean).join('\n');
      item.box.title = `${key === 'leader' ? 'Leader' : m.label || key}: open full size`;
      const id = sessionOf(key);
      // A terminal once its session has started (and kept after, to read back).
      const started = key === 'leader' ? m.started || tasks.get(shown).running : Boolean(m.subtask) || terms.has(id);
      if (started) {
        const entry = ensure(id);
        if (key !== 'leader' && m.since && entry.stamp !== m.since) {
          if (entry.stamp !== null) replay(id, entry);
          entry.stamp = m.since;
        }
        if (open !== id && entry.wrap.parentElement !== item.screen) item.screen.replaceChildren(entry.wrap);
        sizeSession(id, entry);
      } else if (open !== id) item.screen.replaceChildren(el('span', { class: 'team-screen-empty', text: key === 'leader' ? 'Not started' : 'No session yet' }));
      item.screen.classList.toggle('is-empty', !started);
    }
    if (open) renderFullBar();
    requestAnimationFrame(layout);
  }

  /* ------------------------------- wires ------------------------------- */

  function layout() {
    if (node.hidden || !full.hidden) return;
    for (const key of nodes.keys()) scale(sessionOf(key));
    const base = tree.getBoundingClientRect();
    if (!base.width) return;
    const at = (key) => {
      const r = nodes.get(key).box.getBoundingClientRect();
      return { x: r.left - base.left + r.width / 2, top: r.top - base.top, bottom: r.bottom - base.top };
    };
    const leader = at('leader');
    const v = [at('v1'), at('v2')];
    const w = [1, 2, 3, 4].map((n) => at(`w${n}`));
    const busV = (leader.bottom + v[0].top) / 2;
    const busW = (v[0].bottom + w[0].top) / 2;
    const view = team.get(shown);
    const lit = (key) => view?.members.find((m) => m.key === key)?.state === 'working';
    const paths = [];
    const line = (d, on) => paths.push(`<path d="${d}" class="${on ? 'is-lit' : ''}"/>`);
    // The trunk: from the leader down through the verifiers' row to the workers' bus.
    line(`M${leader.x} ${leader.bottom} V${busW}`, [1, 2, 3, 4].some((n) => lit(`w${n}`)) || ['v1', 'v2'].some(lit));
    line(`M${v[0].x} ${busV} H${v[1].x}`, false);
    line(`M${w[0].x} ${busW} H${w[3].x}`, false);
    v.forEach((p, i) => line(`M${p.x} ${busV} V${p.top}`, lit(`v${i + 1}`)));
    w.forEach((p, i) => line(`M${p.x} ${busW} V${p.top}`, lit(`w${i + 1}`)));
    wires.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    wires.innerHTML = paths.join('');
  }

  new ResizeObserver(() => requestAnimationFrame(layout)).observe(tree);

  /* ----------------------------- full size ----------------------------- */

  function renderFullBar() {
    const key = open === shown ? 'leader' : open.split('--').pop();
    const item = nodes.get(key);
    fullLabel.textContent = key === 'leader' ? 'Leader' : item.box.querySelector('.team-role').textContent;
    fullState.textContent = [item.stateEl.textContent, item.subEl.textContent].filter(Boolean).join(' · ');
  }

  function expand(key) {
    const id = sessionOf(key);
    const entry = terms.get(id);
    if (!entry) {
      ctx.flash?.(key === 'leader' ? 'The Leader starts with your first message.' : `${key[0] === 'w' ? 'Worker' : 'Verifier'} ${key[1]} hasn’t started: the Leader starts it when there’s work for it.`);
      return;
    }
    open = id;
    tree.hidden = true;
    full.hidden = false;
    entry.wrap.style.transform = '';
    entry.wrap.classList.add('is-full');
    entry.sized = 'full';
    fullHost.replaceChildren(entry.wrap);
    entry.term.options.fontSize = store.state.settings.terminalFontSize || 12;
    entry.term.options.disableStdin = false;
    renderFullBar();
    requestAnimationFrame(() => {
      fitFull();
      entry.term.focus();
    });
  }

  function fitFull() {
    const entry = open && terms.get(open);
    if (!entry || full.hidden) return;
    try {
      entry.fit.fit();
    } catch {
      /* not laid out yet */
    }
    api.task.resize(open, entry.term.cols, entry.term.rows);
  }

  new ResizeObserver(() => fitFull()).observe(fullHost);

  function collapse() {
    if (!open) return;
    const entry = terms.get(open);
    const id = open;
    open = null;
    full.hidden = true;
    tree.hidden = false;
    if (entry) {
      entry.wrap.classList.remove('is-full');
      entry.term.options.fontSize = MINI_FONT;
      entry.term.resize(MINI.cols, MINI.rows);
      entry.sized = '';
    }
    render();
  }

  /* -------------------------------- api -------------------------------- */

  team.on((taskId) => taskId === shown && render());
  tasks.on(({ id, type }) => {
    if (!shown) return;
    if (id === shown || id.startsWith(`${shown}--`)) {
      if (type === 'exit') terms.get(id)?.term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      render();
    }
  });

  return {
    /** Show a task's team (null hides it). */
    show(id) {
      if (shown !== id && open) collapse();
      shown = id;
      node.hidden = !id;
      if (!id) return;
      render();
    },
    hidden: () => node.hidden,
    /** The session shown full size, if any (keys go to it). */
    open: () => open,
    collapse,
    retheme() {
      const next = theme();
      for (const entry of terms.values()) entry.term.options.theme = next;
    },
    /** For look tests: print into a member's mini terminal. */
    feed(id, data) {
      const entry = ensure(id);
      entry.ready = true;
      entry.term.write(data);
    },
    layout: () => requestAnimationFrame(layout),
  };
}
