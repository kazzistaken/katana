'use strict';

/**
 * Katana's tools when no window is open. With a window open, every tool is
 * carried out there (renderer apptools.js), like a click; with none, the
 * daemon does what it can itself, on the same saved state the window
 * loads next time (state.json, written only while no window is open) with
 * the window's own store code, so a task made here is made the same way.
 *
 * What needs a screen (show, open_file, run_app) or your confirmation (trust_folder,
 * remove_folder) says so instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const worktree = require('../main/worktree');
const { plain } = require('../main/tasks');
const { shellsFrom } = require('../main/shells');
const { existsInPath } = require('../main/claude');
const { lastAnswer } = require('./agent');

const MODEL_ALIAS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
const RENDERER = path.join(__dirname, '..', 'renderer', 'js');
const NEEDS_WINDOW = 'No Katana window is open, and this needs one. Say what you would show, or ask the user to open the app.';

const clip = (text, max) => {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more characters)` : value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let modules = null;
/** The window's own code, which runs here too (it has no DOM in it). */
function load() {
  modules =
    modules ||
    Promise.all(['store.js', 'apptools.js', 'transcript.js'].map((name) => import(pathToFileURL(path.join(RENDERER, name)).href))).then(([store, apptools, transcript]) => ({
      ...store,
      ...apptools,
      ...transcript,
    }));
  return modules;
}

