/**
 * The app's saved state: settings, projects (each one a folder the user
 * trusted), tasks, and Katana's (the agent's) conversation and reminders.
 * One JSON file in userData (main: state:*), saved a moment after each
 * change. What a task said lives in Claude Code's own transcript, not here.
 * No DOM here, so scripts/test-store.mjs runs it under Node.
 *
 *   change         something changed (redraw): once for a burst of changes, a
 *                  moment later (a microtask), never in the middle of one
 *   task-deleting  a task is about to go; end its session first
 *   unreadable     state.json (and its backup) couldn't be read: nothing is
 *                  saved over it until startFresh() (store.unreadable says why)
 */

import { addError } from './apperrors.js';

const SAVE_MS = 200;
const AGENT_HISTORY = 120;

export const DEFAULT_SETTINGS = {
  // New tasks: Claude Code's model and effort.
  taskModel: 'claude-opus-5-5',
  taskEffort: 'medium',
  // New Codex tasks: its model (one Codex lists) and reasoning effort.
  codexModel: 'gpt-6-luna',
  codexEffort: 'medium',
  // New tasks get their own git worktree.
  worktrees: false,
  // How new tasks run: 'single' (one Claude Code session), 'hierarchy' (a leader with workers and verifiers)
  // or 'subagents' (an Opus session that leads and picks a Haiku, Sonnet or Opus sub-agent per piece; runargs.js).
  taskMode: 'single',
  // Hierarchy mode's sessions, per role (the leader is the task's own session; V1's manager/worker settings carry over).
  managerModel: 'claude-opus-5-5',
  managerEffort: 'medium',
  workerModel: 'claude-sonnet-5-5',
  workerEffort: 'medium',
  verifierModel: 'claude-sonnet-5-5',
  verifierEffort: 'medium',
  // Katana, the agent: her brain (she acts with the app's tools, so a strong model).
  agentModel: 'claude-opus-5-5',
  agentEffort: 'low',
  // Wake the agent when a task finishes, so it can tell you what happened.
  wakeAgent: true,
  reopenLastChat: true,
  confirmDeletes: true,
  // '' = the first shell found (PowerShell on Windows).
  shell: '',
  terminalFontSize: 12,
  // Dark grey glass instead of white (macos.css, body[data-dark]).
  // Glass: the scenes and white glass. Slate: one flat blue-grey and a monospace face (slate.css).
  style: 'glass',
  darkMode: false,
  // One of THEME_IDS (a live scene behind the chat), or 'custom:<id>': one of your own backgrounds.
  theme: 'night-lake',
  // Your own backgrounds: [{ id, name, file }], each picture copied into the app's data folder.
  backgrounds: [],
  // A flat colour instead of the theme, which is kept for when this goes off.
  noBackground: false,
  // Which one: an id from NO_BACKGROUND_COLORS.
  noBackgroundColor: 'graphite',
  // default | larger
  textSize: 'default',
  showUsage: true,
  // A note from Windows when a task finishes while you're in another app.
  notifications: true,
  ding: true,
  // The project new tasks go into (the sidebar footer).
  currentProject: '',
  // Tasks run without asking (off: Claude asks in its terminal).
  bypassPermissions: true,
  openAtLogin: false,
  // What the greeting calls you ('' = your Windows user name).
  userName: '',
  // The sidebar collapsed to a slim rail (Ctrl+B).
  rail: false,
};

export const EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

// `name` carries the version, read from the id: claude-opus-5-5 → "Opus 5.5".
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet' },
  { id: 'claude-haiku-5-5', label: 'Haiku' },
].map((model) => {
  const version = model.id.match(/-(\d+)-(\d+)$/);
  return { ...model, version: version ? `${version[1]}.${version[2]}` : '', name: version ? `${model.label} ${version[1]}.${version[2]}` : model.label };
});

/**
 * Codex's models (an OpenAI account's, not Anthropic's): these until the
 * app reads the list from Codex's own cache (setCodexModels), which may
 * change as Codex updates. `name` is how a model reads in the app.
 */
export const CODEX_MODELS = [
  { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
].map((model) => ({ ...model, name: model.label }));

/** Codex's own list (main's sys:found), in place of the one above. */
export function setCodexModels(list) {
  const models = (Array.isArray(list) ? list : []).filter((m) => m && m.id).map((m) => ({ id: String(m.id), label: String(m.label || m.id), name: String(m.label || m.id) }));
  if (models.length) CODEX_MODELS.splice(0, CODEX_MODELS.length, ...models);
}

/** A model id as it reads ("Opus 5.5", "GPT-6-Luna"); '' when it isn't one we know. */
export const modelName = (id) => [...MODELS, ...CODEX_MODELS].find((m) => m.id === id)?.name || '';

export const AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'shell', label: 'Shell' },
];

