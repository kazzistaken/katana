import { el, icons } from './util.js';
import { MODELS, EFFORTS } from './store.js';
import { confirmDialog } from './dialog.js';
import { VOICES } from './live.js';
import { SPEECH_VOICES } from './talk.js';

/**
 * The Settings page: one quiet page in the main panel, each group's name on
 * the left and its settings on the right. Groups are data (GROUPS): a field
 * is a toggle, a row of choices, or `render` for anything else, so a new
 * setting is one more entry. Esc or the × returns to where you were.
 */

const toggle = (key, label, help) => ({ type: 'toggle', key, label, help });
const choices = (key, label, help, options) => ({ type: 'choices', key, label, help, options });

const modelOptions = MODELS.map((model) => ({ value: model.id, label: model.name }));
const effortOptions = EFFORTS.map((effort) => ({ value: effort.id, label: effort.label }));

export const THEMES = [
  { value: 'system', label: 'Match my PC' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'black', label: 'Near black' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'rose-pine', label: 'Rosé Pine' },
  { value: 'nord', label: 'Nord' },
  { value: 'light', label: 'Light' },
];

export const GROUPS = [
  {
    label: 'Look',
    fields: [
      choices('textSize', 'Text size', null, [
        { value: 'default', label: 'Default' },
        { value: 'larger', label: 'Larger' },
      ]),
      choices('theme', 'Theme', null, THEMES),
      toggle('showUsage', 'Show usage in the status line'),
      choices('motion', 'Animations', null, [
        { value: 'full', label: 'Full' },
        { value: 'reduced', label: 'Reduced' },
        { value: 'off', label: 'Off' },
      ]),
    ],
  },
  {
    label: 'Tasks',
    fields: [
      toggle('bypassPermissions', 'Bypass permissions', 'New tasks change files and run commands without asking.'),
      choices('taskModel', 'Model', 'For new Claude Code tasks. A task can change it above its prompt bar.', modelOptions),
      choices('taskEffort', 'Effort', null, effortOptions),
      toggle('worktrees', 'Give each new task its own worktree', 'A separate git checkout on its own branch, so tasks in one folder don’t collide. Merge brings it back.'),
    ],
  },
  {
    label: 'Hierarchy',
    fields: [
      choices('taskMode', 'New tasks run as', 'Hierarchy: the Leader you talk to splits the work across 4 workers (each its own Claude Code session, on its own branch) and has 2 verifiers check it before merging. Switch it per task beside the model above the prompt bar.', [
        { value: 'single', label: 'Single agent' },
        { value: 'hierarchy', label: 'Hierarchy' },
      ]),
      choices('managerModel', 'Leader model', 'Plans, assigns, sends back and merges; writes no code. A task can change it above its prompt bar.', modelOptions),
      choices('managerEffort', 'Leader effort', null, effortOptions),
      choices('workerModel', 'Worker model', 'The workers that write the code. Started only when the Leader has work for them.', modelOptions),
      choices('workerEffort', 'Worker effort', null, effortOptions),
      choices('verifierModel', 'Verifier model', 'The verifiers that review the diff, run the tests and try the app before the Leader accepts it.', modelOptions),
      choices('verifierEffort', 'Verifier effort', null, effortOptions),
    ],
  },
  {
    label: 'Katana',
    fields: [
      toggle('wakeAgent', 'Wake Katana when a task finishes', 'It reads what the task did and tells you, instead of just a ding.'),
      choices('agentModel', 'Model', 'Her brain. She runs the whole app with its own controls, so Opus 5.5 does it best.', modelOptions),
      choices('agentEffort', 'Effort', null, effortOptions),
      toggle('liveVoice', 'Talk out loud with GPT-Live', 'With an OpenAI key, Talk (or Tab on her page) starts a live voice call: GPT-Live listens and speaks, Katana does the work.'),
      { type: 'key', service: 'live', label: 'OpenAI key', help: 'For GPT-Live and dictation (OpenAI hears better than Windows). Kept on this PC, sealed by Windows; never shown again.' },
      choices(
        'liveVoiceName',
        'GPT-Live voice',
        'Takes effect on the next call.',
        VOICES.map((voice) => ({ value: voice, label: voice[0].toUpperCase() + voice.slice(1) }))
      ),
      {
        type: 'key',
        service: 'openrouter',
        placeholder: 'sk-or-…',
        label: 'OpenRouter key',
        help: 'Without GPT-Live: Talk hears you through OpenRouter, a turn at a time, and she answers out loud; dictation uses it too. Kept on this PC, sealed by Windows.',
      },
      toggle(
        'wakeWord',
        'Listen for “Katana”',
        'Say “Katana” or “hey Katana” to talk to her, or “Katana, …” with what you want. While the window is open the mic stays on, and short bursts of speech go to OpenRouter to check for her name (needs the OpenRouter key).'
      ),
      {
        type: 'key',
        service: 'elevenlabs',
        placeholder: 'sk_…',
        label: 'ElevenLabs key (optional)',
        help: 'Her voice straight from ElevenLabs instead of through OpenRouter: it says when each sound is said, so her lips keep exact time. Kept on this PC, sealed by Windows.',
      },
      choices(
        'speechVoice',
        'Her voice (OpenRouter)',
        null,
        SPEECH_VOICES.map((voice) => ({ value: voice, label: voice[0].toUpperCase() + voice.slice(1) }))
      ),
      toggle(
        'bargeIn',
        'Interrupt her by talking',
        'Start talking while she speaks and she stops to listen. Short sounds, typing and her own voice from the speakers don’t count. While she speaks the mic stays on to hear you. Off: Tab still interrupts her (in a GPT-Live call it hangs up).'
      ),
      choices('bargeInSensitivity', 'Interrupt sensitivity', 'Low needs longer, louder speech (a noisy room, speakers turned up); high stops her sooner.', [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ]),
    ],
  },
  {
    label: 'Your turn',
    fields: [
      { type: 'text', key: 'userName', label: 'Your name', help: 'What Katana calls you. Empty: your Windows user name.' },
      toggle('notifications', 'Notifications', 'On — while you’re in another app'),
      toggle('ding', 'Ding when a task needs you or a reminder is due', 'A finished task is a quiet notification (when you’re in another app).'),
      toggle('speakWhenDone', 'Katana speaks up when tasks finish', 'She says it out loud. Off: a notification.'),
      toggle('openAtLogin', 'Open Katana when I log in, so she can always tap you'),
      toggle('reopenLastChat', 'Open the last task on start'),
      toggle('confirmDeletes', 'Ask before deleting'),
    ],
  },
  {
    label: 'Computers',
    render: (ctx) => computersGroup(ctx),
  },
  {
    label: 'Folders',
    render: (ctx) => foldersGroup(ctx),
  },
  {
    label: 'Terminal',
    fields: [
      { type: 'choices', key: 'shell', label: 'Shell', help: 'What a Shell task runs.', options: (ctx) => ctx.shells() },
      choices(
        'terminalFontSize',
        'Font size',
        null,
        [11, 12, 13, 14, 16].map((size) => ({ value: size, label: `${size}` }))
      ),
    ],
  },
  {
    label: 'About',
    render: (ctx) => aboutGroup(ctx),
  },
];

