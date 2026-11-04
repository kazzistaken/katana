import { el, icons, glider } from './util.js';
import { MODELS, CODEX_MODELS, EFFORTS, NO_BACKGROUND_COLORS, flatColor } from './store.js';
import { confirmDialog } from './dialog.js';
import { fileUrl } from './chatview.js';

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
// Read when drawn: the list comes from Codex's own cache once the app has asked.
const codexModelOptions = () => CODEX_MODELS.map((model) => ({ value: model.id, label: model.name }));

// The themes are scenes, each shown by a picture of itself (a still of its live background).
export const THEMES = [
  { value: 'night-lake', label: 'Night lake', preview: 'img/themes/night-lake.jpg' },
  { value: 'rooftop-rain', label: 'Rooftop rain', preview: 'img/themes/rooftop-rain.jpg' },
];

// A tile needs a small picture: shown at full size, a 6000 px photo holds up the page each time the tile is drawn.
const THUMB_WIDTH = 320;
const thumbnails = new Map(); // picture -> the small copy, or a promise of it
let thumbnailing = Promise.resolve();

async function makeThumbnail(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const height = Math.max(1, Math.round((THUMB_WIDTH * image.naturalHeight) / image.naturalWidth));
  const small = await createImageBitmap(image, { resizeWidth: THUMB_WIDTH, resizeHeight: height, resizeQuality: 'medium' });
  const canvas = el('canvas', { width: THUMB_WIDTH, height });
  canvas.getContext('2d').drawImage(small, 0, 0);
  small.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Puts a picture's small copy on a tile: at once if it's made, else when it's ready (one picture at a time). */
function showThumbnail(tile, url) {
  if (!thumbnails.has(url)) {
    const made = thumbnailing.then(() => makeThumbnail(url)).catch(() => url);
    thumbnailing = made;
    thumbnails.set(url, made);
    made.then((small) => thumbnails.set(url, small));
  }
  const small = thumbnails.get(url);
  if (typeof small === 'string') tile.src = small;
  else small.then((ready) => (tile.src = ready));
}

/** The scenes, then your own backgrounds (each removable), then the tile that adds one. */
function themeOptions(ctx) {
  const { store } = ctx;
  const own = (store.state.settings.backgrounds || []).map((bg) => ({
    value: `custom:${bg.id}`,
    label: bg.name,
    thumbnail: fileUrl(bg.file),
    remove: () => removeBackground(ctx, bg),
  }));
  return [...THEMES, ...own, { label: 'Add your own', add: () => addBackground(ctx) }];
}

/** New backgrounds join the list and the last one shows; what couldn't be added is said once. */
async function adoptBackgrounds(ctx, replies) {
  const { store } = ctx;
  const added = replies.filter((reply) => reply && !reply.error);
  if (added.length) {
    store.state.settings.backgrounds = [...(store.state.settings.backgrounds || []), ...added];
    // (Saved as it's switched to: the page draws it again with the new tiles in its row.)
    store.setSetting('theme', `custom:${added.at(-1).id}`);
    ctx.rerender?.();
  }
  const failed = replies.filter((reply) => reply?.error).map((reply) => reply.error);
  if (failed.length) await confirmDialog({ title: `Couldn’t add ${failed.length === 1 ? 'that background' : `${failed.length} backgrounds`}`, body: failed.join('\n'), ok: 'OK', cancel: null });
}

async function addBackground(ctx) {
  await adoptBackgrounds(ctx, [await ctx.api.background.add().catch((error) => ({ error: error.message }))]);
}

/** A dropped file, if it really is a picture (whatever its name says), kept as a background. */
async function saveDropped(ctx, file) {
  try {
    (await createImageBitmap(file)).close();
  } catch {
    return { error: `${file.name} isn’t a picture Katana can use.` };
  }
  return ctx.api.background.save(file.name, file.type, await file.arrayBuffer()).catch((error) => ({ error: `${file.name}: ${error.message}` }));
}

/** What's being dragged may be a picture (some sources don't say what a file is until it's dropped). */
const mayBePicture = (item) => item.kind === 'file' && (item.type.startsWith('image/') || !item.type);

/**
 * Pictures dropped anywhere on the page become backgrounds. (Handled here, not
 * passed up: the window's own handler only takes drops on the prompt bar.)
 */
function acceptDrops(ctx, root) {
  const veil = el('div', { class: 'bg-drop', hidden: true }, el('span', { text: 'Drop to add as a background' }));
  root.after(veil);
  const dragging = (event) => event.dataTransfer?.types.includes('Files');
  root.addEventListener('dragover', (event) => {
    if (!dragging(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const fits = [...event.dataTransfer.items].some(mayBePicture);
    event.dataTransfer.dropEffect = fits ? 'copy' : 'none';
    veil.hidden = !fits;
    // (It covers what's on screen, however far the page is scrolled.)
    veil.style.top = `${root.scrollTop + 12}px`;
    veil.style.height = `${root.clientHeight - 24}px`;
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget)) veil.hidden = true;
  });
  root.addEventListener('drop', async (event) => {
    if (!dragging(event)) return;
    event.preventDefault();
    event.stopPropagation();
    veil.hidden = true;
    // (Read now: a drop's files are gone once this event is over.)
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/') || !file.type);
    if (!files.length) return;
    const replies = [];
    for (const file of files) replies.push(await saveDropped(ctx, file));
    await adoptBackgrounds(ctx, replies);
  });
}

async function removeBackground(ctx, bg) {
  const { store } = ctx;
  const ok = !store.state.settings.confirmDeletes || (await confirmDialog({ title: `Remove “${bg.name}”?`, body: 'It goes from your backgrounds (the picture you chose stays where it was).', ok: 'Remove', danger: true }));
  if (!ok) return;
  store.state.settings.backgrounds = (store.state.settings.backgrounds || []).filter((b) => b.id !== bg.id);
  // It was showing: back to the first scene.
  if (store.state.settings.theme === `custom:${bg.id}`) store.state.settings.theme = THEMES[0].value;
  store.save();
  ctx.api.background.remove(bg.file).catch(() => {});
  ctx.rerender?.();
}

export const GROUPS = [
  {
    label: 'Look',
    fields: [
      choices('style', 'Style', 'Glass: live scenes behind white glass. Slate: one flat blue-grey and a monospace face.', [
        { value: 'glass', label: 'Glass' },
        { value: 'slate', label: 'Slate' },
      ]),
      { ...toggle('darkMode', 'Dark mode', 'Panels, controls and menus turn dark grey instead of white glass.'), glassOnly: true },
      choices('textSize', 'Text size', null, [
        { value: 'default', label: 'Default' },
        { value: 'larger', label: 'Larger' },
      ]),
      { ...choices('theme', 'Theme', 'A live scene behind the app, a picture of your own (click Add your own, or drop pictures anywhere on this page).', themeOptions), glassOnly: true },
      { ...toggle('noBackground', 'No background', 'A flat color instead of a scene or picture.'), glassOnly: true },
      { type: 'flatColor', key: 'noBackgroundColor', label: 'Color' },
      toggle('showUsage', 'Show usage in the status line'),
    ],
  },
  {
    label: 'Tasks',
    fields: [
      toggle('bypassPermissions', 'Bypass permissions', 'New tasks change files and run commands without asking.'),
      choices('taskModel', 'Model', 'For new Claude Code tasks. A task can change it above its prompt bar.', modelOptions),
      choices('taskEffort', 'Effort', null, effortOptions),
      choices('codexModel', 'Codex model', 'For new Codex tasks (pick Codex in the model menu). Signed in through Codex’s own CLI.', codexModelOptions),
      choices('codexEffort', 'Codex effort', null, effortOptions),
      toggle('worktrees', 'Give each new task its own worktree', 'A separate git checkout on its own branch, so tasks in one folder don’t collide. Merge brings it back.'),
    ],
  },
  {
    label: 'Modes',
    fields: [
      choices('taskMode', 'New tasks run as', 'Sub-agents: an Opus session leads (plans, checks the work) and hands each piece to a sub-agent it picks: Haiku for simple fixes, Sonnet for hard work and logic, Opus for complicated systems and hard bugs. Hierarchy: the Leader you talk to splits the work across 4 workers (each its own Claude Code session, on its own branch) and has 2 verifiers check it before merging. Switch it per task beside the model above the prompt bar.', [
        { value: 'single', label: 'Single agent' },
        { value: 'subagents', label: 'Sub-agents' },
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
    ],
  },
  {
    label: 'Dictation',
    fields: [
      { type: 'note', label: 'NVIDIA Canary-Qwen 2.5B', help: 'Hears you on this PC, a phrase at a time when you pause; nothing leaves it. It works in any text box. It loads in the background when Katana opens (a few minutes) and keeps about 5 GB of graphics memory until you quit. Set up once with npm run setup:canary. The keys below are only used when it can’t run.' },
      { type: 'key', service: 'openai', label: 'OpenAI key', help: 'Dictation when Canary can’t run. Kept on this PC, sealed by Windows; never shown again.' },
      {
        type: 'key',
        service: 'openrouter',
        placeholder: 'sk-or-…',
        label: 'OpenRouter key',
        help: 'Dictation, a phrase at a time, when Canary can’t run and there’s no OpenAI key. Kept on this PC, sealed by Windows.',
      },
    ],
  },
  {
    label: 'Your turn',
    fields: [
      { type: 'text', key: 'userName', label: 'Your name', help: 'What Katana calls you. Empty: your Windows user name.' },
      toggle('notifications', 'Notifications', 'On — while you’re in another app'),
      toggle('ding', 'Ding when a task needs you or a reminder is due', 'A finished task is a quiet notification (when you’re in another app).'),
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

// The dots' state: shown only while No background is on, the chosen one ringed and named.
function syncFlatColor(row, settings) {
  const chosen = flatColor(settings);
  row.hidden = !settings.noBackground || settings.style === 'slate';
  row.querySelector('.set-help').textContent = chosen.name;
  for (const dot of row.querySelectorAll('.flat-dot')) dot.setAttribute('aria-pressed', String(dot.dataset.color === chosen.id));
}

// No background's colour: a row of dots, like the Accent color row in macOS's settings.
function flatColorField({ store }, spec) {
  const dots = NO_BACKGROUND_COLORS.map((color) => {
    const dot = el('button', { class: 'flat-dot', type: 'button', title: color.name, 'aria-label': color.name, 'data-color': color.id, onclick: () => store.setSetting(spec.key, color.id) });
    dot.style.background = color.hex;
    return dot;
  });
  const row = fieldRow({ ...spec, help: ' ' }, el('div', { class: 'flat-dots', role: 'group', 'aria-label': spec.label }, dots));
  row.classList.add('is-flat-color');
  syncFlatColor(row, store.state.settings);
  return row;
}

// Settings that mean nothing in Slate: out of sight while it's on, kept for coming back.
function syncGlassOnly(root, settings) {
  for (const row of root.querySelectorAll('[data-glass-only]')) row.hidden = settings.style === 'slate';
}

function glassOnly(ctx, spec) {
  const row = field(ctx, spec);
  if (spec.glassOnly) {
    row.dataset.glassOnly = '';
    row.hidden = ctx.store.state.settings.style === 'slate';
  }
  return row;
}

function field(ctx, spec) {
  const { store } = ctx;
  if (spec.type === 'flatColor') return flatColorField(ctx, spec);
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
      'data-setting': spec.key,
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
    // A tile that does something (adds a background) instead of choosing a value.
    if (option.add) {
      group.append(el('button', { class: 'chip-opt has-preview is-add', type: 'button', onclick: option.add }, el('span', { class: 'theme-preview theme-add', 'aria-hidden': 'true', html: icons.plus }), el('span', { text: option.label })));
      continue;
    }
    const tile = option.thumbnail ? el('img', { class: 'theme-preview', alt: '', draggable: 'false' }) : null;
    if (tile) showThumbnail(tile, option.thumbnail);
    const button = el(
      'button',
      {
        class: `chip-opt${option.swatch ? ' has-swatch' : ''}${option.preview || tile ? ' has-preview' : ''}`,
        type: 'button',
        'aria-pressed': String(String(option.value) === String(value ?? '')),
        onclick: () => {
          for (const other of group.querySelectorAll('.chip-opt:not(.is-add)')) other.setAttribute('aria-pressed', String(other === button));
          store.setSetting(spec.key, option.value);
        },
      },
      // A theme's swatch: its panel, a line of its text and its accent, in its own colours.
      option.swatch ? el('span', { class: 'theme-swatch', 'aria-hidden': 'true' }, option.swatch.map((theme) => el('span', { class: 'swatch-part', 'data-theme': theme }, el('i'), el('b')))) : null,
      // A scene theme's picture of itself.
      option.preview ? el('img', { class: 'theme-preview', src: option.preview, alt: '', draggable: 'false', decoding: 'async', loading: 'lazy' }) : tile,
      el('span', { text: option.label })
    );
    // One of your own: a × on it removes it.
    if (option.remove) {
      const remove = el('button', { class: 'chip-remove', type: 'button', title: `Remove ${option.label}`, 'aria-label': `Remove ${option.label}`, html: icons.x, onclick: option.remove });
      group.append(el('span', { class: 'chip-wrap' }, button, remove));
    } else group.append(button);
  }
  return fieldRow(spec, group, true);
}

/** A secret: typed in, handed to main, never read back (only whether one is set). */
function keyField(ctx, spec) {
  const keys = ctx.api[spec.service];
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
    fieldRow({ label: 'Codex', help: found.codex ? 'Installed.' : 'Not installed: npm i -g @openai/codex, then run codex once to sign in.' }, null),
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
  // The sections listed on the left (they stay put as you scroll; the one you're in is lit), the settings on the right.
  const nav = el('nav', { class: 'set-nav', 'aria-label': 'Settings sections' });
  // The section you're in: one highlight that glides down the list as you scroll.
  const navPill = glider(nav, () => nav.querySelector('.set-nav-item[aria-current="true"]'));
  const groups = el('div', { class: 'set-groups' });
  const inner = el('div', { class: 'settings-inner' }, nav, groups);
  const close = el('button', { class: 'icon settings-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close settings', html: icons.x, onclick: () => ctx.closeSettings() });
  root.replaceChildren(close, inner);
  const smooth = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && document.body.dataset.motion === 'full';

  // (A field that changes its own row, adding a background, draws the page again.)
  const here = Object.assign(Object.create(ctx), { rerender: () => render() });
  acceptDrops(here, root);

  function render() {
    const scroll = root.scrollTop;
    const sections = GROUPS.map((group) =>
      el(
        'section',
        { class: 'set-group', 'aria-label': group.label },
        el('h2', { class: 'set-group-label', text: group.label }),
        el('div', { class: 'set-fields' }, group.render ? group.render(here) : group.fields.map((spec) => glassOnly(here, spec)))
      )
    );
    groups.replaceChildren(...sections);
    nav.replaceChildren(
      navPill.node,
      ...GROUPS.map((group, i) =>
        el('button', { class: 'set-nav-item', type: 'button', text: group.label, onclick: () => {
            chosen = i;
            sections[i].scrollIntoView({ block: 'start', behavior: smooth() ? 'smooth' : 'auto' });
            lightNav();
          },
        })
      )
    );
    root.scrollTop = scroll;
    // (Measured once the page is on screen: it's still hidden while it's built.)
    requestAnimationFrame(lightNav);
  }

  // A section you picked stays lit until you scroll yourself (one near the end can't reach the top).
  let chosen = null;
  for (const type of ['wheel', 'keydown', 'pointerdown']) root.addEventListener(type, () => (chosen = null), { passive: true });

  /** The section at the top of the page (the last one, once the page is scrolled to its end). */
  function lightNav() {
    const sections = [...groups.children];
    if (!sections.length || !root.clientHeight) return;
    const top = root.getBoundingClientRect().top + 64;
    const end = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
    let on = 0;
    sections.forEach((section, i) => {
      if (section.getBoundingClientRect().top <= top) on = i;
    });
    if (end) on = sections.length - 1;
    if (chosen !== null) on = chosen;
    [...nav.querySelectorAll('.set-nav-item')].forEach((item, i) => item.setAttribute('aria-current', String(i === on)));
    navPill.place();
  }
  root.addEventListener('scroll', () => requestAnimationFrame(lightNav), { passive: true });

  // Folders change from here and from the sidebar.
  let folders = '';
  ctx.store.on('change', () => {
    const now = ctx.store.state.projects.map((p) => p.id).join();
    if (!root.hidden && now !== folders) render();
    folders = now;
    // Choosing a theme turns No background off (store.setSetting): its switch shows that at once.
    root.querySelector('[data-setting="noBackground"]')?.setAttribute('aria-checked', String(Boolean(ctx.store.state.settings.noBackground)));
    const flatRow = root.querySelector('.is-flat-color');
    if (flatRow) syncFlatColor(flatRow, ctx.store.state.settings);
    syncGlassOnly(root, ctx.store.state.settings);
  });

  // A section picked last time stays lit only while the page is open.
  new ResizeObserver(() => navPill.place({ now: true })).observe(nav);
  return {
    show() {
      chosen = null;
      render();
    },
  };
}
