# Hierarchy mode — plan

Date: 2026-10-29

A task can run as one Claude Code session (today, "Single agent") or as a
team ("Hierarchy"): 1 Leader, 2 Verifiers, 4 Workers, each a real interactive
Claude Code session started the way tasks are (node-pty, `taskCommand`, 1M
context, hooks), only when needed.

## Who is who

| Role | Session id | Folder | Tools beyond Claude Code's |
|---|---|---|---|
| Leader | the task's own id (its session is the task's conversation) | the task's folder | `katana-team` MCP: team_assign, team_status, team_collect, team_verify, team_send_back, team_merge. Edit/Write/NotebookEdit/Bash/Task are disallowed: it plans, it doesn't code. |
| Worker 1-4 | `<task>--w1` … `--w4` | its own git worktree on its own branch (`xode/…`), made per assignment from the task folder's HEAD; a folder that isn't a git repo: the task folder, with file claims that may not overlap | `katana-viewer` (the app viewer, on the task's pane) |
| Verifier 1-2 | `<task>--v1`, `--v2` | the worktree of the worker it checks | `katana-viewer` + `katana-team` with one tool: team_verdict(pass, details) |

Models: settings `managerModel`/`managerEffort` (leader; already in saved
settings from V1), `workerModel`/`workerEffort`, and new
`verifierModel`/`verifierEffort`; all listed in Settings → Hierarchy.

## Dispatch (src/daemon/team.js, pure, scripts/test-team.mjs)

The daemon owns the team (it must work with the window closed), persisted in
`<userData>/teams.json`, sent to windows as `team:state`.

- **assign(worker?, title, prompt, files)**: refuses a busy worker, one with
  unmerged work, or files that overlap another worker's unmerged claim.
  Makes the worktree, starts a fresh session with a brief (subtask, files it
  owns, branch, "end with a summary").
- **Hearing back**: a member's turn ending (taskstate's `finished`) becomes a
  result the leader hasn't collected. `team_collect` returns them
  (optionally waiting up to N seconds). If the leader is idle when one
  arrives, the daemon types `[team] … call team_collect` into its terminal,
  which wakes it, as a finished task wakes Katana.
- **verify(worker, verifier?)**: a fresh verifier session in that worker's
  worktree; told the base branch to diff against, to run the tests and to
  test in the app viewer, then call team_verdict. No verdict call: its last
  words are read for `VERDICT: PASS|FAIL`; none → failed.
- **send_back(worker, feedback)**: same worker session, typed in; attempt+1,
  the old verdict is cleared.
- **merge(worker)**: only with a passing verdict on the current attempt.
  Commits the worktree, merges its branch into the task folder's branch,
  removes the worktree; the worker's session ends; its claim is freed.
- Member states shown: idle / working / done / failed (+ needs-you flag).
- **Settled** = nothing working, nothing uncollected. A leader turn that
  ends while the team isn't settled isn't "finished" (no ding, no Katana
  summary, no stats): Katana gets one summary per task, when the leader
  finishes with the team settled.

## Window

- Prompt bar: a `Single agent | Hierarchy` segmented toggle right of the
  model · effort line. New task: sets the default (`taskMode`). A task:
  switches it, only while the leader/session isn't working (else a notice).
  To hierarchy: an idle session is closed and resumes as leader on the next
  message (same conversation). To single: members working → confirm, then
  they're stopped; unmerged branches are kept and named.
- Terminal pane in hierarchy mode: a tree (Leader; 2 Verifiers; 4 Workers,
  SVG connectors). Each node: role, state, subtask, and a live mini xterm
  (scaled). Click → full size, typed into; Esc/back returns.
- Chat: the leader's conversation, with compact team lines (member · what
  happened) inside each exchange, by time.
- Katana: app_state gives a hierarchy task `mode` and `team` (one line per
  busy member); her per-turn situation says the same in one line. Members
  aren't tasks, so they never appear as tasks or wake her.

## Proof

npm test (new test-team.mjs, runargs cases); a test-mode run with a throwaway
data folder and a temp git repo, members as shells driven through the team
tools (and, if cheap enough, a real haiku leader); screenshots of the toggle
and the tree.
