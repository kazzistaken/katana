import { $, icons } from './util.js';
import { createStore } from './store.js';
import { createTaskClient } from './taskclient.js';
import { createTeamClient, doing } from './teamclient.js';
import { confirmDialog } from './dialog.js';
import { createAgent } from './agent.js';
import { initSidebar } from './sidebar.js';
import { initChatView } from './chatview.js';
import { initTerminal } from './terminal.js';
import { initSettingsPage } from './settings.js';
import { initVoice } from './voice.js';
import { createLive } from './live.js';
import { createTalk } from './talk.js';
import { createWake } from './wake.js';
import { meterElement } from './meter.js';
import { faceSpeech } from './face.js';
import { createAppTools } from './apptools.js';
import { ding } from './ding.js';

/**
 * Katana — renderer entry. Each task is a real terminal session
 * (Claude Code, Codex or a shell) that main runs; taskclient.js follows
 * what it does. Katana, the agent above the tasks, runs the app for you
 * with its own controls (apptools.js), reminds you of things, and is woken
 * when one finishes; with GPT-Live (live.js) you talk with her out loud.
 * The main panel shows one pane at a time: a task (or the agent, or New
 * task), the task's terminal, or settings.
 */

const LAST_VIEW = 'x2.lastView';
// Every Claude session runs with the 1M-token context window (runargs.js).
const DEFAULT_WINDOW = 1000000;
const api = window.api;

const store = createStore(api);
const tasks = createTaskClient({ api, store });
// Hierarchy mode: the teams that run some tasks (katanad's team.js).
const team = createTeamClient({ api });
let claudeFound = null;
let found = null;
let shellList = [];
let info = null;
// The plan's live use, { fiveHour, week } (main planusage.js); null until fetched or without a login.
let plan = null;
const PLAN_EVERY = 60000;

/* ------------------------------- panes ------------------------------- */

const panes = { chat: $('#chat'), terminal: $('#terminal'), settings: $('#settings') };
const topbar = $('#topbar');
const topLabel = $('#top-label');
const openExternal = $('#open-external');
const viewButtons = { avatar: $('#view-avatar'), chat: $('#view-chat'), file: $('#view-file'), app: $('#view-app'), terminal: $('#view-terminal') };
viewButtons.avatar.innerHTML = icons.person;
viewButtons.chat.innerHTML = icons.doc;
viewButtons.file.innerHTML = icons.globe;
viewButtons.app.innerHTML = icons.app;
viewButtons.terminal.innerHTML = icons.prompt;
let pane = 'chat';
let beforeSettings = 'chat';

function showPane(name) {
  pane = name;
  for (const [key, node] of Object.entries(panes)) {
    if (key === name && node.hidden) {
      node.hidden = false;
      // Replay the crossfade on the pane coming in.
      node.style.animation = 'none';
      void node.offsetWidth;
      node.style.animation = '';
    } else if (key !== name) node.hidden = true;
  }
  if (name === 'terminal') terminal.show(chatView.current());
  if (name === 'chat') chatView.focus();
  renderTopbar();
}

/** What's on screen, top left; which view is lit, top right. */
let lastScreen = '';
/** What's on screen, for Katana: "this" means it. Sent only when it changes. */
function tellScreen(task, fileMode) {
  const next = { pane, view: chatView?.view().type || 'new', task: task?.id || null, title: task?.title || '', file: fileMode ? task.viewFile : '' };
  const key = JSON.stringify(next);
  if (key === lastScreen) return;
  lastScreen = key;
  api.agent.screen(next);
}

