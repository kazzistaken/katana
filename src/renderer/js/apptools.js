import { DEFAULT_SETTINGS, MODELS, EFFORTS } from './store.js';
import { exchanges, writtenFiles } from './transcript.js';
import { VOICES } from './live.js';
import { SPEECH_VOICES } from './talk.js';
import { SENSITIVITIES } from './bargein.js';

/**
 * Katana's hands in the window: her tools (main apptooldefs.js), carried
 * out the way your clicks are, through ctx. A call comes from her Claude
 * turn (mcp-app.cjs → main → tools:call) and its result goes back as JSON.
 * No DOM here, so scripts/test-apptools.mjs runs it under Node.
 */

const MODEL_ALIAS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

// What press_keys sends for a named key; anything else is typed as it is.
export const KEYS = {
  enter: '\r',
  return: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
  space: ' ',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
};

export const keyBytes = (keys) => (Array.isArray(keys) ? keys : [keys]).map((key) => KEYS[String(key).toLowerCase()] ?? String(key));

const ENUMS = {
  theme: ['system', 'graphite', 'black', 'tokyo-night', 'catppuccin', 'rose-pine', 'nord', 'light'],
  textSize: ['default', 'larger'],
  motion: ['full', 'reduced', 'off'],
  taskEffort: EFFORTS.map((e) => e.id),
  agentEffort: EFFORTS.map((e) => e.id),
  managerEffort: EFFORTS.map((e) => e.id),
  workerEffort: EFFORTS.map((e) => e.id),
  verifierEffort: EFFORTS.map((e) => e.id),
  taskMode: ['single', 'hierarchy'],
  liveVoiceName: VOICES,
  speechVoice: SPEECH_VOICES,
  bargeInSensitivity: SENSITIVITIES,
};
// Set through their own tools (set_folder) or kept to the user (the key).
const NOT_HERE = new Set(['currentProject']);

/** A setting change, checked: { key, value } or { error }. */
export function checkSetting(key, value, { shells = [] } = {}) {
  if (!(key in DEFAULT_SETTINGS) || NOT_HERE.has(key)) return { error: `There’s no setting called ${key}.` };
  const kind = typeof DEFAULT_SETTINGS[key];
  let next = value;
  if (/^(task|agent|manager|worker|verifier)Model$/.test(key)) {
    next = MODEL_ALIAS[String(value).toLowerCase()] || value;
    if (!MODELS.some((m) => m.id === next)) return { error: `${key} is one of opus, sonnet, haiku.` };
    return { key, value: next };
  }
  if (kind === 'boolean') {
    if (typeof value === 'string') next = /^(true|on|yes|1)$/i.test(value);
    else next = Boolean(value);
  } else if (kind === 'number') {
    next = Number(value);
    if (!Number.isFinite(next)) return { error: `${key} is a number.` };
    if (key === 'terminalFontSize') next = Math.min(24, Math.max(8, Math.round(next)));
  } else {
    next = String(value ?? '');
    if (ENUMS[key] && !ENUMS[key].includes(next)) return { error: `${key} is one of ${ENUMS[key].join(', ')}.` };
    if (key === 'shell' && next && !shells.some((s) => s.value === next)) return { error: `shell is one of ${shells.map((s) => s.value || 'default').join(', ')}.` };
  }
  return { key, value: next };
}

