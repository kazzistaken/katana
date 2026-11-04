import { $, el, icons, closeDown, SPRING } from './util.js';
import { createStore, setCodexModels, customBackground, flatColor } from './store.js';
import { createTaskClient } from './taskclient.js';
import { createTeamClient, doing } from './teamclient.js';
import { confirmDialog } from './dialog.js';
import { createAgent } from './agent.js';
import { initSidebar } from './sidebar.js';
import { initChatView, isDoc, fileUrl } from './chatview.js';
import { initTerminal } from './terminal.js';
import { initSettingsPage } from './settings.js';
import { SUBAGENTS_LEAD } from './transcript.js';
import { initVoice } from './voice.js';
import { createAppTools } from './apptools.js';
import { ding, doneSound } from './ding.js';
import { initScene, SCENE_THEMES } from './scene.js';

/**
 * Katana — renderer entry. Each task is a real terminal session
 * (Claude Code, Codex or a shell) that main runs; taskclient.js follows
 * what it does. Katana, the agent above the tasks, runs the app for you
 * with its own controls (apptools.js), reminds you of things, and is woken
 * when one finishes.
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
const viewButtons = { chat: $('#view-chat'), file: $('#view-file'), terminal: $('#view-terminal') };
viewButtons.chat.innerHTML = icons.doc;
viewButtons.file.innerHTML = icons.globe;
viewButtons.terminal.innerHTML = icons.prompt;
let pane = 'chat';
let beforeSettings = 'chat';
const mainPanel = $('.panel.main');
let closingSettings = false;
const finishing = new Set(); // Tasks you just pressed Done on, on their way out.

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
  // A document beside the chat: the sidebar folds away to make room, and comes back when it closes.
  const docOpen = fileMode && isDoc(task?.viewFile) ? task.viewFile : '';
  if (!docOpen) docSideOff = '';
  setDocSide(Boolean(docOpen) && docOpen !== docSideOff);
  const appMode = pane === 'chat' && chatView?.mode() === 'app';
  // The browser fills the main area: no bar over it.
  topbar.hidden = pane === 'settings' || appMode;
  const project = store.project(task?.projectId || ctx.currentProject());
  const view = chatView?.view().type;
  // Home keeps the scene sharp; anything you read or work in brings it out of focus behind you (macos.css).
  const looking = pane === 'chat' && (!view || view === 'new') ? 'home' : 'work';
  if (document.body.dataset.view !== looking) document.body.dataset.view = looking;
  // Where you are, as a trail: the folder (and a worktree's branch), then the task or file.
  const folder = task?.worktree && !task.merged ? `${project?.name || ''} · ${task.worktree.branch}` : project?.name || '';
  let trail = [folder];
  if (fileMode) trail = [folder, task.viewFile.split(/[\\/]/).pop()];
  else if (appMode) trail = [folder, 'page'];
  else if (view === 'agent') trail = ['Katana'];
  else if (task) trail = [folder, task.title];
  trail = trail.filter(Boolean);
  // (A branch's name carries its mark, as in the sidebar.)
  const branchMark = view !== 'agent' && !fileMode && !appMode && task?.forkOf ? el('span', { class: 'branch-mark', title: 'Branched: it remembers the conversation it came from', html: icons.branch }) : null;
  topLabel.replaceChildren(...trail.flatMap((part, i) => [i ? el('span', { class: 'top-sep', text: '/', 'aria-hidden': 'true' }) : null, i === trail.length - 1 ? branchMark : null, el('span', { class: i === trail.length - 1 ? 'top-here' : '', text: part })].filter(Boolean)));
  topLabel.title = fileMode ? task.viewFile : task?.cwd || project?.path || '';
  // (A document's own bar has Show in Explorer: this is for what fills the area.)
  openExternal.hidden = !fileMode || Boolean(docOpen);
  tellScreen(task, fileMode);
  // A page opens in the browser; a document in its own app.
  if (fileMode) openExternal.textContent = /\.(md|markdown|txt)$/i.test(task.viewFile) ? 'Open' : 'Open in browser';
  viewButtons.file.hidden = !task?.viewFile;
  viewButtons.terminal.hidden = !task;
  viewButtons.chat.title = view === 'agent' ? 'Conversation' : 'Task';
  const lit = pane === 'terminal' ? 'terminal' : fileMode || appMode ? 'file' : 'chat';
  for (const [key, button] of Object.entries(viewButtons)) {
    button.classList.toggle('is-active', key === lit);
    button.setAttribute('aria-pressed', String(key === lit));
  }
}

viewButtons.chat.addEventListener('click', () => {
  if (pane !== 'chat') showPane('chat');
  chatView.setMode('chat');
});
viewButtons.file.addEventListener('click', () => {
  if (pane !== 'chat') showPane('chat');
  chatView.setMode('file');
});
viewButtons.terminal.addEventListener('click', () => showPane(pane === 'terminal' ? 'chat' : 'terminal'));
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
  // Sub-agents mode: its session leads on Opus (always: runargs.js) and picks a sub-agent per piece.
  const { settings } = store.state;
  const want = kind === 'claude' ? (mode ?? settings.taskMode) : 'single';
  const lead = want === 'hierarchy';
  const delegate = want === 'subagents';
  const task = store.newTask(projectId, { kind, mode: lead || delegate ? want : 'single', title: name, worktree: tree, model: delegate ? SUBAGENTS_LEAD : model ?? (lead ? settings.managerModel : undefined), effort: effort ?? (lead ? settings.managerEffort : undefined) });
  await store.flush();
  if (open) ctx.open(task.id);
  const reply = prompt ? await tasks.send(task, prompt) : await tasks.start(task);
  if (reply?.error) chatView.flash(reply.error);
  // A shell is its terminal: show it. (Codex reads like Claude, in the chat.)
  if (open && kind === 'shell') showPane('terminal');
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

// Katana lives in katanad: her conversation and reminders are hers, the window shows them.
store.agentRemote = {
  say: (role, text, extra) => api.agent.say(role, text, extra),
  remind: (minutes, text) => api.agent.remind(minutes, text),
  watch: (every, check, hours) => api.agent.watch(every, check, hours),
  drop: (id) => api.agent.drop(id),
};
const agent = createAgent({ api, store });

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

/* -------------------------------- ctx -------------------------------- */

