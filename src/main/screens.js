'use strict';

/**
 * What Claude Code (and Codex) put on screen or in their transcripts that
 * Katana reads to know where a session stands, in one place: when a new
 * Claude Code version changes its wording, this is the file to update
 * (scripts/test-screens.mjs holds sample screens for each).
 *
 * Screens are read as plain text (plain() below): colours gone, cursor moves
 * turned into spaces and line breaks.
 */

// Terminal output as text: cursor moves become spaces and line breaks, colours go.
const plain = (text) =>
  String(text || '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.min(Number(n) || 1, 40)))
    .replace(/\x1b\[\d*;?\d*H/g, '\n')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

// The pointer on the chosen line of a list of choices ("❯ 1. Yes"). Claude Code
// draws ❯; a terminal without the glyph gets >.
const POINTER = '[❯>]';
// A dialog's choices, as Claude Code draws them: the pointer on "1. Yes" (or "1. No"
// in the bypass one), more numbered choices under it. Prose that merely asks
// "Do you want to …?" has none of this.
const CHOICES = `${POINTER}\\s*1\\.\\s*(?:Yes|No)\\b[\\s\\S]{0,600}?\\b[2-4]\\.\\s*(?:Yes|No)\\b`;
const dialog = (question) => new RegExp(`(?:${question})[\\s\\S]{0,1200}?${CHOICES}`, 'i');

// Its input box: Claude Code's prompt ❯, Codex's ›.
const INPUT_PROMPT = { claude: '❯', codex: '›' };

/**
 * Questions a session asks in its terminal that only you can answer: [pattern,
 * what Katana says, need, when]. `when`: 'always' (startup dialogs: trust,
 * bypass) or 'tool' (a tool's permission dialog: only possible with bypass off,
 * or while a tool waits to run).
 */
const CLAUDE_QUESTIONS = [
  // "Do you trust the files in this folder?" / "Is this a project you created or one you trust?"
  [dialog('one you trust|trust (?:this|the files in this) folder|trust this project'), 'Claude Code asks whether you trust this folder. Answer it in the terminal.', 'permission', 'always'],
  // "WARNING: Claude Code running in Bypass Permissions mode … ❯ 1. No, exit  2. Yes, I accept"
  [dialog('Bypass Permissions mode'), 'Claude Code asks you to accept bypass permissions mode (once). Answer it in the terminal.', 'permission', 'always'],
  // "Do you want to proceed?" (a command), "… make this edit to x?", "… create x?", "… allow Claude to fetch …?"
  [dialog('Do you want to (?:proceed|make this edit|create|allow|delete|overwrite)[^\\n?]{0,300}\\?'), 'Claude wants permission for its next step. Answer it in the terminal.', 'permission', 'tool'],
];
// Codex's (with bypass off): running a command, an edit, more access; trusting the folder.
const CODEX_QUESTIONS = [
  [/Would you like to (run the following command|make the following edits|grant these permissions|send input to)/i, 'Codex wants permission for its next step. Answer it in the terminal.', 'permission', 'tool'],
  [/trust (the contents of )?this (folder|directory)/i, 'Codex asks whether you trust this folder. Answer it in the terminal.', 'permission', 'always'],
];
const questionsOf = (kind) => (kind === 'codex' ? CODEX_QUESTIONS : CLAUDE_QUESTIONS);

/**
 * The question on a (plain) screen, or null: { text, need }. `toolDialogs`:
 * whether a tool's permission dialog can be up now (bypass off, or a tool waits).
 */
function findQuestion(screen, kind = 'claude', { toolDialogs = true } = {}) {
  const found = questionsOf(kind).find(([re, , , when]) => (when === 'always' || toolDialogs) && re.test(screen));
  return found ? { text: found[1], need: found[2] } : null;
}

/** Its input box is up: its prompt drawn, and no question on screen in its place. */
const inputReady = (screen, kind = 'claude') => screen.includes(INPUT_PROMPT[kind] || INPUT_PROMPT.claude) && !findQuestion(screen, kind);

// `claude --session-id <id>` on a session that exists already.
const SESSION_IN_USE = /Session ID \S+ is already in use/;

// The transcript's user line Claude Code writes when you press Esc mid-turn.
const INTERRUPTED = /^\[Request interrupted by user/;

// A Notification hook's message when it waits for you: "Claude needs your permission to use Bash".
const NEEDS_YOU = /permission|approve|needs your/i;

// "Trust this folder?" for trustKeys (team.js): the question, and the pointer on Yes or No.
const TRUST_QUESTION = /trust (this|the files in this) folder|one you trust|trust this project/i;
const TRUST_POINTER = /[❯›>]\s*(?:\d+\.\s*)?(Yes|No)\b/gi;
const TRUST_YES_BELOW = /\n[^\S\n]*(?:\d+\.\s*)?Yes\b/i;

module.exports = {
  plain,
  findQuestion,
  inputReady,
  questionsOf,
  SESSION_IN_USE,
  INTERRUPTED,
  NEEDS_YOU,
  TRUST_QUESTION,
  TRUST_POINTER,
  TRUST_YES_BELOW,
};
