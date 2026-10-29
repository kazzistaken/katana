import { el, icons, placeNear, tokens, spinner } from './util.js';
import { MODELS, EFFORTS } from './store.js';
import { browserGame, exchanges, writtenFiles } from './transcript.js';
import { dither, paintScene } from './dither.js';
import { mountFace, setFaceSource, kick as kickFace } from './face.js';
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
const kindOf = (name) => KIND.find(([, re]) => re.test(name))?.[0] || 'page';
const isDoc = (file) => /\.(md|markdown|txt)$/i.test(String(file || ''));
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
  // A document: its path, Show in Explorer, ×; then its words.
  const docPath = el('span', { class: 'doc-path' });
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
  // How the task runs: one Claude session, or a team (a Leader with workers and verifiers).
  const modeButtons = {
    single: el('button', { class: 'mode-opt', type: 'button', text: 'Single agent', title: 'One Claude Code session does the work', 'aria-pressed': 'true' }),
    hierarchy: el('button', { class: 'mode-opt', type: 'button', text: 'Hierarchy', title: 'A Leader splits the work across 4 workers on their own branches; 2 verifiers check it before it’s merged', 'aria-pressed': 'false' }),
  };
  const modeToggle = el('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'How this task runs' }, modeButtons.single, modeButtons.hierarchy);
  const meta = el('div', { class: 'foot-meta' }, modeToggle, modelText, el('span', { class: 'meta-dot', text: '·', 'aria-hidden': 'true' }), effortText);
  const composer = el('form', { class: 'composer' }, el('span', { class: 'composer-caret', text: '›', 'aria-hidden': 'true' }), input);
  const foot = el('div', { class: 'foot' }, banner, meta, composer);
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

  const task = () => (view.type === 'task' ? store.task(view.id) : null);

  /* ------------------------------ pieces ------------------------------ */

  function userBubble(text) {
    const body = el('span', { class: 'ex-user-text', text });
    const node = el('div', { class: 'ex-user' }, body);
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

  function workBlock({ head, sub, since, tokensNow, usageNow, onStop, needs, waiting = 'Needs you', dots = false }) {
    const statusText = el('span', { class: 'ex-status-text' });
    const node = el(
      'div',
      { class: 'ex-work' },
      el('div', { class: 'ex-status' }, el('span', { class: `status-dot ${needs ? 'is-needs' : 'is-working'}`, 'aria-hidden': 'true' }), statusText),
      el('h2', { class: 'ex-head' }, head, dots ? thinkingDots() : null),
      sub ? el('p', { class: 'ex-sub', text: sub }) : null,
      el(
        'div',
        { class: 'ex-actions' },
        needs ? keyButton('Open terminal', '⌃`', 'Answer it in the terminal (Ctrl+`)', () => ctx.showTerminal()) : null,
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
          el('kbd', { text: '⌃.' })
        )
      )
    );
    const tick = () => {
      const parts = [needs ? waiting : 'Working', duration(Date.now() - since)];
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
      if (kind === 'page') {
        filesEl.append(
          el(
            'button',
            { class: `file-chip${mode === 'file' && task()?.viewFile === file.path ? ' is-open' : ''}`, type: 'button', title: file.path, onclick: () => openFile(file.path) },
            file.name,
            el('small', { text: size(file.size) })
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
      status(`${state} · ${ago(at)}`, error ? 'failed' : ''),
      el('h2', { class: `ex-head${error ? ' is-error' : ''}` }, inline(head || (state === 'Stopped' ? 'Stopped.' : 'Done.'))),
      buttons?.length ? el('div', { class: 'ex-actions' }, buttons) : null,
      filesEl,
      mediaEl,
      rest ? el('div', { class: 'ex-body' }, blocks(rest)) : null,
    ];
    fillFiles(key, [...(files || []), ...pathsIn(text)], base, filesEl, mediaEl);
    return nodes.filter(Boolean);
  }

  /* ------------------------------ tasks ------------------------------- */

  function taskButtons(current) {
    const buttons = [];
    if (!current.doneAt) buttons.push(keyButton('Done', '⌃D', 'Done with this task (Ctrl+D)', () => ctx.done(current.id)));
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

  function taskExchange(ex, last, current) {
    const t = tasks.get(current.id);
    // The leader's [team] notes are the daemon's, not yours: shown as a line, not a bubble.
    const node = el('section', { class: 'ex' }, ex.prompts.filter((p) => !TEAM_NOTE.test(p.text)).map((p) => userBubble(p.text)));
    node.append(...teamLines(current, ex, list[list.indexOf(ex) + 1]));
    // The leader waits while its team works: say who.
    const crew = last && t.state === 'idle' && ctx.team?.busy(current.id) ? ctx.team.working(current.id) : [];
    if (crew.length) node.append(el('div', { class: 'ex-team is-live' }, teamRow('Team', `working · ${crew.join(', ')}`, 'live')));
    const working = last && (t.state === 'working' || t.state === 'needs');
    if (working) {
      const tool = t.tool;
      node.append(
        workBlock({
          needs: t.state === 'needs',
          waiting: tasks.waiting(current.id),
          head: t.state === 'needs' ? (t.need === 'asking' ? 'Claude is asking you' : 'Claude needs your permission') : 'Thinking',
          sub: t.state === 'needs' ? t.message : tool ? tool.desc || `${tool.name} ${tool.detail || ''}`.trim() : '',
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
    list = exchanges(t.transcript.entries);
    // Sent but not in the transcript yet: shown at once.
    const waiting = pending.get(current.id);
    if (waiting && list.some((ex) => ex.prompts.some((p) => p.text.trim() === waiting.trim()))) pending.delete(current.id);
    else if (waiting) list.push({ prompts: [{ text: waiting, at: Date.now() }], texts: [], tools: [], interrupted: false, at: Date.now() });
    if (!list.length) {
      // (A hierarchy task whose team has done things shows them, even before its leader's transcript is read.)
      if (t.state === 'working' || t.state === 'needs' || ctx.team?.get(current.id)?.log.length) list.push({ prompts: [], texts: [], tools: [], interrupted: false, at: Date.now() });
      else {
        column.replaceChildren(
          el('div', { class: 'newtask' }, el('h2', { class: 'newtask-title', text: current.title }), el('p', { class: 'newtask-text', text: current.kind === 'claude' ? 'Nothing here yet. Write to Claude below.' : 'This task runs in its terminal (>_).' }))
        );
        return;
      }
    }
    if (list.length > (counts.get(current.id) ?? list.length)) fresh = true;
    counts.set(current.id, list.length);
    if (fresh || shownFrom === null || shownFrom > list.length - 1) shownFrom = list.length - 1;
    const nodes = list.slice(shownFrom).map((ex, i, shown) => taskExchange(ex, i === shown.length - 1, current));
    if (fresh) nodes.at(-1).classList.add('is-new');
    column.replaceChildren(...nodes);
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

  function reviewStrip() {
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

  /* --------------------------- agent: portrait ------------------------- */

  /*
   * Katana's face, alive while it's on screen (face.js): she breathes,
   * blinks, her mouth shapes the words she says, a light crosses her face
   * while she thinks, and she's mint while the mic is open for her.
   */
  const portrait = mountFace(el('canvas', { class: 'agent-portrait', 'aria-hidden': 'true' }));

  /** Is she speaking out loud right now (her voice, a call, or Windows' voice)? */
  function voicing() {
    const call = ctx.live?.();
    if (call?.active()) return typeof call.label === 'function' ? call.state() === 'speaking' : call.speaking();
    return 'speechSynthesis' in window && speechSynthesis.speaking;
  }

  setFaceSource(() => {
    const call = ctx.live?.();
    const turns = call?.active() && typeof call.label === 'function';
    const speaking = voicing();
    return {
      // Mint means the mic is open for her: a turn's mic, dictation, or a call while she's quiet.
      listening: !speaking && Boolean(turns ? call.micOpen() : ctx.isListening?.()),
      thinking: agent.busy() || Boolean(call?.active() && ['thinking', 'connecting'].includes(call.state())),
      speaking,
    };
  });

  // The face's words and Talk button, kept current during a call (refreshVoice).
  let replyEl = null;
  let talkEl = null;

  function heardText() {
    const call = ctx.live?.();
    if (call?.heard()) return `› ${call.heard()}`;
    const asked = [...store.state.agent.messages].reverse().find((m) => m.role === 'user' || m.role === 'event');
    if (asked) return `› ${asked.text}`;
    if (call?.active()) return call.micOpen?.() === false ? '' : 'Listening…';
    return 'Talk or type to Katana: she runs the app, starts tasks and tells you when they finish.';
  }

  function replyNode() {
    const call = ctx.live?.();
    if (call?.said()) return el('p', { class: 'agent-reply is-live' }, call.said());
    // Talking a turn at a time: her answer shows only once her voice says it.
    const waiting = call?.active() && typeof call.label === 'function' && call.state() === 'thinking';
    if (agent.busy() || waiting) return el('p', { class: 'agent-reply is-thinking' }, spinner(), ` ${agent.busy() && agent.activity() ? clipWords(agent.activity()) : 'Thinking'}`, thinkingDots());
    if (call?.state() === 'connecting') return el('p', { class: 'agent-reply is-thinking' }, spinner(), ' Connecting');
    const said = [...store.state.agent.messages].reverse().find((m) => m.role === 'agent' || m.role === 'error');
    return said ? el('p', { class: `agent-reply${said.role === 'error' ? ' is-error' : ''}`, title: 'Show the conversation', onclick: () => setAgentMode('doc') }, inline(said.text)) : el('p', { class: 'agent-reply', hidden: true });
  }

  function talkButton() {
    const call = ctx.live?.();
    const inCall = Boolean(call?.active());
    // A turn-at-a-time conversation says what it's doing; mint only while the mic is open.
    const turns = inCall && typeof call.label === 'function';
    const label = turns ? call.label() : inCall ? (call.state() === 'connecting' ? 'Connecting…' : 'Hang up') : 'Talk to Katana';
    return el(
      'button',
      {
        class: `mic-btn talk-btn${ctx.isListening?.() && !turns ? ' is-listening' : ''}${inCall && !turns ? ' is-call' : ''}${turns ? ' is-turns' : ''}${turns && call.micOpen() ? ' is-mic' : ''}`,
        type: 'button',
        title: turns ? (call.micOpen() ? 'Done talking (Tab)' : 'Stop (Tab)') : inCall ? 'Hang up (Tab)' : 'Talk to Katana (Tab)',
        onpointerdown: (event) => event.preventDefault(),
        onclick: () => ctx.toggleVoice(),
      },
      el('span', { class: 'talk-mic', html: icons.mic }),
      el('span', { class: 'talk-label', text: label }),
      el('kbd', { text: 'tab' })
    );
  }

  /** During a call: what you say, what she says, the button; without redrawing the face. */
  function refreshVoice() {
    if (view.type !== 'agent' || agentMode !== 'avatar' || !heard?.isConnected) return;
    heard.textContent = heardText();
    // Only what changed is replaced, so nothing replays its entrance.
    const same = (a, b) => a.className === b.className && a.textContent === b.textContent;
    const nextReply = replyNode();
    if (!same(nextReply, replyEl)) {
      replyEl.replaceWith(nextReply);
      replyEl = nextReply;
      markLong();
    }
    const nextTalk = talkButton();
    if (!same(nextTalk, talkEl)) {
      talkEl.replaceWith(nextTalk);
      talkEl = nextTalk;
    }
    kickFace();
  }

  /** Her reply's slot fades its edge only when there's more than fits. */
  function markLong() {
    requestAnimationFrame(() => {
      const slot = replyEl?.parentElement;
      if (slot?.classList.contains('agent-said')) slot.classList.toggle('is-long', replyEl.offsetHeight > slot.clientHeight + 1);
    });
  }
  window.addEventListener('resize', () => replyEl?.isConnected && markLong());

  function avatarScreen() {
    heard = el('p', { class: 'agent-heard', text: heardText() });
    replyEl = replyNode();
    talkEl = talkButton();
    kickFace();
    // Her words sit in a slot of fixed height right under her face, so a
    // short or long reply never moves her; the review strip has a box of its own.
    const review = reviewStrip();
    markLong();
    return el(
      'div',
      { class: `agent-stage${review ? ' has-review' : ''}` },
      portrait.element,
      el('div', { class: 'agent-said' }, replyEl),
      heard,
      talkEl,
      review
    );
  }

  let heard = null;
  let agentMode = (() => {
    try {
      return localStorage.getItem('x2.agentMode') === 'doc' ? 'doc' : 'avatar';
    } catch {
      return 'avatar';
    }
  })();

  /** The agent as a face (avatar) or as its conversation (doc). */
  function setAgentMode(next) {
    agentMode = next === 'doc' ? 'doc' : 'avatar';
    try {
      localStorage.setItem('x2.agentMode', agentMode);
    } catch {
      /* remembered for this window only */
    }
    render();
    ctx.onMode?.(mode);
    if (agentMode === 'doc') input.focus();
  }

  // What you're saying shows under the face as you say it.
  input.addEventListener('input', () => {
    if (heard?.isConnected && input.value.trim()) heard.textContent = `› ${input.value.trim()}`;
  });

  // On the face: Tab talks (voice.js); typing anything else (not a space) opens the conversation to type in.
  document.addEventListener('keydown', (event) => {
    if (view.type !== 'agent' || agentMode !== 'avatar' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable], .xterm') || !root.offsetParent) return;
    if (event.code === 'Space') event.preventDefault();
    else if (event.key.length === 1) setAgentMode('doc');
  });

  function renderAgent(fresh) {
    if (agentMode === 'avatar') {
      column.replaceChildren(avatarScreen());
      return;
    }
    list = agentExchanges();
    const strip = reviewStrip();
    if (!list.length && !agent.busy()) {
      column.replaceChildren(...[strip, introScreen()].filter(Boolean));
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
      node.append(workBlock({ head: 'Thinking', dots: true, sub: agent.activity() ? clipWords(agent.activity()) : '', since: agent.since(), tokensNow: () => 0, onStop: () => agent.stop() }));
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

  function introScreen() {
    const art = el('canvas', { class: 'newtask-art', 'aria-hidden': 'true' });
    requestAnimationFrame(() => dither(art, { cell: 2, paint: paintScene }));
    return el(
      'div',
      { class: 'newtask' },
      art,
      el('h2', { class: 'newtask-title', text: 'Katana' }),
      el('p', {
        class: 'newtask-text',
        text: 'Tell me what you want done. I start tasks in your folders, keep an eye on them, and tell you when they finish or need you. I can also set reminders and change settings.',
      })
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

  const AGENT_NAME = { claude: 'Claude', codex: 'Codex', shell: 'a shell' };

  /** The line under the box: who, how hard, where — each part opens its menu. */
  function chooserLine() {
    const { settings } = store.state;
    const model = MODELS.find((m) => m.id === settings.taskModel)?.name || 'Claude';
    const project = store.project(ctx.currentProject());
    const worktree = Boolean(draft.worktree ?? settings.worktrees);
    const who = el('button', { class: 'chooser', type: 'button', text: draft.kind === 'claude' ? `Claude ${model}` : AGENT_NAME[draft.kind] });
    const effort = el('button', { class: 'chooser', type: 'button', text: `${(EFFORTS.find((e) => e.id === settings.taskEffort) || EFFORTS[1]).label.toLowerCase()} effort` });
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
        { label: 'Codex', on: draft.kind === 'codex', run: () => (draft.kind = 'codex') },
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
      draft.kind === 'claude' ? [', ', effort] : null,
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
    return el(
      'div',
      { class: 'newtask' },
      el('p', { class: 'newtask-today', text: todayLine() }),
      el('h2', { class: 'newtask-greeting', text: greeting }),
      hasFolders ? meta : null,
      composer,
      hasFolders ? chooserLine() : el('p', { class: 'newtask-with' }, el('button', { class: 'chooser', type: 'button', text: 'Add a folder', onclick: () => ctx.addProject() }), ' to start: tasks only run inside folders you trust.')
    );
  }

  /* ------------------------------ render ------------------------------ */

  function render({ fresh = false } = {}) {
    renderQueued = 0;
    if (view.type === 'task' && !task()) view = { type: 'new' };
    if (view.type === 'task') renderTask(fresh);
    else if (view.type === 'agent') renderAgent(fresh);
    else column.replaceChildren(newTaskScreen());
    // New task has its box in the middle; everywhere else it sits at the bottom.
    const isNew = view.type === 'new';
    const face = view.type === 'agent' && agentMode === 'avatar';
    stage.classList.toggle('is-new', isNew);
    stage.classList.toggle('is-face', face);
    foot.classList.toggle('is-empty', isNew);
    // The face has no box: it listens (Tab) or opens the conversation to type.
    foot.classList.toggle('is-ghost', face);
    if (!isNew && meta.parentNode !== foot) foot.insertBefore(meta, composer.parentNode === foot ? composer : null);
    if (!isNew && composer.parentNode !== foot) foot.append(composer);
    if (fresh) stage.scrollTop = 0;
    renderMeta();
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
      const node = view.type === 'task' ? taskExchange(list[shownFrom], false, current) : agentExchange(list[shownFrom], false);
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
    if (view.type === 'agent') later();
    if (type === 'error' && view.type === 'task' && view.id === id) flash(message);
    // A turn finished while its page is open: show what it made.
    if (type === 'finished' && view.type === 'task' && view.id === id && (mode === 'file' || (mode === 'app' && appPane.isPage(id)))) showFinishedPage(id);
    // A turn that made a browser game: its page goes in the viewer (the globe), even unopened.
    else if (type === 'finished') {
      const last = exchanges(tasks.get(id)?.transcript.entries || []).at(-1);
      const game = last ? browserGame(last, store.task(id)?.title) : '';
      if (game && game !== store.task(id)?.viewFile) {
        store.patchTask(id, { viewFile: game });
        if (view.type === 'task' && view.id === id) ctx.onMode?.(mode);
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
    stage.hidden = mode !== 'chat';
    viewer.hidden = mode === 'chat';
    viewer.classList.toggle('is-app', mode === 'app');
    root.classList.toggle('is-app', mode === 'app');
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
      for (const chip of column.querySelectorAll('.file-chip.is-open')) chip.classList.remove('is-open');
    }
    ctx.onMode?.(mode);
  }

  /** A web page in the app viewer: started, or the running one shown (the same page isn't started again). */
  function showPage(t, file) {
    const running = appPane.state(t.id);
    if (!(appPane.isLive(t.id) && samePath(running?.page, file))) appPane.run(t, { page: file });
  }

  /**
   * Runs the task's app (`command`, else its package.json's) or shows a
   * page (`page`), and shows it if `show` and it's the task on screen.
   * A failure isn't shown: it's logged with the task's errors (main).
   */
  async function runApp(id, { command = '', page = '', show = true, cwd = '' } = {}) {
    const t = store.task(id);
    if (!t) return { error: 'There’s no task like that.' };
    const reply = await appPane.run(t, { command, page, cwd });
    if (!reply?.error && show && view.type === 'task' && view.id === id) setMode('app');
    return reply;
  }

  /** Back to the task from the app viewer. A page ends (it starts again in a moment); an app keeps running. */
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
  function showFinishedPage(id) {
    const last = exchanges(tasks.get(id).transcript.entries).at(-1);
    const page = last ? writtenFiles(last).filter((file) => /\.html?$/i.test(file)).at(-1) : '';
    if (page && page !== task()?.viewFile && !isDoc(task()?.viewFile)) {
      store.patchTask(id, { viewFile: page });
      setMode('file');
    }
    // The transcript's last lines land a moment after the turn ends.
    setTimeout(reloadViewer, 400);
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
    if (t) return { model: t.model || settings.taskModel, effort: t.effort || settings.taskEffort, task: t };
    if (draft.kind === 'claude' && settings.taskMode === 'hierarchy') return { model: settings.managerModel, effort: settings.managerEffort, keys: ['managerModel', 'managerEffort'] };
    return { model: settings.taskModel, effort: settings.taskEffort, keys: ['taskModel', 'taskEffort'] };
  }

  function renderMeta() {
    const t = task();
    const kind = t ? t.kind : view.type === 'new' ? draft.kind : 'claude';
    meta.hidden = kind !== 'claude';
    const { model, effort } = current();
    const name = MODELS.find((m) => m.id === model)?.name || 'Model';
    const mode = taskMode();
    modeToggle.hidden = view.type === 'agent' || kind !== 'claude';
    for (const [key, button] of Object.entries(modeButtons)) {
      button.classList.toggle('is-on', key === mode);
      button.setAttribute('aria-pressed', String(key === mode));
    }
    // Not while it works: the switch waits for the turn to end.
    const busy = Boolean(t) && ['working', 'needs'].includes(tasks.get(t.id).state);
    modeToggle.classList.toggle('is-locked', busy);
    modeToggle.title = busy ? 'Switch once it’s done (or stop it first)' : t ? 'How this task runs' : 'How new tasks run';
    modelText.textContent = view.type === 'agent' ? `Katana · ${name}` : mode === 'hierarchy' ? `Leader · ${name}` : name;
    modelText.title = view.type === 'agent' ? 'Katana’s model' : mode === 'hierarchy' ? 'The Leader’s model (workers’ and verifiers’: Settings → Hierarchy)' : t ? 'This task’s model' : 'Model for new tasks';
    effortText.textContent = `${(EFFORTS.find((e) => e.id === effort) || EFFORTS[1]).label.toLowerCase()} effort`;
    effortText.title = t ? 'Takes effect when the task next starts' : 'How hard it thinks';
    input.placeholder = placeholder();
  }

  /** 'single' or 'hierarchy': the open task's, or new tasks'. */
  function taskMode() {
    const t = task();
    if (t) return t.mode === 'hierarchy' ? 'hierarchy' : 'single';
    return store.state.settings.taskMode === 'hierarchy' ? 'hierarchy' : 'single';
  }

  async function chooseMode(next) {
    const t = task();
    if (!t) store.setSetting('taskMode', next);
    else await ctx.setTaskMode(t.id, next);
    render();
    input.focus();
  }
  for (const [key, button] of Object.entries(modeButtons)) button.addEventListener('click', () => chooseMode(key));

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
      if (which === 'model' && tasks.get(now.task.id).running) api.task.say(now.task.id, `/model ${value}`);
    } else store.setSetting(now.keys[which === 'model' ? 0 : 1], value);
    renderMeta();
  }

  function closePop() {
    if (!pop) return;
    pop.node.remove();
    pop.anchor.setAttribute('aria-expanded', 'false');
    pop = null;
  }

  function openPop(anchor, node) {
    closePop();
    document.body.append(node);
    placeNear(node, anchor);
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
    if (pop?.anchor === modelText) return closePop();
    const { model } = current();
    openPop(
      modelText,
      el(
        'div',
        { class: 'pop', role: 'menu', 'aria-label': 'Model' },
        MODELS.map((m) =>
          el('button', {
            class: `menu-item${m.id === model ? ' is-on' : ''}`,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(m.id === model),
            html: `<span class="chip-mark">${icons.claude}</span><span>${m.name}</span>`,
            onclick: () => {
              setChoice('model', m.id);
              closePop();
              input.focus();
            },
          })
        )
      )
    );
  });

  effortText.addEventListener('click', () => openEffort(effortText));

  /** The effort slider, under whichever button asked for it. */
  function openEffort(anchor) {
    if (pop?.anchor === anchor) return closePop();
    const index = Math.max(0, EFFORTS.findIndex((e) => e.id === current().effort));
    const slider = el('input', { class: 'slider', type: 'range', min: '0', max: String(EFFORTS.length - 1), step: '1', value: String(index), 'aria-label': 'Effort' });
    const steps = EFFORTS.map((step, i) =>
      el('button', {
        type: 'button',
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
      slider.style.setProperty('--fill', `${(i / (EFFORTS.length - 1)) * 100}%`);
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
        slider,
        el('div', { class: 'effort-steps' }, steps),
        el('p', { class: 'effort-hint', text: task() ? 'Takes effect when this task next starts.' : 'Higher effort thinks longer and is slower.' })
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
  function flash(text) {
    if (blocked || !text) return;
    clearTimeout(flashTimer);
    banner.textContent = text;
    banner.hidden = false;
    flashTimer = setTimeout(() => {
      if (!blocked) banner.hidden = true;
    }, 6000);
  }

  function setBlocked(reason) {
    blocked = reason;
    banner.hidden = !reason;
    banner.textContent = reason;
    input.disabled = Boolean(reason);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.max(18, Math.min(input.scrollHeight, 200))}px`;
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || blocked) return;
    if (view.type === 'agent') {
      input.value = '';
      autosize();
      agent.ask(text);
      return;
    }
    let t = task();
    if (!t) {
      const projectId = ctx.currentProject();
      if (!store.project(projectId)) {
        flash('Add a folder first: tasks only run inside folders you trust.');
        return;
      }
      input.value = '';
      autosize();
      t = await ctx.createTask({ projectId, kind: draft.kind, prompt: text, worktree: draft.worktree ?? store.state.settings.worktrees });
      draft.worktree = null;
      if (!t) return;
      if (t.kind !== 'claude') return;
      pending.set(t.id, text);
      render({ fresh: true });
      return;
    }
    input.value = '';
    autosize();
    // Its app went wrong while you used it: fix that too? (asked once; the log is cleared either way)
    const fix = await askToFix(text, t.appErrors, (summary) =>
      confirmDialog({ title: summary.title, body: summary.lines.join('\n'), ok: 'Fix them too', cancel: 'Dismiss' })
    );
    if (fix.clear) store.clearAppErrors(t.id);
    // Watching its page: you stay on it, and it refreshes when the work is done.
    if (mode === 'file') flash(`Sent. ${t.kind === 'claude' ? 'Claude' : 'It'} is on it; the page refreshes when it’s done.`);
    if (t.doneAt) store.markDone(t.id, false);
    if (t.kind === 'claude') pending.set(t.id, text);
    const reply = await ctx.sendToTask(t.id, fix.text);
    if (reply?.error) {
      pending.delete(t.id);
      flash(reply.error);
    }
    render({ fresh: true });
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  /* ------------------------------- open ------------------------------- */

  async function show(next) {
    closePop();
    view = next;
    shownFrom = null;
    if (next.type === 'new') greeting = '';
    setBlocked('');
    const t = task();
    if (t) tasks.load(t);
    setMode(t?.viewFile && mode === 'file' ? 'file' : mode === 'app' && t && appPane.has(t.id) ? 'app' : 'chat');
    render();
    if (t && t.kind === 'claude' && !(await ctx.hasClaude())) setBlocked('Claude Code not found. Install it and sign in, then restart.');
    else if (t && !(await api.folder.exists(t.cwd))) setBlocked(`Folder not found: ${t.cwd}`);
    if (!blocked) input.focus();
  }

  store.on('change', () => {
    renderMeta();
    if (view.type === 'new' || view.type === 'agent') later();
  });

  return {
    show,
    flash,
    showContext,
    setMode,
    openFile,
    runApp,
    app: appPane,
    setAgentMode,
    refreshVoice,
    agentMode: () => agentMode,
    mode: () => mode,
    view: () => view,
    current: () => (view.type === 'task' ? view.id : null),
    refresh: () => render(),
    focus: () => !blocked && input.focus(),
  };
}
