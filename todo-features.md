# TASK-MASTER 3000 — Features

A todo list app styled like the LCD screen of an 80s digital watch. It is a single file, `todo.html`, that runs in any browser with nothing to install.

## Tasks

| Action | How |
| --- | --- |
| Add a task | Type in the `> NEW TASK_` line and press **Enter** |
| Mark done / not done | Click `[ ]` / `[■]` next to the task |
| Edit a task | Double-click its text, then **Enter** to save or **Esc** to cancel |
| Delete a task | Hover over the row and click `DEL` |
| Delete by editing | Clear a task's text while editing and save |
| Clear all finished tasks | Press the red **CLR DONE** button |

- New tasks go to the top of the list.
- Tasks are limited to 40 characters so they fit on the screen.
- Finished tasks are dimmed and crossed out.
- Pressing Enter on an empty line plays an error beep and adds nothing.

## Buttons

| Button | What it does |
| --- | --- |
| **MODE** | Cycles the filter: ALL → ACT (active) → DONE |
| **LIGHT** | Turns the teal backlight on or off |
| **SOUND** | Turns the beeps on or off |
| **CLR DONE** | Removes every finished task |

## Screen

- **Status row:** shows which filter is on (ALL / ACT / DONE) by lighting it up and dimming the others. It also has a ♪ marker that shows when sound is on, and the day of the week.
- **Clock:** live time in `HH:MM:SS`, with faint unlit `88:88:88` segments behind it.
- **Info line:** today's date (`MM-DD`) and how many tasks are left (`LEFT 03`).
- **Empty states:** a blinking `-- NO DATA --`, `-- NONE DONE --` or `-- ALL CLEAR --`, depending on the filter.
- **Look:** olive-green LCD panel with a pixel grid, see-through dark text with the offset shadow real LCD characters cast, and a pixel font (VT323). Hovering over a row turns it dark with light text.

## Sound

Each action plays a short square-wave beep, like a digital watch:

- **Add / edit / mode / light:** standard beep
- **Mark done:** higher beep
- **Mark not done:** lower beep
- **Delete / clear done:** low, longer beep
- **Error (empty task):** lowest, longest beep

## Saving

- Tasks are saved in the browser's `localStorage` under the key `tasks-app-v1`. They're still there after a refresh or browser restart.
- They are saved per browser and per device. Clearing site data deletes them.
- The filter, backlight and sound settings are not saved. They reset each time you load the page.

## Requirements

- Any modern browser.
- An internet connection only for the VT323 font. Offline, the app still works and falls back to a monospace font.