/** The themes there are (each a scene); a saved theme from before falls back to the first. */
export const THEME_IDS = ['night-lake', 'rooftop-rain'];

// No background's colours, in the order of macOS's accent colours: each of its hues at full saturation, darkened only until --muted (#bcc0c4) reads on it at 4.5:1.
export const NO_BACKGROUND_COLORS = [
  { id: 'graphite', name: 'Graphite', hex: '#383838' },
  { id: 'blue', name: 'Blue', hex: '#004c9e' },
  { id: 'purple', name: 'Purple', hex: '#8d0090' },
  { id: 'pink', name: 'Pink', hex: '#9d0049' },
  { id: 'red', name: 'Red', hex: '#a20005' },
  { id: 'orange', name: 'Orange', hex: '#7f3b00' },
  { id: 'yellow', name: 'Yellow', hex: '#644b00' },
  { id: 'green', name: 'Green', hex: '#155b00' },
];

export const flatColor = (settings) => NO_BACKGROUND_COLORS.find((color) => color.id === settings.noBackgroundColor) || NO_BACKGROUND_COLORS[0];

/** The background of your own the theme names ('custom:<id>'), or null. */
/** Finds a task's parent among these tasks. (A branch knows its parent by the parent's Claude session.) */
export function parentsAmong(tasks) {
  const bySession = new Map(tasks.filter((task) => task.sessionId).map((task) => [task.sessionId, task]));
  return (task) => {
    const parent = task.forkOf ? bySession.get(task.forkOf) : null;
    return parent && parent !== task ? parent : null;
  };
}

/**
 * Tasks in the order given, except that a branch comes straight after the task it
 * branched from, however either is doing. One whose parent isn't in the list stays
 * where it was.
 */
export function branchesUnderParents(tasks) {
  const parentOf = parentsAmong(tasks);
  const children = new Map();
  for (const task of tasks) {
    const parent = parentOf(task);
    if (parent) children.set(parent, [...(children.get(parent) || []), task]);
  }
  const out = [];
  const seen = new Set();
  const place = (task) => {
    if (seen.has(task)) return;
    seen.add(task);
    out.push(task);
    for (const child of children.get(task) || []) place(child);
  };
  for (const task of tasks) if (!parentOf(task)) place(task);
  // (Branches of each other, which shouldn't happen: still listed.)
  for (const task of tasks) place(task);
  return out;
}

export function customBackground(settings) {
  const theme = String(settings?.theme || '');
  if (!theme.startsWith('custom:') || !Array.isArray(settings.backgrounds)) return null;
  return settings.backgrounds.find((b) => b && `custom:${b.id}` === theme && b.file) || null;
}

// One-time changes to saved settings, each applied once.
const MIGRATIONS = ['agent-opus', 'branch-icon'];
// Settings of features that are gone (talking with Katana out loud; the choices of style, animations and background area): dropped from saved state.
const RETIRED = ['liveVoice', 'liveVoiceName', 'wakeWord', 'speechVoice', 'bargeIn', 'bargeInSensitivity', 'speakWhenDone', 'style', 'motion', 'backdrop'];

function migrate(state) {
  // The colour themes (Graphite, Rosé Pine…) are gone: only scenes are left.
  if (!Array.isArray(state.settings.backgrounds)) state.settings.backgrounds = [];
  // No background was a theme: it's a setting of its own now, over the first scene.
  if (state.settings.theme === 'none') state.settings.noBackground = true;
  state.settings.noBackgroundColor = flatColor(state.settings).id;
  if (!THEME_IDS.includes(state.settings.theme) && !customBackground(state.settings)) state.settings.theme = THEME_IDS[0];
  // Katana runs the app with tools now: Opus 5.5 is her brain.
  if (!state.migrations.includes('agent-opus')) state.settings.agentModel = 'claude-opus-5-5';
  // A branch is marked by an icon on its name now, not by words in it.
  if (!state.migrations.includes('branch-icon')) {
    for (const task of state.tasks || []) if (task.forkOf && / \(branch\)$/.test(task.title || '')) task.title = task.title.replace(/ \(branch\)$/, '');
  }
  for (const key of RETIRED) delete state.settings[key];
  state.migrations = [...new Set([...state.migrations, ...MIGRATIONS])];
}

const uid = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/**
 * A folder path without its trailing slash, except a drive or disk root:
 * "C:" alone means "wherever the app is on drive C", not the drive.
 */