function renderTopbar() {
  const task = store.task(chatView?.current());
  const fileMode = pane === 'chat' && chatView?.mode() === 'file';
  const appMode = pane === 'chat' && chatView?.mode() === 'app';
  // The app viewer fills the main area, like a browser: no bar over it.
  topbar.hidden = pane === 'settings' || appMode;
  const project = store.project(task?.projectId || ctx.currentProject());
  const view = chatView?.view().type;
  let label = project?.name || '';
  if (fileMode) label = task.viewFile.split(/[\\/]/).pop();
  else if (appMode) label = `${project?.name || ''} · app`;
  else if (view === 'agent') label = 'katana';
  else if (task?.worktree && !task.merged) label = `${project?.name || ''} · ${task.worktree.branch}`;
  topLabel.textContent = label;
  topLabel.title = fileMode ? task.viewFile : task?.cwd || project?.path || '';
  openExternal.hidden = !fileMode;
  tellScreen(task, fileMode);
  // A page opens in the browser; a document in its own app.
  if (fileMode) openExternal.textContent = /\.(md|markdown|txt)$/i.test(task.viewFile) ? 'Open' : 'Open in browser';
  viewButtons.file.hidden = !task?.viewFile;
  viewButtons.terminal.hidden = !task;
  // Run app: starts the task's app the first time, then shows it.
  viewButtons.app.hidden = !task;
  const appState = task ? chatView.app.state(task.id) : null;
  viewButtons.app.title = appState ? 'App' : 'Run app';
  viewButtons.app.classList.toggle('is-running', Boolean(task && chatView.app.isLive(task.id)));
  // Katana: its face, or its conversation.
  viewButtons.avatar.hidden = view !== 'agent';
  const face = view === 'agent' && chatView.agentMode() === 'avatar';
  viewButtons.chat.title = view === 'agent' ? 'Conversation' : 'Task';
  const lit = pane === 'terminal' ? 'terminal' : fileMode ? 'file' : appMode ? 'app' : face ? 'avatar' : 'chat';
  for (const [key, button] of Object.entries(viewButtons)) {
    button.classList.toggle('is-active', key === lit);
    button.setAttribute('aria-pressed', String(key === lit));
  }
}

viewButtons.chat.addEventListener('click', () => {
  if (pane !== 'chat') showPane('chat');
  if (chatView.view().type === 'agent') chatView.setAgentMode('doc');
  else chatView.setMode('chat');
});
viewButtons.avatar.addEventListener('click', () => chatView.setAgentMode('avatar'));
viewButtons.file.addEventListener('click', () => {
  if (pane !== 'chat') showPane('chat');
  chatView.setMode('file');
});
viewButtons.terminal.addEventListener('click', () => showPane(pane === 'terminal' ? 'chat' : 'terminal'));
viewButtons.app.addEventListener('click', () => {
  const id = chatView.current();
  if (!id) return;
  if (pane !== 'chat') showPane('chat');
  if (chatView.mode() === 'app') chatView.setMode('chat');
  else if (chatView.app.has(id)) chatView.setMode('app');
  else chatView.runApp(id);
});
openExternal.addEventListener('click', () => {
  const file = store.task(chatView.current())?.viewFile;
  if (file) api.file.open(file);
});

/* ------------------------------- tasks ------------------------------- */

function remember(view) {
  try {
    localStorage.setItem(LAST_VIEW, view);
  } catch {
    /* a per-window nicety only */
  }
}

/** Make a task and start it with its first message: { projectId, kind, mode, prompt, worktree, title, model, effort, open }. */
async function createTask({ projectId, kind = 'claude', mode, prompt = '', worktree = false, title, model, effort, open = true }) {
  const project = store.project(projectId);
  if (!project) return null;
  const name = title || (prompt ? prompt.replace(/\s+/g, ' ').trim().slice(0, 40) : kind === 'shell' ? 'Shell' : 'New task');
  let tree = null;
  if (worktree && kind !== 'shell') {
    tree = await api.worktree.create(project.path, name);
    if (tree?.error) {
      chatView.flash(tree.error);
      tree = null;
    }
  }
  // Hierarchy mode (Claude only): the task's session leads a team, on the leader's model unless one was picked.
  const lead = kind === 'claude' && (mode ?? store.state.settings.taskMode) === 'hierarchy';
  const { settings } = store.state;
  const task = store.newTask(projectId, { kind, mode: lead ? 'hierarchy' : 'single', title: name, worktree: tree, model: model ?? (lead ? settings.managerModel : undefined), effort: effort ?? (lead ? settings.managerEffort : undefined) });
  await store.flush();
  if (open) ctx.open(task.id);
  const reply = prompt ? await tasks.send(task, prompt) : await tasks.start(task);
  if (reply?.error) chatView.flash(reply.error);
  // Codex and shells are their terminal: show it.
  if (open && kind !== 'claude') showPane('terminal');
  sidebar.render();
  return task;
}

