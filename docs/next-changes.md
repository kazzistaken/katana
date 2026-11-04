# Katana: changes to make now

Written 2026-10-30, after the bug-fix pass. The fixes from the reliability and
speed reviews are already in this folder (not committed yet). This is what's left.

## 1. Do these first

- [ ] **Restart Katana.** The daemon only swaps to new code when nothing is running.
- [ ] **Try it for a few minutes.** In particular:
  - [ ] Resume an old, long task: it should open fast, with no freeze.
  - [ ] Open a task's terminal (`Ctrl+``): output still shows, and the full history replays.
  - [ ] Run a page or browser game in the app viewer: it loads, and its sound and video work.
  - [ ] Press F5 while Katana is busy: she shouldn't hang.
  - [ ] Merge a worktree task: it merges into the branch it started from.
- [ ] **Commit** the fixes, separately from your Codex / Night lake work if you want clean history.
- [ ] **Remove the fix worktree**: `C:\Users\diddy\Downloads\XodeCodeV2-fixbugs` and its branch `fix/all-bugs`.

## 2. How things behave now (no action needed)

- A page in the app viewer can only load files from its own folder (`../assets` won't load).
  Hidden files (`.env`, `.git`) aren't served. Mic, camera and similar permission requests are denied.
- A broken `state.json` now shows a dialog. Katana falls back to `state.json.bak`
  and never saves over the broken file unless you choose **Start fresh**.
- Merging a worktree is refused if your checkout is on a different branch or has uncommitted changes.
  The message says why.
- Deleting a task removes its worktree folder. Its branch is kept if it has commits that aren't merged.
- In Sub-agents mode, the working line shows the lead's "Agent" call, not the sub-agent's own tool.
- A window that a running app opens by itself can stay visible for 1–2 s before
  it's moved off-screen (it was 300 ms).

## 3. Bugs left open (small)

| What | Where | Fix |
|---|---|---|
| Codex history is read from the start of the file on resume (in 1 MB pieces now) | `src/main/codex.js` `rolloutTranscript`, `src/main/tasks.js` | Resume from the file's end like Claude tasks do; read history from the end |
| Daemon `history()` still reads synchronously (capped at 4 MB) | `src/main/tasks.js:593` | Make it async once `headless.js` awaits it |
| Hierarchy team members' worktrees aren't cleaned up on delete | `src/daemon/team.js` | Use `worktree.cleanup()` for each member's tree |
| Katana's `remove_folder` with no window open says "needs a window" | `src/daemon/headless.js` | Run it headless like `delete_task` |
| The app viewer doesn't tell main when its pane is hidden, so polling only slows down when the whole window is minimized | `src/renderer/js/appview.js` → `src/main/appview.js` | Report pane visibility; poll every 2 s while hidden |
| A tool call that arrives just as the page starts reloading fails instead of running headless | `src/daemon/core.js` `windowReady` | Retry it headless |
| A headless call that runs longer than 15 s doesn't block the page loading | `src/daemon/core.js` | Wait longer, or reload state after the call ends |
| Sub-agents' own tools don't show on the working line | `src/daemon/taskstate.js` | Read the sub-agent transcript files too |
| Tasks with the same `updatedAt` can swap order | `src/renderer/js/sidebar.js` | Break ties by id |
| Not checked end to end: reopening a done task reloads its chat from disk | `src/renderer/js/app.js` `done()`, `taskclient.load()` | Add a look test |

## 4. Groundwork before big features

- [ ] **One set of Katana tools.** About 31 tools exist twice: `src/renderer/js/apptools.js`
  (window open) and `src/daemon/headless.js` (window closed). They keep drifting apart. Share one definition.
- [ ] **Model names in one place.** They're hard-coded in 7 files, and `MODEL_ALIAS` is duplicated.
- [ ] **One list of daemon methods.** Adding one now touches `core.js`, `protocol.js`, `main.js`,
  `preload.js` and the renderer client.
- [ ] **Split `chatview.js`.** It's one 1,400-line function and can't be unit-tested.
  Separate the task view, Katana's view, New task, the composer and the file/app viewer.
- [ ] **Split `styles.css`** (3,600+ lines) by area: base, sidebar, chat, settings, themes.
- [ ] **Tests for the untested parts:** `main.js` IPC handlers, `hook.cjs`, `mcp-app.cjs`, `notify.js`, and `chatview.js` once it's split.
- [ ] **Type-checking without a build step:** JSDoc types plus `tsc --checkJs --noEmit`.

## 5. Big features (in the order I'd build them)

1. **Review desk.** A Changes view for each task: changed files and side-by-side diffs, comments on a line
   that go back to the task, keep or discard each file, merge. Katana writes a short review: what changed,
   what's risky, what to test.
2. **Proof cards.** A finished task shows evidence: which tests ran and whether they passed,
   a screenshot from the app viewer, lines added and removed.
3. **Better sidebar rows and a control-centre home.** Each row says what the task is doing now,
   how long it's been running, and lines changed. Tasks are grouped by folder.
   The home screen shows what needs you, running tasks and today's wrap-up.
4. **Overnight queue.** A backlog that Katana runs while your plan has usage left. Morning report.
5. **Rewind.** A snapshot before each turn and "undo this turn", for Claude, Codex and shell tasks.
6. **Quick switcher (`Ctrl+P`)** to jump to any task, action or setting, plus search across all past conversations.
7. **Project memory.** A short brief for each folder (how to run it, conventions, decisions)
   that Katana learns from finished tasks and gives to new ones.
8. **Playbooks.** Saved recipes ("QA pass", "release") started with one click or by voice.
9. **Best-of-3.** The same task done two or three ways on separate worktrees. Compare, keep the best.
10. **Conflict radar.** A warning when two tasks edit the same file in one folder.
11. **Already planned:** receipts in Katana's thread, and linking computers over Tailscale.

Smaller UI touches:
- Show "N earlier requests" above a task's latest exchange (scrolling up is the only way to find them now).
- Katana's page: live captions, her recent actions, and the needs-you list next to her face.
- Focus mode: one task fills the screen, and only needs-you alerts come through.
- Settings → Modes: a single preset card (Fast / Balanced / Max) instead of three rows of model and effort buttons.
- Labels on the icon-only buttons in the top bar.
