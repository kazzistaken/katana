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
    watch: (file) => ipcRenderer.invoke('file:watch', file),
    onChanged: (callback) => subscribe('file:changed', callback),
  },
  // The app viewer: your app run from a task's folder, live in the pane (main appview.js).
  appview: {
    start: (taskId, cwd, command, page) => ipcRenderer.invoke('app:start', { taskId, cwd, command, page }),
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
  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    // OpenAI dictation: the mic as base64 PCM16 (24 kHz) while you speak, a commit at each pause.
    audio: (chunk) => ipcRenderer.send('voice:audio', chunk),
    commit: () => ipcRenderer.send('voice:commit'),
    // OpenRouter dictation: a phrase (base64 WAV) as { text } or { error }.
    clip: (wav) => ipcRenderer.invoke('voice:clip', wav),
    onError: (callback) => subscribe('voice:error', callback),
    onText: (callback) => subscribe('voice:text', callback),
    onPartial: (callback) => subscribe('voice:partial', callback),
    onState: (callback) => subscribe('voice:state', callback),
  },
  // GPT-Live, Katana's voice: main holds the key and makes the session.
  live: {
    hasKey: () => ipcRenderer.invoke('live:has-key'),
    setKey: (key) => ipcRenderer.invoke('live:set-key', key),
    start: (options) => ipcRenderer.invoke('live:start', options),
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
  // OpenRouter: its key (set, or not), and Katana's words as speech ({ audio, type } or { error }).
  openrouter: {
    hasKey: () => ipcRenderer.invoke('openrouter:has-key'),
    setKey: (key) => ipcRenderer.invoke('openrouter:set-key', key),
  },
  // ElevenLabs (optional): its key; with one, her speech comes with when each character is said ({ audio, type, alignment }).
  elevenlabs: {
    hasKey: () => ipcRenderer.invoke('elevenlabs:has-key'),
    setKey: (key) => ipcRenderer.invoke('elevenlabs:set-key', key),
  },
  speech: {
    say: (text, voice) => ipcRenderer.invoke('speech:say', { text, voice }),
  },
  // Katana's tools: a call from her Claude turn, carried out here.
  tools: {
    onCall: (callback) => subscribe('tools:call', callback),
    result: (callId, result, error) => ipcRenderer.send('tools:result', { callId, result, error }),
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
    running: () => ipcRenderer.invoke('task:running'),
    snapshot: () => ipcRenderer.invoke('task:snapshot'),
    quiet: (id) => ipcRenderer.invoke('task:quiet', id),
    history: (cwd, sessionId) => ipcRenderer.invoke('task:history', { cwd, sessionId }),
    onData: (callback) => subscribe('task:data', callback),
    onState: (callback) => subscribe('task:state', callback),
    onTranscript: (callback) => subscribe('task:transcript', callback),
    onExit: (callback) => subscribe('task:exit', callback),
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
    changes: (tree) => ipcRenderer.invoke('worktree:changes', { tree }),
  },
});