/** A task finished: it rises to the top and, if you weren't looking, stays marked. (Its alert comes from katanad.) */
function finished(id) {
  const task = store.task(id);
  if (!task) return;
  const watching = chatView.current() === id && pane !== 'settings' && document.hasFocus();
  store.patchTask(id, { updatedAt: Date.now(), unread: !watching });
  // Counted a moment later: the transcript's last lines land just after Stop.
  const t = tasks.get(id);
  const worked = Date.now() - t.since;
  setTimeout(() => store.countFinished(worked, t.transcript.tokensSince(t.since)), 1200);
  refreshPlan();
}

function notify(title, body, onclick) {
  try {
    const note = new Notification(title, { body, silent: true, tag: 'katana' });
    note.onclick = onclick;
  } catch {
    /* notifications are off in Windows */
  }
}

// A team changing: the sidebar's dot and line follow it.
team.on(() => sidebar.render());

tasks.on(({ id, type, at }) => {
  if (type === 'finished') finished(id);
  // It finished in the background while no window was open: marked, at the top.
  if (type === 'missed' && store.task(id)) store.patchTask(id, { unread: chatView.current() !== id, updatedAt: at });
  sidebar.render();
  if (id === chatView.current()) queueMicrotask(() => sidebar.renderFoot());
});

/* ------------------------------- agent ------------------------------- */

let speaking = null;
function speak(text) {
  // In a voice conversation she says it herself.
  if (live?.active() || talk?.active() || !store.state.settings.speakWhenDone) return;
  // Her own voice (OpenRouter, or ElevenLabs directly) when there's a key; else Windows' voice.
  if (routerKey || elevenKey) {
    api.speech.say(text, store.state.settings.speechVoice).then((speech) => {
      if (speech?.error) chatView.flash(`Katana’s voice: ${speech.error}`);
      if (!speech?.audio) return;
      if (speaking) {
        speaking.pause();
        URL.revokeObjectURL(speaking.src);
      }
      const bytes = Uint8Array.from(atob(speech.audio), (c) => c.charCodeAt(0));
      speaking = new Audio(URL.createObjectURL(new Blob([bytes], { type: speech.type || 'audio/wav' })));
      meterElement(speaking);
      // Her face says the words with it: timed by ElevenLabs when it gave times, else fitted to the recording.
      faceSpeech.play(speaking, { text, bytes, alignment: speech.alignment });
      speaking.play().catch(() => {});
    });
    return;
  }
  if (!('speechSynthesis' in window)) return;
  const words = new SpeechSynthesisUtterance(text);
  words.rate = 1.05;
  // Her face says the words as they're said: each word's start, from the voice itself.
  words.addEventListener('start', () => faceSpeech.begin(text, words.rate));
  words.addEventListener('boundary', (event) => event.name === 'word' && faceSpeech.word(event.charIndex, event.charLength));
  words.addEventListener('end', () => faceSpeech.end());
  words.addEventListener('error', () => faceSpeech.end());
  speechSynthesis.cancel();
  speechSynthesis.speak(words);
}

