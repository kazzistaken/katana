import { el, icons, placeNear, tokens, popIn, leave, motionOn, keepInStep, SPRING, EASE_OUT } from './util.js';
import { commandsFor, namingCommand, matchCommands, readCommand, opensTerminal } from './slashcommands.js';
import { MODELS, CODEX_MODELS, EFFORTS, modelName as nameOfModel } from './store.js';
import { browserGame, exchanges, liveSubagents, splitImages, writtenFiles, SUBAGENTS_LEAD } from './transcript.js';
import { dither, paintScene } from './dither.js';
import { inline, blocks } from './md.js';
import { createAppPane } from './appview.js';
import { askToFix } from './apperrors.js';
import { confirmDialog } from './dialog.js';

/**
 * The main pane. It shows one of three things:
 *   a task       its latest exchange, read from the session's transcript:
 *                what you asked, a status line, Claude's answer's first
 *                sentence big, Done (and Merge for a worktree), the files it
 *                wrote (chips; pictures, video and sound play inline), then
 *                the rest of the answer. Older exchanges come back when you
 *                scroll up past the top. While it works: Working (time,
 *                tokens), Thinking, what the current call is for, Stop.
 *   the agent    Katana's own conversation, the same way, with the tasks
 *                waiting for you (the review queue), reminders and checks on top.
 *   New task     where it runs (Claude Code, Codex or a shell; which folder;
 *                its own worktree or not), then the first message.
 * A page a reply names opens in the viewer in place of the exchange, the
 * prompt bar still under it; when the file changes, the viewer reloads.
 * Markdown and text are laid out as a document (a bar with the path, Show
 * in Explorer and ×, then the words), the rest shows as itself in a frame.
 */

const HIGH = 0.8; // the bars turn rose from here: memory is nearly full

const KIND = [
  ['image', /\.(png|jpe?g|gif|webp|avif|svg)$/i],
  ['video', /\.(mp4|webm|mov|m4v)$/i],
  ['audio', /\.(mp3|wav|ogg|m4a|flac)$/i],
];
// How each agent is named in what the view says.
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', shell: 'a shell' };
const kindOf = (name) => KIND.find(([, re]) => re.test(name))?.[0] || 'page';
export const isDoc = (file) => /\.(md|markdown|txt)$/i.test(String(file || ''));
// A web page: shown in the app viewer, like an app (the one browser view).
const isPage = (file) => /\.html?$/i.test(String(file || ''));
const samePath = (a, b) => String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase();

/** A long path cut in the middle, keeping where it starts and its file name. */
export function fitPath(path, chars) {
  const value = String(path || '');
  if (value.length <= chars) return value;
  const keep = Math.max(8, chars - 1);
  const tail = Math.min(value.length, Math.max(Math.ceil(keep * 0.55), Math.min(value.split(/[\/]/).pop().length + 2, keep - 6)));
  return `${value.slice(0, keep - tail)}…${value.slice(-tail)}`;
}

