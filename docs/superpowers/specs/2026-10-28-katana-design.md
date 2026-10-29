# Katana — design

Date: 2026-10-28
Status: approved in chat, awaiting review of this write-up

## Why

XodeCode's canvas shows every agent's terminal. V2 is its own app built around the
Manager idea. You never see a terminal. You type what you want into a chat, a
Manager splits the work across hidden Claude Code workers in your project folder,
and you see only:

- the tool calls running at that moment;
- a short ✓/✗ summary when the work is done.

V2 starts small. Many more features will be added later, so the structure has to
stay easy to grow.

## What the user asked for

- **App and UI:** a new, separate app in `C:\Users\diddy\Downloads\XodeCodeV2`, with
  a basic dark UI (black background).
- **Claude:** runs hidden, used like an API, and connects through the user's Claude
  subscription. No terminals are shown anywhere.
- **Behaviour:** everything the canvas Manager does.
- **Chats and projects:** you can make new chats, each in a project, with trusted
  folders.
- **System prompt:** workers use Claude Code's normal system prompt.
- **Decisions from the questions:**
  - who does the work: the Manager plus hidden workers;
  - memory: workers keep their sessions per chat;
  - trust: a trusted folder lets workers do everything there.

## Approach

Electron with plain ES modules and no build step, as in XodeCode. These parts are
copied from XodeCode and adapted:

- `resolveClaude`, `spawnClaudeProcess`, `quote`, `pipeLines`, `parseClaudeLine`,
  `describeTool`, `compactInput`, `toolResultText`, `normalizeModel` and
  `normalizeEffort` from `src/main/main.js`;
- `managerlogic.js` and `manager.js` from `src/renderer/js/`, together with their
  tests (`scripts/test-manager.mjs`), including the review fixes from 2026-10-28.

Claude is reached only through the `claude` CLI on PATH (`claude -p`), so it uses
whatever account that CLI is signed into. No API key is needed.

## The screen

Everything sits on a black background (`#000`) in a single window. The window has
a frameless title strip with minimize, maximize and close buttons.

```
┌──────────────┬─────────────────────────────────────────────┐
│ + New chat   │  Add dark mode            C:\code\shop      │
│              │                                             │
│ shop         │                you: add dark mode and fix…  │
│   Add dark…  │                                             │
│   Fix login  │  ● Worker 1 · Edit  theme.js                │
│ blog         │  ● Worker 2 · Bash  npm test                │
│   New chat   │                                             │
│              │  Worker 1                                   │
│ + Add project│  ✓ Dark mode toggle in Settings             │
│ ⚙ Settings   │  ┌───────────────────────────────────────┐  │
└──────────────┴──┤ Ask the Manager…                    ➤ │──┘
                  └───────────────────────────────────────┘
```

**Sidebar** (260px)
- "New chat" makes a chat in the project of the open chat, or in the only project.
  With more than one project and none chosen, it asks which one.
- Projects are listed by folder name, each with its chats underneath, newest first.
- At the bottom: "Add project" and "Settings".
- Right-clicking a chat offers Rename and Delete. Right-clicking a project offers
  Remove, which also deletes its chats.

**Chat pane**
- **Header:** the chat title and the project path.
- **Body:** the same layout as the XodeCode Manager view:
  - a centred column, max 760px;
  - user messages right-aligned at 16px;
  - summaries at 20px with green ✓ and red ✗ lines and agent names in bold;
  - the live strip under the newest message;
  - the composer at the bottom, with Send that becomes Stop while working.
- **Empty chat:** shows "Tell the Manager what you want done in <folder name>.
  It splits the work across Claude workers and reports back."

**Before any project exists**, the pane shows one button: "Add a project folder".

## Projects and trust

**Adding a project**
- "Add project" opens the system folder picker.
- A confirm dialog follows:
  - Title: "Trust this folder?"
  - Text: "Claude workers can read, edit and run commands in <path> without asking."
  - Buttons: "Trust folder" and "Cancel".
- Only a trusted folder becomes a project. A project *is* a trusted folder; there is
  no untrusted project.
- Adding the same path twice opens the existing project.

**Settings** lists the trusted folders, each with a Remove button (the same as
removing the project). It also has the Manager model and the worker model, each a
choice between Opus, Sonnet and Haiku. The defaults are Manager Sonnet at low effort
and workers Sonnet at medium effort.

**Missing folders:** when a project folder no longer exists, its chats show "Folder
not found: <path>" and the composer is disabled.

## How a chat works

A chat has these parts:

- **One Manager:** a hidden Claude with no tools. It uses the Manager instructions
  from XodeCode, adapted so that agents are workers.
- **Up to 4 workers:** named Worker 1 to Worker 4 in the order they are opened.
- **Its messages:** user messages, summaries and errors.

The loop is the same `manager.js` as in XodeCode: plan → dispatch → watch → wait →
read → summarize. These things differ:

- **The roster** lists only this chat's workers. All of them are idle between
  requests, because only the Manager prompts them.
- **"new" opens the next worker.** A chat never has more than 4 workers.
- **Stop** stops the Manager and also cancels every running worker in the chat,
  because the workers are hidden.
- **The chat title** comes from the first request, trimmed to 40 characters, until
  you rename it.

**Memory.** The Manager and every worker keep a Claude session ID, saved with the
chat. Each turn resumes it, so follow-ups work, even after a restart.