// Katana lives in katanad: her conversation and reminders are hers, the window shows them.
store.agentRemote = {
  say: (role, text, extra) => api.agent.say(role, text, extra),
  remind: (minutes, text) => api.agent.remind(minutes, text),
  watch: (every, check, hours) => api.agent.watch(every, check, hours),
  drop: (id) => api.agent.drop(id),
};
const agent = createAgent({ api, store });
// What she says out loud (a voice conversation says its own; a finished task is only written).
agent.on(({ type, text, kind }) => type === 'reply' && kind !== 'voice' && kind !== 'finished' && speak(text));

// A reminder came due (she tells you what it was about, too).
/**
 * An alert, its level decided by katanad: needs and reminder ding (and
 * notify while you're in another app); done only notifies, quietly, and
 * only when you're elsewhere; fyi never reaches here.
 */
api.agent.onAlert(({ level, title, body, taskId, taskIds }) => {
  const { settings } = store.state;
  const away = !document.hasFocus();
  if (level !== 'done' && settings.ding) ding();
  if (!settings.notifications || !away) return;
  const open = taskId ? () => ctx.open(taskId) : taskIds?.length ? () => ctx.open(taskIds[0]) : () => ctx.openAgent();
  notify(title, body, open);
});

const live = createLive({ api, store, agent, ctx: { flash: (text) => ctx.flash(text), userName: () => ctx.userName() } });
// Talking a turn at a time through OpenRouter (when there's no GPT-Live).
const talk = createTalk({ api, agent, store, ctx: { flash: (text) => ctx.flash(text) } });
let liveKey = null;
let routerKey = null;
let elevenKey = null;
/** Which voice keys are set (Settings asks again after a change). */
const refreshKeys = () =>
  Promise.all([
    api.live
      .hasKey()
      .then((has) => (liveKey = has))
      .catch(() => (liveKey = false)),
    api.openrouter
      .hasKey()
      .then((has) => (routerKey = has))
      .catch(() => (routerKey = false)),
    api.elevenlabs
      .hasKey()
      .then((has) => (elevenKey = has))
      .catch(() => (elevenKey = false)),
  ]);
refreshKeys().then(() => routerKey && talk.warm());
let warmedVoice = store.state.settings.speechVoice;
store.on('change', () => {
  const voice = store.state.settings.speechVoice;
  if (voice !== warmedVoice && routerKey) talk.warm();
  warmedVoice = voice;
});
let liveHinted = false;

/* -------------------------------- ctx -------------------------------- */