const ctx = {
  store,
  api,
  tasks,
  team,
  agent,
  current: () => chatView?.current() || null,
  viewType: () => chatView?.view().type || 'new',
  sceneAgents: (list) => scene.setAgents(list),
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
   * Switch a task between 'single' (one session), 'hierarchy' (a leader
   * with workers and verifiers) and 'subagents' (one Opus session that leads
   * and hands each piece to a Haiku, Sonnet or Opus sub-agent). Not while it works; an idle session closes
   * and resumes in its new role on the next message, same conversation.
   * Leaving hierarchy stops a working team (after asking); unmerged work stays on its branches.
   */
  async setTaskMode(id, mode) {
    const task = store.task(id);
    const next = mode === 'hierarchy' || mode === 'subagents' ? mode : 'single';
    if (!task || task.kind !== 'claude' || task.mode === next) return null;
    const t = tasks.get(id);
    if (t.state === 'working' || t.state === 'needs') {
      chatView.flash('It’s working: switch once it’s done (or stop it first).');
      return { error: 'working' };
    }
    if (next !== 'hierarchy' && team.busy(id)) {
      const ok = await confirmDialog({ title: 'Stop the team?', body: `${team.working(id).join(', ')} still working. ${next === 'single' ? 'Single agent' : 'Sub-agents'} stops them; work that isn’t merged stays on its branches.`, ok: 'Stop and switch', cancel: 'Keep the team' });
      if (!ok) return null;
    }
    const reply = await team.setMode(id, next);
    if (reply?.error) {
      chatView.flash(reply.error);
      return reply;
    }
    store.patchTask(id, { mode: next });
    const left = reply?.unmerged?.length ? ` Unmerged work stays on ${reply.unmerged.join(', ')}.` : '';
    const said = {
      hierarchy: 'Hierarchy: your next message goes to the Leader, who splits the work across workers and has verifiers check it.',
      subagents: `Sub-agents: your next message goes to one Claude session, same conversation, led by Opus, which hands each piece to a sub-agent: Haiku for simple fixes, Sonnet for hard work and logic, Opus for complicated systems and hard bugs.${left}`,
      single: `Single agent: your next message goes to one Claude session, same conversation.${left}`,
    };
    chatView.flash(said[next]);
    if (pane === 'terminal') terminal.show(id);
    sidebar.render();
    renderTopbar();
    return reply;
  },
  /** The collapsed sidebar slid out over the chat (hover; sidebar.js), or back. Never saved. */
  setPeek(on) {
    peek = Boolean(on);
    applyLook();
  },
  /** The sidebar as a slim rail (Ctrl+B), or full. */
  toggleRail() {
    // Folded for a document beside the chat: Ctrl+B opens it (or folds it) for that document only.
    if (docSide || docSideOff) {
      docSideOff = docSide ? store.task(chatView.current())?.viewFile || '' : '';
      return setDocSide(!docSide);
    }
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
  /**
   * Branch a Claude task: a new task that starts from its conversation so far
   * (Claude Code's --fork-session), in the same folder. The two go on separately.
   */
  branch(id) {
    const from = store.task(id);
    if (!from || from.kind !== 'claude' || !from.started) return null;
    const task = store.newTask(from.projectId, {
      kind: 'claude',
      // A team is its leader's own: the branch is one session (switch it after, if you like).
      mode: from.mode === 'hierarchy' ? 'single' : from.mode,
      // (aiTitled: the copied session's own title would make it look like the original. Its next message names it.)
      title: from.title,
      aiTitled: true,
      model: from.model,
      effort: from.effort,
      // Its folder, worktree included: the worktree stays the original task's (merged or deleted with it).
      cwd: from.cwd,
      forkOf: from.sessionId,
    });
    ctx.open(task.id);
    // (A new branch is only its prompt bar, with no words on the page.)
    return task;
  },
  /** Write to a task from anywhere (the prompt bar, Katana). */
  async sendToTask(id, text) {
    const task = store.task(id);
    if (!task) return null;
    if (task.doneAt) store.markDone(id, false);
    store.patchTask(id, { updatedAt: Date.now() });
    // Not running: the message starts its session, in its terminal's size when that's open.
    const term = id === terminal.shown() ? terminal.size() : null;
    return tasks.send(task, text, term ? { cols: term.cols, rows: term.rows } : {});
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
    // Free its transcript and terminal like a delete does (reopening reloads the transcript from disk).
    // A moment later, so the last lines of the ended session don't recreate a half-empty transcript.
    setTimeout(() => {
      const now = store.task(id);
      if (!now?.doneAt || chatView.current() === id || ctx.stateOf(id) === 'working') return;
      tasks.forget(id);
      terminal.drop(id);
      terminal.team.drop(id);
    }, 1500);
  },
  /** You pressing Done: a tick, a sound, and the chat closes down before the next one shows. */
  finishTask(id) {
    const task = store.task(id);
    if (!task || task.doneAt || finishing.has(id) || ctx.stateOf(id) === 'working') return;
    if (store.state.settings.ding) doneSound();
    if (chatView.current() !== id || pane === 'settings') {
      ctx.done(id);
      return;
    }
    finishing.add(id);
    const button = document.querySelector('.key-btn.is-done-key');
    if (button) {
      button.style.minWidth = `${button.offsetWidth}px`;
      button.classList.add('is-finishing');
      button.innerHTML = `${icons.check}Done`;
      button.animate([{ transform: 'scale(0.86)' }, { transform: 'none' }], { duration: 380, easing: SPRING });
    }
    closeDown(
      mainPanel,
      () => {
        finishing.delete(id);
        ctx.done(id);
      },
      button ? 130 : 0
    );
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
  usage: (id) => ctx.planUsage() || ctx.contextUsage(id),
  /** The plan's live 5-hour and weekly use: { text, short, share, title }, or null. */
  planUsage() {
    const now = Date.now();
    const live = [
      ['5h', 'These 5 hours', plan?.fiveHour],
      ['wk', 'This week', plan?.week],
    ].filter(([, , w]) => w && w.resetsAt > now);
    if (live.length) {
      const resets = (at) => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return {
        text: `${live.map(([type, , w]) => `${type} ${Math.round(w.used * 100)}%`).join(' · ')} used`,
        short: live.map(([type, , w]) => `${type} ${Math.round(w.used * 100)}%`).join(' · '),
        share: Math.max(...live.map(([, , w]) => w.used)),
        title: live.map(([, label, w]) => `${label}: ${Math.round(w.used * 100)}% of your Claude plan used, resets ${resets(w.resetsAt)}`).join('\n'),
      };
    }
    return null;
  },
  /** How full a task's memory is: { text, share, title }, or null with no task. */
  contextUsage(id) {
    if (!id) return null;
    const { used, window } = ctx.contextOf(id);
    const percent = (used / window) * 100;
    return { text: `${percent > 0 && percent < 1 ? '<1' : Math.round(percent)}% context`, share: used / window, title: 'How full this task’s memory (context window) is' };
  },
  addProject: () => sidebar.addProject(),
  removeProject: (project) => sidebar.removeProject(project),
  openSettings() {
    if (pane !== 'settings') beforeSettings = pane;
    settingsPage.show();
    showPane('settings');
  },
  closeSettings() {
    if (pane !== 'settings') {
      showPane(beforeSettings);
      return;
    }
    if (closingSettings) return;
    closingSettings = true;
    closeDown(mainPanel, () => {
      closingSettings = false;
      // (Unless something else was opened while it closed.)
      if (pane === 'settings') showPane(beforeSettings);
    });
  },
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
  /** The prompt bar's mic: dictation. */
  dictate: () => voice.toggle(),
};

// What a task's app logged going wrong in the viewer: kept with the task, unseen, until your next message to it.
// A burst of them (an app printing error after error) is kept in one go, a moment later.
const appErrorsHeld = new Map(); // task id -> entries
let appErrorsTimer = 0;
api.appview.onError(({ taskId, entry } = {}) => {
  const list = appErrorsHeld.get(taskId) || [];
  // (A flood beyond this adds nothing: the log keeps 50, repeats counted.)
  if (list.length < 500) list.push(entry);
  appErrorsHeld.set(taskId, list);
  appErrorsTimer = appErrorsTimer || setTimeout(keepAppErrors, 300);
});
function keepAppErrors() {
  appErrorsTimer = 0;
  for (const [taskId, entries] of appErrorsHeld) store.addAppErrors(taskId, entries);
  appErrorsHeld.clear();
}

// A task going away ends its session first.
store.on('task-deleting', (id) => {
  tasks.kill(id);
  team.stop(id, true);
  chatView.app.drop(id);
  tasks.forget(id);
  terminal.drop(id);
  terminal.team.drop(id);
  if (chatView.current() === id) queueMicrotask(() => ctx.open(store.openTasks()[0]?.id || null));
  // Its unmerged worktree goes too (after its session lets go of the folder); a branch holding unmerged work stays.
  const tree = store.task(id)?.worktree;
  // (Not while a branch of it still works in that folder.)
  const branched = tree && store.state.tasks.some((task) => task.id !== id && task.cwd === tree.path);
  if (tree && !store.task(id).merged && !branched) {
    setTimeout(() => api.worktree.cleanup(tree).then((reply) => reply?.warning && chatView.flash(reply.warning)).catch(() => {}), 500);
  }
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
// The sidebar folded for a document open beside the chat (not saved: settings.rail is your own choice).
let docSide = false;
// The document you opened the sidebar again for (Ctrl+B): it stays open for that one.
let docSideOff = '';
function setDocSide(on) {
  if (docSide === on) return;
  docSide = on;
  applyLook();
}
// Collapsed, and slid out for the moment under the mouse.
let peek = false;
let loginWanted = null;

function applyLook() {
  const { settings } = store.state;
  if (loginWanted !== null && loginWanted !== Boolean(settings.openAtLogin)) api.sys.openAtLogin(Boolean(settings.openAtLogin));
  loginWanted = Boolean(settings.openAtLogin);
  // One of your own backgrounds: the 'custom' scene, painting that picture. No background: 'none' over either (scene.js), the theme kept.
  // Slate has no scene and its own colour; the settings for the others are kept for coming back.
  const slate = settings.style === 'slate';
  const noScene = slate || settings.noBackground;
  const own = noScene ? null : customBackground(settings);
  const theme = noScene ? 'none' : own ? 'custom' : SCENE_THEMES.has(settings.theme) ? settings.theme : 'night-lake';
  const flat = slate ? { id: 'slate', hex: '#2f3642' } : flatColor(settings);
  const look = `${settings.style}|${theme}|${flat.id}|${own?.file || ''}|${Boolean(settings.darkMode)}|${settings.textSize}|${settings.rail}|${docSide}|${peek}`;
  if (look === lastLook) return;
  lastLook = look;
  if (own) document.body.dataset.photo = fileUrl(own.file);
  else delete document.body.dataset.photo;
  // No background's colour: the one source of the window's and panels' flat colour (styles.css, macos.css).
  document.body.style.setProperty('--flat-c', flat.hex);
  document.body.dataset.flat = flat.id;
  document.body.dataset.theme = theme;
  if (slate) document.body.dataset.look = 'slate';
  else delete document.body.dataset.look;
  document.body.toggleAttribute('data-dark', slate || Boolean(settings.darkMode));
  document.body.dataset.size = settings.textSize === 'larger' ? 'larger' : 'default';
  // Slid out, it's drawn as the full sidebar over the rail's narrow column (data-peek: macos.css).
  const folded = Boolean(settings.rail) || docSide;
  if (peek && !folded) {
    peek = false;
    sidebar?.holdWidth();
  }
  document.body.toggleAttribute('data-rail', folded && !peek);
  document.body.toggleAttribute('data-peek', folded && peek);
  terminal?.retheme();
  sidebar?.render();
}
store.on('change', applyLook);
// The open task's name changed (renamed, or the AI's title): the top bar follows.
let topTitle = '';
store.on('change', () => {
  const title = store.task(chatView?.current())?.title || '';
  if (title === topTitle) return;
  topTitle = title;
  renderTopbar();
});
const scene = initScene();
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
        ctx.finishTask(chatView.current());
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
  // (Not when Esc just stopped dictation: voice.js took it.)
  if (event.key === 'Escape' && !event.defaultPrevented && pane === 'settings' && !document.querySelector('.dialog:not(.is-leaving), .pop:not(.is-leaving)')) {
    event.preventDefault();
    ctx.closeSettings();
  }
});

// A change made in the last moment before closing or reloading is still saved (saves are debounced).
window.addEventListener('beforeunload', () => {
  if (appErrorsTimer) keepAppErrors();
  store.flush();
});

// The saved state couldn't be read (nor its backup): nothing is saved over it until you choose.
store.on('unreadable', async ({ message, file } = {}) => {
  const fresh = await confirmDialog({
    title: 'Your saved projects and tasks couldn’t be read',
    body: `${file || 'state.json'} is damaged or locked (${message}). Nothing has been written over it. Start fresh keeps it beside the new one (renamed .unreadable-…) so it can be recovered; Not now leaves it alone (changes you make won’t be saved; F5 tries again).`,
    ok: 'Start fresh',
    cancel: 'Not now',
  });
  if (fresh) return startFresh();
  const bar = el('div', { class: 'state-unreadable', role: 'alert', style: 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:1000;display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:8px;background:#5a1d1d;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.4)' }, el('span', { text: 'Saved state unreadable: changes aren’t being saved.' }), el('button', { class: 'btn', type: 'button', text: 'Start fresh', onclick: () => startFresh().then(() => bar.remove()) }));
  document.body.append(bar);
});
async function startFresh() {
  try {
    await store.startFresh();
    chatView.flash('Started fresh. The unreadable file was kept beside it in the data folder.');
  } catch (error) {
    chatView.flash(`Couldn’t start fresh: ${error.message}`);
  }
}

// Like a Mac window: the lights go grey while you're in another app.
window.addEventListener('blur', () => document.body.toggleAttribute('data-blurred', true));
window.addEventListener('focus', () => document.body.toggleAttribute('data-blurred', false));

/* ------------------------------- start ------------------------------- */

// The opening (macos.css): the scene comes up out of the dark, then the panels settle over it.
setTimeout(() => document.body.removeAttribute('data-boot'), 2600);

const chatView = initChatView(ctx);
const terminal = initTerminal(ctx);
const settingsPage = initSettingsPage(ctx);
const sidebar = initSidebar(ctx);
const voice = initVoice(ctx);
ctx.readScreen = (id, lines) => terminal.screen(id, lines);

const appTools = createAppTools({
  api,
  store,
  tasks,
  ctx,
  terminal,
  flash: (text) => chatView.flash(text),
  notify: (text) => !document.hasFocus() && notify('Katana', text, () => ctx.openAgent()),
});

api.shells.list().then((list) => {
  shellList = list || [];
});
api.sys.info().then((value) => {
  info = value;
});
api.sys.found().then((value) => {
  found = value;
  // The models Codex offers now, for its model menus.
  setCodexModels(value?.codexModels);
  chatView.refresh();
});

store.load().then(async () => {
  applyLook();
  refreshPlan();
  setInterval(refreshPlan, PLAN_EVERY);
  // The tasks and Katana live on in katanad: catch up with them.
  // Then her tool calls can come here (until now main kept them waiting).
  await Promise.all([tasks.sync(), agent.sync(), team.sync()]).finally(() => api.tools?.ready?.());
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
window.__x2 = { scene, store, ctx, chatView, sidebar, terminal, tasks, team, agent, showPane, appTools };
