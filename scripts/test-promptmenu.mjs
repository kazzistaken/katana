// What a session's terminal shows when it asks something, as the chat reads it (screens from real Claude Code 2.1.316).
import assert from 'node:assert/strict';
import { parsePromptMenu, arrowKeys, inputBoxRows } from '../src/renderer/js/promptmenu.js';

const RULE = '─'.repeat(60);
const labels = (menu) => menu.options.map((option) => option.label);

/* Folder trust: no numbers, the arrow on the first. */
{
  const menu = parsePromptMenu(`
${RULE}
 Accessing workspace:

 C:\\Users\\me\\project

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`);
  assert.deepEqual(labels(menu), ['No, exit', 'Yes, I trust this folder']);
  assert.equal(menu.selected, 0);
  assert.equal(menu.question, "Claude Code'll be able to read, edit, and execute files here.");
  assert.match(menu.detail, /Quick safety check/);
  assert.doesNotMatch(menu.detail, /Security guide/);
  // The arrow moved: it follows.
  const moved = parsePromptMenu(`${RULE}\n Trust it?\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter to confirm · Esc to cancel`);
  assert.equal(moved.selected, 1);
}

/* Ticking boxes: notes that only repeat the label go; Next is a choice; what's below the line is set apart. */
{
  const menu = parsePromptMenu(`  size? Options: Small, Large. Do nothing else.
${RULE}

Which fruits do I like?

  1. [ ] Apple
         Apple
❯ 2. [✔] Pear
         Pear
  3. [ ] Plum
         Plum
  4. [ ] Type something
     Next
${RULE}
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
  assert.equal(menu.question, 'Which fruits do I like?');
  assert.equal(menu.multi, true);
  assert.deepEqual(labels(menu), ['Apple', 'Pear', 'Plum', 'Type something', 'Next', 'Chat about this']);
  assert.equal(menu.selected, 1);
  assert.deepEqual(menu.options.map((o) => o.checked), [false, true, false, false, null, null]);
  assert.deepEqual(menu.options.map((o) => o.free), [false, false, false, true, false, false]);
  assert.deepEqual(menu.options.map((o) => o.quiet), [false, false, false, false, false, true]);
  assert.equal(menu.options[0].note, '');
}

/* One answer, with notes. */
{
  const menu = parsePromptMenu(`${RULE}
 ☐ Colour

Which colour do I prefer?

❯ 1. Red
     Warm, and it runs
     on to a second line
  2. Green
     Calm
  3. Type something
${RULE}
  4. Chat about this

Enter to select · Esc to cancel`);
  assert.equal(menu.question, 'Which colour do I prefer?');
  assert.equal(menu.multi, false);
  assert.deepEqual(labels(menu), ['Red', 'Green', 'Type something', 'Chat about this']);
  assert.equal(menu.options[0].note, 'Warm, and it runs on to a second line');
  assert.equal(menu.options[1].note, 'Calm');
  assert.equal(menu.detail, '');
}

/* A permission: what it wants to do is the detail. */
{
  const menu = parsePromptMenu(`● Bash(echo hi > file.txt)
${RULE}
 Bash command

   echo hi > file.txt
   Write a file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for echo commands
   3. No, and tell Claude what to do differently (esc)
`);
  assert.equal(menu.question, 'Do you want to proceed?');
  assert.match(menu.detail, /echo hi > file\.txt/);
  assert.equal(menu.options.length, 3);
  assert.equal(menu.selected, 0);
  assert.equal(menu.options[2].number, 3);
}

/* Reviewing answers before they go. */
{
  const menu = parsePromptMenu(`${RULE}

Review your answers

⚠ You have not answered all questions

 ● Which fruits do I like?
   → Pear

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`);
  assert.equal(menu.question, 'Ready to submit your answers?');
  assert.match(menu.detail, /→ Pear/);
  assert.deepEqual(labels(menu), ['Submit answers', 'Cancel']);
}

/* Nothing being asked: the empty input box, what's being typed in it, what was said, and a numbered list in an answer. */
{
  assert.equal(parsePromptMenu(''), null);
  const typing = `❯ Use the AskUserQuestion tool now
  with exactly two questions

✻ Slithering… (running PreToolUse hook · 12s)

${RULE}
❯
${RULE}
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt`;
  assert.equal(parsePromptMenu(typing), null);
  assert.equal(parsePromptMenu(`${RULE}\n❯ half a message\n${RULE}\n  ⏵⏵ bypass permissions on`), null);
  assert.equal(parsePromptMenu(`● Here's the plan:\n  1. Read the code\n  2. Fix it\n\n✻ Done\n\n${RULE}\n❯\n${RULE}`), null);
  // Your own message above, and no box drawn yet: one line isn't a question.
  assert.equal(parsePromptMenu('❯ Fix the login bug\n  and run the tests\n\n✻ Working…'), null);
}

/* A line across the screen read together with the row after it: what's above stays out. */
{
  const menu = parsePromptMenu(`❯ Use the AskUserQuestion tool
${RULE}←  ☒ Fruit  ☐ Size  ✔ Submit  →

What size?

❯ 1. Small
  2. Large
`);
  assert.equal(menu.question, 'What size?');
  assert.equal(menu.detail, '');
}

/* The review as it's really drawn, with no gap before the question. */
{
  const menu = parsePromptMenu(`${RULE}
Review your answers

 ● Which fruits do you like?
   → Apple, Plum
 ● What size?
   → Medium please
Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`);
  assert.equal(menu.question, 'Ready to submit your answers?');
  assert.match(menu.detail, /Review your answers/);
  assert.match(menu.detail, /→ Medium please/);
}

/* A question with no line at its top: the banner and your own message stay out. */
{
  const menu = parsePromptMenu(` ▐▛███▛█   Claude Code v2.1.316
▝▜██████▀  Haiku 5.5
 ▝▝   ▝▝   ~\\project

❯ Use the AskUserQuestion tool now to ask me

Which colour do you prefer?

❯ 1. Red
  2. Green
`);
  assert.equal(menu.question, 'Which colour do you prefer?');
  assert.equal(menu.detail, '');
}

/* The session's own input box: found, with the hints around it; a menu isn't one. */
{
  const pad = ' '.repeat(90);
  const box = ['● Done.', '', `${pad}○ low · /effort`, RULE, RULE, '❯ ', '  ⏵⏵ bypass permissions on', ''];
  assert.deepEqual(inputBoxRows(box), [2, 6]);
  assert.deepEqual(inputBoxRows(['● Done.', RULE, '❯ half a message', RULE]), [1, 3]);
  assert.equal(inputBoxRows(['Which one?', RULE, '❯ 5. Chat about this']), null);
  assert.equal(inputBoxRows(['nothing here', '']), null);
}

/* Moving the arrow. */
assert.deepEqual(arrowKeys(0, 2), ['\x1b[B', '\x1b[B']);
assert.deepEqual(arrowKeys(2, 1), ['\x1b[A']);
assert.deepEqual(arrowKeys(1, 1), []);

console.log('prompt menu ok');