const ctx = {
  store,
  api,
  tasks,
  team,
  agent,
  current: () => chatView?.current() || null,
  viewType: () => chatView?.view().type || 'new',
  // A hierarchy task works while its team does, even when its leader waits.
  stateOf: (id) => (tasks.get(id).state === 'idle' && team.busy(id) ? 'working' : tasks.get(id).state),
  /** What a working task is doing, in a few words (the sidebar's second line). */
  activityOf(id) {
    const t = tasks.get(id);
    if (t.state === 'needs') return tasks.waiting(id);
    if (t.state === 'idle' && team.busy(id)) return `Team: ${team.working(id).join(', ')}`;
    if (!t.tool) return 'Thinking';
    return doing(t.tool);
  },
  /**
   * Switch a task between 'single' (one session) and 'hierarchy' (a leader
   * with workers and verifiers). Not while it works; an idle session closes
   * and resumes in its new role on the next message, same conversation.
   * Leaving hierarchy stops a working team (after asking); unmerged work stays on its branches.
   */
  async setTaskMode(id, mode) {
    const task = store.task(id);
    const next = mode === 'hierarchy' ? 'hierarchy' : 'single';
    if (!task || task.kind !== 'claude' || task.mode === next) return null;
    const t = tasks.get(id);
    if (t.state === 'working' || t.state === 'needs') {
      chatView.flash('It’s working: switch once it’s done (or stop it first).');
      return { error: 'working' };
    }
    if (next === 'single' && team.busy(id)) {
      const ok = await confirmDialog({ title: 'Stop the team?', body: `${team.working(id).join(', ')} still working. Single agent stops them; work that isn’t merged stays on its branches.`, ok: 'Stop and switch', cancel: 'Keep the team' });
      if (!ok) return null;
    }
    const reply = await team.setMode(id, next);
    if (reply?.error) {
      chatView.flash(reply.error);
      return reply;
    }
    store.patchTask(id, { mode: next });
    const left = reply?.unmerged?.length ? ` Unmerged work stays on ${reply.unmerged.join(', ')}.` : '';
    chatView.flash(next === 'hierarchy' ? 'Hierarchy: your next message goes to the Leader, who splits the work across workers and has verifiers check it.' : `Single agent: your next message goes to one Claude session, same conversation.${left}`);
    if (pane === 'terminal') terminal.show(id);
    sidebar.render();
    renderTopbar();
    return reply;
  },
  /** The sidebar as a slim rail (Ctrl+B), or full. */
  toggleRail() {
    store.setSetting('rail', !store.state.settings.rail);
  },
  /** Open a task; null opens New task. */
  open(id) {
    const task = store.task(id);
    remember(task ? id : '');
    if (task?.unread) store.patchTask(id, { unread: false });
    if (task && task.projectId !== store.state.settings.currentProject) store.setSetting('currentProject', task.projectId);
    chatView.show(task ? { type: 'task', id } : { type: 'new' });
    if (pane === 'settings' || (pane === 'terminal' && !task)) showPane('chat');
    else if (pane === 'terminal') terminal.show(id);
    sidebar.render();
    renderTopbar();
  },
  openAgent() {
    remember('agent');
    chatView.show({ type: 'agent' });
    if (pane !== 'chat') showPane('chat');
    sidebar.render();
    renderTopbar();
  },
  newTask() {
    if (pane !== 'chat') showPane('chat');
    ctx.open(null);
  },
  createTask,
  /** Write to a task from anywhere (the prompt bar, Katana). */
  async sendToTask(id, text) {
    const task = store.task(id);
    if (!task) return null;
    if (task.doneAt) store.markDone(id, false);
    store.patchTask(id, { updatedAt: Date.now() });
    const term = id === terminal.shown() ? terminal.size() : null;
    if (!tasks.get(id).running && term) await tasks.start(task, '', { cols: term.cols, rows: term.rows });
    return tasks.send(task, text);
  },
  /** Done with a task: its session ends, it leaves the list, the next one shows. */
  done(id, { quiet = false } = {}) {
    const task = store.task(id);
    if (!task || ctx.stateOf(id) === 'working') return;
    tasks.kill(id);
    if (task.mode === 'hierarchy') team.stop(id);
    chatView.app.drop(id);
    store.markDone(id);
    if (!quiet && chatView.current() === id) ctx.open(store.openTasks()[0]?.id || null);
  },
  /** Merge a worktree task's branch back, then it's done. */
  async merge(id) {
    const task = store.task(id);
    if (!task?.worktree || task.merged) return null;
    tasks.kill(id);
    const reply = await api.worktree.merge(task.worktree, `Katana: ${task.title}`);
    if (reply?.error) {
      chatView.flash(reply.error);
      return reply;
    }
    store.patchTask(id, { merged: true });
    ctx.done(id);
    // After done: opening the next task clears the banner.
    chatView.flash(`Merged ${task.worktree.branch} into ${task.worktree.base}.${reply?.warning ? ` ${reply.warning}` : ''}`);
    return reply;
  },
  async discard(id) {
    const task = store.task(id);
    if (!task?.worktree || task.merged) return null;
    tasks.kill(id);
    const reply = await api.worktree.discard(task.worktree);
    if (reply?.error) {
      chatView.flash(reply.error);
      return reply;
    }
    store.patchTask(id, { merged: true });
    ctx.done(id);
    if (reply?.warning) chatView.flash(reply.warning);
    return reply;
  },
  /** The project new tasks go into. */
  currentProject() {
    const { settings, projects } = store.state;
    return store.project(settings.currentProject) ? settings.currentProject : projects[0]?.id || '';
  },
  hasClaude: async () => {
    if (claudeFound === null) claudeFound = await api.sys.claude().catch(() => false);
    return claudeFound;
  },
  found: () => found,
  /** What the greeting calls you: Settings, else your Windows user name. */
  userName() {
    const name = String(store.state.settings.userName || info?.user || '').trim();
    return name ? name[0].toUpperCase() + name.slice(1) : '';
  },
  today: () => store.today(),
  /** How full a task's memory is: { used, window }. */
  contextOf: (id) => ({ used: tasks.get(id).transcript.context(), window: DEFAULT_WINDOW }),
  showContext: (anchor) => chatView.showContext(anchor),
  /**
   * What the usage meter and the Working line show: the plan's live 5-hour and
   * weekly use (whole percents, as Anthropic reports them; a window past its
   * reset is dropped), else this task's memory. { text, share 0..1, title } or null.
   */
  usage(id) {
    const now = Date.now();
    const live = [
      ['5h', 'These 5 hours', plan?.fiveHour],
      ['wk', 'This week', plan?.week],
    ].filter(([, , w]) => w && w.resetsAt > now);
    if (live.length) {
      const resets = (at) => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return {
        text: `${live.map(([type, , w]) => `${type} ${Math.round(w.used * 100)}%`).join(' · ')} used`,
        share: Math.max(...live.map(([, , w]) => w.used)),
        title: live.map(([, label, w]) => `${label}: ${Math.round(w.used * 100)}% of your Claude plan used, resets ${resets(w.resetsAt)}`).join('\n'),
      };
    }
    if (!id) return null;
    const { used, window } = ctx.contextOf(id);
    return { text: `ctx ${((used / window) * 100).toFixed(2)}% used`, share: used / window, title: 'How full this task’s memory is' };
  },
  addProject: () => sidebar.addProject(),
  removeProject: (project) => sidebar.removeProject(project),
  openSettings() {
    if (pane !== 'settings') beforeSettings = pane;
    settingsPage.show();
    showPane('settings');
  },
  closeSettings: () => showPane(beforeSettings),
  showTerminal: () => chatView.current() && showPane('terminal'),
  /** The open task's file in the viewer. */
  showFile() {
    if (pane !== 'chat') showPane('chat');
    chatView.setMode('file');
  },
  openFile(file) {
    if (pane !== 'chat') showPane('chat');
    chatView.openFile(file);
  },
  /** Run a task's app in the viewer (`command`, else its package.json's start), or show a page; on screen if `show`. */
  runApp(id, { command = '', page = '', show = true, cwd = '' } = {}) {
    if (show && pane !== 'chat') showPane('chat');
    return chatView.runApp(id, { command, page, show, cwd });
  },
  stopApp: (id) => chatView.app.stop(id),
  appState: (id) => chatView.app.state(id),
  appOutput: (id) => chatView.app.output(id),
  setAgentMode: (mode) => chatView.setAgentMode(mode),
  pane: () => pane,
  shells: () => [{ value: '', label: 'Default' }, ...shellList.map((shell) => ({ value: shell.id, label: shell.label }))],
  info: () => info,
  flash: (text) => chatView.flash(text),
  chatShown: () => pane === 'chat',
  /** Bring the prompt bar back on screen. */
  showChat() {
    if (pane !== 'chat') showPane('chat');
    if (chatView.mode() !== 'chat') chatView.setMode('chat');
  },
  onMode: () => renderTopbar(),
  /** Talk: a GPT-Live conversation with Katana when it's set up, dictation otherwise. */
  /**
   * Talk: a GPT-Live conversation with an OpenAI key (when that's on);
   * else, with an OpenRouter key, a turn at a time (talk.js); else dictation.
   */
  toggleVoice() {
    if (live.active()) return live.stop();
    if (talk.active()) return talk.tap();
    if (store.state.settings.liveVoice && liveKey) return live.start();
    if (routerKey) return talk.tap();
    if (liveKey === false && routerKey === false && !liveHinted && chatView.view().type === 'agent') {
      liveHinted = true;
      chatView.flash('Add an OpenAI or OpenRouter key in Settings → Katana to talk with her out loud. Dictating for now.');
    }
    return voice.toggle();
  },
  isListening: () => Boolean(live?.active() || talk?.active() || voice?.isListening()),
  /** The voice conversation on now (what the face shows): a turn-at-a-time one, or GPT-Live. */
  live: () => (talk.active() ? talk : live),
  /** An OpenRouter key is set (her wake word and turn-at-a-time voice need it). */
  routerKey: () => Boolean(routerKey),
  refreshLiveKey: refreshKeys,
};

