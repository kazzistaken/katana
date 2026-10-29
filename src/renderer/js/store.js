/**
 * The app's saved state: settings, projects (each one a folder the user
 * trusted), tasks, and Katana's (the agent's) conversation and reminders.
 * One JSON file in userData (main: state:*), saved a moment after each
 * change. What a task said lives in Claude Code's own transcript, not here.
 * No DOM here, so scripts/test-store.mjs runs it under Node.
 *
 *   change         something changed (redraw)
 *   task-deleting  a task is about to go; end its session first
 */

import { addError } from './apperrors.js';

const SAVE_MS = 200;
const AGENT_HISTORY = 120;

export const DEFAULT_SETTINGS = {
  // New tasks: Claude Code's model and effort.
  taskModel: 'claude-opus-5-5',
  taskEffort: 'medium',
  // New tasks get their own git worktree.
  worktrees: false,
  // How new tasks run: 'single' (one Claude Code session) or 'hierarchy' (a leader with workers and verifiers).
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
  // Talk out loud with her through GPT-Live (needs an OpenAI key), and its voice.
  liveVoice: true,
  liveVoiceName: 'marin',
  // Listen for "Katana" / "hey Katana" while the window is open (OpenRouter hears short phrases).
  wakeWord: true,
  // Her voice when she talks a turn at a time (OpenRouter's speech).
  speechVoice: 'Rachel',
  // Talking over her while she speaks cuts her off (barge-in), and how sure it must be: low | medium | high.
  bargeIn: true,
  bargeInSensitivity: 'medium',
  // Wake the agent when a task finishes, so it can tell you what happened.
  wakeAgent: true,
  reopenLastChat: true,
  confirmDeletes: true,
  // '' = the first shell found (PowerShell on Windows).
  shell: '',
  terminalFontSize: 12,
  // full | reduced | off
  motion: 'full',
  // system | graphite | black | tokyo-night | catppuccin | rose-pine | nord | light
  theme: 'graphite',
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
  // Katana says her words out loud.
  speakWhenDone: false,
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

export const AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'shell', label: 'Shell' },
];

// One-time changes to saved settings, each applied once.
const MIGRATIONS = ['agent-opus', 'gemini-voice', 'eleven-voice'];

function migrate(state) {
  // Katana runs the app with tools now: Opus 5.5 is her brain.
  if (!state.migrations.includes('agent-opus')) state.settings.agentModel = 'claude-opus-5-5';
  // Her voice moved to Gemini's speech (OpenRouter has no OpenAI voices).
  // Then to ElevenLabs' (much faster to start speaking).
  if (!state.migrations.includes('eleven-voice')) state.settings.speechVoice = 'Rachel';
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
    // You named it (Rename): Claude Code's own title doesn't replace it.
    named: Boolean(task.named),
    kind,
    // 'hierarchy': its session leads a team of workers and verifiers (daemon/team.js).
    mode: task.mode === 'hierarchy' && kind === 'claude' ? 'hierarchy' : 'single',
    // Claude Code's session: its transcript is the task's history.
    sessionId: task.sessionId || (kind === 'claude' ? crypto.randomUUID() : ''),
    // Where it runs: the project folder, or its worktree.
    cwd: task.cwd || '',
    worktree: task.worktree && typeof task.worktree === 'object' ? task.worktree : null,
    model: task.model || '',
    effort: task.effort || '',
    // Its session has been started once (later starts resume it).
    started: Boolean(task.started),
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
  // What goes to state.json: all of it, but Katana's memory when she keeps it herself.
  const saved = () => (store.agentRemote ? { ...store.state, agent: undefined } : store.state);
  const store = {
    state: { version: 2, settings: { ...DEFAULT_SETTINGS }, projects: [], tasks: [], agent: normalizeAgent(), stats: normalizeStats(), migrations: [...MIGRATIONS] },

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
      if (saved && typeof saved === 'object') {
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
      clearTimeout(timer);
      timer = setTimeout(() => {
        Promise.resolve(api.state.save(saved())).catch((error) => console.error('[store] save failed', error));
      }, SAVE_MS);
      store.emit('change');
    },

    /** Save now: main checks trust against the saved file before a task starts. */
    flush() {
      clearTimeout(timer);
      store.emit('change');
      return Promise.resolve(api.state.save(saved())).catch((error) => console.error('[store] save failed', error));
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

    /** A new task in a project: { kind, mode, title, model, effort, worktree }. */
    newTask(projectId, options = {}) {
      const project = store.project(projectId);
      const task = normalizeTask({
        projectId,
        kind: options.kind || 'claude',
        mode: options.mode || 'single',
        title: options.title,
        model: options.model ?? store.state.settings.taskModel,
        effort: options.effort ?? store.state.settings.taskEffort,
        worktree: options.worktree || null,
        cwd: options.worktree?.path || project?.path || '',
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

    /** Its app went wrong in the viewer: kept quietly (nothing on screen shows it). */
    addAppError(id, entry) {
      const task = store.task(id);
      if (!task) return;
      task.appErrors = addError(task.appErrors, entry);
      store.save();
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
      store.emit('change');
    },

    /** A line she just added. */
    receiveAgentMessage(message) {
      const { agent } = store.state;
      agent.messages.push(message);
      if (agent.messages.length > AGENT_HISTORY) agent.messages.splice(0, agent.messages.length - AGENT_HISTORY);
      store.emit('agent-message', message);
      store.emit('change');
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
      store.save();
    },
  };
  return store;
}
