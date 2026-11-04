import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { el, icons } from './util.js';
import { modelName } from './store.js';
import { initTeamView } from './teamview.js';
import { inputBoxRows } from './promptmenu.js';

/**
 * The >_ view: the open task's real terminal — Claude Code, Codex or the
 * shell itself, as it runs (main tasks.js). One shows at a time. Its
 * terminal is made the first time you look and kept (hidden) after, so
 * switching back is instant; what it printed before you looked is replayed
 * first. You can type straight into it: answer Claude's questions, use its
 * slash commands, anything. A task whose session isn't running offers to
 * resume it. A task in hierarchy mode shows its team instead (teamview.js).
 *
 * What it prints stands on the scene, with the same prompt bar as the chat under
 * it: the session's own input box isn't shown, and an empty bar's arrows, Enter,
 * Tab and Esc go to the session for its menus. Above the bar, a line saying where
 * the session stands, who runs it and where, with Stop, Resume and the text size.
 */

export const FONT = '"Geist Mono", ui-monospace, Consolas, monospace';

// Ordinary terminal colours, so everything a CLI prints reads as it would in
// any terminal; the background and text follow the theme.
const ANSI = {
  black: '#4a4a4a',
  red: '#e5534b',
  green: '#4eba65',
  yellow: '#d7ba5f',
  blue: '#5c9cf5',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f47067',
  brightGreen: '#6bd486',
  brightYellow: '#e5c97a',
  brightBlue: '#7cb4ff',
  brightMagenta: '#d89ae8',
  brightCyan: '#7fd0da',
  brightWhite: '#ffffff',
};

export function theme() {
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  const light = document.body.dataset.theme === 'light';
  return {
    ...ANSI,
    background: v('--panel-c') || '#141414',
    foreground: v('--text') || '#ebebeb',
    cursor: v('--text') || '#ebebeb',
    cursorAccent: v('--panel-c') || '#141414',
    ...(light ? { black: '#3b3b39', white: '#5d5d59', brightWhite: '#1b1b1a', yellow: '#8a6a0c', green: '#2f7a3d', cyan: '#1f6a70', blue: '#2a5fa5', red: '#b4473c', magenta: '#875a94' } : {}),
    selectionBackground: light ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.2)',
  };
}

