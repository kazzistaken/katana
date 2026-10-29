# Katana features: what we have, what's next

The features from the Katana design doc the user shared (2026-10-29), checked
against this app. Update the status as things land.

Left out on purpose (2026-10-29): the phone, and the permission-safety parts
(trust modes, keeping Katana from changing permissions). This is a private app
only its owner uses.

Status: **have**, **partly**, **missing**, **in progress**.

## Order we're building in

1. **Daemon, step 1**: tasks live in a background process (`katanad`), so F5 and
   closing the window never kill them. (done 2026-10-29: `src/daemon/`,
   `src/main/daemonclient.js`, `scripts/test-daemon.mjs`)
2. **Daemon, step 2**: Katana's turns, reminders and notifications move into the
   daemon, so she works with no window open. (done 2026-10-29: `src/daemon/agent.js`,
   `toolport.js`, `headless.js`, `notify.js`; `scripts/test-agent.mjs`, `test-headless.mjs`)
3. **Needs-you queue**: asking vs needing permission, sorted by what needs you.
   (done 2026-10-29, with alert levels, "this" and Katana's own folder)
4. **Receipts** in Katana's thread; **recurring checks**.
5. **Voice that pauses**: tap to talk, closes on a real pause, stays warm.
   (done 2026-10-29 through OpenRouter: `src/renderer/js/talk.js`, `mic.js`, `src/main/openrouter.js`)
6. Later: other computers over Tailscale.

## 1. The daemon owns the work; the apps are views

- Every task runs in a background daemon, not in the app window. **have**
  (`src/daemon/katanad.js`, Electron's runtime as Node; the window connects over
  a named pipe with a token; one daemon per data folder; leaves after 10 idle minutes;
  Settings → About shows it and can stop every task)
- Closing a window never kills a task. **have** (F5 and main-code restarts too)
- Every window shows the same state, because the daemon holds the only copy. **have**
  (`src/daemon/taskstate.js` decides working / needs / idle; the window follows `task:state`
  and catches up with `task:snapshot` after a reload; tasks that finished while no
  window was open come back marked)
- A daemon running older code is replaced only when a restart loses nothing: no task
  working or asking, no shell or Codex open (idle Claude sessions resume later). **have**
- Clients hold no logic: decisions like "is this task waiting for you" live in
  the daemon; the window only draws them. **have** (task state, Katana, her memory
  in `agent.json`, reminders, waking and every alert's level are decided in the daemon;
  the window only plays an alert, since it knows whether you're looking)
- Katana works with no window open. **have** (her tools go to the open window, or
  run in the daemon on the saved state when none is; screen-only tools say so)

## 2. One queue of what needs you

- One list focused on what needs you now, not where tasks run. **have**
  (the sidebar puts waiting-for-you first, then finished-and-unseen, then working,
  then the rest, most recent first in each)
- A row names its computer only when it isn't this one. **missing** (one computer)
- States: working, asking, needing permission, finished. **have**
  (`needs` carries `need`: 'asking' for Claude's question tools, AskUserQuestion and
  ExitPlanMode, with the question; 'permission' for tool approvals and folder trust)
- The daemon decides the state, so every app agrees. **have**

## 3. Katana is one agent above your tasks

- Talk by typing or voice. **have** (typing; GPT-Live voice with Opus behind it)
- Her tools are the app itself. **have** (27 app tools over MCP, `src/main/apptooldefs.js`)
- Start a task (in a folder; on any computer). **partly** (this computer only)
- Steer or answer a task. **have** (`send_to_task`, `press_keys`)
- Check on work and get a short answer. **have** (`app_state`, `read_task`, `read_terminal`)
- Reminders. **have** (one-off; they fire from the daemon, window or not)
- Recurring checks ("every 10 minutes, check CI"). **missing**
- You can open any task and work on it directly while she keeps watching. **have**
- She is a task too, in her own folder. **have** (her turns run in `<userData>/katana`,
  hers to keep notes and files in across turns)

## 4. One Katana across every computer

- Each computer runs a daemon; daemons link up over Tailscale; every computer
  lists every other's tasks. **missing**
- Several addresses per computer, tried in turn, the first that answers kept. **missing**
- Latest word wins: a removed computer stays removed. **missing**
- Asleep isn't gone: "offline since" with the last-heard time. **missing**
- One ding, where you are: alerts go to the computer you touched last. **missing**
- Roles (a work laptop keeps to itself; a friend's server runs tasks without a
  way into your machines). **missing** (planned there too)

## 5. Voice that pauses instead of calling

- One key: tap to open the mic, tap to close it; mint means the mic is open. **have**
  (with an OpenRouter key and no GPT-Live: Talk / Tab on her page; mint only while the mic is open;
  with an OpenAI key and GPT-Live on, Talk is still a call)
- Closes on a real pause, not a timer; a back-and-forth stays open longer; at
  least 20 s when she asked you something; "let's talk this through" stays open. **have**
  (a tap with no words closes after 6 s; her question reopens it for 20 s; talking it
  through reopens after every answer, with longer pauses, until "that's all" or "bye")
- Closing the mic doesn't end the conversation; the line stays warm for a few
  minutes so the next tap is instant. **have** (she keeps her session, so the next tap
  carries on; there's no connection to keep open, each turn is one request)
- Heard and said through OpenRouter: speech to text `openai/gpt-4o-transcribe`, her
  voice `openai/gpt-4o-mini-tts` (Settings → Katana → Her voice). **have**
- Muting really stops capture (the OS mic indicator goes off). **have** (hang up stops the mic tracks)
- "This" means what you're looking at. **have** (the window tells the daemon what's
  on screen; her turns get an "On screen" line and are told "this" means it)

## 6. She tells you when things stop

- When a task finishes, fails or asks, she's told and tells you once. **have**
  (finished wakes her directly; no shell watch)
- Needs you: notification with sound. **have** (window closed: a Windows toast with
  sound from the daemon; window open: ding + notification when it isn't focused)
- Done: one quiet notification, grouped. **have** (no ding; dones within 4 s are one
  "N tasks finished"; for a Claude task she's woken for, her words about it are the alert)
- FYI: no notification, her reply says it. **have** (levels: needs and reminder with
  sound, done quiet, fyi none; her replies to reminders are fyi)
- Focus / Do Not Disturb respected, as the OS does. **have** (Windows notifications)
- Seen on one computer counts as seen on all of them. **missing** (one computer)
- Her own replies don't count as "a task finished". **have**

## 7. Every task's screen is visible

- Each task has its conversation view and its terminal view. **have**
- Every change Katana makes is a receipt in her thread; a receipt opens its task. **missing**