// What a task's app logged going wrong in the viewer: kept with the task, unseen, until your next message to it.
api.appview.onError(({ taskId, entry } = {}) => store.addAppError(taskId, entry));

// A task going away ends its session first.
store.on('task-deleting', (id) => {
  tasks.kill(id);
  team.stop(id, true);
  chatView.app.drop(id);
  tasks.forget(id);
  terminal.drop(id);
  if (chatView.current() === id) queueMicrotask(() => ctx.open(store.openTasks()[0]?.id || null));
});

// The plan's live use: every minute, when a turn finishes, and when Katana's runs say it moved.
// A failed fetch (offline, no login) clears it, so the meter falls back to the task's memory.
async function refreshPlan() {
  plan = await api.sys.planUsage().catch(() => null);
  sidebar.renderFoot();
}
api.run.onEvent((event) => {
  if (event.type === 'limits') refreshPlan();
});

/* ------------------------------- look -------------------------------- */

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
let lastLook = '';
let loginWanted = null;

function applyLook() {
  const { settings } = store.state;
  if (loginWanted !== null && loginWanted !== Boolean(settings.openAtLogin)) api.sys.openAtLogin(Boolean(settings.openAtLogin));
  loginWanted = Boolean(settings.openAtLogin);
  const theme = settings.theme === 'system' ? (darkScheme.matches ? 'graphite' : 'light') : settings.theme || 'graphite';
  const look = `${theme}|${settings.textSize}|${settings.motion}|${settings.rail}`;
  if (look === lastLook) return;
  lastLook = look;
  document.body.dataset.theme = theme;
  document.body.dataset.size = settings.textSize === 'larger' ? 'larger' : 'default';
  document.body.dataset.motion = settings.motion || 'full';
  document.body.toggleAttribute('data-rail', Boolean(settings.rail));
  terminal?.retheme();
  sidebar?.render();
}
store.on('change', applyLook);
darkScheme.addEventListener('change', () => {
  lastLook = '';
  applyLook();
});

