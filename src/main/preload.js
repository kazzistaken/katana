'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    show: () => ipcRenderer.send('win:show'),
  },
  // Katana's runs report the plan's usage (the sidebar shows it).
  run: {
    onEvent: (callback) => subscribe('run:event', callback),
  },
  state: {
    load: () => ipcRenderer.invoke('state:load'),
    save: (state) => ipcRenderer.invoke('state:save', state),
    // state.json unreadable: start fresh (the bad file is kept beside it, renamed).
    reset: () => ipcRenderer.invoke('state:reset'),
  },
  folder: {
    pick: () => ipcRenderer.invoke('folder:pick'),
    exists: (folder) => ipcRenderer.invoke('folder:exists', folder),
    confirm: (folder) => ipcRenderer.invoke('folder:confirm', folder),
  },
  file: {
    stat: (paths, base) => ipcRenderer.invoke('file:stat', { paths, base }),
    open: (file) => ipcRenderer.invoke('file:open', file),
    read: (file) => ipcRenderer.invoke('file:read', file),
    reveal: (file) => ipcRenderer.invoke('file:reveal', file),
    save: (file) => ipcRenderer.invoke('file:save', file),
    saveText: (name, text) => ipcRenderer.invoke('file:saveText', { name, text }),
    copy: (file) => ipcRenderer.invoke('file:copy', file),
    watch: (file) => ipcRenderer.invoke('file:watch', file),
    onChanged: (callback) => subscribe('file:changed', callback),
  },
  image: {
    save: (type, bytes) => ipcRenderer.invoke('image:save', { type, bytes }),
  },
  // Your own backgrounds: pick a picture (copied into the app's data), or remove one.
  background: {
    add: () => ipcRenderer.invoke('background:add'),
    save: (name, type, bytes) => ipcRenderer.invoke('background:save', { name, type, bytes }),
    remove: (file) => ipcRenderer.invoke('background:remove', file),
  },
  // The browser: a web page from a task's folder, live in the pane (main appview.js).
  appview: {
    start: (taskId, cwd, page) => ipcRenderer.invoke('app:start', { taskId, cwd, page }),
    reload: (taskId) => ipcRenderer.invoke('app:reload', taskId),
    screenshot: (taskId) => ipcRenderer.invoke('app:screenshot', taskId),
    click: (taskId, options) => ipcRenderer.invoke('app:click', { taskId, ...options }),
    keys: (taskId, keys) => ipcRenderer.invoke('app:keys', { taskId, keys }),
    type: (taskId, text) => ipcRenderer.invoke('app:type', { taskId, text }),
    scroll: (taskId, options) => ipcRenderer.invoke('app:scroll', { taskId, ...options }),
    onError: (callback) => subscribe('app:error', callback),
    stop: (taskId) => ipcRenderer.invoke('app:stop', taskId),
    restart: (taskId) => ipcRenderer.invoke('app:restart', taskId),
    state: (taskId) => ipcRenderer.invoke('app:state', taskId),
    output: (taskId) => ipcRenderer.invoke('app:output', taskId),
    select: (taskId, hwnd) => ipcRenderer.invoke('app:select', { taskId, hwnd }),
    popout: (taskId) => ipcRenderer.invoke('app:popout', taskId),
    drop: (taskId) => ipcRenderer.invoke('app:drop', taskId),
    pane: (taskId, width, height, dpr) => ipcRenderer.send('app:pane', { taskId, width, height, dpr }),
    input: (taskId, hwnd, events) => ipcRenderer.send('app:input', { taskId, hwnd, events }),
    onState: (callback) => subscribe('app:state', callback),
    onOutput: (callback) => subscribe('app:output', callback),
  },
  sys: {
    claude: () => ipcRenderer.invoke('sys:claude'),
    found: () => ipcRenderer.invoke('sys:found'),
    info: () => ipcRenderer.invoke('sys:info'),
    // { fiveHour, week }: each { used 0..1, resetsAt ms } or null; null without a login.
    planUsage: () => ipcRenderer.invoke('sys:plan-usage'),
    openAtLogin: (on) => ipcRenderer.invoke('app:login', on),
  },
  commands: {
    list: (cwd) => ipcRenderer.invoke('commands:list', cwd),
  },
  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    // OpenAI dictation: the mic as base64 PCM16 (24 kHz) while you speak, a commit at each pause.
    audio: (chunk) => ipcRenderer.send('voice:audio', chunk),
    commit: () => ipcRenderer.send('voice:commit'),
    // OpenRouter dictation: a phrase (base64 WAV) as { text } or { error }.
    clip: (wav) => ipcRenderer.invoke('voice:clip', wav),
    // Canary dictation (on this PC): the same.
    canary: (wav) => ipcRenderer.invoke('voice:canary', wav),
    onError: (callback) => subscribe('voice:error', callback),
    onText: (callback) => subscribe('voice:text', callback),
    onPartial: (callback) => subscribe('voice:partial', callback),
    onLive: (callback) => subscribe('voice:live', callback),
    onState: (callback) => subscribe('voice:state', callback),
  },
  // The OpenAI key, for dictation: main holds it; the window only learns whether there is one.
  openai: {
    hasKey: () => ipcRenderer.invoke('openai:has-key'),
    setKey: (key) => ipcRenderer.invoke('openai:set-key', key),
  },
  // Katana, who lives in katanad: what she says, her reminders and checks, whether she's busy.
  agent: {
    ask: (options) => ipcRenderer.invoke('agent:ask', options),
    stop: () => ipcRenderer.invoke('agent:stop'),
    say: (role, text, extra) => ipcRenderer.invoke('agent:say', { role, text, extra }),
    remind: (minutes, text) => ipcRenderer.invoke('agent:remind', { minutes, text }),
    watch: (every, check, hours) => ipcRenderer.invoke('agent:watch', { every, check, hours }),
    drop: (id) => ipcRenderer.invoke('agent:drop', id),
    state: () => ipcRenderer.invoke('agent:state'),
    onMessage: (callback) => subscribe('agent:message', callback),
    onState: (callback) => subscribe('agent:state', callback),
    onBusy: (callback) => subscribe('agent:busy', callback),
    onReply: (callback) => subscribe('agent:reply', callback),
    onAlert: (callback) => subscribe('alert', callback),
    screen: (shown) => ipcRenderer.send('agent:screen', shown),
  },
  // OpenRouter, for dictation: its key (set, or not).
  openrouter: {
    hasKey: () => ipcRenderer.invoke('openrouter:has-key'),
    setKey: (key) => ipcRenderer.invoke('openrouter:set-key', key),
  },
  // Katana's tools: a call from her Claude turn, carried out here.
  tools: {
    onCall: (callback) => subscribe('tools:call', callback),
    result: (callId, result, error) => ipcRenderer.send('tools:result', { callId, result, error }),
    // The page has its state and can take her calls now.
    ready: () => ipcRenderer.send('tools:ready'),
  },
  shells: {
    list: () => ipcRenderer.invoke('shells:list'),
  },
  task: {
    start: (options) => ipcRenderer.invoke('task:start', options),
    say: (id, text) => ipcRenderer.invoke('task:say', { id, text }),
    write: (id, data) => ipcRenderer.send('task:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('task:resize', { id, cols, rows }),
    stop: (id) => ipcRenderer.invoke('task:stop', id),
    answered: (id) => ipcRenderer.invoke('task:answered', id),
    kill: (id) => ipcRenderer.invoke('task:kill', id),
    tail: (id) => ipcRenderer.invoke('task:tail', id),
    // A terminal opened on a task: its output comes (onData) from now on; what it printed so far.
    watch: (id) => ipcRenderer.invoke('task:watch', id),
    unwatch: (id) => ipcRenderer.send('task:unwatch', id),
    running: () => ipcRenderer.invoke('task:running'),
    snapshot: () => ipcRenderer.invoke('task:snapshot'),
    quiet: (id) => ipcRenderer.invoke('task:quiet', id),
    history: (cwd, sessionId, kind, id) => ipcRenderer.invoke('task:history', { cwd, sessionId, kind, id }),
    onData: (callback) => subscribe('task:data', callback),
    onState: (callback) => subscribe('task:state', callback),
    onTranscript: (callback) => subscribe('task:transcript', callback),
    onExit: (callback) => subscribe('task:exit', callback),
    onTitle: (callback) => subscribe('task:title', callback),
    onLost: (callback) => subscribe('task:lost', callback),
  },
  // Hierarchy mode: a task run by a leader, workers and verifiers (daemon/team.js).
  team: {
    snapshot: () => ipcRenderer.invoke('team:snapshot'),
    mode: (id, mode) => ipcRenderer.invoke('team:mode', { id, mode }),
    stop: (id, forget) => ipcRenderer.invoke('team:stop', { id, forget }),
    onState: (callback) => subscribe('team:state', callback),
  },
  // katanad, the background process the tasks run in.
  daemon: {
    status: () => ipcRenderer.invoke('daemon:status'),
    stopAll: () => ipcRenderer.invoke('daemon:stop-all'),
  },
  worktree: {
    create: (project, title) => ipcRenderer.invoke('worktree:create', { project, title }),
    merge: (tree, message) => ipcRenderer.invoke('worktree:merge', { tree, message }),
    discard: (tree) => ipcRenderer.invoke('worktree:discard', { tree }),
    cleanup: (tree) => ipcRenderer.invoke('worktree:cleanup', { tree }),
    changes: (tree) => ipcRenderer.invoke('worktree:changes', { tree }),
  },
});