export function trimFolder(folder) {
  const value = String(folder || '').trim();
  const trimmed = value.replace(/[\\/]+$/, '');
  if (/^[a-z]:$/i.test(trimmed)) return `${trimmed}\\`;
  if (!trimmed && /^[\\/]/.test(value)) return value[0];
  return trimmed;
}

/** A folder path in one spelling: trimmed, case-blind on Windows. */
export function folderKey(folder) {
  const trimmed = trimFolder(folder);
  return /^[a-z]:/i.test(trimmed) ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}

export const folderName = (folder) => String(folder || '').split(/[\\/]/).filter(Boolean).pop() || folder;

function normalizeTask(task) {
  const kind = ['claude', 'codex', 'shell'].includes(task.kind) ? task.kind : 'claude';
  return {
    id: task.id || uid('task'),
    projectId: task.projectId,
    title: task.title || 'New task',
    // You named it (Rename): nothing replaces it, ever.
    named: Boolean(task.named),
    // Titled by the AI from your messages (daemon/tasktitle.js): Claude Code's own title doesn't replace it.
    aiTitled: Boolean(task.aiTitled),
    kind,
    // 'hierarchy': its session leads a team of workers and verifiers (daemon/team.js);
    // 'subagents': its session leads on Opus and hands the work to Haiku, Sonnet or Opus sub-agents (runargs.js).
    mode: (task.mode === 'hierarchy' || task.mode === 'subagents') && kind === 'claude' ? task.mode : 'single',
    // Claude Code's session: its transcript is the task's history.
    sessionId: task.sessionId || (kind === 'claude' ? crypto.randomUUID() : ''),
    // Where it runs: the project folder, or its worktree.
    cwd: task.cwd || '',
    worktree: task.worktree && typeof task.worktree === 'object' ? task.worktree : null,
    model: task.model || '',
    effort: task.effort || '',
    // Its session has been started once (later starts resume it).
    started: Boolean(task.started),
    // Branched from another task: the session it copies (its conversation so far) when it first starts.
    forkOf: kind === 'claude' ? task.forkOf || '' : '',
    // When its first start copied that session: its chat shows only what came after (taskclient.js).
    branchedAt: task.branchedAt || 0,
    createdAt: task.createdAt || Date.now(),
    updatedAt: task.updatedAt || task.createdAt || Date.now(),
    // Finished with (Done): out of the list. Unread: finished while you looked elsewhere.
    doneAt: task.doneAt || 0,
    unread: Boolean(task.unread),
    merged: Boolean(task.merged),
    // The file open in the viewer, if any.
    viewFile: task.viewFile || '',
    // What its app logged going wrong in the viewer, unseen (apperrors.js); asked about on your next message.
    appErrors: Array.isArray(task.appErrors) ? task.appErrors : [],
  };
}

const today = () => new Date().toLocaleDateString('en-CA');

/** Today's numbers for the New task screen; a new day starts from zero. */
function normalizeStats(stats = {}) {
  return stats.day === today() ? { day: stats.day, finished: stats.finished || 0, workedMs: stats.workedMs || 0, tokens: stats.tokens || 0 } : { day: today(), finished: 0, workedMs: 0, tokens: 0 };
}

function normalizeAgent(agent = {}) {
  return {
    sessionId: agent.sessionId || '',
    messages: Array.isArray(agent.messages) ? agent.messages.slice(-AGENT_HISTORY) : [],
    reminders: Array.isArray(agent.reminders) ? agent.reminders : [],
    watches: Array.isArray(agent.watches) ? agent.watches : [],
  };
}