/* ----------------------------- keyboard ------------------------------ */

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.code === 'Backquote') {
    event.preventDefault();
    if (chatView.current()) showPane(pane === 'terminal' ? 'chat' : 'terminal');
    return;
  }
  // In the terminal, keys belong to the session (Ctrl+D, Ctrl+N…).
  if (pane === 'terminal') return;
  if (mod && !event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 'n') {
      event.preventDefault();
      ctx.newTask();
      return;
    }
    if (key === 'b') {
      event.preventDefault();
      ctx.toggleRail();
      return;
    }
    if (key === 'k') {
      event.preventDefault();
      ctx.openAgent();
      return;
    }
    if (key === ',') {
      event.preventDefault();
      if (pane === 'settings') ctx.closeSettings();
      else ctx.openSettings();
      return;
    }
    if (pane === 'chat' && chatView.current()) {
      if (key === 'd') {
        event.preventDefault();
        ctx.done(chatView.current());
        return;
      }
      if (key === '.') {
        event.preventDefault();
        tasks.stop(store.task(chatView.current()));
        return;
      }
    }
    if (pane === 'chat' && chatView.view().type === 'agent' && key === '.') {
      event.preventDefault();
      agent.stop();
      return;
    }
  }
  if (event.key === 'Escape' && pane === 'settings' && !document.querySelector('.dialog, .pop')) {
    event.preventDefault();
    ctx.closeSettings();
  }
});