export function initTerminal(ctx) {
  const root = document.querySelector('#terminal');
  const { store, api, tasks } = ctx;
  const stage = el('div', { class: 'term-stage' });
  // The header: where it stands, who runs it and where, and what you can do.
  const dot = el('span', { class: 'status-dot', 'aria-hidden': 'true' });
  const stateText = el('span', { class: 'term-state' });
  const who = el('span', { class: 'term-who' });
  const where = el('span', { class: 'term-where' });
  const noteText = el('span', { class: 'term-note-text' });
  const stop = el('button', { class: 'key-btn is-quiet', type: 'button', title: 'Stop (Esc in the session)', onclick: () => stopShown() }, 'Stop');
  const resume = el('button', { class: 'key-btn', type: 'button', text: 'Resume', onclick: () => resumeShown() });
  const sizeButton = (label, step, title) => el('button', { class: 'term-size', type: 'button', title, 'aria-label': title, text: label, onclick: () => resize(step) });
  const sizes = el('span', { class: 'term-sizes' }, sizeButton('A−', -1, 'Smaller text'), sizeButton('A+', 1, 'Larger text'));
  const head = el(
    'header',
    { class: 'term-head' },
    el('span', { class: 'term-status' }, dot, stateText),
    el('span', { class: 'term-id' }, who, where),
    el('span', { class: 'term-tools' }, noteText, stop, resume, sizes)
  );
  const empty = el('div', { class: 'term-empty', hidden: true }, el('span', { class: 'term-empty-mark', html: icons.prompt }), el('p', { text: 'Open a task to see its terminal.' }), el('p', { class: 'term-empty-hint', text: 'Ctrl+` switches between a task and its terminal.' }));
  // The prompt bar: words go to the session as a message; with none, keys go to whatever it's showing.
  const box = el('textarea', { class: 'term-input', rows: 1, spellcheck: 'false', 'aria-label': 'Message or command' });
  const mic = el('button', { class: 'mic-btn dictate-btn', type: 'button', title: 'Dictate (Ctrl+Shift+M)', 'aria-label': 'Dictate', 'aria-pressed': 'false', html: icons.mic, onpointerdown: (event) => event.preventDefault(), onclick: () => ctx.dictate() });
  const bar = el('form', { class: 'composer term-composer' }, box, mic);
  bar.addEventListener('submit', (event) => {
    event.preventDefault();
    sendBar();
  });
  const PASS_KEYS = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C', Tab: '\t', Escape: '\x1b', Enter: '\r' };
  box.addEventListener('keydown', (event) => {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'Enter' && !event.shiftKey && box.value.trim()) {
      event.preventDefault();
      sendBar();
      return;
    }
    if (box.value || event.shiftKey || !shown) return;
    const running = tasks.get(shown).running;
    const waiting = running && tasks.get(shown).state === 'needs';
    const keys = PASS_KEYS[event.key] || (waiting && /^[1-9]$/.test(event.key) ? event.key : '');
    if (!keys || !running) return;
    event.preventDefault();
    event.stopPropagation();
    api.task.write(shown, keys);
  });
  async function sendBar() {
    const text = box.value.trim();
    const task = store.task(shown);
    if (!text || !task) return;
    box.value = '';
    const entry = terms.get(task.id);
    // A stopped session's words give way to the session itself.
    if (entry?.history) {
      entry.term.reset();
      entry.history = false;
    }
    const reply = await ctx.sendToTask(task.id, text);
    if (reply?.error) noteText.textContent = reply.error;
    renderNote();
  }
  const frame = el('div', { class: 'term-frame' }, stage, head, bar);
  root.replaceChildren(frame, empty);
  // Hierarchy mode: the team as a tree of live mini terminals, in place of the one terminal.
  const teamView = initTeamView(ctx, frame);

  const terms = new Map(); // task id -> { host, term, fit, ready, early }
  const watched = new Set(); // tasks whose output comes to this window: a terminal (or its team) open on it
  let shown = null;
  let fontReady = null;

  /* ------------------------------ terminals ---------------------------- */

  async function ensure(id) {
    if (terms.has(id)) return terms.get(id);
    fontReady = fontReady || document.fonts.load(`12px ${FONT}`).catch(() => {});
    const host = el('div', { class: 'term-host', hidden: true });
    stage.append(host);
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: store.state.settings.terminalFontSize || 12,
      lineHeight: 1.32,
      allowTransparency: true,
      cursorBlink: false,
      scrollback: 8000,
      theme: theme(),
      // Dim and grey text stays readable on the dark background.
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Output that arrives while the replay is being fetched waits its turn.
    const entry = { host, term, fit, ready: false, early: [] };
    terms.set(id, entry);
    await fontReady;
    term.open(host);
    term.onData((data) => api.task.write(id, data));
    // Claude's or Codex's own input box stays out of sight (the bar below is the one to use), and typing goes to the bar.
    if (store.task(id)?.kind !== 'shell') {
      const hide = el('style');
      host.append(hide);
      const hideBox = () => {
        const buffer = term.buffer.active;
        const rows = Array.from({ length: term.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
        const span = inputBoxRows(rows);
        const rule = span ? `.xterm-rows > div:nth-child(n + ${span[0] + 1}):nth-child(-n + ${span[1] + 1}) { visibility: hidden; }` : '';
        if (hide.textContent !== rule) hide.textContent = rule;
      };
      term.onRender(hideBox);
      term.onScroll(hideBox);
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) box.focus();
        return event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey;
      });
    }
    // Its output comes to this window from now on (only tasks with a terminal open: watched); what it printed before, replayed.
    watched.add(id);
    const tail = await api.task.watch(id);
    if (tail) term.write(tail);
    for (const chunk of entry.early) term.write(chunk);
    entry.early = [];
    entry.ready = true;
    return entry;
  }

  api.task.onData(({ id, data }) => {
    const entry = terms.get(id);
    if (!entry) return;
    if (entry.ready) entry.term.write(data);
    else entry.early.push(data);
  });

  function fitShown() {
    const entry = shown && terms.get(shown);
    if (!entry || entry.host.hidden || root.hidden || frame.hidden || stage.hidden) return;
    try {
      entry.fit.fit();
    } catch {
      /* not laid out yet */
    }
    if (tasks.get(shown).running) api.task.resize(shown, entry.term.cols, entry.term.rows);
  }

  new ResizeObserver(() => fitShown()).observe(stage);

  const AGENT = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' };
  const since = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  let clock = 0;

  /** The header: its state (kept ticking while it works), who runs it and where, and its buttons. */
  function renderNote() {
    const task = store.task(shown);
    empty.hidden = Boolean(task);
    frame.hidden = !task;
    clearTimeout(clock);
    if (!task) return;
    const t = tasks.get(task.id);
    const running = Boolean(t.running);
    const state = !running ? 'off' : t.state;
    dot.className = `status-dot${state === 'working' ? ' is-working' : state === 'needs' ? ' is-needs' : state === 'off' ? ' is-off' : ''}`;
    stateText.textContent = state === 'working' ? `Working · ${since(Date.now() - t.since)}` : state === 'needs' ? 'Waiting for you' : running ? 'Idle' : task.started ? 'Not running' : 'Not started';
    head.dataset.state = state;
    const model = task.kind === 'shell' ? '' : modelName(task.model) || task.model || '';
    who.textContent = [AGENT[task.kind] || 'Task', model].filter(Boolean).join(' · ');
    const folder = String(task.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    where.textContent = [folder, task.worktree && !task.merged ? task.worktree.branch : ''].filter(Boolean).join(' · ');
    where.title = task.cwd || '';
    // Not running: what Resume does; working: Stop.
    noteText.textContent = running ? '' : task.started ? 'Resume to pick up where it left off' : '';
    noteText.hidden = running || !task.started;
    resume.hidden = running;
    resume.textContent = task.started ? 'Resume' : 'Start';
    stop.hidden = !running || state !== 'working';
    const shell = task.kind === 'shell';
    box.placeholder = shell ? 'Run a command…' : running ? `Message ${AGENT[task.kind] || 'the session'}, or a / command…` : task.started ? 'Write to resume…' : 'Write to start…';
    if (state === 'working') clock = setTimeout(renderNote, 1000);
  }

  function stopShown() {
    const task = store.task(shown);
    if (!task) return;
    tasks.stop(task);
    box.focus();
  }

  /** The text size, one step at a time (Settings → Terminal keeps it). */
  function resize(step) {
    const now = store.state.settings.terminalFontSize || 12;
    const next = Math.min(24, Math.max(8, now + step));
    if (next !== now) store.setSetting('terminalFontSize', next);
  }

  /** What a stopped session said, printed as plain terminal text. */
  function printHistory(entry, id) {
    const crlf = (text) => String(text).replace(/\r?\n/g, '\r\n');
    const lines = [];
    for (const item of tasks.get(id).transcript.entries) {
      if (item.kind === 'prompt') lines.push(`\x1b[1m> ${crlf(item.text)}\x1b[0m`, '');
      else if (item.kind === 'text') lines.push(`\x1b[37m●\x1b[0m ${crlf(item.text)}`, '');
      else if (item.kind === 'interrupt') lines.push('\x1b[31m  ⎿  Interrupted\x1b[0m', '');
      else if (item.kind === 'tool') {
        const input = item.input || {};
        const args = String(input.command || input.file_path || input.pattern || input.url || input.description || '').replace(/\s+/g, ' ').slice(0, 160);
        lines.push(`\x1b[32m●\x1b[0m \x1b[1m${item.name}\x1b[0m(${args})`);
        const out = String(item.result?.text || '').replace(/\s+$/, '').split('\n');
        if (item.result) {
          lines.push(`  ⎿  ${out.slice(0, 3).join('\r\n     ')}`);
          if (out.length > 3) lines.push(`     … +${out.length - 3} lines`);
        }
        lines.push('');
      }
    }
    entry.term.reset();
    // (No cursor under what it said: nothing is typed here until it runs again.)
    entry.term.write(`${lines.length ? lines.join('\r\n') : '\x1b[2mNothing yet.\x1b[0m'}\x1b[?25l`);
    entry.history = true;
  }

  async function resumeShown() {
    const task = store.task(shown);
    if (!task) return;
    const entry = await ensure(task.id);
    entry.host.hidden = false;
    try {
      entry.fit.fit();
    } catch {
      /* laid out next frame */
    }
    // The session prints itself again when it resumes.
    if (entry.history) {
      entry.term.reset();
      entry.history = false;
    }
    const reply = await tasks.start(task, '', { cols: entry.term.cols, rows: entry.term.rows });
    if (reply?.error) noteText.textContent = reply.error;
    renderNote();
    (task.kind === 'shell' ? entry.term : box).focus();
  }

  tasks.on(({ id, type }) => {
    if (id === shown && (type === 'change' || type === 'exit')) renderNote();
    if (type === 'exit') terms.get(id)?.term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
  });

  /* -------------------------------- api -------------------------------- */

  /** Show a task's terminal (null: none); a hierarchy task's team. */
  async function show(id) {
    shown = store.task(id) ? id : null;
    const hierarchy = store.task(shown)?.mode === 'hierarchy';
    stage.hidden = hierarchy;
    bar.hidden = hierarchy;
    teamView.show(hierarchy && !root.hidden ? shown : null);
    // The team's mini terminals (teamview.js) draw its sessions' output: watched from now on (its members' with it).
    if (hierarchy && !root.hidden && !watched.has(shown)) {
      watched.add(shown);
      api.task.watch(shown);
    }
    for (const [key, entry] of terms) entry.host.hidden = key !== shown;
    renderNote();
    if (!shown || root.hidden || hierarchy) return;
    const running = tasks.get(shown).running;
    const fresh = !terms.has(shown);
    const entry = await ensure(shown);
    if (shown !== id) return;
    // Not running: show what it said before, as text, instead of an empty screen.
    if (!running && (fresh || entry.history)) printHistory(entry, shown);
    entry.host.hidden = false;
    requestAnimationFrame(() => {
      fitShown();
      if (store.task(shown)?.kind === 'shell') entry.term.focus();
      else box.focus();
    });
  }

  /** A task that went away takes its terminal with it. */
  function drop(id) {
    if (watched.delete(id)) api.task.unwatch(id);
    const entry = terms.get(id);
    if (!entry) return;
    entry.term.dispose();
    entry.host.remove();
    terms.delete(id);
  }

  // What the last off-screen look found: the same output reads the same.
  let read = { id: '', output: '', lines: [] };

  /**
   * A task's screen as text, its last `lines` (Katana reads it): its own
   * terminal when it has one, otherwise its output replayed off screen.
   */
  async function screen(id, lines = 60) {
    const entry = terms.get(id);
    let term = entry && entry.ready && !entry.history ? entry.term : null;
    let scratch = null;
    if (!term) {
      // (At its real size: what it drew only reads right there.)
      const output = await api.task.tail(id);
      if (read.id === id && read.output === output) return read.lines.slice(-Math.max(1, lines)).join('\n');
      const size = (await api.task.size?.(id).catch(() => null)) || terms.get(shown)?.term;
      scratch = new Terminal({ cols: size?.cols || 120, rows: size?.rows || 34, scrollback: 2000, allowProposedApi: false });
      await new Promise((resolve) => scratch.write(output || '', resolve));
      term = scratch;
      read = { id, output, lines: [] };
    }
    const buffer = term.buffer.active;
    const out = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      // A line the terminal wrapped is still one line of text.
      if (line?.isWrapped && out.length) out[out.length - 1] += line.translateToString(true);
      else out.push(line?.translateToString(true) ?? '');
    }
    scratch?.dispose();
    while (out.length && !out.at(-1).trim()) out.pop();
    if (scratch) read.lines = out;
    return out.slice(-Math.max(1, lines)).join('\n');
  }

  function retheme() {
    const next = theme();
    for (const entry of terms.values()) entry.term.options.theme = next;
    teamView.retheme();
  }

  store.on('change', () => {
    const size = store.state.settings.terminalFontSize || 12;
    for (const entry of terms.values()) {
      if (entry.term.options.fontSize !== size) entry.term.options.fontSize = size;
    }
    fitShown();
    // (Its model or folder may have changed.)
    if (shown && !root.hidden) renderNote();
  });

  return { show, drop, retheme, screen, team: teamView, shown: () => shown, size: () => terms.get(shown)?.term };
}