export function createStore(api) {
  const listeners = new Map();
  let timer = 0;
  let changeQueued = false;
  /** 'change', once for everything changed in this turn of the event loop. */
  const changed = () => {
    if (changeQueued) return;
    changeQueued = true;
    queueMicrotask(() => {
      changeQueued = false;
      store.emit('change');
    });
  };
  /** Write it a moment from now (nothing is written over a state file that couldn't be read). */
  const writeSoon = () => {
    clearTimeout(timer);
    if (store.unreadable) return;
    timer = setTimeout(() => {
      Promise.resolve(api.state.save(saved())).catch((error) => console.error('[store] save failed', error));
    }, SAVE_MS);
  };
  // What goes to state.json: all of it, but Katana's memory when she keeps it herself.
  const saved = () => (store.agentRemote ? { ...store.state, agent: undefined } : store.state);
  const store = {
    state: { version: 2, settings: { ...DEFAULT_SETTINGS }, projects: [], tasks: [], agent: normalizeAgent(), stats: normalizeStats(), migrations: [...MIGRATIONS] },
    /** { message, file } when the saved state couldn't be read (main's state:load said so); else null. */
    unreadable: null,

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },

    emit(event, payload) {
      for (const fn of listeners.get(event) || []) {
        try {
          fn(payload);
        } catch (error) {
          console.error(`[store] ${event} listener failed`, error);
        }
      }
    },

    async load() {
      const saved = await Promise.resolve(api.state.load()).catch(() => null);
      if (saved?.stateUnreadable) {
        // Not a fresh start: the user's projects are in that file. Defaults until they choose.
        store.unreadable = { message: String(saved.stateUnreadable.message || 'unreadable'), file: String(saved.stateUnreadable.file || '') };
        store.emit('unreadable', store.unreadable);
      } else if (saved && typeof saved === 'object') {
        store.state = {
          version: 2,
          settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
          projects: Array.isArray(saved.projects) ? saved.projects : [],
          // Version 1 had Manager chats; those are not tasks and are left behind.
          tasks: (Array.isArray(saved.tasks) ? saved.tasks : []).map(normalizeTask),
          agent: normalizeAgent(saved.agent),
          stats: normalizeStats(saved.stats),
          migrations: Array.isArray(saved.migrations) ? saved.migrations : [],
        };
        migrate(store.state);
      }
      store.emit('change');
      return store.state;
    },

    /** Save soon (changes come in bursts while tasks work). */
    save() {
      writeSoon();
      changed();
    },

    /** Save now: main checks trust against the saved file before a task starts. */
    flush() {
      clearTimeout(timer);
      changed();
      if (store.unreadable) return Promise.resolve(false);
      return Promise.resolve(api.state.save(saved())).catch((error) => console.error('[store] save failed', error));
    },

    /**
     * The saved state couldn't be read and the user chose to start fresh:
     * main keeps that file beside it (renamed), and this state is saved.
     */
    async startFresh() {
      if (!store.unreadable) return true;
      const reply = await api.state.reset?.();
      if (reply?.error) throw new Error(reply.error);
      store.unreadable = null;
      await store.flush();
      return reply?.kept || true;
    },

    project: (id) => store.state.projects.find((project) => project.id === id) || null,
    task: (id) => store.state.tasks.find((task) => task.id === id) || null,
    /** A project by its name or path (the agent names folders). */
    projectByName(name) {
      const key = String(name || '').trim().toLowerCase();
      return store.state.projects.find((p) => p.name.toLowerCase() === key || folderKey(p.path) === folderKey(name)) || null;
    },

    /** Trust a folder: it becomes a project (the same one if it's already there). */
    addProject(folder) {
      const key = folderKey(folder);
      const existing = store.state.projects.find((project) => folderKey(project.path) === key);
      if (existing) return existing;
      const path = trimFolder(folder);
      const project = { id: uid('proj'), name: folderName(path), path, trustedAt: Date.now() };
      store.state.projects.push(project);
      store.flush();
      return project;
    },

    removeProject(id) {
      for (const task of store.state.tasks.filter((t) => t.projectId === id)) store.emit('task-deleting', task.id);
      store.state.tasks = store.state.tasks.filter((task) => task.projectId !== id);
      store.state.projects = store.state.projects.filter((project) => project.id !== id);
      store.flush();
      store.emit('project-removed', id);
    },

    /** A new task in a project: { kind, mode, title, named, model, effort, worktree, cwd, forkOf }. */
    newTask(projectId, options = {}) {
      const project = store.project(projectId);
      const task = normalizeTask({
        projectId,
        kind: options.kind || 'claude',
        mode: options.mode || 'single',
        title: options.title,
        named: options.named,
        aiTitled: options.aiTitled,
        // A Codex task starts on Codex's model and effort; a shell has none.
        model: options.model ?? ({ claude: store.state.settings.taskModel, codex: store.state.settings.codexModel }[options.kind || 'claude'] || ''),
        effort: options.effort ?? ({ claude: store.state.settings.taskEffort, codex: store.state.settings.codexEffort }[options.kind || 'claude'] || ''),
        worktree: options.worktree || null,
        cwd: options.cwd || options.worktree?.path || project?.path || '',
        forkOf: options.forkOf || '',
      });
      store.state.tasks.push(task);
      store.save();
      return task;
    },

    renameTask(id, title) {
      const task = store.task(id);
      const value = String(title || '').trim();
      if (!task || !value) return;
      task.title = value;
      store.save();
    },

    /** The AI's title for a task, unless you've named it yourself. */
    aiTitle(id, title) {
      const task = store.task(id);
      const value = String(title || '').trim();
      if (!task || !value || task.named) return;
      task.aiTitled = true;
      if (task.title === value) return;
      task.title = value;
      store.save();
    },

    deleteTask(id) {
      if (!store.task(id)) return;
      store.emit('task-deleting', id);
      store.state.tasks = store.state.tasks.filter((task) => task.id !== id);
      store.save();
    },

    /** Every task still open, the one used most recently first. */
    openTasks: () => store.state.tasks.filter((task) => !task.doneAt).sort((a, b) => b.updatedAt - a.updatedAt),

    /** Done: the task leaves the list (it comes back if you write to it again). */
    markDone(id, done = true) {
      const task = store.task(id);
      if (!task) return;
      task.doneAt = done ? Date.now() : 0;
      task.unread = false;
      store.save();
    },

    patchTask(id, patch) {
      const task = store.task(id);
      if (!task) return;
      Object.assign(task, patch);
      store.save();
    },

    /** Its app went wrong in the viewer: kept quietly (nothing on screen shows it, so no redraw). */
    addAppError(id, entry) {
      store.addAppErrors(id, [entry]);
    },

    /** Several at once (a burst of error output): one save. */
    addAppErrors(id, entries) {
      const task = store.task(id);
      if (!task || !entries?.length) return;
      for (const entry of entries) task.appErrors = addError(task.appErrors, entry);
      writeSoon();
    },

    clearAppErrors(id) {
      const task = store.task(id);
      if (!task || !task.appErrors.length) return;
      task.appErrors = [];
      store.save();
    },

    /** A task finished: count it, its time and the tokens it wrote, for today. */
    countFinished(workedMs, tokens) {
      const stats = normalizeStats(store.state.stats);
      stats.finished += 1;
      stats.workedMs += Math.max(0, workedMs || 0);
      stats.tokens += Math.max(0, tokens || 0);
      store.state.stats = stats;
      store.save();
    },

    /** Today's numbers (zero when the day has changed). */
    today: () => normalizeStats(store.state.stats),

    /* ------------------------------ agent ------------------------------ */

    /**
     * Where Katana lives, when not here: { say, remind, watch, drop } (the window's
     * line to katanad). Her conversation and reminders are then hers to keep
     * (agent.json); this store only shows them and leaves them out of state.json.
     */
    agentRemote: null,

    /** Her whole conversation, reminders and checks, as she has them. */
    setAgentState({ messages, reminders, watches } = {}) {
      const { agent } = store.state;
      if (Array.isArray(messages)) agent.messages = messages.slice(-AGENT_HISTORY);
      if (Array.isArray(reminders)) agent.reminders = reminders;
      if (Array.isArray(watches)) agent.watches = watches;
      changed();
    },

    /** A line she just added. */
    receiveAgentMessage(message) {
      const { agent } = store.state;
      agent.messages.push(message);
      if (agent.messages.length > AGENT_HISTORY) agent.messages.splice(0, agent.messages.length - AGENT_HISTORY);
      store.emit('agent-message', message);
      changed();
    },

    agentSay(role, text, extra = {}) {
      if (store.agentRemote) return store.agentRemote.say(role, String(text || ''), extra);
      const message = { role, text: String(text || ''), at: Date.now(), ...extra };
      const { agent } = store.state;
      agent.messages.push(message);
      if (agent.messages.length > AGENT_HISTORY) agent.messages.splice(0, agent.messages.length - AGENT_HISTORY);
      store.save();
      store.emit('agent-message', message);
      return message;
    },

    addReminder(minutes, text) {
      if (store.agentRemote) return store.agentRemote.remind(minutes, String(text || ''));
      const reminder = { id: uid('rem'), at: Date.now() + Math.max(0.1, Number(minutes) || 0) * 60000, text: String(text || '') };
      store.state.agent.reminders.push(reminder);
      store.save();
      return reminder;
    },

    dropReminder(id) {
      if (store.agentRemote) return store.agentRemote.drop(id);
      store.state.agent.reminders = store.state.agent.reminders.filter((r) => r.id !== id);
      store.save();
    },

    /** A recurring check: only katanad runs them (it looks while the window is closed). */
    addWatch(every, check, hours) {
      if (!store.agentRemote) throw new Error('Recurring checks run in the background process, which isn’t connected.');
      return store.agentRemote.watch(every, String(check || ''), hours);
    },

    dropWatch(id) {
      if (store.agentRemote) return store.agentRemote.drop(id);
      store.state.agent.watches = store.state.agent.watches.filter((w) => w.id !== id);
      store.save();
    },

    setSetting(key, value) {
      store.state.settings[key] = value;
      // A theme chosen under No background would otherwise not show.
      if (key === 'theme') store.state.settings.noBackground = false;
      store.save();
    },
  };
  return store;
}