// A change made in the last moment before closing or reloading is still saved (saves are debounced).
window.addEventListener('beforeunload', () => store.flush());

// Like a Mac window: the lights go grey while you're in another app.
window.addEventListener('blur', () => document.body.toggleAttribute('data-blurred', true));
window.addEventListener('focus', () => document.body.toggleAttribute('data-blurred', false));

/* ------------------------------- start ------------------------------- */

const chatView = initChatView(ctx);
const terminal = initTerminal(ctx);
const settingsPage = initSettingsPage(ctx);
const sidebar = initSidebar(ctx);
const voice = initVoice(ctx);

/** She heard her name: two soft rising notes. */
function chime() {
  try {
    const audio = new AudioContext();
    [660, 880].forEach((pitch, i) => {
      const tone = audio.createOscillator();
      const level = audio.createGain();
      tone.frequency.value = pitch;
      level.gain.setValueAtTime(0, audio.currentTime + i * 0.09);
      level.gain.linearRampToValueAtTime(0.07, audio.currentTime + i * 0.09 + 0.02);
      level.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.09 + 0.22);
      tone.connect(level).connect(audio.destination);
      tone.start(audio.currentTime + i * 0.09);
      tone.stop(audio.currentTime + i * 0.09 + 0.25);
    });
    setTimeout(() => audio.close(), 800);
  } catch {
    /* no sound: she still listens */
  }
}

// "Katana" / "hey Katana": she wakes and listens, wherever you are in the app; Tab sends.
createWake({
  api,
  store,
  ctx,
  busy: () => talk.active() || live.active() || voice.isListening() || Boolean(speaking && !speaking.paused && !speaking.ended),
  onWake(request) {
    if (store.state.settings.liveVoice && liveKey && !request) {
      chime();
      live.start();
      return;
    }
    // She answers to her name herself ("Mhm?", "What's up?"), then listens.
    talk.wake(request);
    chatView.flash(request ? `Katana heard “${request}”. Say more, or press Tab to send.` : 'Katana is listening. Press Tab to send.');
  },
});
const appTools = createAppTools({
  api,
  store,
  tasks,
  ctx,
  terminal,
  live,
  flash: (text) => chatView.flash(text),
  notify: (text) => !document.hasFocus() && notify('Katana', text, () => ctx.openAgent()),
});
// The face follows the call: listening, speaking, hung up.
live.on(() => chatView.view().type === 'agent' && chatView.refreshVoice());
talk.on(() => chatView.view().type === 'agent' && chatView.refreshVoice());

api.shells.list().then((list) => {
  shellList = list || [];
});
api.sys.info().then((value) => {
  info = value;
});
api.sys.found().then((value) => {
  found = value;
});

store.load().then(async () => {
  applyLook();
  refreshPlan();
  setInterval(refreshPlan, PLAN_EVERY);
  // The tasks and Katana live on in katanad: catch up with them.
  await Promise.all([tasks.sync(), agent.sync(), team.sync()]);
  let last = null;
  try {
    last = localStorage.getItem(LAST_VIEW);
  } catch {
    /* none */
  }
  if (last === 'agent') return ctx.openAgent();
  const reopen = store.state.settings.reopenLastChat && store.task(last) && !store.task(last).doneAt ? last : null;
  ctx.open(reopen || store.openTasks()[0]?.id || null);
  return undefined;
});

// Look tests drive the app through this.
window.__x2 = { store, ctx, chatView, sidebar, terminal, tasks, team, agent, live, talk, showPane, appTools };
