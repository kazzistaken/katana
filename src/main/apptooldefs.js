'use strict';

/**
 * Katana's hands: everything you can do in the app, as tools for her Claude
 * turns (mcp-app.cjs serves them, apptools.js routes the calls). Pure data,
 * so scripts/test-apptools.mjs checks it under Node.
 */

const task = { type: 'string', description: 'The task id (from app_state).' };
const str = (description) => ({ type: 'string', description });

const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

const onTask = { type: 'string', description: 'The task (default: the one on screen).' };
const point = { x: { type: 'number', description: 'Across, in the last app_screenshot’s pixels.' }, y: { type: 'number', description: 'Down, in the last app_screenshot’s pixels.' } };

/**
 * The app viewer: where the user's app (or a web page) runs, live, beside
 * its task, and where agents test it. Katana has these (with `task`); each
 * task's own Claude Code session has them too, for itself (VIEW_TOOLS).
 */
const APP_TOOLS = [
  tool(
    'run_app',
    'Run the app in a task’s folder (an Electron app, or Katana itself), or show a web page (an HTML file, a browser game), live in the app viewer, where it can be tested with app_screenshot, app_click, app_type and app_key. With no command or page, package.json’s start script (or electron .) decides. Running again keeps the one already running. Test here, never in a separate window.',
    { task: onTask, command: str('What to run instead, e.g. “npm run dev” or “electron main.js” (optional).'), page: str('An HTML file’s full path, to show that page instead (optional).') }
  ),
  tool('stop_app', 'Stop what runs in a task’s app viewer (its windows close, then whatever is left is ended).', { task: onTask }),
  tool(
    'read_app_output',
    'What the app in a task’s viewer printed (stdout and stderr), whether it is running, and the errors it logged (console errors, uncaught exceptions, failed loads, crashes) that are waiting to be fixed.',
    { task: onTask, lines: { type: 'number', minimum: 1, maximum: 2000, description: 'How many of the last lines (default 80).' } }
  ),
  tool('app_screenshot', 'See the app in a task’s viewer as it is now (its current window, with any dialog over it). Clicks and scrolls use this picture’s pixels.', { task: onTask }),
  tool(
    'app_click',
    'Click in the app at a point of the last app_screenshot.',
    { task: onTask, ...point, button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' }, double: { type: 'boolean', description: 'A double click.' } },
    ['x', 'y']
  ),
  tool('app_type', 'Type text into the app where it has the keyboard (click the field first). A new line presses Enter.', { task: onTask, text: str('What to type.') }, ['text']),
  tool(
    'app_key',
    'Press keys in the app, one after another: names like Enter, Tab, Escape, Backspace, ArrowDown, PageUp, F5, or combinations like Ctrl+A, Shift+Tab, Ctrl+Shift+K.',
    { task: onTask, keys: { type: 'array', items: { type: 'string' }, description: 'The keys, in order.' } },
    ['keys']
  ),
  tool(
    'app_scroll',
    'Scroll the app at a point of the last app_screenshot (dy down, dx right, in pixels; negative goes back; about 100 a wheel notch).',
    { task: onTask, ...point, dy: { type: 'number' }, dx: { type: 'number' } },
    ['x', 'y']
  ),
];

/** What a task's own session may use: the viewer tools, on its own task (no `task` to give). */
const VIEW_TOOLS = APP_TOOLS.map((t) => {
  const { task: _task, ...properties } = t.inputSchema.properties;
  return { ...t, description: t.description.replace(/a task’s (app )?viewer/g, 'your task’s app viewer').replace(/in a task’s folder/, 'in your task’s folder'), inputSchema: { ...t.inputSchema, properties, required: t.inputSchema.required.filter((r) => r !== 'task') } };
});

const TOOLS = [
  tool('app_state', 'Everything in the app right now: trusted folders, every task (id, title, folder, agent, state, what it is doing, last reply), what is on screen, all settings, reminders, recurring checks and today’s numbers. Call it first when you need to know what is going on.'),
  tool(
    'read_task',
    'A task’s conversation: what was asked, what it answered, the tools it used and files it wrote, plus its state and any question it is asking.',
    { task, exchanges: { type: 'integer', minimum: 1, maximum: 20, description: 'How many of the latest requests (default 3).' } },
    ['task']
  ),
  tool(
    'read_terminal',
    'The text on a task’s terminal right now (its last lines): a question Claude Code is asking, a shell’s output, Codex’s screen.',
    { task, lines: { type: 'integer', minimum: 5, maximum: 400, description: 'How many lines from the bottom (default 60).' } },
    ['task']
  ),
  tool(
    'new_task',
    'Start a task: a real Claude Code (or Codex, or shell) session in a trusted folder, with its first message. Returns its id.',
    {
      folder: str('The folder’s name or path (one from app_state). Default: the current folder.'),
      prompt: str('What to do, standing on its own. For a shell: the command to run.'),
      title: str('3-6 words.'),
      agent: { type: 'string', enum: ['claude', 'codex', 'shell'] },
      model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      worktree: { type: 'boolean', description: 'Its own git worktree and branch (when two tasks share a folder).' },
      hierarchy: { type: 'boolean', description: 'Run it as a team (hierarchy mode): a Leader that splits the work across up to 4 workers on their own branches and has 2 verifiers check it before merging. For big work with separable parts (default false: one session).' },
      open: { type: 'boolean', description: 'Show it on screen (default false).' },
    },
    ['prompt']
  ),
  tool('send_to_task', 'Write to a task, as the user would in its prompt bar. Starts or resumes its session when it is not running.', { task, text: str('The message.') }, ['task', 'text']),
  tool(
    'press_keys',
    'Press keys in a task’s terminal, e.g. to answer a question Claude Code asks: ["1","enter"], ["down","enter"], ["esc"]. Named keys: enter, esc, tab, up, down, left, right, backspace, space, ctrl+c, ctrl+d; anything else is typed as it is. Read the terminal first.',
    { task, keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 } },
    ['task', 'keys']
  ),
  tool('stop_task', 'Stop what a task is doing (Esc; Ctrl+C for a shell). Its session stays open.', { task }, ['task']),
  tool('finish_task', 'Done with a task: its session ends and it leaves the list (Done, Ctrl+D).', { task }, ['task']),
  tool('reopen_task', 'Bring a done task back into the list.', { task }, ['task']),
  tool('restart_task', 'End a task’s session and start it again (a Claude task resumes its conversation).', { task }, ['task']),
  tool('rename_task', 'Rename a task.', { task, title: str('The new name.') }, ['task', 'title']),
  tool('delete_task', 'Delete a task and its history for good. Only when the user asked for exactly that.', { task }, ['task']),
  tool('merge_task', 'Merge a worktree task’s branch back into its folder’s branch; then it is done.', { task }, ['task']),
  tool('discard_task', 'Throw away a worktree task’s branch and worktree without merging. Only when the user asked.', { task }, ['task']),
  tool('task_changes', 'What a worktree task changed: its git status and diff summary.', { task }, ['task']),
  tool(
    'show',
    'Change what is on screen.',
    {
      view: {
        type: 'string',
        enum: ['task', 'terminal', 'file', 'new_task', 'katana', 'katana_conversation', 'settings', 'close_settings'],
        description: 'task, terminal, file: a task (give its id) as its conversation, its terminal or its open file. katana: your face; katana_conversation: your conversation as text.',
      },
      task,
    },
    ['view']
  ),
  tool(
    'set_setting',
    'Change one setting (the keys and current values are in app_state.settings). Themes: system, graphite, black, tokyo-night, catppuccin, rose-pine, nord, light. textSize: default, larger. motion: full, reduced, off. Models: opus, sonnet, haiku. Efforts: low, medium, high, xhigh, max.',
    { key: str('The setting’s key.'), value: { description: 'Its new value: true/false, a number or a string.' } },
    ['key', 'value']
  ),
  tool('set_folder', 'Make a folder the current one: new tasks go there.', { folder: str('Its name or path.') }, ['folder']),
  tool(
    'trust_folder',
    'Add a folder to the trusted folders tasks may run in. The user confirms it in a dialog (or picks it when no path is given).',
    { path: str('The folder’s full path (optional).') }
  ),
  tool('remove_folder', 'Stop trusting a folder: its tasks are deleted (the folder itself is not touched). The user confirms it.', { folder: str('Its name or path.') }, ['folder']),
  tool(
    'remind',
    'Set a reminder: you are woken with [reminder] when it is due, to tell the user.',
    { minutes: { type: 'number', minimum: 0.1, description: 'From now.' }, text: str('What to remind.') },
    ['minutes', 'text']
  ),
  tool('cancel_reminder', 'Cancel a reminder.', { reminder: str('Its id, or words from its text.') }, ['reminder']),
  tool(
    'watch',
    'Set a recurring check (“every 10 minutes, check CI and tell me when it’s green”): you are woken with [check] every few minutes to look, and say nothing to the user until its condition is met; then you tell them once and it ends. The first look is right away.',
    {
      every: { type: 'number', minimum: 1, description: 'Minutes between looks.' },
      check: str('What to look at, how, and what counts as met, written so it stands on its own (e.g. “Run gh run list in C:\\code\\shop: met when the latest run on main is completed and successful”).'),
      hours: { type: 'number', minimum: 0.1, maximum: 168, description: 'Give up after this long (default 24).' },
    },
    ['every', 'check']
  ),
  tool('cancel_watch', 'Stop a recurring check.', { watch: str('Its id, or words from its check.') }, ['watch']),
  tool(
    'open_file',
    'Show a file (HTML, image, video, audio, PDF, Markdown, text) in the app’s viewer beside a task, or open it in its default app. A web page (HTML) opens in the app viewer, as run_app with page does.',
    { path: str('The file’s full path.'), task: { type: 'string', description: 'The task to show it beside (default: the one on screen).' }, external: { type: 'boolean', description: 'Open it in its default app instead.' } },
    ['path']
  ),
  ...APP_TOOLS,
  tool('notice', 'Show a short notice above the prompt bar (and a Windows notification when the user is in another app).', { text: str('A sentence.') }, ['text']),
  tool('end_voice', 'Hang up the live voice conversation (when the user says goodbye or asks you to stop listening).'),
];

module.exports = { TOOLS, VIEW_TOOLS };