function createHeadless({ userDataDir, core, agent, notify }) {
  const stateFile = path.join(userDataDir, 'state.json');

  /** The saved state, through the window's store: changed, then written. */
  async function withStore(change, { write = true } = {}) {
    const { createStore } = await load();
    const store = createStore({
      state: {
        load: async () => {
          try {
            return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          } catch {
            return null;
          }
        },
        // Katana's memory lives in agent.json, not here.
        save: async (state) => {
          fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ ...state, agent: undefined }, null, 2), 'utf8');
          fs.renameSync(`${stateFile}.tmp`, stateFile);
          return true;
        },
      },
    });
    await store.load();
    const result = await change(store);
    if (write) await store.flush();
    return result;
  }

  const live = () => new Map(core.snapshot().map((t) => [t.id, t]));

  function need(store, id) {
    const task = store.task(String(id || ''));
    if (!task) throw new Error(`There’s no task ${id}. Call app_state for the ids.`);
    return task;
  }

  function folder(store, name) {
    const { settings, projects } = store.state;
    const current = projects.find((p) => p.id === settings.currentProject) || projects[0];
    const project = name ? store.projectByName(name) : current;
    if (!project) throw new Error(name ? `There’s no trusted folder called ${name}.` : 'There are no trusted folders yet.');
    return project;
  }

  /** Open the task's session, as the window would. */
  async function startTask(store, task, prompt = '') {
    const reply = await core.start({
      id: task.id,
      kind: task.kind,
      cwd: task.cwd,
      sessionId: task.sessionId,
      resume: task.started,
      model: task.model,
      effort: task.effort,
      mode: task.mode,
      title: task.title,
      bypass: store.state.settings.bypassPermissions !== false,
      prompt: task.kind === 'shell' ? '' : prompt,
      cols: 120,
      rows: 34,
    });
    if (reply?.error) throw new Error(reply.error);
    if (!task.started) store.patchTask(task.id, { started: true });
    // A shell takes no first message: it's typed once the shell is up.
    if (task.kind === 'shell' && prompt) setTimeout(() => core.say(task.id, prompt), 700);
    return reply;
  }

  const run = {
    app_state: () =>
      withStore((store) => {
        const states = live();
        const { settings, projects, tasks } = store.state;
        return {
          time: new Date().toLocaleString(),
          screen: 'No Katana window is open.',
          folders: projects.map((p) => ({ name: p.name, path: p.path, current: p.id === settings.currentProject })),
          tasks: tasks
            .filter((t) => !t.doneAt || Date.now() - t.doneAt < 3 * 864e5)
            .map((t) => {
              const s = states.get(t.id);
              return {
                id: t.id,
                title: t.title,
                folder: store.project(t.projectId)?.name || '?',
                agent: t.kind,
                state: s?.running ? s.state : 'not running',
                doing: s?.state === 'working' && s.tool ? s.tool.desc || s.tool.name : undefined,
                question: s?.state === 'needs' ? `${s.need === 'asking' ? 'Asking you' : 'Needs permission'}: ${s.message || 'in its terminal.'}` : undefined,
                worktree: t.worktree && !t.merged ? t.worktree.branch : undefined,
                done: Boolean(t.doneAt) || undefined,
                last: clip(lastAnswer(t), 400) || undefined,
              };
            }),
          settings,
          reminders: agent.state().reminders.map((r) => ({ id: r.id, text: r.text, at: new Date(r.at).toLocaleTimeString() })),
          checks: agent.state().watches.map((w) => ({ id: w.id, check: w.check, every: w.every, looked: w.checks, until: new Date(w.until).toLocaleString() })),
          today: store.today(),
          voice: 'off (no window)',
        };
      }, { write: false }),
    read_task: ({ task: id, exchanges: count = 3 }) =>
      withStore(async (store) => {
        const task = need(store, id);
        const { createTranscript, exchanges, writtenFiles } = await load();
        const transcript = createTranscript();
        transcript.add(task.kind === 'claude' && task.started ? core.history(task.cwd, task.sessionId) : []);
        const s = live().get(task.id);
        return {
          id: task.id,
          title: task.title,
          cwd: task.cwd,
          agent: task.kind,
          state: s?.running ? s.state : 'not running',
          question: s?.state === 'needs' ? s.message : undefined,
          requests: exchanges(transcript.entries)
            .slice(-Math.max(1, Math.min(20, count)))
            .map((ex) => ({
              asked: ex.prompts.map((p) => clip(p.text, 2000)),
              tools: ex.tools.slice(-30).map((tool) => `${tool.name} ${String(tool.input?.description || tool.input?.command || tool.input?.file_path || '').slice(0, 140)}`.trim()),
              files: writtenFiles(ex),
              answer: clip(ex.texts.at(-1)?.text || '', 6000),
              stopped: ex.interrupted || undefined,
            })),
          note: task.kind === 'claude' ? undefined : 'Codex and shells keep no transcript: use read_terminal.',
        };
      }, { write: false }),
    read_terminal: ({ task: id, lines = 60 }) => {
      if (!core.running().includes(String(id))) return { running: false, screen: '(not running: read_task shows what it said)' };
      // No terminal to draw it in here: the raw text, its last lines (redraws may repeat).
      const text = plain(core.tail(String(id)).slice(-40000)).replace(/\r/g, '');
      const shown = text.split('\n').map((line) => line.trimEnd()).filter((line, i, all) => line || (all[i - 1] ?? '') !== '');
      return { running: true, screen: shown.slice(-Math.min(400, Math.max(5, lines))).join('\n') };
    },
    new_task: ({ folder: name, prompt, title, agent: kind, model, effort, worktree: own, hierarchy = false }) =>
      withStore(async (store) => {
        const project = folder(store, name);
        const value = String(prompt || '');
        const agentKind = ['claude', 'codex', 'shell'].includes(kind) ? kind : 'claude';
        const label = title || value.replace(/\s+/g, ' ').trim().slice(0, 40) || 'New task';
        let tree = null;
        if ((own ?? store.state.settings.worktrees) && agentKind !== 'shell') {
          tree = await worktree.create(project.path, label);
          if (tree?.error) tree = null;
        }
        const lead = Boolean(hierarchy) && agentKind === 'claude';
        const { settings } = store.state;
        const task = store.newTask(project.id, { kind: agentKind, mode: lead ? 'hierarchy' : 'single', title: label, worktree: tree, model: MODEL_ALIAS[model] ?? (lead ? settings.managerModel : undefined), effort: effort ?? (lead ? settings.managerEffort : undefined) });
        await store.flush();
        await startTask(store, task, value);
        return { id: task.id, title: task.title, folder: project.name };
      }),
    send_to_task: ({ task: id, text }) =>
      withStore(async (store) => {
        const task = need(store, id);
        if (task.doneAt) store.markDone(task.id, false);
        store.patchTask(task.id, { updatedAt: Date.now() });
        if (!core.running().includes(task.id)) await startTask(store, task, String(text || ''));
        else {
          if (live().get(task.id)?.state === 'needs') throw new Error('It is asking something first: read_terminal, then press_keys if the user said what to choose.');
          core.say(task.id, String(text || ''));
        }
        return { sent: true };
      }),
    press_keys: async ({ task: id, keys }) => {
      const key = String(id);
      if (!core.running().includes(key)) throw new Error('That task isn’t running.');
      const { keyBytes } = await load();
      const bytes = keyBytes(keys);
      for (const data of bytes) {
        core.write(key, data);
        await wait(60);
      }
      core.answered(key);
      return { pressed: keys };
    },
    stop_task: ({ task: id }) => {
      core.stop(String(id));
      return { stopped: true };
    },
    finish_task: ({ task: id }) =>
      withStore((store) => {
        const task = need(store, id);
        if (live().get(task.id)?.state === 'working') throw new Error('It is still working: stop it first.');
        core.kill(task.id);
        store.markDone(task.id);
        return { done: true };
      }),
    reopen_task: ({ task: id }) => withStore((store) => (store.markDone(need(store, id).id, false), { reopened: true })),
    restart_task: ({ task: id }) =>
      withStore(async (store) => {
        const task = need(store, id);
        core.kill(task.id);
        await wait(500);
        await startTask(store, task);
        return { restarted: true };
      }),
    rename_task: ({ task: id, title }) =>
      withStore((store) => {
        const value = String(title || '').trim();
        if (!value) throw new Error('A name, please.');
        store.patchTask(need(store, id).id, { title: value, named: true });
        return { renamed: value };
      }),
    delete_task: ({ task: id }) =>
      withStore((store) => {
        const task = need(store, id);
        core.kill(task.id);
        store.deleteTask(task.id);
        return { deleted: true };
      }),
    merge_task: ({ task: id }) =>
      withStore(async (store) => {
        const task = need(store, id);
        if (!task.worktree || task.merged) throw new Error('That task has no worktree to merge.');
        core.kill(task.id);
        const reply = await worktree.merge(task.worktree, `Katana: ${task.title}`);
        if (reply?.error) throw new Error(reply.error);
        store.patchTask(task.id, { merged: true });
        store.markDone(task.id);
        return { merged: `${task.worktree.branch} into ${task.worktree.base}`, ...(reply.warning ? { warning: reply.warning } : {}) };
      }),
    discard_task: ({ task: id }) =>
      withStore(async (store) => {
        const task = need(store, id);
        if (!task.worktree || task.merged) throw new Error('That task has no worktree.');
        core.kill(task.id);
        const reply = await worktree.discard(task.worktree);
        store.patchTask(task.id, { merged: true });
        store.markDone(task.id);
        return { discarded: true, ...(reply.warning ? { warning: reply.warning } : {}) };
      }),
    task_changes: ({ task: id }) =>
      withStore(async (store) => {
        const task = need(store, id);
        if (!task.worktree) throw new Error('That task works in its folder directly, with no worktree.');
        const reply = await worktree.changes(task.worktree);
        if (reply?.error) throw new Error(reply.error);
        return reply;
      }, { write: false }),
    set_setting: ({ key, value }) =>
      withStore(async (store) => {
        const { checkSetting } = await load();
        const shells = [{ value: '' }, ...shellsFrom(existsInPath).map((s) => ({ value: s.id }))];
        const checked = checkSetting(String(key || ''), value, { shells });
        if (checked.error) throw new Error(checked.error);
        store.setSetting(checked.key, checked.value);
        return { [checked.key]: checked.value };
      }),
    set_folder: ({ folder: name }) =>
      withStore((store) => {
        const project = folder(store, name);
        store.setSetting('currentProject', project.id);
        return { current: project.name };
      }),
    remind: ({ minutes, text }) => {
      const reminder = agent.remind(minutes, text);
      return { id: reminder.id, at: new Date(reminder.at).toLocaleTimeString() };
    },
    cancel_reminder: ({ reminder }) => {
      const key = String(reminder || '').toLowerCase();
      const { reminders } = agent.state();
      // No words, no match: '' is in every text.
      const found = reminders.find((r) => r.id === reminder) || (key && reminders.find((r) => r.text.toLowerCase().includes(key)));
      if (!found) throw new Error('There’s no reminder like that.');
      agent.drop(found.id);
      return { cancelled: found.text };
    },
    watch: ({ every, check, hours }) => {
      const item = agent.watch(every, check, hours);
      return { id: item.id, every: item.every, until: new Date(item.until).toLocaleString() };
    },
    cancel_watch: ({ watch: which }) => {
      const key = String(which || '').toLowerCase();
      const { watches } = agent.state();
      const found = watches.find((w) => w.id === which) || (key && watches.find((w) => w.check.toLowerCase().includes(key)));
      if (!found) throw new Error('There’s no check like that.');
      agent.drop(found.id);
      return { cancelled: found.check };
    },
    notice: ({ text }) => ({ shown: notify({ title: 'Katana', body: String(text || ''), sound: false }) }),
    show: () => {
      throw new Error(NEEDS_WINDOW);
    },
    open_file: () => {
      throw new Error(NEEDS_WINDOW);
    },
    run_app: () => {
      throw new Error(NEEDS_WINDOW);
    },
    stop_app: () => ({ already: 'No window is open, so no app is running in one (apps end with the window).' }),
    read_app_output: () => {
      throw new Error(NEEDS_WINDOW);
    },
    // The viewer lives in the window: nothing runs in it while it's closed.
    ...Object.fromEntries(
      ['app_screenshot', 'app_click', 'app_type', 'app_key', 'app_scroll'].map((name) => [
        name,
        () => {
          throw new Error(NEEDS_WINDOW);
        },
      ])
    ),
    trust_folder: () => {
      throw new Error('Trusting a folder needs the user to confirm it in the app, and no window is open.');
    },
    remove_folder: () => {
      throw new Error('Removing a folder needs the user to confirm it in the app, and no window is open.');
    },
    end_voice: () => ({ already: 'No voice conversation is on (no window is open).' }),
  };

  return {
    names: () => Object.keys(run),
    async call(name, args) {
      const fn = run[name];
      if (!fn) return { error: `There’s no tool called ${name}.` };
      try {
        return { result: await fn(args || {}) };
      } catch (error) {
        return { error: error.message };
      }
    },
  };
}

module.exports = { createHeadless };
