// What Katana reads off Claude Code's (and Codex's) screens and transcripts (src/main/screens.js),
// against sample screens: when a Claude Code update changes its wording, this shows what broke.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const screens = require('../src/main/screens.js');
const { trustKeys } = require('../src/daemon/team.js');
const { plain, findQuestion, inputReady, SESSION_IN_USE, INTERRUPTED, NEEDS_YOU } = screens;

// Screens as Claude Code draws them (plain text).
const TRUST = ' Do you trust the files in this folder?\n\n C:\\repo\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit';
const TRUST_NEW = ' Accessing workspace:\n C:\\repo\n Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit';
const BYPASS = ' WARNING: Claude Code running in Bypass Permissions mode\n In Bypass Permissions mode, Claude Code will not ask for your approval…\n ❯ 1. No, exit\n   2. Yes, I accept';
const BASH = ' Bash command\n\n   rm -rf dist\n   Remove the build folder\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for rm commands in C:\\repo\n   3. No, and tell Claude what to do differently (esc)';
const EDIT = ' Edit file\n src/app.js\n …\n Do you want to make this edit to app.js?\n ❯ 1. Yes\n   2. Yes, allow all edits during this session (shift+tab)\n   3. No, and tell Claude what to do differently (esc)';
const CREATE = ' Create file\n notes.md\n Do you want to create notes.md?\n ❯ 1. Yes\n   2. Yes, allow all edits during this session (shift+tab)\n   3. No, and tell Claude what to do differently (esc)';
const FETCH = ' Fetch\n https://example.com\n Do you want to allow Claude to fetch this content?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for example.com\n   3. No, and tell Claude what to do differently (esc)';
const INPUT = '● Fixed it: the tests pass.\n\n╭────────────────────╮\n│ ❯                  │\n╰────────────────────╯\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';

/* ------------------------- its questions ------------------------- */
for (const [screen, need] of [[TRUST, /trust this folder/], [TRUST_NEW, /trust this folder/], [BYPASS, /bypass permissions/]]) {
  const found = findQuestion(screen, 'claude', { toolDialogs: false });
  assert.ok(found, `startup dialog seen: ${screen.slice(0, 40)}`);
  assert.match(found.text, need);
  assert.equal(found.need, 'permission');
}
for (const screen of [BASH, EDIT, CREATE, FETCH]) {
  assert.equal(findQuestion(screen, 'claude')?.need, 'permission', `permission dialog seen: ${screen.slice(0, 30)}`);
  // With bypass on and no tool waiting, a tool's dialog can't be up.
  assert.equal(findQuestion(screen, 'claude', { toolDialogs: false }), null);
}

// Claude's own words asking you something are not a dialog: no "needs permission" for a reply.
const REPLIES = [
  '● All done. Do you want to create a PR?',
  '● The migration is ready. Do you want to proceed with deploying it?\n\n  1. Yes, deploy now\n  2. Wait for review',
  '● Do you want to make this edit to the README as well? I can also allow the linter to fix the rest.',
  '● I added a note on Claude Code\'s Bypass Permissions mode to the docs, and on whether you trust this folder.',
];
for (const reply of REPLIES) {
  assert.equal(findQuestion(reply, 'claude'), null, `a reply is not a question: ${reply.slice(0, 40)}`);
  assert.equal(findQuestion(`${reply}\n\n${INPUT}`, 'claude'), null);
}

// Codex: its approvals (bypass off) and its trust question.
assert.equal(findQuestion('Would you like to run the following command?\n  npm test\n› 1. Yes, proceed', 'codex')?.need, 'permission');
assert.equal(findQuestion('Would you like to run the following command?', 'codex', { toolDialogs: false }), null);
assert.ok(findQuestion('Do you trust the contents of this directory?', 'codex', { toolDialogs: false }));

/* --------------------------- its input box --------------------------- */
assert.equal(inputReady(INPUT), true);
assert.equal(inputReady(TRUST), false, 'a question is not the input box');
assert.equal(inputReady(BYPASS), false);
assert.equal(inputReady('Resuming…\n Claude Code v2.1\n'), false);
assert.equal(inputReady('› Ask Codex to do anything', 'codex'), true);

/* ------------------------- terminal output as text ------------------------- */
assert.equal(plain('\x1b[1mDo\x1b[2Cyou\x1b[0m'), 'Do  you');
assert.equal(plain('a\x1b[3;1Hb\x1b]0;title\x07'), 'a\nb');
// A dialog drawn with cursor moves and colours still reads as one.
assert.ok(findQuestion(plain(`\x1b[2J\x1b[1;1H Do you want to proceed?\x1b[2;1H\x1b[36m❯\x1b[39m\x1b[1C1. Yes\x1b[3;1H  2. No, and tell Claude what to do differently`), 'claude'));

/* ------------------------- other things it says ------------------------- */
assert.match('Error: Session ID 0a1b2c3d-1111-2222-3333-444455556666 is already in use.', SESSION_IN_USE);
assert.match('[Request interrupted by user for tool use]', INTERRUPTED);
assert.match('Claude needs your permission to use Bash', NEEDS_YOU);
assert.doesNotMatch('Claude is waiting for your input', NEEDS_YOU);

// Answering "trust this folder?" for a team member: where the pointer is.
assert.deepEqual(trustKeys(TRUST), ['\r']);
assert.deepEqual(trustKeys(' Do you trust the files in this folder?\n ❯ 1. No, exit\n   2. Yes, proceed'), ['\x1b[B', '\r']);
assert.equal(trustKeys(INPUT), null);

console.log('screens ok');
