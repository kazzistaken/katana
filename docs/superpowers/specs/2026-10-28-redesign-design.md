# Katana redesign — "night study"

Date: 2026-10-28. Status: design approved in chat ("Looks right, write it up and build it").

## Why

The first V2 UI was too bare and its text sizes jumped around. The user has ADHD and wants:

- something calm, with a character of its own;
- as little jumbled text as possible;
- a real terminal, instead of the read-only worker log.

## Look

**Colours**

| Token | Value | Use |
|---|---|---|
| bg | `#000` | Window background |
| panel | `#070707` | Panel fill |
| outline | `#2A2723` | Panel outline, warm |
| outline-soft | `#1C1A17` | Softer outline |
| text | `#E9E4DA` | Main text |
| muted | `#9B958B` | Secondary text |
| faint | `#6E6960` | Least important text |
| accent (sage) | `#9CBF9F` | "Working", the active chat, done (✓) |
| rose | `#D99A94` | Not done (✗), errors |

**Type**
- Body text is Atkinson Hyperlegible Next (400, 500, 600). The terminal uses Atkinson Hyperlegible Mono.
- Both come from `@fontsource` in node_modules, so nothing is fetched online.
- There is one text size, 15px. Small labels are 13px. Hierarchy comes from weight and spacing, never from big text.

**Shape**
- Panels have 16px corners and controls have 10px corners.
- Panels sit 10px from the window edges and 10px from each other.

## Layout

The title bar is black. It holds the app name, the view switch ([chat] [›_]) and the window buttons.

Below it are two outlined panels:

1. **The sidebar**, 264px wide.
   - **Header row:**
     - "New chat" as plain text, with no background and no outline;
     - an Add project icon, which opens the folder picker. Its title and button read "Trust this folder"; choosing a folder trusts it, with no extra dialog;
     - a Settings gear icon.
   - **Below the header:** projects, with their chats underneath.
   - **Working chats:** a sage dot next to the chat, breathing slowly.
2. **The main panel**, which shows one of three things: the chat, the terminal or settings.

## Chat

- **Header:** the chat title, with the project path in faint text.
- **Messages:** all text is the same size.
  - Your messages sit in soft bubbles.
  - Manager summaries show the worker name in semibold, with sage ✓ lines and rose ✗ lines.
  - Errors are rose.
- **Live strip:** one line per tool call that is running: a breathing dot, the name, then the label.
- **Composer:** a text box, then a row of controls below it:
  - **Context ring:** shows the highest share of its context window used by the Manager or any worker in the chat. Clicking it opens a popover with a bar per agent (`used / window`) and **Start fresh**, which clears this chat's Manager and worker sessions and their context numbers.
  - **Model:** a menu for this chat's workers: Opus, Sonnet or Haiku. The default comes from Settings, and the choice is saved on the chat.
  - **Effort:** a slider with 5 steps (low, medium, high, xhigh, max). It applies to this chat's workers and is saved on the chat.
  - **Send / Stop.**

## Settings (a full page in the main panel)

A list of sections on the left and the content on the right. Esc or Back returns to the chat.

| Section | What's in it |
|---|---|
| General | Open the last chat on start; confirm before deleting chats |
| Models | Manager model and effort; default worker model and effort |
| Projects & trust | Trusted folders, each with Remove; add a folder |
| Terminal | Shell (PowerShell, pwsh or cmd, whichever are installed); font size from 12 to 18 |
| Appearance | Animations: full, reduced or off |
| About | Version, the Claude path that was found, the data folder |

The sections are defined as data (`SECTIONS`), so adding one means adding one entry.

## Terminal (rebuilt)

- A real shell, run through `node-pty` in main and shown with `@xterm/xterm` and its fit addon in the renderer. It uses the Mono font and the night palette.
- It opens in the open chat's project folder.
- **Tabs:** each project has its own row of tabs with a "+". The first tab opens by itself the first time you open the terminal for a project.
- Closing a tab kills its shell. Switching views or chats only hides the tabs, so the shells keep running.
- **Main process:**
  - `pty:create({ cwd, cols, rows, shell })` returns `{ id }`. `cwd` must be a trusted folder (the same `runGuard` as workers);
  - `pty:write`, `pty:resize` and `pty:kill`;
  - output arrives as `pty:data` and the end as `pty:exit`;
  - all shells are killed when the app quits.
- **Shortcuts:** `Ctrl+\`` toggles the terminal and `Ctrl+Shift+\`` opens a new tab.

The old read-only `terminalsview.js` is removed.

## Context numbers

- `parseClaudeLine` sends `{ type: 'usage', used, window }` from each assistant message's `usage`, where `used` is input + cache_read + cache_creation + output tokens.
- It also sends usage from `result.modelUsage[*].contextWindow` when that is present. The window is 1,000,000: every Claude session runs with the 1M context window.
- Each worker and the Manager keep their latest `{ used, window }` in memory, and `pool.context()` and `managerApi.context()` return them.
- `chat.context` holds a saved copy, so the ring shows something after a restart.

## Animations

Settings has a level: full, reduced or off. "Reduced" is also used when the system asks for reduced motion.

- On launch, the panels settle in (opacity and a 6px rise) over 320ms, one after the other.
- A new message fades in with a 4px rise over 220ms.
- Live lines slide in from 6px to the left and fade out.
- The context ring fills over 400ms.
- The main panel crossfades between chat, terminal and settings over 160ms.
- The working dot breathes on a 2.4s cycle.
- Popovers and menus scale from 0.98 and fade over 140ms.

## Testing

- **Node tests:**
  - `parseClaudeLine` usage;
  - the store: `chat.workerModel` and `workerEffort`, and `startFresh`;
  - the pool uses the chat's model and effort and keeps context numbers;
  - `runGuard` for pty paths;
  - shell choice.
- **Look tests:** screenshots of the welcome screen, a chat with live lines and a summary, the context popover, settings, and the terminal with a real PowerShell tab (no Claude involved).