**Several chats at once.** Each chat has its own Manager and workers. Switching
chats keeps the other chat's work going. When work is running in a chat that isn't
open, the sidebar shows a small dot next to that chat.

## Main process

**Running turns.** Each turn is one `claude -p` process, the same approach as
XodeCode's `claude:send`. A process runs one turn, is resumed by session ID next
time, and nothing stays running between turns.

**Worker turns:** `run:start({ runId, cwd, message, sessionId, model, effort })`.
- Arguments: `-p --output-format stream-json --verbose --model --effort
  --permission-mode bypassPermissions --allow-dangerously-skip-permissions`, plus
  `--resume <sessionId>` when the worker has one.
- `cwd` is the project folder. A turn whose `cwd` is not a trusted project path is
  refused, and main checks this against the saved trusted list itself.
- There is no custom system prompt, so workers use Claude Code's default.
- The message goes in on stdin. Events go out as `run:event { runId, ...parsed }`,
  using the same shapes as XodeCode's `parseClaudeLine`, including `init` with
  `sessionId`. `exit` is sent on close, and `error` is sent on a non-zero exit with
  stderr.
- Starting a run with a `runId` that is still running kills the old process first.

**Manager turns** use the same `run:start`, with these arguments instead:
`-p --input-format text --output-format stream-json --verbose --model --effort
--system-prompt-file <userData>/manager.md --tools "" --setting-sources project`,
plus `--resume` when it has a session. `cwd` is userData. When a Manager turn ends
without a `result`, main also sends `{ type: 'dead', message }`, so a waiting
request fails instead of hanging.

**Other IPC**

| Call | What it does |
|---|---|
| `run:cancel(runId)` | Kills that turn's process. |
| `state:load()` / `state:save(state)` | Reads and writes `<userData>/state.json`. The save is written to a temporary file and then renamed into place, so a crash can't corrupt it. |
| `folder:pick()` | Opens the folder picker. |
| `folder:exists(path)` | Checks whether a folder still exists. |
| `win:*` | Window buttons. |

**Look tests.** When `XODE2_TEST=look` is set, `run:start` is refused, the same as
`NO_CLAUDE` in XodeCode.

## Saved state

```
{
  version: 1,
  settings: { managerModel, managerEffort, workerModel, workerEffort },
  projects: [{ id, name, path, trustedAt }],
  chats: [{
    id, projectId, title, createdAt, updatedAt,
    managerSessionId,
    workers: [{ id, name, sessionId }],
    messages: [{ role, text, at, kind? }]   // last 200 kept
  }]
}
```

Worker messages are not saved. A worker's own tool-by-tool history lives only in
memory, for the summary of the request in flight; its Claude session has
everything it needs to resume.

## Renderer modules

| File | Purpose |
|---|---|
| `managerlogic.js`, `manager.js` | Copied from XodeCode. `createManager(deps)` stays dependency-injected. |
| `workers.js` | `createWorkerPool({ api, chat, project, settings, save })`. It provides the `agents` interface `manager.js` needs (`list`, `status`, `messages`, `send`, `spawn`, `alive`, `onEvent`). It turns `run:event`s into per-worker messages and status, saves the worker's session ID from `init`, and adds `cancelAll()`. |
| `managerapi.js` | `managerApi({ api, chat, settings, save })`. It provides the `api` interface `manager.js` needs (`send`, `stop`, `onEvent`, `loadHistory`, `saveHistory`) on top of `run:start` / `run:cancel`. It saves the Manager's session ID from `init` and keeps chat messages in `chat.messages`. |
| `store.js` | Loads and saves state, with change events. |
| `sidebar.js` | Projects, chats, New chat, Add project, the trust dialog, the context menus. |
| `chatview.js` | The chat pane: log, live strip, composer, header. (Adapted from XodeCode's `managerview.js`.) |
| `settings.js` | The settings panel. |
| `app.js` | Wiring. It keeps one `{ manager, pool }` per opened chat. |

## Edge cases

- **No `claude` on PATH:** a banner says "Claude Code not found. Install it and sign
  in, then restart." The composer is disabled.
- **The project folder was deleted:** see "Missing folders" under Projects and trust.
- **A worker's resume fails because its session is gone:** that worker's session ID
  is cleared, and the turn is retried once without `--resume`.
- **A chat is deleted while working:** all its runs are cancelled first.
- **The app quits:** all running processes are killed.

## Out of scope (for now)

Showing a worker's full transcript, attaching files or images, choosing permission
levels per folder, a budget, voice input, more than 4 workers, and syncing.

## Testing

- **`npm test`** runs the Node scripts:
  - `test-manager.mjs`, carried over;
  - `test-workers.mjs`, with a fake `api`, covering:
    - `init` saves the session ID;
    - tool and tool-result events become messages;
    - `result` sets the worker idle;
    - `spawn` names workers 1 to 4 and refuses a fifth;
    - `cancelAll` cancels every running run;
  - `test-managerapi.mjs`, covering:
    - a session ID from `init` is saved and passed back as `sessionId` on the next
      `send`;
    - `dead` and `result` are forwarded;
    - `saveHistory` writes `chat.messages`.
- **`node --check`** on every file.
- **A look test** (`XODE2_TEST=look`) that:
  - opens the app, adds a project by calling the test hook directly instead of the
    folder picker, and takes a screenshot of the trust dialog;
  - makes a chat;
  - drives the chat view with fake events, taking screenshots of the live strip and
    the summary.

  It never starts a real Claude.
- The user does the live run.