const clip = (text, max) => {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more characters)` : value;
};

export function createAppTools({ api, store, tasks, ctx, terminal, live, flash, notify }) {
  /** A task by id; it must exist. */
  function need(id) {
    const task = store.task(String(id || ''));
    if (!task) throw new Error(`There’s no task ${id}. Call app_state for the ids.`);
    return task;
  }

  function folder(name) {
    const project = name ? store.projectByName(name) : store.project(ctx.currentProject());
    if (!project) throw new Error(name ? `There’s no trusted folder called ${name}.` : 'There are no trusted folders yet.');
    return project;
  }

  const stateName = (id) => {
    const t = tasks.get(id);
    // A hierarchy task's leader may wait while its team works: the task is working.
    if (ctx.stateOf?.(id) === 'working') return 'working';
    return t.state === 'idle' && !t.running ? 'not running' : t.state;
  };

  /** A hierarchy task's team, one line per member with work (Katana sees the team, not its sessions). */
  const teamOf = (id) =>
    (ctx.team?.get(id)?.members || []).filter((m) => m.subtask).map((m) => `${m.label} ${m.needs ? 'needs the user' : m.state}${m.verdict && m.role === 'worker' ? ` (${m.verdict})` : ''}${m.merged ? ' (merged)' : ''}: ${m.subtask}`);

  function lastAnswer(id) {
    const entries = tasks.get(id).transcript.entries;
    for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].kind === 'text') return entries[i].text;
    return '';
  }

  function appState() {
    const { settings, projects, agent, tasks: all } = store.state;
    const view = ctx.viewType();
    return {
      time: new Date().toLocaleString(),
      screen: { pane: ctx.pane(), view, task: ctx.current(), file: ctx.current() ? store.task(ctx.current())?.viewFile || null : null },
      folders: projects.map((p) => ({ name: p.name, path: p.path, current: p.id === ctx.currentProject() })),
      tasks: all
        .filter((t) => !t.doneAt || Date.now() - t.doneAt < 3 * 864e5)
        .map((t) => ({
          id: t.id,
          title: t.title,
          folder: store.project(t.projectId)?.name || '?',
          agent: t.kind,
          state: stateName(t.id),
          doing: (ctx.stateOf?.(t.id) ?? tasks.get(t.id).state) === 'working' ? ctx.activityOf(t.id) : undefined,
          question: tasks.get(t.id).state === 'needs' ? `${tasks.waiting(t.id)}: ${tasks.get(t.id).message || 'in its terminal.'}` : undefined,
          model: t.model || undefined,
          mode: t.mode === 'hierarchy' ? 'hierarchy (a Leader with workers and verifiers)' : undefined,
          team: t.mode === 'hierarchy' ? teamOf(t.id) : undefined,
          worktree: t.worktree && !t.merged ? t.worktree.branch : undefined,
          done: Boolean(t.doneAt) || undefined,
          unread: t.unread || undefined,
          last: clip(lastAnswer(t.id), 400) || undefined,
        })),
      settings,
      reminders: agent.reminders.map((r) => ({ id: r.id, text: r.text, at: new Date(r.at).toLocaleTimeString() })),
      checks: (agent.watches || []).map((w) => ({ id: w.id, check: w.check, every: w.every, looked: w.checks, until: new Date(w.until).toLocaleString() })),
      today: store.today(),
      voice: live?.active() ? 'in a live voice conversation' : 'off',
    };
  }

  async function readTask({ task: id, exchanges: count = 3 }) {
    const task = need(id);
    await tasks.load(task);
    const t = tasks.get(task.id);
    const list = exchanges(t.transcript.entries).slice(-Math.max(1, Math.min(20, count)));
    return {
      id: task.id,
      title: task.title,
      folder: store.project(task.projectId)?.name,
      cwd: task.cwd,
      agent: task.kind,
      state: stateName(task.id),
      doing: t.state === 'working' ? ctx.activityOf(task.id) : undefined,
      question: t.state === 'needs' ? t.message : undefined,
      requests: list.map((ex) => ({
        asked: ex.prompts.map((p) => clip(p.text, 2000)),
        tools: ex.tools.slice(-30).map((tool) => `${tool.name} ${String(tool.input?.description || tool.input?.command || tool.input?.file_path || tool.input?.pattern || tool.input?.url || '').slice(0, 140)}`.trim()),
        files: writtenFiles(ex),
        answer: clip(ex.texts.at(-1)?.text || '', 6000),
        stopped: ex.interrupted || undefined,
      })),
      note: task.kind === 'claude' ? undefined : 'Codex and shells keep no transcript: use read_terminal.',
    };
  }

  /** Show a task's terminal (it may need the >_ pane first). */
  function showTask(id, pane) {
    ctx.open(id);
    if (pane === 'terminal') ctx.showTerminal();
    if (pane === 'file') {
      if (!store.task(id)?.viewFile) throw new Error('That task has no file open.');
      ctx.showFile();
    }
  }

  const run = {
    app_state: () => appState(),
    read_task: readTask,
    read_terminal: async ({ task: id, lines = 60 }) => {
      const task = need(id);
      if (!tasks.get(task.id).running) return { running: false, screen: '(not running: read_task shows what it said)' };
      return { running: true, screen: await terminal.screen(task.id, Math.min(400, Math.max(5, lines))) };
    },
    new_task: async ({ folder: name, prompt, title, agent, model, effort, worktree, hierarchy = false, open = false }) => {
      const project = folder(name);
      const task = await ctx.createTask({
        projectId: project.id,
        kind: ['claude', 'codex', 'shell'].includes(agent) ? agent : 'claude',
        prompt: String(prompt || ''),
        title: title || undefined,
        worktree: worktree ?? store.state.settings.worktrees,
        // Hers are single sessions unless she asks for a team.
        mode: hierarchy ? 'hierarchy' : 'single',
        model: MODEL_ALIAS[model] || undefined,
        effort: EFFORTS.some((e) => e.id === effort) ? effort : undefined,
        open: Boolean(open),
      });
      if (!task) throw new Error('The task couldn’t be made.');
      return { id: task.id, title: task.title, folder: project.name };
    },
    send_to_task: async ({ task: id, text }) => {
      const task = need(id);
      const reply = await ctx.sendToTask(task.id, String(text || ''));
      if (reply?.error) throw new Error(reply.error);
      return { sent: true };
    },
    press_keys: ({ task: id, keys }) => {
      const task = need(id);
      if (!tasks.get(task.id).running) throw new Error('That task isn’t running.');
      const bytes = keyBytes(keys);
      // One at a time, as typed: a TUI reads a burst as one paste.
      bytes.forEach((data, i) => setTimeout(() => api.task.write(task.id, data), i * 60));
      tasks.answered(task.id);
      return { pressed: keys };
    },
    stop_task: ({ task: id }) => {
      tasks.stop(need(id));
      return { stopped: true };
    },
    finish_task: ({ task: id }) => {
      const task = need(id);
      if (tasks.get(task.id).state === 'working') throw new Error('It is still working: stop it first.');
      ctx.done(task.id);
      return { done: true };
    },
    reopen_task: ({ task: id }) => {
      store.markDone(need(id).id, false);
      return { reopened: true };
    },
    restart_task: async ({ task: id }) => {
      const task = need(id);
      tasks.kill(task.id);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const reply = await tasks.start(store.task(task.id));
      if (reply?.error) throw new Error(reply.error);
      return { restarted: true };
    },
    rename_task: ({ task: id, title }) => {
      const value = String(title || '').trim();
      if (!value) throw new Error('A name, please.');
      store.patchTask(need(id).id, { title: value, named: true });
      return { renamed: value };
    },
    delete_task: ({ task: id }) => {
      store.deleteTask(need(id).id);
      return { deleted: true };
    },
    merge_task: async ({ task: id }) => {
      const task = need(id);
      if (!task.worktree || task.merged) throw new Error('That task has no worktree to merge.');
      const reply = await ctx.merge(task.id);
      if (reply?.error) throw new Error(reply.error);
      return { merged: `${task.worktree.branch} into ${task.worktree.base}`, ...(reply?.warning ? { warning: reply.warning } : {}) };
    },
    discard_task: async ({ task: id }) => {
      const task = need(id);
      if (!task.worktree || task.merged) throw new Error('That task has no worktree.');
      const reply = await ctx.discard(task.id);
      if (reply?.error) throw new Error(reply.error);
      return { discarded: true, ...(reply?.warning ? { warning: reply.warning } : {}) };
    },
    task_changes: async ({ task: id }) => {
      const task = need(id);
      if (!task.worktree) throw new Error('That task works in its folder directly, with no worktree.');
      const reply = await api.worktree.changes(task.worktree);
      if (reply?.error) throw new Error(reply.error);
      return reply;
    },
    show: ({ view, task: id }) => {
      if (view === 'task' || view === 'terminal' || view === 'file') showTask(need(id || ctx.current()).id, view);
      else if (view === 'new_task') ctx.newTask();
      else if (view === 'katana' || view === 'katana_conversation') {
        ctx.openAgent();
        ctx.setAgentMode(view === 'katana' ? 'avatar' : 'doc');
      } else if (view === 'settings') ctx.openSettings();
      else if (view === 'close_settings') ctx.closeSettings();
      else throw new Error(`There’s no view called ${view}.`);
      return { shown: view };
    },
    set_setting: ({ key, value }) => {
      const checked = checkSetting(String(key || ''), value, { shells: ctx.shells() });
      if (checked.error) throw new Error(checked.error);
      store.setSetting(checked.key, checked.value);
      return { [checked.key]: checked.value };
    },
    set_folder: ({ folder: name }) => {
      const project = folder(name);
      store.setSetting('currentProject', project.id);
      return { current: project.name };
    },
    trust_folder: async ({ path }) => {
      let chosen = String(path || '').trim();
      if (chosen) {
        if (!(await api.folder.confirm(chosen))) return { trusted: false, why: 'The user said no (or the folder doesn’t exist).' };
      } else {
        chosen = await api.folder.pick();
        if (!chosen) return { trusted: false, why: 'The user cancelled.' };
      }
      const project = store.addProject(chosen);
      return { trusted: true, name: project.name, path: project.path };
    },
    remove_folder: async ({ folder: name }) => ({ removed: Boolean(await ctx.removeProject(folder(name))) }),
    remind: async ({ minutes, text }) => {
      const reminder = await store.addReminder(minutes, text);
      return { id: reminder.id, at: new Date(reminder.at).toLocaleTimeString() };
    },
    cancel_reminder: async ({ reminder }) => {
      const key = String(reminder || '').toLowerCase();
      // No words, no match: '' is in every text.
      const found = store.state.agent.reminders.find((r) => r.id === reminder) || (key && store.state.agent.reminders.find((r) => r.text.toLowerCase().includes(key)));
      if (!found) throw new Error('There’s no reminder like that.');
      await store.dropReminder(found.id);
      return { cancelled: found.text };
    },
    watch: async ({ every, check, hours }) => {
      const item = await store.addWatch(every, check, hours);
      return { id: item.id, every: item.every, until: new Date(item.until).toLocaleString() };
    },
    cancel_watch: async ({ watch: which }) => {
      const key = String(which || '').toLowerCase();
      const all = store.state.agent.watches || [];
      const found = all.find((w) => w.id === which) || (key && all.find((w) => w.check.toLowerCase().includes(key)));
      if (!found) throw new Error('There’s no check like that.');
      await store.dropWatch(found.id);
      return { cancelled: found.check };
    },
    open_file: async ({ path, task: id, external = false }) => {
      const file = String(path || '');
      const [info] = (await api.file.stat([file], '')) || [];
      if (!info) throw new Error('That file doesn’t exist, or isn’t a kind the viewer shows (HTML, images, video, audio, PDF, Markdown, text).');
      if (external) {
        await api.file.open(info.path);
        return { opened: info.path };
      }
      const task = need(id || ctx.current());
      ctx.open(task.id);
      ctx.openFile(info.path);
      return { showing: info.path, beside: task.title };
    },
    // A hierarchy verifier's (or worker's) call comes with its own folder (`cwd`): its app runs from there, in its task's viewer.
    run_app: async ({ task: id, command = '', page = '', from = '', cwd = '' }) => {
      const task = need(id || ctx.current());
      // A task's own session testing in the background doesn't take over your screen;
      // Katana asked to show it, or you're on that task: it shows.
      const show = from !== 'task' || ctx.current() === task.id;
      if (show) ctx.open(task.id);
      const reply = await ctx.runApp(task.id, { command: String(command || ''), page: String(page || ''), show, ...(from === 'task' && cwd ? { cwd: String(cwd) } : {}) });
      if (reply?.error) throw new Error(reply.error);
      // Ready to be looked at: its first window is up (or it ended).
      const state = await settle(task.id);
      if (state?.status === 'failed' || state?.status === 'exited') throw new Error(`It ended right away${state.exitCode != null ? ` (exit code ${state.exitCode})` : ''}. read_app_output says why.`);
      return { running: reply.page || reply.label, in: reply.cwd, status: state?.status || reply.status, windows: (state?.windows || []).filter((w) => w.kind === 'top').map((w) => w.title), shown: show };
    },
    app_screenshot: async ({ task: id }) => viewer(await api.appview.screenshot(need(id || ctx.current()).id)),
    app_click: async ({ task: id, x, y, button = 'left', double = false }) => viewer(await api.appview.click(need(id || ctx.current()).id, { x: Number(x), y: Number(y), button, double: Boolean(double) })),
    app_type: async ({ task: id, text = '' }) => viewer(await api.appview.type(need(id || ctx.current()).id, String(text))),
    app_key: async ({ task: id, keys = [] }) => viewer(await api.appview.keys(need(id || ctx.current()).id, Array.isArray(keys) ? keys.map(String) : [String(keys)])),
    app_scroll: async ({ task: id, x, y, dy = 0, dx = 0 }) => viewer(await api.appview.scroll(need(id || ctx.current()).id, { x: Number(x), y: Number(y), dy: Number(dy), dx: Number(dx) })),
    stop_app: async ({ task: id }) => {
      const task = need(id || ctx.current());
      if (!ctx.appState(task.id)) return { already: 'No app has run beside that task.' };
      const state = await ctx.stopApp(task.id);
      return { stopped: state?.label || true, status: state?.status || 'exited' };
    },
    read_app_output: ({ task: id, lines = 80 }) => {
      const task = need(id || ctx.current());
      const state = ctx.appState(task.id);
      if (!state) return { none: 'No app has run beside that task. run_app starts one.' };
      const text = ctx.appOutput(task.id).split(/\r?\n/).slice(-Math.max(1, Math.min(2000, Number(lines) || 80))).join('\n');
      return {
        app: state.page || state.label,
        status: state.status,
        exitCode: state.exitCode,
        windows: state.windows.filter((w) => w.kind === 'top').map((w) => w.title),
        output: clip(text, 12000),
        // Logged quietly while it ran; the user is asked about them on their next message.
        errors: (task.appErrors || []).map(({ kind, message, detail, count }) => ({ kind, message, ...(detail ? { detail: clip(detail, 1500) } : {}), ...(count > 1 ? { count } : {}) })),
      };
    },
    notice: ({ text }) => {
      flash(String(text || ''));
      notify?.(String(text || ''));
      return { shown: true };
    },
    end_voice: () => {
      if (!live?.active()) return { already: 'No voice conversation is on.' };
      // After this answer is spoken.
      setTimeout(() => live.stop(), 2500);
      return { ending: true };
    },
  };

  /** A viewer call's answer, or its error thrown (so the tool says it). */
  function viewer(reply) {
    if (!reply || reply.error) throw new Error(reply?.error || 'The app viewer didn’t answer.');
    return reply;
  }

  /** A run just started: wait (a while) until it has a window, or ended. */
  async function settle(id, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
      const state = ctx.appState(id);
      const done = state && (state.status === 'failed' || state.status === 'exited' || (state.status === 'running' && state.windows.some((w) => w.kind === 'top')));
      if (done || Date.now() > end) return state;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function call(name, args) {
    const fn = run[name];
    if (!fn) throw new Error(`There’s no tool called ${name}.`);
    return fn(args || {});
  }

  api.tools?.onCall(async ({ callId, name, args }) => {
    try {
      api.tools.result(callId, await call(name, args));
    } catch (error) {
      api.tools.result(callId, null, error?.message || String(error));
    }
  });

  return { call, names: () => Object.keys(run) };
}