const clipWords = (text, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// File names and paths a reply mentions (main checks which exist).
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.(?:html?|svg|png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|flac|pdf|md)\b/gi;
const pathsIn = (text) => [...new Set(String(text || '').match(PATH_RE) || [])];

/** A local path as a file:// URL (the drive letter kept as it is). */
export function fileUrl(path) {
  const parts = String(path).replace(/\\/g, '/').split('/');
  const encoded = parts.map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

function ago(at) {
  const seconds = Math.max(0, (Date.now() - (at || Date.now())) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

const duration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** An answer as a headline (its first sentence) and the text after it (Markdown). */
export function splitAnswer(text) {
  const value = String(text || '').trim();
  if (!value) return { head: '', rest: '' };
  const lines = value.split('\n');
  // An answer that opens with code or a list has no sentence to lead with.
  if (/^\s*(```|[-*•]\s|\d+[.)]\s)/.test(lines[0])) return { head: '', rest: value };
  let head = lines[0].replace(/^#+\s*/, '').trim();
  let more = '';
  const sentence = head.match(/^(.{12,}?[.!?])\s+(.+)$/);
  if (sentence) {
    head = sentence[1];
    more = sentence[2];
  }
  return { head, rest: [more, ...lines.slice(1)].join('\n').trim() };
}

export function initChatView(ctx) {
  const root = document.querySelector('#chat');
  const { store, api, tasks, agent } = ctx;

  /* ------------------------------ parts ------------------------------- */

  const column = el('div', { class: 'column' });
  const stage = el('div', { class: 'stage', role: 'log', 'aria-live': 'polite' }, column);
  const frame = el('iframe', { sandbox: 'allow-scripts', title: 'File' });
  // A document: its path, Show in Explorer, Copy, Download, ×; then its words.
  const docPath = el('span', { class: 'doc-path' });
  const docButton = (icon, label, run) => el('button', { class: 'doc-action', type: 'button', onclick: run }, el('span', { class: 'doc-action-icon', html: icons[icon], 'aria-hidden': 'true' }), el('span', { class: 'doc-action-label', text: label }));
  // Copy says "Copied" with a tick for a moment.
  const docCopy = docButton('copy', 'Copy', async () => {
    if (!(await api.file.copy(docFile).catch(() => false))) return flash('That file can’t be copied.');
    docCopy.firstChild.innerHTML = icons.check;
    docCopy.lastChild.textContent = 'Copied';
    clearTimeout(docCopy._reset);
    docCopy._reset = setTimeout(() => {
      docCopy.firstChild.innerHTML = icons.copy;
      docCopy.lastChild.textContent = 'Copy';
    }, 1500);
  });
  const docDownload = docButton('download', 'Download', () => api.file.save(docFile));
  const docBody = el('article', { class: 'doc-body' });
  const docScroll = el('div', { class: 'doc-scroll' }, docBody);
  const doc = el(
    'div',
    { class: 'doc', hidden: true },
    el(
      'header',
      { class: 'doc-bar' },
      el('span', { class: 'doc-icon', html: icons.doc, 'aria-hidden': 'true' }),
      docPath,
      el('button', { class: 'doc-reveal', type: 'button', text: 'Show in Explorer', onclick: () => api.file.reveal(docFile) }),
      docCopy,
      docDownload,
      el('button', { class: 'doc-close', type: 'button', title: 'Close', 'aria-label': 'Close', html: icons.x, onclick: () => setMode('chat') })
    ),
    docScroll
  );
  let docFile = '';
  // Your app, running live (appview.js): × stops it and closes the pane.
  // Your app or a web page, filling the main area (appview.js). Back: the task again.
  const appPane = createAppPane({ api, onBack: () => leaveApp(), onChange: (id) => id === view.id && ctx.onMode?.(mode) });
  const viewer = el('div', { class: 'viewer', hidden: true }, frame, doc, appPane.element);
  const banner = el('p', { class: 'chat-banner', role: 'status', hidden: true });
  const input = el('textarea', { class: 'composer-input', rows: '1', placeholder: 'Write to Claude…', 'aria-label': 'Write to Claude' });
  const modelText = el('button', { type: 'button', 'aria-haspopup': 'menu' });
  const effortText = el('button', { type: 'button', 'aria-haspopup': 'dialog' });
  // How the task runs: one Claude session, a team (a Leader with workers and verifiers), or one session delegating to sub-agents.
  const MODES = [
    { id: 'single', label: 'Single agent', desc: 'One Claude Code session does the work' },
    { id: 'subagents', label: 'Sub-agents', desc: 'Opus leads; it picks Haiku, Sonnet or Opus sub-agents' },
    { id: 'hierarchy', label: 'Hierarchy', desc: 'A Leader splits it across workers, verifiers check it' },
  ];
  const modeText = el('button', { class: 'mode-pick', type: 'button', 'aria-haspopup': 'menu' });
  const modeDot = el('span', { class: 'meta-dot', text: '·', 'aria-hidden': 'true' });
  const meta = el('div', { class: 'foot-meta' }, modeText, modeDot, modelText, el('span', { class: 'meta-dot', text: '·', 'aria-hidden': 'true' }), effortText);
  // Dictation: click to start, click again to stop; the words stay in the box for you to send.
  const dictate = el('button', {
    class: 'mic-btn dictate-btn',
    type: 'button',
    title: 'Dictate (Ctrl+Shift+M)',
    'aria-label': 'Dictate',
    'aria-pressed': 'false',
    html: icons.mic,
    onpointerdown: (event) => event.preventDefault(),
    onclick: () => ctx.dictate(),
  });
  // Pictures pasted or dropped in, waiting to go with the message: click one to take it out.
  const tray = el('div', { class: 'composer-images', hidden: true });
  const composer = el('form', { class: 'composer' }, tray, el('span', { class: 'composer-caret', text: '›', 'aria-hidden': 'true' }), input, dictate);
  // What rides on the prompt bar's top edge, wherever the bar is: a notice on the left, how the task runs on the right.
  const overBar = el('div', { class: 'foot-over' }, banner, meta);
  const foot = el('div', { class: 'foot' }, overBar, composer);
  root.replaceChildren(stage, viewer, foot);

  // What is shown: { type: 'task', id } | { type: 'agent' } | { type: 'new' }.
  let view = { type: 'new' };
  let mode = 'chat';
  let list = [];
  let shownFrom = null;
  let pop = null;
  let ticker = 0;
  let blocked = '';
  let renderQueued = 0;
  // The new task being set up: agent kind and worktree.
  const draft = { kind: 'claude', worktree: null };
  // What you sent that the transcript hasn't shown yet, per task.
  const pending = new Map();
  // How many exchanges each view had: one more means a new request, shown alone.
  const counts = new Map();
  const fileCache = new Map();
  // Exchanges already drawn (all but the live one), by their first entry, to be kept while nothing in them changes.
  let built = new Map();
  // The transcript read into exchanges, redone only when it grew.
  let parsed = { entries: null, length: -1, list: [] };

  const task = () => (view.type === 'task' ? store.task(view.id) : null);

  /* ------------------------------ pieces ------------------------------ */

  /** What you wrote: its pictures as they are (no bubble), then its words. */
  function userBubble(raw, pictures) {
    const { text, images } = pictures ? { text: raw, images: pictures } : splitImages(raw);
    const shots = images.length ? el('div', { class: 'ex-user-images' }, images.map((src) => el('img', { class: 'ex-user-image', src: /^data:/.test(src) ? src : fileUrl(src), alt: '', draggable: 'false' }))) : null;
    if (!text) return shots || el('div', { class: 'ex-user' });
    const body = el('span', { class: 'ex-user-text', text });
    const node = el('div', { class: 'ex-user' }, body);
    if (shots) return el('div', { class: 'ex-user-group' }, shots, node);
    requestAnimationFrame(() => {
      if (body.scrollHeight > body.clientHeight + 1) {
        node.classList.add('is-long');
        node.title = 'Show all';
        node.addEventListener('click', () => node.classList.toggle('is-open'));
      }
    });
    return node;
  }

  const status = (text, kind = '') =>
    el('div', { class: 'ex-status' }, el('span', { class: `status-dot${kind ? ` is-${kind}` : ''}`, 'aria-hidden': 'true' }), el('span', { class: 'ex-status-text', text }));

  const keyButton = (label, key, title, run, extra = '') =>
    el('button', { class: `key-btn${extra}`, type: 'button', title, onclick: run }, label, key ? el('kbd', { text: key }) : null);

  /** Working: status, headline, what it is doing, Stop. Kept live by tick(). */
  /** Three dots that pulse in turn beside "Thinking"; still when motion is reduced or off. */
  function thinkingDots() {
    return el('span', { class: 'thinking-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));
  }

  function workBlock({ head, sub, since, tokensNow, usageNow, onStop, needs, waiting = 'Needs you', dots = false, subagents = null }) {
    const statusText = el('span', { class: 'ex-status-text' });
    const headline = el('h2', { class: 'ex-head', 'data-slide': 'head' }, head, dots ? thinkingDots() : null);
    const node = el(
      'div',
      { class: `ex-work${subagents ? ' has-subagents' : ''}` },
      // With sub-agents at work one block says it all: the headline with its time and use beside it, their rows under it, Stop. (Their rows have the spinners.)
      subagents
        ? el('div', { class: 'ex-work-title' }, headline, statusText)
        : [el('div', { class: 'ex-status' }, el('span', { class: `status-dot ${needs ? 'is-needs' : 'is-working'}`, 'aria-hidden': 'true' }), statusText), headline],
      sub ? el('p', { class: 'ex-sub', text: sub }) : null,
      subagents,
      el(
        'div',
        { class: 'ex-actions', 'data-slide': 'actions' },
        needs ? keyButton('Open terminal', 'Ctrl+`', 'Answer it in the terminal (Ctrl+`)', () => ctx.showTerminal()) : null,
        // On press, not click: the view redraws as the task works, and a
        // redraw between press and release would swallow the click.
        el(
          'button',
          {
            class: 'key-btn',
            type: 'button',
            title: 'Stop (Ctrl+.)',
            onpointerdown: (event) => event.button === 0 && onStop(),
            onclick: (event) => event.detail === 0 && onStop(), // Enter or Space
          },
          'Stop',
          el('kbd', { text: 'Ctrl+.' })
        )
      )
    );
    const tick = () => {
      const parts = [...(subagents ? [] : [needs ? waiting : 'Working']), duration(Date.now() - since)];
      const n = tokensNow();
      if (n) parts.push(`↓ ${tokens(n)} tokens`);
      const usage = usageNow?.();
      if (usage?.share) parts.push(usage.text);
      statusText.textContent = parts.join(' · ');
    };
    node._tick = tick;
    tick();
    return node;
  }

  async function fillFiles(key, candidates, base, filesEl, mediaEl) {
    if (!candidates.length) return;
    let found = fileCache.get(key);
    if (!found) {
      found = (await api.file.stat(candidates, base).catch(() => [])) || [];
      fileCache.set(key, found);
    }
    for (const file of found) {
      const kind = kindOf(file.name);
      // A page of an Electron or Node app can't be opened by itself: no chip for it.
      if (file.app) continue;
      if (kind === 'page') {
        // Its name opens it (again: closes it); the arrow saves a copy.
        filesEl.append(
          el(
            'span',
            { class: `file-chip${mode === 'file' && task()?.viewFile === file.path ? ' is-open' : ''}`, 'data-file': file.path },
            el('button', { class: 'file-chip-open', type: 'button', title: file.path, text: file.name, onclick: () => toggleFile(file.path) }),
            el('button', { class: 'file-chip-save', type: 'button', title: `Download (${size(file.size)})`, 'aria-label': `Download ${file.name}`, html: icons.download, onclick: () => api.file.save(file.path) })
          )
        );
        continue;
      }
      const src = fileUrl(file.path);
      mediaEl.append(
        kind === 'image' ? el('img', { class: 'media', src, alt: file.name }) : el(kind, { class: 'media', src, controls: true, preload: 'metadata' }),
        el('div', { class: 'media-caption' }, el('span', { text: file.name }), el('button', { type: 'button', text: 'Show in folder', onclick: () => api.file.reveal(file.path) }))
      );
    }
  }

  /** A finished answer: status, headline, buttons, files, the rest. */
  function answerBlock({ state, at, text, error, buttons, files, base, key }) {
    const { head, rest } = error ? { head: text, rest: '' } : splitAnswer(text);
    const filesEl = el('div', { class: 'ex-files' });
    const mediaEl = el('div', { class: 'ex-media' });
    const nodes = [
      // (macOS: no status line once it's finished; the headline takes its place, the time in its tooltip.)
      document.body.dataset.style === 'macos' ? null : status(`${state} · ${ago(at)}`, error ? 'failed' : ''),
      el('h2', { class: `ex-head${error ? ' is-error' : ''}`, title: `${state} · ${ago(at)}` }, inline(head || (state === 'Stopped' ? 'Stopped.' : 'Done.'))),
      filesEl,
      mediaEl,
      rest ? el('div', { class: 'ex-body' }, blocks(rest)) : null,
      // Done (Merge, Discard) at the very end, under everything it said.
      buttons?.length ? el('div', { class: 'ex-actions' }, buttons) : null,
    ];
    fillFiles(key, [...(files || []), ...pathsIn(text)], base, filesEl, mediaEl);
    return nodes.filter(Boolean);
  }

  /* ------------------------------ tasks ------------------------------- */

  function taskButtons(current) {
    const buttons = [];
    if (!current.doneAt) buttons.push(keyButton('Done', 'Ctrl+D', 'Done with this task (Ctrl+D)', () => ctx.finishTask(current.id), ' is-done-key'));
    if (current.worktree && !current.merged) {
      buttons.push(keyButton('Merge', '', `Merge ${current.worktree.branch} into ${current.worktree.base}`, () => ctx.merge(current.id), ' is-quiet'));
      buttons.push(keyButton('Discard', '', 'Remove the worktree without merging', () => ctx.discard(current.id), ' is-quiet'));
    }
    return buttons;
  }

  /**
   * Hierarchy mode: what the team did during an exchange, as compact lines
   * (from its log, by time), and the daemon's [team] notes to the leader.
   */
  const TEAM_NOTE = /^\[team\] /;
  // History is still; only the live line (who works now) shines.
  const TEAM_DOTS = { live: 'is-working', start: '', back: '', fail: 'is-failed', needs: 'is-needs', pass: 'is-pass', merge: 'is-pass', done: 'is-done', note: '' };
  const teamRow = (who, text, kind) => el('div', { class: `ex-team-row is-${kind || 'note'}` }, el('span', { class: `status-dot ${TEAM_DOTS[kind] || ''}`, 'aria-hidden': 'true' }), el('b', { text: who }), el('span', { class: 'ex-team-text', text }));

  function teamLines(current, ex, next) {
    const view = ctx.team?.get(current.id);
    if (current.mode !== 'hierarchy' && !view) return [];
    const from = list.indexOf(ex) <= 0 ? -Infinity : ex.at || 0;
    const to = next?.at || Infinity;
    const label = (key) => `${key[0] === 'w' ? 'Worker' : 'Verifier'} ${key[1]}`;
    const rows = (view?.log || []).filter((entry) => entry.at >= from && entry.at < to).map((entry) => teamRow(label(entry.key), entry.text, entry.kind));
    if (ex.prompts.some((p) => TEAM_NOTE.test(p.text))) rows.unshift(teamRow('Team', 'news for the Leader', 'note'));
    return rows.length ? [el('div', { class: 'ex-team' }, rows)] : [];
  }

  /** The sub-agents an exchange called that still work (Sub-agents mode, or any task that used them): who, on which model, for what. Each row goes when its sub-agent is done. */
  const liveCalls = (ex, last, t) => liveSubagents(ex, { turnLive: last && (t.state === 'working' || t.state === 'needs'), sessionOpen: t.running, since: t.startedAt });
  const modelName = (id) => MODELS.find((m) => String(id).startsWith(m.id))?.name || String(id).replace(/\[1m\]$/i, '').replace(/^\w/, (c) => c.toUpperCase());
  function subagentRows(calls) {
    if (!calls.length) return null;
    const rows = calls.map((c) => {
      const who = [c.agent, c.model && modelName(c.model)].filter(Boolean).join(' · ');
      const what = `${c.what || 'a piece of the work'}${c.state === 'background' ? ' (in the background)' : ''}`;
      const row = teamRow(who, what, 'live');
      // (Cut short on its line: the whole of it in the tooltip. Two rows with the same words slide as one.)
      row.title = `${who}: ${what}`;
      row.dataset.slide = `row:${who}:${what}`;
      return row;
    });
    return el('div', { class: 'ex-team ex-subagents', 'aria-label': 'Sub-agents' }, rows);
  }

  /** Where the parts of the working block are, from its top. */
  function workParts() {
    const block = column.querySelector('.ex-work');
    if (!block) return null;
    const top = block.getBoundingClientRect().top;
    return { block, tops: new Map([...block.querySelectorAll('[data-slide]')].map((part) => [part.dataset.slide, part.getBoundingClientRect().top - top])) };
  }

  /** A sub-agent done: its row goes, and what was under it slides up to close the gap instead of snapping there. (Only around sub-agents: the plain working view stays as it is.) */
  function slideWorkParts(was, sameTurn) {
    const now = workParts();
    if (!was || !now || !sameTurn || !motionOn()) return;
    if (!was.block.classList.contains('has-subagents') && !now.block.classList.contains('has-subagents')) return;
    for (const part of now.block.querySelectorAll('[data-slide]')) {
      const from = was.tops.get(part.dataset.slide);
      const by = from === undefined ? 0 : from - now.tops.get(part.dataset.slide);
      if (Math.abs(by) >= 1) part.animate([{ transform: `translateY(${by}px)` }, { transform: 'none' }], { duration: 280, easing: EASE_OUT });
    }
  }

  function taskExchange(ex, last, current) {
    const t = tasks.get(current.id);
    // The leader's [team] notes are the daemon's, not yours: shown as a line, not a bubble.
    const node = el('section', { class: 'ex' }, ex.prompts.filter((p) => !TEAM_NOTE.test(p.text)).map((p) => userBubble(p.text, p.images)));
    const working = last && (t.state === 'working' || t.state === 'needs');
    const calls = liveCalls(ex, last, t);
    // (While it works they're part of the working block; a background one outliving the turn stands by itself.)
    node.append(...teamLines(current, ex, list[list.indexOf(ex) + 1]), ...(working ? [] : [subagentRows(calls)].filter(Boolean)));
    // The leader waits while its team works: say who.
    const crew = last && t.state === 'idle' && ctx.team?.busy(current.id) ? ctx.team.working(current.id) : [];
    if (crew.length) node.append(el('div', { class: 'ex-team is-live' }, teamRow('Team', `working · ${crew.join(', ')}`, 'live')));
    if (working) {
      const tool = t.tool;
      // The sub-agent's own call: its row already says this.
      const rowSays = calls.length && tool && (tool.name === 'Agent' || tool.name === 'Task' || calls.some((c) => c.what === tool.desc));
      node.append(
        workBlock({
          needs: t.state === 'needs',
          waiting: tasks.waiting(current.id),
          // Working while a tool runs (what for, below), Thinking between them.
          head: t.state === 'needs' ? `${AGENT_NAME[current.kind] || 'Claude'} ${t.need === 'asking' ? 'is asking you' : 'needs your permission'}` : tool || calls.some((c) => c.state === 'running') ? 'Working' : 'Thinking',
          sub: t.state === 'needs' ? t.message : rowSays ? '' : tool ? tool.desc || `${tool.name} ${tool.detail || ''}`.trim() : '',
          subagents: subagentRows(calls),
          since: t.since,
          tokensNow: () => t.transcript.tokensSince(t.since),
          // Like the sidebar's meter: the plan's live use, else this task's memory.
          usageNow: () => ctx.usage(current.id),
          onStop: () => tasks.stop(current),
        })
      );
      return node;
    }
    const answer = ex.texts.at(-1);
    if (!answer && !ex.interrupted && !ex.tools.length) return node;
    const at = Math.max(answer?.at || 0, ex.tools.at(-1)?.at || 0, ex.at || 0);
    node.append(
      ...answerBlock({
        state: ex.interrupted ? 'Stopped' : 'Finished',
        at,
        text: answer?.text || '',
        buttons: last ? taskButtons(current) : [],
        files: writtenFiles(ex),
        base: current.cwd,
        key: `${current.id}:${ex.at}:${answer?.at || 0}`,
      })
    );
    return node;
  }

  function renderTask(fresh) {
    const current = task();
    const t = tasks.get(current.id);
    const entries = t.transcript.entries;
    if (parsed.entries !== entries || parsed.length !== entries.length) parsed = { entries, length: entries.length, list: exchanges(entries) };
    list = parsed.list.slice();
    // Sent but not in the transcript yet: shown at once.
    const waiting = pending.get(current.id) ?? (sendingFirst && !entries.length ? sendingFirst : undefined);
    const sent = waiting && splitImages(waiting);
    if (waiting && list.some((ex) => ex.prompts.some((p) => p.text.trim() === sent.text && (p.images?.length || 0) === sent.images.length))) pending.delete(current.id);
    else if (waiting) list.push({ prompts: [{ ...sent, at: Date.now() }], texts: [], tools: [], interrupted: false, at: Date.now() });
    if (!list.length) {
      // (A hierarchy task whose team has done things shows them, even before its leader's transcript is read.)
      if (t.state === 'working' || t.state === 'needs' || ctx.team?.get(current.id)?.log.length) list.push({ prompts: [], texts: [], tools: [], interrupted: false, at: Date.now() });
      else {
        column.replaceChildren(
          el('div', { class: 'newtask' }, el('h2', { class: 'newtask-title', text: current.title }), el('p', { class: 'newtask-text', text: current.kind === 'shell' ? 'This task runs in its terminal (>_).' : `Nothing here yet. Write to ${AGENT_NAME[current.kind]} below.` }))
        );
        return;
      }
    }
    if (list.length > (counts.get(current.id) ?? list.length)) fresh = true;
    counts.set(current.id, list.length);
    if (fresh || shownFrom === null || shownFrom > list.length - 1) shownFrom = list.length - 1;
    const nodes = list.slice(shownFrom).map((ex, i, shown) => exchangeNode(ex, i === shown.length - 1, current));
    if (fresh) nodes.at(-1).classList.add('is-new');
    // Earlier exchanges stay as they are; only what changed (the live one) is swapped in.
    const keep = new Set(nodes);
    for (const [key, entry] of built) if (!keep.has(entry.node)) built.delete(key);
    nodes.forEach((node, i) => {
      const at = column.children[i];
      if (at !== node) column.insertBefore(node, at || null);
    });
    while (column.children.length > nodes.length) column.lastElementChild.remove();
  }

  /**
   * An exchange's node: the live (last) one is drawn anew each time; an earlier one
   * is kept until its words, tool results or the team's log change.
   */
  function exchangeNode(ex, last, current) {
    const key = ex.prompts[0] || ex.texts[0] || ex.tools[0];
    if (last || !key) return taskExchange(ex, last, current);
    const sig = [ex.prompts.length, ex.texts.length, ex.tools.length, ex.interrupted, ex.tools.map((tool) => (tool.result ? tool.result.status || 1 : 0)).join(''), list[list.indexOf(ex) + 1] ? 1 : 0, ctx.team?.get(current.id)?.log.length || 0, liveCalls(ex, false, tasks.get(current.id)).length, current.id].join('|');
    const had = built.get(key);
    if (had && had.sig === sig) return had.node;
    const node = taskExchange(ex, last, current);
    built.set(key, { sig, node });
    return node;
  }

  /* ------------------------------ agent ------------------------------- */

  function agentExchanges() {
    const out = [];
    let current = null;
    for (const message of store.state.agent.messages) {
      if (message.role === 'user' || message.role === 'event') {
        if (current && !current.replies.length) current.asks.push(message);
        else out.push((current = { asks: [message], replies: [] }));
      } else {
        if (!current) out.push((current = { asks: [], replies: [] }));
        current.replies.push(message);
      }
    }
    return out;
  }

  /** What the review strip would show now: it is redrawn only when this changes. */
  const reviewKey = () =>
    JSON.stringify([
      store.openTasks().filter((t) => t.unread || tasks.get(t.id).state === 'needs').map((t) => [t.id, t.title, tasks.get(t.id).state === 'needs' ? tasks.get(t.id).need : '']),
      store.state.agent.reminders.map((r) => [r.id, r.at, r.text]),
      (store.state.agent.watches || []).map((w) => [w.id, w.every, w.check]),
    ]);
  let reviewDrawn = '';

  /** Tasks come and go from "Waiting for you" all day: swap that list in place, not Katana's whole screen. */
  function refreshReview() {
    if (view.type !== 'agent') return;
    const key = reviewKey();
    if (key === reviewDrawn) return;
    const next = reviewStrip();
    const old = column.querySelector(':scope > .review');
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) column.prepend(next);
  }

  /** Anything else Katana's screen shows that a store change could alter (her folder, the look, what was said). */
  const agentKey = () => {
    const messages = store.state.agent.messages;
    const { dataset } = document.body;
    return [store.state.settings.currentProject, dataset.theme, dataset.style, dataset.size, dataset.motion, messages.length, messages.at(-1)?.at, messages.at(-1)?.text?.length].join('|');
  };
  let agentDrawn = '';
  let agentQueued = 0;
  /** A task event or store change while Katana's page is open: after the frame, redraw only what it touched. */
  function agentTouched() {
    if (agentQueued) return;
    agentQueued = requestAnimationFrame(() => {
      agentQueued = 0;
      if (view.type !== 'agent') return;
      if (agentKey() !== agentDrawn) render();
      else refreshReview();
    });
  }

  function reviewStrip() {
    reviewDrawn = reviewKey();
    const waiting = store.openTasks().filter((t) => t.unread || tasks.get(t.id).state === 'needs');
    const reminders = store.state.agent.reminders;
    const watches = store.state.agent.watches || [];
    if (!waiting.length && !reminders.length && !watches.length) return null;
    return el(
      'div',
      { class: 'review' },
      waiting.length ? el('p', { class: 'review-title', text: `Waiting for you · ${waiting.length}` }) : null,
      waiting.map((t) =>
        el(
          'button',
          { class: 'review-row', type: 'button', onclick: () => ctx.open(t.id) },
          el('span', { class: `task-dot ${tasks.get(t.id).state === 'needs' ? 'is-needs' : 'is-unread'}` }),
          el('span', { class: 'review-name', text: t.title }),
          el('span', { class: 'review-note', text: tasks.get(t.id).state === 'needs' ? (tasks.get(t.id).need === 'asking' ? 'asking you' : 'needs permission') : 'finished' })
        )
      ),
      reminders.length ? el('p', { class: 'review-title', text: 'Reminders' }) : null,
      reminders.map((r) =>
        el(
          'div',
          { class: 'review-row is-static' },
          el('span', { class: 'review-time', text: new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
          el('span', { class: 'review-name', text: r.text }),
          el('button', { class: 'text-btn', type: 'button', text: 'Cancel', onclick: () => store.dropReminder(r.id) })
        )
      ),
      watches.length ? el('p', { class: 'review-title', text: 'Checking' }) : null,
      watches.map((w) =>
        el(
          'div',
          { class: 'review-row is-static' },
          el('span', { class: 'review-time', text: `every ${w.every}m` }),
          el('span', { class: 'review-name', text: w.check }),
          el('button', { class: 'text-btn', type: 'button', text: 'Cancel', onclick: () => store.dropWatch(w.id) })
        )
      )
    );
  }

  function renderAgent(fresh) {
    list = agentExchanges();
    const strip = reviewStrip();
    // Nothing said yet (at most the tasks' news): her intro, with that news under it.
    const talked = list.some((ex) => ex.replies.length || ex.asks.some((m) => m.role !== 'event'));
    if (!talked && !agent.busy()) {
      column.replaceChildren(...[strip, introScreen(list.flatMap((ex) => ex.asks))].filter(Boolean));
      return;
    }
    if (agent.busy() && (!list.length || list.at(-1).replies.length)) list.push({ asks: [], replies: [] });
    if (list.length > (counts.get('agent') ?? list.length)) fresh = true;
    counts.set('agent', list.length);
    if (fresh || shownFrom === null || shownFrom > list.length - 1) shownFrom = list.length - 1;
    const nodes = list.slice(shownFrom).map((ex, i, shown) => agentExchange(ex, i === shown.length - 1));
    if (fresh) nodes.at(-1).classList.add('is-new');
    column.replaceChildren(...[strip, ...nodes].filter(Boolean));
  }

  function agentExchange(ex, last) {
    const node = el('section', { class: 'ex' }, ex.asks.map((m) => (m.role === 'event' ? el('div', { class: 'ex-event', text: m.text }) : userBubble(m.text))));
    if (last && agent.busy()) {
      node.append(workBlock({ head: agent.activity() ? 'Working' : 'Thinking', dots: true, sub: agent.activity() ? clipWords(agent.activity()) : '', since: agent.since(), tokensNow: () => 0, onStop: () => agent.stop() }));
      return node;
    }
    const reply = ex.replies.at(-1);
    if (!reply) return node;
    node.append(
      ...answerBlock({
        state: reply.role === 'error' ? 'Failed' : reply.kind === 'stopped' ? 'Stopped' : 'Replied',
        at: reply.at,
        text: reply.text,
        error: reply.role === 'error',
        key: `agent:${reply.at}`,
      })
    );
    return node;
  }

  /** Her conversation before it starts: who she is, things to ask her (they fill the prompt bar), and the tasks' latest news. */
  // The welcome picture is dithered once (about 20k dots) and kept while its size and colour stay.
  const introArt = el('canvas', { class: 'newtask-art', 'aria-hidden': 'true' });
  let introArtKey = '';

  function introScreen(events = []) {
    const art = introArt;
    requestAnimationFrame(() => {
      const key = [getComputedStyle(document.body).getPropertyValue('--text'), art.clientWidth, art.clientHeight, window.devicePixelRatio].join('|');
      if (key === introArtKey) return;
      introArtKey = key;
      dither(art, { cell: 2, paint: paintScene });
    });
    const folder = store.project(store.state.settings.currentProject)?.name;
    const starters = ['What’s running right now?', folder ? `Start a task in ${folder} to ` : 'Start a task to ', 'Remind me in 20 minutes to '];
    const fill = (text) => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(text.length, text.length);
    };
    return el(
      'div',
      { class: 'newtask agent-intro' },
      art,
      el('h2', { class: 'newtask-title', text: 'Katana' }),
      el('p', {
        class: 'newtask-text',
        text: 'Tell me what you want done. I start tasks in your folders, keep an eye on them, and tell you when they finish or need you. I can also set reminders and change settings.',
      }),
      el(
        'div',
        { class: 'intro-starters', role: 'group', 'aria-label': 'Things to ask' },
        starters.map((text) => el('button', { class: 'intro-starter', type: 'button', text: text.trim().endsWith('?') ? text : `${text.trim()}…`, onclick: () => fill(text) }))
      ),
      events.length
        ? el(
            'div',
            { class: 'intro-news' },
            el('p', { class: 'intro-news-title', text: 'Latest' }),
            events.slice(-3).map((m) => el('p', { class: 'intro-news-row', text: m.text }))
          )
        : null
    );
  }

  /* ----------------------------- new task ----------------------------- */

  // A greeting for the time of day, picked once each time the screen opens.
  const GREETINGS = {
    morning: ['Morning, {n}. The agents are caffeinated.', 'Good morning, {n}. Pick a target.', 'Morning, {n}. What are we shipping?'],
    afternoon: ['Afternoon, {n}. What’s next?', 'Good afternoon, {n}. Pick a target.', 'Afternoon, {n}. The agents are warmed up.'],
    evening: ['Evening, {n}. One more thing?', 'Good evening, {n}. Pick a target.', 'Evening, {n}. The agents are still keen.'],
    night: ['Late one, {n}. The agents don’t sleep.', 'Still up, {n}? Pick a target.', 'Night shift, {n}. What needs doing?'],
  };
  let greeting = '';

  function pickGreeting() {
    const hour = new Date().getHours();
    const part = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : hour >= 18 && hour < 23 ? 'evening' : 'night';
    const list = GREETINGS[part];
    const name = ctx.userName();
    greeting = list[Math.floor(Math.random() * list.length)].replace('{n}', name).replace(/^(\w+), \./, '$1.');
  }

  /** "Today: 10 finished · agents worked 8h · ↓ 47.2k tokens". */
  function todayLine() {
    const stats = ctx.today();
    const hours = stats.workedMs / 3600000;
    const worked = hours >= 1 ? `${Math.round(hours)}h` : `${Math.max(0, Math.round(stats.workedMs / 60000))}m`;
    return `Today: ${stats.finished} finished · agents worked ${worked} · ↓ ${tokens(stats.tokens)} tokens`;
  }

  /** The line under the box: who, how hard, where — each part opens its menu. */
  function chooserLine() {
    const { settings } = store.state;
    const model = MODELS.find((m) => m.id === settings.taskModel)?.name || 'Claude';
    const codexModel = CODEX_MODELS.find((m) => m.id === settings.codexModel)?.name || settings.codexModel || '';
    const project = store.project(ctx.currentProject());
    const worktree = Boolean(draft.worktree ?? settings.worktrees);
    const who = el('button', { class: 'chooser', type: 'button', text: draft.kind === 'claude' ? `Claude ${model}` : draft.kind === 'codex' ? `Codex ${codexModel}`.trim() : AGENT_NAME[draft.kind] });
    const effort = el('button', { class: 'chooser', type: 'button', text: `${(EFFORTS.find((e) => e.id === current().effort) || EFFORTS[1]).label.toLowerCase()} effort` });
    const where = el('button', { class: 'chooser', type: 'button', text: project ? project.name : 'pick a folder' });
    who.addEventListener('click', () =>
      menu(who, [
        ...MODELS.map((m) => ({
          label: `Claude ${m.name}`,
          on: draft.kind === 'claude' && settings.taskModel === m.id,
          run: () => {
            draft.kind = 'claude';
            store.setSetting('taskModel', m.id);
          },
        })),
        '-',
        ...CODEX_MODELS.map((m) => ({
          label: `Codex ${m.name}`,
          on: draft.kind === 'codex' && settings.codexModel === m.id,
          run: () => {
            draft.kind = 'codex';
            store.setSetting('codexModel', m.id);
          },
        })),
        '-',
        { label: 'A shell', on: draft.kind === 'shell', run: () => (draft.kind = 'shell') },
      ])
    );
    effort.addEventListener('click', () => openEffort(effort));
    where.addEventListener('click', () =>
      menu(where, [
        ...store.state.projects.map((p) => ({ label: p.name, title: p.path, on: p.id === ctx.currentProject(), run: () => store.setSetting('currentProject', p.id) })),
        '-',
        { label: 'Add a folder…', run: () => ctx.addProject() },
        { label: worktree ? 'Work in the folder itself' : 'Work on its own worktree', run: () => (draft.worktree = !worktree) },
      ])
    );
    return el(
      'p',
      { class: 'newtask-with' },
      'with ',
      who,
      draft.kind !== 'shell' ? [', ', effort] : null,
      ' · in ',
      where,
      worktree && draft.kind !== 'shell' ? ' · own worktree' : null
    );
  }

  /** A small menu under a button: [{ label, on, run, title }] and '-'. */
  function menu(anchor, items) {
    if (pop?.anchor === anchor) return closePop();
    openPop(
      anchor,
      el(
        'div',
        { class: 'pop', role: 'menu' },
        items.map((item) =>
          item === '-'
            ? el('div', { class: 'menu-sep', role: 'separator' })
            : el('button', {
                class: `menu-item${item.on ? ' is-on' : ''}`,
                type: 'button',
                role: 'menuitem',
                title: item.title || null,
                text: item.label,
                onclick: () => {
                  closePop();
                  item.run();
                  render();
                  input.focus();
                },
              })
        )
      )
    );
    return undefined;
  }

  function newTaskScreen() {
    if (!greeting) pickGreeting();
    const hasFolders = store.state.projects.length > 0;
    if (!hasFolders) meta.remove();
    else if (meta.parentNode !== overBar) overBar.append(meta);
    return el(
      'div',
      { class: 'newtask' },
      el('p', { class: 'newtask-today', text: todayLine() }),
      el('h2', { class: 'newtask-greeting', text: greeting }),
      overBar,
      composer,
      hasFolders ? chooserLine() : el('p', { class: 'newtask-with' }, el('button', { class: 'chooser', type: 'button', text: 'Add a folder', onclick: () => ctx.addProject() }), ' to start: tasks only run inside folders you trust.')
    );
  }

  /* ------------------------------ render ------------------------------ */

  function render({ fresh = false } = {}) {
    renderQueued = 0;
    // (New task's screen is rebuilt around the prompt bar, which would lose the keyboard, and what you're typing, whenever a task elsewhere changes.)
    const typing = document.activeElement === input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null;
    keepingFocus = Boolean(typing);
    if (view.type === 'agent') agentDrawn = agentKey();
    if (view.type === 'task' && !task()) view = { type: 'new' };
    // Going to or from New task or a new branch, the prompt bar travels between the places it lives.
    const emptyBranch = isEmptyBranch();
    const barPlace = view.type === 'new' ? 'new' : emptyBranch ? 'branch' : 'foot';
    const travels = motionOn() && composer.isConnected && barPlace !== barPlaceWas;
    const barWas = travels ? composer.getBoundingClientRect() : null;
    barPlaceWas = barPlace;
    const partsWere = view.type === 'task' ? workParts() : null;
    const turnWas = turnShown;
    if (view.type === 'task') {
      renderTask(fresh);
      turnShown = `${view.id}:${list.length}`;
      slideWorkParts(partsWere, !fresh && turnWas === turnShown);
    } else if (view.type === 'agent') renderAgent(fresh);
    else column.replaceChildren(newTaskScreen());
    // New task has its box in the middle; everywhere else it sits at the bottom.
    const isNew = view.type === 'new';
    stage.classList.toggle('is-new', isNew);
    foot.classList.toggle('is-empty', isNew);
    root.classList.toggle('is-new-branch', emptyBranch);
    if (!isNew && meta.parentNode !== overBar) overBar.append(meta);
    if (!isNew && overBar.parentNode !== foot) foot.prepend(overBar);
    if (!isNew && composer.parentNode !== foot) foot.append(composer);
    if (fresh) stage.scrollTop = 0;
    renderMeta();
    if (barWas) {
      const barIs = composer.getBoundingClientRect();
      const [dx, dy] = [barWas.left - barIs.left, barWas.top - barIs.top];
      if (barIs.width && (Math.abs(dy) > 1 || Math.abs(dx) > 1)) {
        composer.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 680, easing: SPRING });
      }
    }
    if (typing && document.activeElement !== input && input.isConnected && !input.disabled) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(...typing);
    }
    keepingFocus = false;
    if (arriving) {
      arriving = false;
      arrive(Boolean(barWas));
    }
    keepInStep(column);
  }

  /** New task opening: its parts come up one after another. A conversation is simply there, as a page in a Mac window is. */
  // The first message of a task being created.
  let sendingFirst = '';
  // A redraw is moving the prompt bar: its losing focus for that moment means nothing.
  let keepingFocus = false;
  let barPlaceWas = '';
  // Which task's which request the working block is of (a new one doesn't slide from the last).
  let turnShown = '';

  /** A branch nothing has been said in yet: just the prompt bar, in the middle (macos.css). */
  function isEmptyBranch() {
    const current = task();
    if (!current?.forkOf || mode !== 'chat' || pending.has(current.id)) return false;
    const live = tasks.get(current.id);
    return !live.transcript.entries.length && live.state !== 'working' && live.state !== 'needs';
  }

  let arriving = false;
  function arrive(barMoving) {
    if (!motionOn()) return;
    if (view.type !== 'new') {
      // The prompt bar is on its way down through here: what it would cross comes up behind it.
      if (barMoving) for (const part of [column, meta]) part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 170, easing: 'ease-out', fill: 'backwards' });
      return;
    }
    // (At the app's opening they wait for the scene to come up.)
    const wait = document.body.hasAttribute('data-boot') ? 620 : 40;
    const parts = [...column.querySelectorAll('.newtask > *')].filter((part) => !(barMoving && part === composer));
    parts.forEach((part, i) => {
      part.animate(
        [
          { opacity: 0, transform: 'translateY(12px)', filter: 'blur(5px)' },
          { opacity: 1, transform: 'none', filter: 'blur(0)' },
        ],
        { duration: 720, delay: wait + i * 70, easing: EASE_OUT, fill: 'backwards' }
      );
    });
  }

  const later = () => {
    if (!renderQueued) renderQueued = requestAnimationFrame(() => render());
  };

  // Past the top, the exchange before comes back (and stays in place).
  stage.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY >= 0 || stage.scrollTop > 0 || !shownFrom || view.type === 'new') return;
      const height = stage.scrollHeight;
      shownFrom -= 1;
      const current = task();
      const node = view.type === 'task' ? exchangeNode(list[shownFrom], false, current) : agentExchange(list[shownFrom], false);
      const first = column.querySelector('.ex');
      column.insertBefore(node, first);
      stage.scrollTop = stage.scrollHeight - height;
    },
    { passive: true }
  );

  // The timers in Working lines move on their own.
  ticker = setInterval(() => {
    for (const node of column.querySelectorAll('.ex-work')) node._tick?.();
  }, 1000);

  tasks.on(({ id, type, message }) => {
    if (view.type === 'task' && view.id === id && (type === 'change' || type === 'finished' || type === 'needs' || type === 'exit')) later();
    if (view.type === 'agent') agentTouched();
    if (type === 'error' && view.type === 'task' && view.id === id) flash(message);
    // A turn finished while its page is open: show what it made.
    if (type === 'finished' && view.type === 'task' && view.id === id && (mode === 'file' || (mode === 'app' && appPane.isPage(id)))) showFinishedPage(id);
    // A turn that made a browser game: its page goes in the viewer (the globe), even unopened.
    else if (type === 'finished') {
      const last = exchanges(tasks.get(id)?.transcript.entries || []).at(-1);
      const game = last ? browserGame(last, store.task(id)?.title) : '';
      if (game && game !== store.task(id)?.viewFile) {
        // An Electron or Node game's page can't be shown by itself.
        standalone(game, store.task(id)?.cwd).then((ok) => {
          if (!ok || game === store.task(id)?.viewFile) return;
          store.patchTask(id, { viewFile: game });
          if (view.type === 'task' && view.id === id) ctx.onMode?.(mode);
        });
      }
    }
  });
  agent.on(() => view.type === 'agent' && later());
  ctx.team?.on((id) => view.type === 'task' && view.id === id && later());
  store.on('agent-message', (message) => view.type === 'agent' && render({ fresh: message.role === 'user' }));

  /* ------------------------------ files ------------------------------- */

  function openFile(path) {
    const current = task();
    if (!current) return;
    store.patchTask(current.id, { viewFile: path });
    setMode('file');
  }

  /** A file chip: opens its file, or closes it when it's the one open beside the chat. */
  function toggleFile(path) {
    if (mode === 'file' && task()?.viewFile === path) setMode('chat');
    else openFile(path);
  }

  /**
   * chat: the exchange; file: the task's open file in the viewer (a web
   * page goes in the app viewer instead); app: its app or page, running,
   * filling the main area with no prompt bar.
   */
  function setMode(next) {
    const current = task();
    const file = current?.viewFile || '';
    if (next === 'file' && current && isPage(file)) {
      showPage(current, file);
      next = 'app';
    }
    mode = next === 'file' && file ? 'file' : next === 'app' && current ? 'app' : 'chat';
    // A text document opens beside the chat, like a side panel; anything else fills the area.
    const side = mode === 'file' && isDoc(file);
    stage.hidden = mode !== 'chat' && !side;
    viewer.hidden = mode === 'chat';
    viewer.classList.toggle('is-app', mode === 'app');
    viewer.classList.toggle('is-side', side);
    root.classList.toggle('is-app', mode === 'app');
    root.classList.toggle('is-doc', side);
    for (const chip of column.querySelectorAll('.file-chip')) chip.classList.toggle('is-open', mode === 'file' && chip.dataset.file === file);
    if (mode === 'app') {
      frame.hidden = true;
      doc.hidden = true;
      appPane.show(current);
    } else appPane.hide();
    if (mode === 'file') {
      const asDoc = isDoc(file);
      doc.hidden = !asDoc;
      frame.hidden = asDoc;
      if (asDoc && docFile !== file) showDoc(file);
      else if (!asDoc && frame.dataset.file !== file) {
        frame.dataset.file = file;
        frame.src = fileUrl(file);
      }
      api.file.watch(file);
    } else if (mode === 'app' && isPage(file)) {
      // Its page is reloaded when the file changes.
      api.file.watch(file);
    } else {
      api.file.watch('');
    }
    ctx.onMode?.(mode);
  }

  /** A web page in the browser: started, or the running one shown (the same page isn't started again). */
  function showPage(t, file) {
    const running = appPane.state(t.id);
    if (!(appPane.isLive(t.id) && samePath(running?.page, file))) appPane.run(t, { page: file });
  }

  /**
   * Shows a web page (`page`) in the browser, on screen if `show` and it's the
   * task on screen. A failure isn't shown: it's logged with the task's errors (main).
   */
  async function runApp(id, { page = '', show = true, cwd = '' } = {}) {
    const t = store.task(id);
    if (!t) return { error: 'There’s no task like that.' };
    const reply = await appPane.run(t, { page, cwd });
    if (!reply?.error && show && view.type === 'task' && view.id === id) setMode('app');
    return reply;
  }

  /** Back to the task from the browser. Its page ends (it starts again in a moment). */
  function leaveApp() {
    const t = task();
    if (t && appPane.isPage(t.id)) appPane.stop(t.id);
    setMode('chat');
  }

  /** The open file, read again (a page reloads, a document keeps its place). */
  function reloadViewer() {
    const t = task();
    const file = t?.viewFile;
    if (mode === 'app' && t && appPane.isPage(t.id)) return appPane.reload(t.id);
    if (mode !== 'file' || !file) return undefined;
    if (isDoc(file)) showDoc(file, { keepScroll: true });
    else frame.src = `${fileUrl(file)}?v=${Date.now()}`;
    return undefined;
  }

  /**
   * The task just finished: if this turn wrote a new page, open that one;
   * otherwise reload the one on screen (its scripts and styles may have changed).
   */
  async function showFinishedPage(id) {
    const last = exchanges(tasks.get(id).transcript.entries).at(-1);
    const page = last ? writtenFiles(last).filter((file) => /\.html?$/i.test(file)).at(-1) : '';
    if (page && page !== task()?.viewFile && !isDoc(task()?.viewFile) && (await standalone(page, store.task(id)?.cwd)) && task()?.id === id) {
      store.patchTask(id, { viewFile: page });
      setMode('file');
    }
    // The transcript's last lines land a moment after the turn ends.
    setTimeout(reloadViewer, 400);
  }

  /** A page that stands by itself (no package.json over it, main file:stat): one that can be shown. */
  async function standalone(file, base) {
    const found = await api.file.stat([file], base).catch(() => []);
    return (found || []).some((info) => !info.app);
  }

  api.file.onChanged((file) => {
    if (file === task()?.viewFile) reloadViewer();
  });

  /** A Markdown or text file, laid out; read again when it changes. */
  async function showDoc(file, { keepScroll = false } = {}) {
    docFile = file;
    fitDocPath();
    const top = keepScroll ? docScroll.scrollTop : 0;
    const text = await api.file.read(file).catch(() => null);
    if (docFile !== file) return;
    if (text === null || text === undefined) docBody.replaceChildren(el('p', { class: 'doc-missing', text: 'This file can’t be read (it may be gone, or too big).' }));
    else if (/\.txt$/i.test(file)) docBody.replaceChildren(el('pre', { class: 'doc-plain', text }));
    else docBody.replaceChildren(...blocks(text));
    docScroll.scrollTop = top;
  }

  // The path fits its bar, cut in the middle: as long as it can be without running over.
  function fitDocPath() {
    if (!docFile) return;
    docPath.title = docFile;
    docPath.textContent = docFile;
    if (!docPath.clientWidth) return;
    for (let chars = docFile.length - 1; chars > 8 && docPath.scrollWidth > docPath.clientWidth; chars -= 1) docPath.textContent = fitPath(docFile, chars);
  }
  document.fonts?.ready.then(() => fitDocPath());
  new ResizeObserver(() => fitDocPath()).observe(doc);

  /* ---------------------------- popovers ------------------------------ */

  /** The model and effort the line above the prompt bar is about. */
  function current() {
    const t = task();
    const { settings } = store.state;
    if (view.type === 'agent') return { model: settings.agentModel, effort: settings.agentEffort, keys: ['agentModel', 'agentEffort'] };
    if (t && t.kind === 'codex') return { model: t.model || settings.codexModel, effort: t.effort || settings.codexEffort, task: t };
    if (t) return { model: t.model || settings.taskModel, effort: t.effort || settings.taskEffort, task: t };
    if (draft.kind === 'codex') return { model: settings.codexModel, effort: settings.codexEffort, keys: ['codexModel', 'codexEffort'] };
    if (draft.kind === 'claude' && settings.taskMode === 'hierarchy') return { model: settings.managerModel, effort: settings.managerEffort, keys: ['managerModel', 'managerEffort'] };
    // (Sub-agents mode: its lead is always Opus.)
    if (draft.kind === 'claude' && settings.taskMode === 'subagents') return { model: SUBAGENTS_LEAD, effort: settings.taskEffort, keys: ['taskModel', 'taskEffort'] };
    return { model: settings.taskModel, effort: settings.taskEffort, keys: ['taskModel', 'taskEffort'] };
  }

  function renderMeta() {
    const t = task();
    const kind = t ? t.kind : view.type === 'new' ? draft.kind : 'claude';
    meta.hidden = kind === 'shell';
    const { model, effort } = current();
    const name = nameOfModel(model) || (kind === 'codex' && model) || 'Model';
    // (Teams and sub-agents are Claude's: a Codex task is one session.)
    const mode = kind === 'claude' ? taskMode() : 'single';
    modeText.hidden = modeDot.hidden = view.type === 'agent' || kind !== 'claude';
    modeText.textContent = MODES.find((m) => m.id === mode).label;
    // Not while it works: the switch waits for the turn to end.
    const busy = Boolean(t) && ['working', 'needs'].includes(tasks.get(t.id).state);
    modeText.classList.toggle('is-locked', busy);
    modeText.title = busy ? 'Switch once it’s done (or stop it first)' : t ? 'How this task runs' : 'How new tasks run';
    // Sub-agents mode: its lead is always Opus, and it picks its sub-agents' models: said, not picked here.
    const fixed = view.type !== 'agent' && mode === 'subagents';
    modelText.classList.toggle('is-fixed', fixed);
    modelText.setAttribute('aria-disabled', String(fixed));
    modelText.textContent = view.type === 'agent' ? `Katana · ${name}` : mode === 'hierarchy' ? `Leader · ${name}` : fixed ? 'Opus lead · sub-agents' : name;
    modelText.title =
      view.type === 'agent'
        ? 'Katana’s model'
        : mode === 'hierarchy'
          ? 'The Leader’s model (workers’ and verifiers’: Settings → Modes)'
          : mode === 'subagents'
            ? 'Opus leads: it plans, checks the work, and picks a sub-agent for each piece: Haiku for simple fixes, Sonnet for hard work and logic, Opus for complicated systems and hard bugs'
            : t
              ? 'This task’s model'
              : 'Model for new tasks';
    effortText.textContent = `${(EFFORTS.find((e) => e.id === effort) || EFFORTS[1]).label.toLowerCase()} effort`;
    effortText.title = t ? 'Takes effect when the task next starts' : 'How hard it thinks';
    input.placeholder = placeholder();
  }

  /** 'single', 'hierarchy' or 'subagents': the open task's, or new tasks'. */
  function taskMode() {
    const mode = task()?.mode ?? store.state.settings.taskMode;
    return MODES.some((m) => m.id === mode) ? mode : 'single';
  }

  async function chooseMode(next) {
    const t = task();
    if (!t) store.setSetting('taskMode', next);
    else await ctx.setTaskMode(t.id, next);
    render();
    input.focus();
  }
  modeText.addEventListener('click', () => {
    if (pop?.anchor === modeText) return closePop();
    const mode = taskMode();
    openPop(
      modeText,
      el(
        'div',
        { class: 'pop mode-pop', role: 'menu', 'aria-label': 'How this task runs' },
        MODES.map((m) =>
          el(
            'button',
            {
              class: `menu-item${m.id === mode ? ' is-on' : ''}`,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': String(m.id === mode),
              onclick: () => {
                closePop();
                if (m.id !== mode) chooseMode(m.id);
                else input.focus();
              },
            },
            el('span', { class: 'menu-text' }, el('span', { text: m.label }), el('span', { class: 'menu-desc', text: m.desc }))
          )
        )
      )
    );
  });

  function placeholder() {
    if (view.type === 'agent') return agent.busy() ? 'Add a note for Katana…' : 'Write to Katana…';
    const t = task();
    if (!t) return draft.kind === 'shell' ? 'Run a command…' : taskMode() === 'hierarchy' ? 'Describe the work for the team…' : 'Describe the task…';
    if (t.mode === 'hierarchy') return tasks.get(t.id).state === 'working' ? 'Add a note for the Leader…' : 'Write to the Leader…';
    const state = tasks.get(t.id).state;
    if (t.kind === 'shell') return 'Run a command…';
    return state === 'working' ? `Add a note for ${t.kind === 'codex' ? 'Codex' : 'Claude'}…` : `Write to ${t.kind === 'codex' ? 'Codex' : 'Claude'}…`;
  }

  function setChoice(which, value) {
    const now = current();
    if (now.task) {
      store.patchTask(now.task.id, { [which]: value });
      // A model change reaches a running session at once, as Claude Code's /model.
      // (Only between turns: typed mid-turn it would answer a question or become a note to Claude.)
      const live = tasks.get(now.task.id);
      if (which === 'model' && now.task.kind === 'claude' && live.running && live.state === 'idle') api.task.say(now.task.id, `/model ${value}`);
      // Codex picks its model in a menu of its own: an idle session closes instead, and resumes on it with the next message.
      if (now.task.kind === 'codex' && live.running && live.state === 'idle') tasks.kill(now.task.id);
    } else store.setSetting(now.keys[which === 'model' ? 0 : 1], value);
    renderMeta();
  }

  function closePop() {
    if (!pop) return;
    leave(pop.node);
    pop.anchor.setAttribute('aria-expanded', 'false');
    pop = null;
  }

  function openPop(anchor, node) {
    closePop();
    document.body.append(node);
    placeNear(node, anchor);
    popIn(node, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    pop = { node, anchor };
    node.querySelector('button')?.focus();
  }

  document.addEventListener('pointerdown', (event) => {
    if (pop && !pop.node.contains(event.target) && !pop.anchor.contains(event.target)) closePop();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pop) {
      const { anchor } = pop;
      closePop();
      anchor.focus();
    }
  });

  modelText.addEventListener('click', () => {
    if (modelText.classList.contains('is-fixed')) return;
    if (pop?.anchor === modelText) return closePop();
    const { model } = current();
    const t = task();
    // Katana is Claude; a task keeps its own agent's models; a new task can be either: Claude's, then Codex's.
    const kind = view.type === 'agent' ? 'claude' : t ? t.kind : draft.kind;
    const groups = view.type !== 'agent' && !t ? ['claude', 'codex'] : [kind];
    const item = (agentKind, m) => {
      const on = kind === agentKind && m.id === model;
      return el('button', {
        class: `menu-item${on ? ' is-on' : ''}`,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(on),
        html: `<span class="chip-mark">${icons[agentKind]}</span><span>${m.name}</span>`,
        onclick: () => {
          closePop();
          if (!t && view.type !== 'agent' && draft.kind !== agentKind) {
            // A new task switching between Claude and Codex.
            draft.kind = agentKind;
            store.setSetting(agentKind === 'codex' ? 'codexModel' : 'taskModel', m.id);
            render();
          } else setChoice('model', m.id);
          input.focus();
        },
      });
    };
    openPop(
      modelText,
      el(
        'div',
        { class: 'pop', role: 'menu', 'aria-label': 'Model' },
        groups.map((agentKind, i) => [
          i ? el('div', { class: 'menu-sep', role: 'separator' }) : null,
          groups.length > 1 ? el('p', { class: 'pop-title', text: agentKind === 'codex' ? 'Codex' : 'Claude Code' }) : null,
          (agentKind === 'codex' ? CODEX_MODELS : MODELS).map((m) => item(agentKind, m)),
        ])
      )
    );
  });

  effortText.addEventListener('click', () => openEffort(effortText));

  /** The effort slider, under whichever button asked for it. */
  function openEffort(anchor) {
    if (pop?.anchor === anchor) return closePop();
    const index = Math.max(0, EFFORTS.findIndex((e) => e.id === current().effort));
    const slider = el('input', { class: 'effort-input', type: 'range', min: '0', max: String(EFFORTS.length - 1), step: '1', value: String(index), 'aria-label': 'Effort' });
    const place = (i) => `--at:${i / (EFFORTS.length - 1)}`;
    // The input does the work, unseen; the bar you see glides to where it is.
    const slide = el('div', { class: 'effort-slide' }, el('span', { class: 'effort-rail' }, el('span', { class: 'effort-fill' })), slider, el('span', { class: 'effort-thumb' }));
    const steps = EFFORTS.map((step, i) =>
      el('button', {
        type: 'button',
        style: place(i),
        text: step.label,
        onclick: () => {
          slider.value = String(i);
          show();
          save();
        },
      })
    );
    const show = () => {
      const i = Number(slider.value);
      slide.style.setProperty('--at', String(i / (EFFORTS.length - 1)));
      steps.forEach((step, k) => step.setAttribute('aria-pressed', String(k === i)));
    };
    const save = () => {
      setChoice('effort', EFFORTS[Number(slider.value)].id);
      if (view.type === 'new') render();
    };
    slider.addEventListener('input', show);
    slider.addEventListener('change', save);
    show();
    openPop(
      anchor,
      el(
        'div',
        { class: 'pop effort-pop', role: 'dialog', 'aria-label': 'Effort' },
        el('p', { class: 'pop-title', text: 'Effort' }),
        slide,
        el('div', { class: 'effort-steps' }, steps),
        el('p', { class: 'effort-hint', text: task()?.kind === 'codex' ? 'Takes effect with your next message.' : task() ? 'Takes effect when this task next starts.' : 'Higher effort thinks longer and is slower.' })
      )
    );
    slider.focus();
    return undefined;
  }

  /** How full a task's memory is (the sidebar footer opens it). */
  function showContext(anchor) {
    const t = task();
    if (!t) return;
    if (pop?.anchor === anchor) return closePop();
    const used = ctx.contextOf(t.id);
    const share = Math.min(1, used.used / used.window);
    const fill = el('span', { class: share >= HIGH ? 'is-high' : null, style: 'width:0%' });
    requestAnimationFrame(() => {
      fill.style.width = `${(share * 100).toFixed(1)}%`;
    });
    openPop(
      anchor,
      el(
        'div',
        { class: 'pop context-pop', role: 'dialog', 'aria-label': 'Memory used', tabindex: '-1' },
        el('p', { class: 'pop-title', text: 'Memory used' }),
        el('div', { class: 'context-row' }, el('div', { class: 'context-line' }, el('span', { text: t.title }), el('span', { class: 'context-numbers', text: `${tokens(used.used)} / ${tokens(used.window)}` })), el('span', { class: 'context-bar' }, fill))
      )
    );
  }

  /* ----------------------------- composer ----------------------------- */

  /** A short notice over the prompt bar (a voice error, say); it clears itself. */
  let flashTimer = 0;
  // (Slid in from here, not from CSS: New task's screen is rebuilt around the note, and a CSS animation would start over each time.)
  function showBanner(text) {
    const appearing = banner.hidden;
    banner.textContent = text;
    banner.hidden = false;
    if (appearing && motionOn()) banner.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: SPRING });
  }

  function flash(text) {
    if (blocked || !text) return;
    clearTimeout(flashTimer);
    showBanner(text);
    flashTimer = setTimeout(() => {
      if (!blocked) banner.hidden = true;
    }, 6000);
  }

  function setBlocked(reason) {
    blocked = reason;
    if (reason) showBanner(reason);
    else {
      banner.hidden = true;
      banner.textContent = '';
    }
    input.disabled = Boolean(reason);
  }

  function autosize() {
    // Empty: one line (measured while the bar is being laid out, it can read far taller).
    if (!input.value) {
      input.style.height = '';
      return;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.max(18, Math.min(input.scrollHeight, 200))}px`;
  }

  /* Pictures: saved where Claude can read them (main.js image:save); the message carries their paths. */
  const attached = [];
  const READABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

  /** A picture as PNG, JPEG, GIF or WebP (the kinds Claude reads): others are redrawn as PNG. */
  async function readableImage(file) {
    if (READABLE_IMAGE.test(file.type)) return { type: file.type, bytes: await file.arrayBuffer() };
    try {
      // A data: URL, not a blob: one (the page's CSP allows only data: and file: images).
      const img = new Image();
      img.src = await new Promise((done, fail) => {
        const reader = new FileReader();
        reader.onload = () => done(reader.result);
        reader.onerror = fail;
        reader.readAsDataURL(file);
      });
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 1024;
      canvas.height = img.naturalHeight || 1024;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
      return blob ? { type: 'image/png', bytes: await blob.arrayBuffer() } : null;
    } catch {
      return null;
    }
  }

  async function attach(files) {
    for (const file of files) {
      const image = await readableImage(file);
      const saved = image && (await api.image.save(image.type, image.bytes));
      if (!saved) {
        flash(`Couldn’t attach ${file.name || 'that picture'}: it isn’t a picture this app can read.`);
        continue;
      }
      attached.push(saved);
    }
    showTray();
  }

  function showTray() {
    tray.hidden = !attached.length;
    tray.replaceChildren(
      ...attached.map((file, i) =>
        // Only its × takes it away: clicking the picture itself does nothing.
        el('div', { class: 'composer-image' },
          el('img', { src: fileUrl(file), alt: '', draggable: 'false' }),
          el('button', {
            class: 'composer-image-x',
            type: 'button',
            title: 'Remove',
            'aria-label': 'Remove picture',
            html: icons.x,
            onclick: () => {
              attached.splice(i, 1);
              showTray();
              input.focus();
            },
          })
        )
      )
    );
  }

  const imageFiles = (list) => [...(list || [])].filter((file) => file.type.startsWith('image/'));

  input.addEventListener('paste', (event) => {
    const files = imageFiles(event.clipboardData?.files);
    if (!files.length) return;
    event.preventDefault();
    attach(files);
  });
  // Dropped on the prompt bar; elsewhere a drop does nothing (never opens the file).
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    const over = composer.contains(event.target) && !input.disabled;
    event.dataTransfer.dropEffect = over ? 'copy' : 'none';
    composer.classList.toggle('is-dropping', over);
  });
  window.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) composer.classList.remove('is-dropping');
  });
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    composer.classList.remove('is-dropping');
    if (!composer.contains(event.target) || input.disabled) return;
    const files = imageFiles(event.dataTransfer.files);
    if (files.length) attach(files).then(() => input.focus());
    else flash('Only pictures can be dropped here.');
  });

  /** What goes to Claude: your words, then a line per picture. */
  function takeMessage() {
    const text = [input.value.trim(), ...attached].filter(Boolean).join('\n\n');
    input.value = '';
    attached.length = 0;
    showTray();
    autosize();
    return text;
  }

  /* ------------------------------- / menu ------------------------------ */

  // Typing / at the start of the bar: every command this task's session knows, narrowed as you type.
  let slash = null; // the menu on screen: { node, place, rows, at }
  let slashDismissed = false; // Esc: no menu until the bar's text stops being a command name
  const ownCommands = new Map(); // folder -> your own commands and skills, as far as main has said

  const slashKind = () => (view.type === 'agent' ? '' : (task()?.kind ?? draft.kind));
  const slashFolder = () => task()?.cwd || store.project(ctx.currentProject())?.path || '';
  const sessionCommands = () => commandsFor(slashKind(), ownCommands.get(slashFolder()) || []);

  function closeSlash() {
    slash?.node.remove();
    slash = null;
  }

  function markSlash() {
    slash.rows.forEach((row, i) => {
      row.classList.toggle('is-on', i === slash.at);
      row.setAttribute('aria-selected', String(i === slash.at));
    });
    slash.rows[slash.at]?.scrollIntoView({ block: 'nearest' });
  }

  /** A command chosen: run it, unless it needs more from you first (or you asked to add more: Tab). */
  function chooseSlash(command, { more = false } = {}) {
    closeSlash();
    input.value = `/${command.name}${more || command.needs ? ' ' : ''}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (!more && !command.needs) submit();
  }

  function showSlash() {
    const typed = namingCommand(input.value);
    if (typed === null) slashDismissed = false;
    const found = typed === null || slashDismissed || document.activeElement !== input ? [] : matchCommands(sessionCommands(), typed);
    if (!found.length) return closeSlash();
    const picked = slash?.rows[slash.at]?.dataset.name;
    const rows = found.map((command) =>
      el(
        'button',
        {
          class: 'menu-item slash-item',
          type: 'button',
          role: 'option',
          tabindex: '-1',
          'data-name': command.name,
          // On press, and without taking the keyboard from the bar.
          onpointerdown: (event) => {
            event.preventDefault();
            chooseSlash(command);
          },
        },
        el('span', { class: 'slash-name', text: `/${command.name}` }),
        command.hint ? el('span', { class: 'slash-hint', text: command.hint }) : null,
        el('span', { class: 'slash-about', text: command.about })
      )
    );
    if (!slash) {
      const node = el('div', { class: 'pop slash-pop', role: 'listbox', 'aria-label': 'Commands' });
      node.addEventListener('mousemove', (event) => {
        const row = event.target.closest?.('.slash-item');
        const index = row ? slash.rows.indexOf(row) : -1;
        if (index >= 0 && index !== slash.at) {
          slash.at = index;
          markSlash();
        }
      });
      document.body.append(node);
      slash = { node, place: null, rows: [], at: 0 };
    }
    slash.node.replaceChildren(...rows);
    slash.node.style.width = `${composer.offsetWidth}px`;
    slash.rows = rows;
    // (You keep the one you were on while it's still there; a new word starts at the best match.)
    slash.at = Math.max(0, found.findIndex((command) => command.name === picked));
    if (typed) slash.at = 0;
    if (slash.place) slash.place();
    else slash.place = placeNear(slash.node, composer);
    markSlash();
  }

  input.addEventListener('input', () => {
    const typed = namingCommand(input.value);
    // Your own commands: asked for once when the menu first opens for a folder, then it fills in.
    if (typed !== null && slashKind() === 'claude' && !ownCommands.has(slashFolder())) {
      const folder = slashFolder();
      ownCommands.set(folder, []);
      api.commands?.list(folder).then((list) => {
        ownCommands.set(folder, list || []);
        if (slash) showSlash();
      }).catch(() => {});
    }
    showSlash();
  });
  input.addEventListener('blur', () => {
    if (!keepingFocus) closeSlash();
  });

  /** After sending: a picker waits for you in the terminal; a long-running command says it's under way. */
  function afterCommand(read) {
    if (!read) return;
    if (opensTerminal(read)) ctx.showTerminal();
    else if (read.command.note) flash(read.command.note);
  }

  async function submit() {
    closeSlash();
    if ((!input.value.trim() && !attached.length) || blocked) return;
    if (view.type === 'agent') {
      agent.ask(takeMessage());
      return;
    }
    let t = task();
    if (!t) {
      const projectId = ctx.currentProject();
      if (!store.project(projectId)) {
        flash('Add a folder first: tasks only run inside folders you trust.');
        return;
      }
      const text = takeMessage();
      const command = readCommand(text, sessionCommands());
      // (The task opens before this returns: until it does, this is what it shows.)
      sendingFirst = draft.kind === 'shell' ? '' : text;
      t = await ctx.createTask({ projectId, kind: draft.kind, prompt: text, worktree: draft.worktree ?? store.state.settings.worktrees }).finally(() => (sendingFirst = ''));
      draft.worktree = null;
      if (!t) return;
      if (t.kind === 'shell') return;
      if (!opensTerminal(command)) pending.set(t.id, text);
      render({ fresh: true });
      afterCommand(command);
      return;
    }
    const command = readCommand(input.value, sessionCommands());
    const text = takeMessage();
    // Its app went wrong while you used it: fix that too? (asked once; the log is cleared either way)
    const fix = await askToFix(text, t.appErrors, (summary) =>
      confirmDialog({ title: summary.title, body: summary.lines.join('\n'), ok: 'Fix them too', cancel: 'Dismiss' })
    );
    if (fix.clear) store.clearAppErrors(t.id);
    // Watching its page: you stay on it, and it refreshes when the work is done.
    if (mode === 'file') flash(`Sent. ${t.kind === 'shell' ? 'It' : AGENT_NAME[t.kind]} is on it; the page refreshes when it’s done.`);
    if (t.doneAt) store.markDone(t.id, false);
    if (t.kind !== 'shell' && !opensTerminal(command)) pending.set(t.id, text);
    // (A new branch's bar sets off down the page at once, not when the session answers.)
    if (root.classList.contains('is-new-branch')) render({ fresh: true });
    const reply = await ctx.sendToTask(t.id, fix.text);
    if (reply?.error) {
      pending.delete(t.id);
      flash(reply.error);
    }
    render({ fresh: true });
    if (!reply?.error) afterCommand(command);
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    // The / menu has the arrows, Tab, Enter and Esc while it's open.
    if (slash && !event.isComposing) {
      const count = slash.rows.length;
      const chosen = () => sessionCommands().find((command) => command.name === slash.rows[slash.at]?.dataset.name);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        slash.at = (slash.at + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        markSlash();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const command = chosen();
        if (command) chooseSlash(command, { more: event.key === 'Tab' });
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slashDismissed = true;
        closeSlash();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  /* ------------------------------- open ------------------------------- */

  // What you'd started writing in each chat, words and pictures: it stays there when you go elsewhere.
  const drafts = new Map(); // task id, 'agent' or 'new' -> { text, images }
  const draftKey = (v) => (v.type === 'task' ? v.id : v.type);

  function swapDraft(from, to) {
    const text = input.value;
    if (text.trim() || attached.length) drafts.set(draftKey(from), { text, images: [...attached] });
    else drafts.delete(draftKey(from));
    const draftNow = drafts.get(draftKey(to));
    input.value = draftNow?.text || '';
    attached.splice(0, attached.length, ...(draftNow?.images || []));
    showTray();
    autosize();
  }
  store.on('task-deleting', (id) => drafts.delete(id));

  async function show(next) {
    closePop();
    closeSlash();
    swapDraft(view, next);
    view = next;
    shownFrom = null;
    built = new Map();
    parsed = { entries: null, length: -1, list: [] };
    if (next.type === 'new') greeting = '';
    setBlocked('');
    const t = task();
    if (t) tasks.load(t);
    setMode(t?.viewFile && mode === 'file' ? 'file' : mode === 'app' && t && appPane.has(t.id) ? 'app' : 'chat');
    arriving = true;
    render();
    const missingClaude = t && t.kind === 'claude' && !(await ctx.hasClaude());
    const missingFolder = t && !missingClaude && !(await api.folder.exists(t.cwd));
    if (view !== next) return; // another task opened while this checked
    if (missingClaude) setBlocked('Claude Code not found. Install it and sign in, then restart.');
    else if (missingFolder) setBlocked(`Folder not found: ${t.cwd}`);
    if (!blocked) input.focus();
  }

  store.on('change', () => {
    renderMeta();
    if (view.type === 'new') later();
    else if (view.type === 'agent') agentTouched();
  });

  return {
    show,
    flash,
    showContext,
    setMode,
    openFile,
    runApp,
    app: appPane,
    mode: () => mode,
    view: () => view,
    current: () => (view.type === 'task' ? view.id : null),
    refresh: () => render(),
    focus: () => !blocked && input.focus(),
  };
}