/* ------------------------------ fields ------------------------------- */

function fieldRow(field, control, stacked = false) {
  return el(
    'div',
    { class: `set-field${stacked ? ' is-stacked' : ''}` },
    el(
      'div',
      { class: 'set-field-text' },
      el('p', { class: 'set-name', text: field.label }),
      field.help ? el('p', { class: 'set-help', text: field.help }) : null
    ),
    control
  );
}

function field(ctx, spec) {
  const { store } = ctx;
  const value = store.state.settings[spec.key];
  if (spec.type === 'note') return fieldRow(spec, null);
  if (spec.type === 'key') return keyField(ctx, spec);
  if (spec.type === 'text') {
    const box = el('input', { class: 'text-field', type: 'text', value: value || '', 'aria-label': spec.label, spellcheck: 'false' });
    box.addEventListener('change', () => store.setSetting(spec.key, box.value.trim()));
    return fieldRow(spec, box, true);
  }
  if (spec.type === 'toggle') {
    const button = el('button', {
      class: 'toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': String(Boolean(value)),
      'aria-label': spec.label,
      onclick: () => {
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(next));
        store.setSetting(spec.key, next);
      },
    });
    return fieldRow(spec, button);
  }
  const options = typeof spec.options === 'function' ? spec.options(ctx) : spec.options;
  const group = el('div', { class: 'chips', role: 'group', 'aria-label': spec.label });
  for (const option of options) {
    const button = el('button', {
      class: 'chip-opt',
      type: 'button',
      text: option.label,
      'aria-pressed': String(String(option.value) === String(value ?? '')),
      onclick: () => {
        for (const other of group.children) other.setAttribute('aria-pressed', String(other === button));
        store.setSetting(spec.key, option.value);
      },
    });
    group.append(button);
  }
  return fieldRow(spec, group, true);
}

/** A secret: typed in, handed to main, never read back (only whether one is set). */
function keyField(ctx, spec) {
  const keys = ctx.api[spec.service || 'live'];
  const blank = spec.placeholder || 'sk-…';
  const box = el('input', { class: 'text-field', type: 'password', placeholder: blank, 'aria-label': spec.label, spellcheck: 'false', autocomplete: 'off' });
  const state = el('span', { class: 'set-help key-state' });
  const clear = el('button', { class: 'text-btn is-danger', type: 'button', text: 'Remove', hidden: true });
  const show = (has) => {
    state.textContent = has ? 'A key is set.' : 'No key yet.';
    clear.hidden = !has;
    box.placeholder = has ? 'Paste a new key to replace it' : blank;
  };
  keys.hasKey().then(show).catch(() => show(false));
  const save = async (value) => {
    show(await keys.setKey(value));
    box.value = '';
    ctx.refreshLiveKey?.();
  };
  box.addEventListener('change', () => box.value.trim() && save(box.value.trim()));
  clear.addEventListener('click', () => save(''));
  return fieldRow(spec, el('div', { class: 'key-row' }, box, state, clear), true);
}

/* ------------------------- custom groups ----------------------------- */

function foldersGroup(ctx) {
  const { projects } = ctx.store.state;
  return [
    el(
      'div',
      {},
      projects.map((project) =>
        el(
          'div',
          { class: 'folder-row' },
          el('span', { class: 'folder-name', text: project.name }),
          el('span', { class: 'folder-path', text: project.path, title: project.path }),
          el('button', { class: 'text-btn is-danger', type: 'button', text: 'Remove', onclick: () => ctx.removeProject(project) })
        )
      ),
      projects.length ? null : el('p', { class: 'set-help', text: 'No trusted folders yet.' })
    ),
    el('div', {}, el('button', { class: 'text-btn', type: 'button', text: '+ Add a folder', onclick: () => ctx.addProject() })),
  ];
}

function computersGroup(ctx) {
  const info = ctx.info() || {};
  const found = ctx.found() || {};
  return [
    fieldRow({ label: 'this PC', help: [info.computer, info.system].filter(Boolean).join(' · ') || null }, el('span', { class: 'about-value', text: 'Runs tasks here' })),
    fieldRow({ label: 'Claude Code', help: found.claude ? 'Installed and signed in through its own CLI.' : 'Not found. Install it and sign in.' }, null),
    fieldRow({ label: 'Codex', help: found.codex ? 'Installed.' : 'Not installed: npm i -g @openai/codex, then sign in.' }, null),
  ];
}

function aboutGroup(ctx) {
  const info = ctx.info() || {};
  const row = (label, value) => fieldRow({ label }, el('span', { class: 'about-value', text: value || '—' }));
  return [row('Version', info.version), row('Claude Code', info.claude || 'Not found'), row('Data folder', info.dataDir), backgroundRow(ctx)];
}

/** katanad: the tasks keep running in it when the window closes; stop them all here. */
function backgroundRow(ctx) {
  const value = el('span', { class: 'about-value', text: '…' });
  const stop = el('button', { class: 'text-btn is-danger', type: 'button', text: 'Stop all tasks', hidden: true });
  const show = async () => {
    const status = await ctx.api.daemon.status().catch((error) => ({ error: error.message }));
    if (status?.error) {
      value.textContent = 'Not running';
      stop.hidden = true;
      return;
    }
    const n = status.running || 0;
    value.textContent = `${n ? `${n} task${n === 1 ? '' : 's'} running` : 'Nothing running'}${status.inProcess ? ' (in the app)' : ''}${status.stale ? ' · updates when idle' : ''}`;
    stop.hidden = !n;
  };
  stop.addEventListener('click', async () => {
    const ok =
      !ctx.store.state.settings.confirmDeletes ||
      (await confirmDialog({ title: 'Stop every running task?', body: 'Their sessions end. Claude tasks can be resumed later; shells start over.', ok: 'Stop all', danger: true }));
    if (!ok) return;
    await ctx.api.daemon.stopAll();
    setTimeout(show, 400);
  });
  show();
  return fieldRow(
    { label: 'Background tasks', help: 'Tasks and Katana run in a background process (katanad): closing or reloading the window never ends them, and she still reminds and notifies you.' },
    el('div', { class: 'key-row' }, value, stop)
  );
}

/* ------------------------------- page -------------------------------- */

export function initSettingsPage(ctx) {
  const root = document.querySelector('#settings');
  const inner = el('div', { class: 'settings-inner' });
  const close = el('button', { class: 'icon settings-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close settings', html: icons.x, onclick: () => ctx.closeSettings() });
  root.replaceChildren(close, inner);

  function render() {
    const scroll = root.scrollTop;
    inner.replaceChildren(
      ...GROUPS.map((group) =>
        el(
          'section',
          { class: 'set-group', 'aria-label': group.label },
          el('h2', { class: 'set-group-label', text: group.label }),
          el('div', { class: 'set-fields' }, group.render ? group.render(ctx) : group.fields.map((spec) => field(ctx, spec)))
        )
      )
    );
    root.scrollTop = scroll;
  }

  // Folders change from here and from the sidebar.
  let folders = '';
  ctx.store.on('change', () => {
    const now = ctx.store.state.projects.map((p) => p.id).join();
    if (!root.hidden && now !== folders) render();
    folders = now;
  });

  return { show: render };
}
