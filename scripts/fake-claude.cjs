'use strict';

/**
 * A stand-in for interactive Claude Code, for stress runs that cost nothing
 * (XODE2_FAKE_CLAUDE in a test run: claude.js resolveClaude picks this up).
 * It takes the same arguments a task's `claude` gets and behaves the way
 * Katana reads a real one:
 *
 *  - draws a TUI: banner, an input box with ❯, a spinner while it works,
 *    streamed answer text and tool output (lots of ANSI, like the real one)
 *  - writes a transcript in Claude Code's format (user / assistant lines,
 *    tool_use and tool_result, usage, ai-title) and names it through its hooks
 *  - runs the hooks from --settings: SessionStart, UserPromptSubmit, Stop
 *  - takes a pasted message plus Enter as a new turn; Esc interrupts
 *
 * How hard it works: XODE2_FAKE_PACE (1 = about a real session's pace, higher
 * = faster and noisier), XODE2_FAKE_STEPS (tool calls per turn).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);

// A hidden one-shot (`claude -p`, a task's title): answers from what it's given on stdin.
if (argv.includes('-p')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    const last = input.trim().split(/\r?\n/).pop().replace(/^\d+\.\s*/, '');
    process.stdout.write(`Working on ${last.split(/\s+/).slice(0, 3).join(' ')}\n`);
    process.exit(0);
  });
  return;
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const dash = argv.indexOf('--');
const firstPrompt = dash >= 0 ? argv.slice(dash + 1).join(' ') : '';
const sessionId = flag('--session-id') || flag('--resume') || crypto.randomUUID();
const settingsFile = flag('--settings');
const model = flag('--model') || 'claude-opus-5-5';
const PACE = Math.max(0.1, Number(process.env.XODE2_FAKE_PACE) || 1);
const STEPS = Math.max(1, Number(process.env.XODE2_FAKE_STEPS) || 6);

// The transcript lives next to the hooks folder (never in the real ~/.claude).
const hooksDir = process.env.XODE_HOOKS || path.join(require('node:os').tmpdir(), 'fake-claude');
const transcriptDir = path.join(hooksDir, '..', 'fake-transcripts');
fs.mkdirSync(transcriptDir, { recursive: true });
const transcript = path.join(transcriptDir, `${sessionId}.jsonl`);
// --fork-session: a copy of that session's lines, each keeping its own time (as Claude Code does).
if (argv.includes('--fork-session') && flag('--resume') && !fs.existsSync(transcript)) {
  try {
    fs.copyFileSync(path.join(transcriptDir, `${flag('--resume')}.jsonl`), transcript);
  } catch {
    /* nothing to copy */
  }
}

let hooks = {};
try {
  hooks = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks || {};
} catch {
  /* no hooks: still draws and writes */
}

/* ------------------------------ helpers ------------------------------ */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms / PACE));
const out = (text) => process.stdout.write(text);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
let parent = null;

function append(line) {
  const full = { parentUuid: parent, isSidechain: false, userType: 'external', cwd: process.cwd(), sessionId, version: '2.1.314', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...line };
  parent = full.uuid;
  fs.appendFileSync(transcript, `${JSON.stringify(full)}\n`);
  return full;
}

/** Runs one hook event as Claude Code would: each command, the event as JSON on stdin. */
function hook(name, extra = {}) {
  const groups = hooks[name] || [];
  const event = JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), hook_event_name: name, ...extra });
  const runs = [];
  for (const group of groups) {
    for (const h of group.hooks || []) {
      if (h.type !== 'command' || !h.command) continue;
      runs.push(
        new Promise((resolve) => {
          const child = spawn(h.command, { shell: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
          child.on('error', resolve);
          child.on('exit', resolve);
          child.stdin.end(event);
        })
      );
    }
  }
  return Promise.all(runs);
}

/* ------------------------------ the screen ------------------------------ */

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const ORANGE = '\x1b[38;2;215;119;87m';
const GREEN = '\x1b[38;2;78;186;101m';
const GREY = '\x1b[38;2;153;153;153m';
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽'];
const WORDS = ['Thinking', 'Pondering', 'Reticulating', 'Computing', 'Brewing', 'Synthesizing', 'Noodling'];
let cols = process.stdout.columns || 100;
process.stdout.on('resize', () => {
  cols = process.stdout.columns || cols;
});

function inputBox() {
  const w = Math.max(20, cols - 2);
  out(`\r\n${GREY}╭${'─'.repeat(w - 2)}╮\r\n│${RESET} ❯ ${' '.repeat(Math.max(0, w - 5))}${GREY}│\r\n╰${'─'.repeat(w - 2)}╯${RESET}\r\n`);
  out(`${DIM}  ⏵⏵ bypass permissions on (shift+tab to cycle)${RESET}\r\n`);
}

let spinTimer = null;
let spinWord = 'Thinking';
let spinStart = 0;
function spinner(on) {
  clearInterval(spinTimer);
  spinTimer = null;
  if (!on) return out('\r\x1b[2K');
  spinStart = Date.now();
  spinWord = pick(WORDS);
  let i = 0;
  // The real one redraws its status line many times a second.
  spinTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - spinStart) / 1000);
    out(`\r\x1b[2K${ORANGE}${SPIN[i++ % SPIN.length]} ${spinWord}…${RESET} ${DIM}(${secs}s · ↓ ${rand(100, 9000)} tokens · esc to interrupt)${RESET}`);
  }, Math.max(16, 120 / PACE));
}

/* ------------------------------ a turn ------------------------------ */

const FILES = ['src/app.js', 'src/server/routes.ts', 'lib/parser.py', 'README.md', 'src/components/Chart.tsx', 'tests/api.test.js', 'package.json'];
const LOREM =
  'The change keeps the existing structure and only touches the parts that need it. I checked the call sites and the tests cover the new branch. Next I will run the suite and look at the output for anything that regressed. '.split(' ');
const sentence = (n) => Array.from({ length: n }, () => pick(LOREM)).join(' ');

function codeBlock(lines) {
  return Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(4)} ${pick(['const ', 'let ', 'return ', 'if (', '  await ', 'export function '])}${sentence(rand(2, 7)).replace(/\s/g, '_')};`).join('\n');
}

const TOOLS = [
  () => ({ name: 'Read', input: { file_path: path.join(process.cwd(), pick(FILES)) }, result: codeBlock(rand(30, 160)) }),
  () => ({ name: 'Grep', input: { pattern: pick(['TODO', 'useEffect', 'export default', 'fetch\\(']) }, result: Array.from({ length: rand(3, 40) }, () => `${pick(FILES)}:${rand(1, 900)}: ${sentence(6)}`).join('\n') }),
  () => ({ name: 'Bash', input: { command: pick(['npm test', 'git status', 'ls -la', 'node scripts/build.mjs', 'pytest -q']), description: 'Run it' }, result: Array.from({ length: rand(10, 120) }, (_, i) => `${i % 7 ? '  ✓' : '  ●'} ${sentence(rand(3, 9))} (${rand(1, 90)} ms)`).join('\n') }),
  () => ({ name: 'Edit', input: { file_path: path.join(process.cwd(), pick(FILES)), old_string: sentence(4), new_string: sentence(5) }, result: `The file has been updated. Here's the result:\n${codeBlock(rand(8, 30))}` }),
  () => ({ name: 'Write', input: { file_path: path.join(process.cwd(), pick(FILES)), content: codeBlock(rand(20, 80)) }, result: 'File created successfully.' }),
];

let busy = false;
let interrupted = false;
let turns = 0;

async function streamText(text) {
  out('\r\x1b[2K● ');
  const words = text.split(' ');
  for (let i = 0; i < words.length; i += 3) {
    if (interrupted) return;
    out(`${words.slice(i, i + 3).join(' ')} `);
    await wait(rand(10, 40));
  }
  out('\r\n');
}

async function turn(prompt) {
  busy = true;
  interrupted = false;
  turns += 1;
  out(`\r\n${GREY}> ${prompt.slice(0, cols - 4)}${RESET}\r\n\r\n`);
  await hook('UserPromptSubmit', { prompt });
  append({ type: 'user', message: { role: 'user', content: prompt } });
  if (turns === 1) append({ type: 'ai-title', aiTitle: prompt.split(/\s+/).slice(0, 5).join(' ') || 'Fake task' });
  spinner(true);
  const steps = rand(Math.max(1, STEPS - 2), STEPS + 2);
  for (let s = 0; s < steps && !interrupted; s += 1) {
    await wait(rand(300, 1400));
    if (interrupted) break;
    const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
    const said = sentence(rand(12, 60));
    const usage = { input_tokens: rand(10, 400), cache_read_input_tokens: rand(20000, 180000), cache_creation_input_tokens: rand(0, 3000), output_tokens: rand(40, 900) };
    spinner(false);
    await streamText(said);
    append({ type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: said }], stop_reason: null, usage } });
    const tool = pick(TOOLS)();
    const toolId = `toolu_${crypto.randomBytes(12).toString('hex')}`;
    append({ type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: tool.name, input: tool.input }], stop_reason: 'tool_use', usage } });
    out(`${GREEN}●${RESET} ${tool.name}(${String(tool.input.command || tool.input.file_path || tool.input.pattern).slice(0, cols - 12)})\r\n`);
    spinner(true);
    await wait(rand(400, 2500));
    if (interrupted) break;
    spinner(false);
    // Tool output, as the real one prints it (a few lines folded, the rest counted).
    const shown = tool.result.split('\n');
    for (const line of shown.slice(0, 12)) out(`${DIM}  ⎿  ${line.slice(0, cols - 8)}${RESET}\r\n`);
    if (shown.length > 12) out(`${DIM}     … +${shown.length - 12} lines (ctrl+o to expand)${RESET}\r\n`);
    append({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: tool.result, is_error: false }] }, toolUseResult: { stdout: tool.result.slice(0, 2000), stderr: '', interrupted: false } });
    spinner(true);
  }
  spinner(false);
  if (interrupted) {
    append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    out(`${DIM}  ⎿  Interrupted · What should Claude do instead?${RESET}\r\n`);
  } else {
    const final = `Done. ${sentence(rand(30, 120))}\n\n- ${sentence(8)}\n- ${sentence(10)}\n- ${sentence(6)}`;
    await streamText(final.replace(/\n/g, ' '));
    append({ type: 'assistant', message: { id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: final }], stop_reason: 'end_turn', usage: { input_tokens: 50, cache_read_input_tokens: 120000, cache_creation_input_tokens: 500, output_tokens: rand(200, 1500) } } });
    await hook('Stop', { stop_hook_active: false });
  }
  inputBox();
  busy = false;
}

/* ------------------------------ input ------------------------------ */

let typed = '';
let pasting = false;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  let rest = data;
  while (rest.length) {
    if (rest.startsWith('\x1b[200~')) {
      pasting = true;
      rest = rest.slice(6);
      continue;
    }
    if (rest.startsWith('\x1b[201~')) {
      pasting = false;
      rest = rest.slice(6);
      continue;
    }
    const ch = rest[0];
    rest = rest.slice(1);
    if (pasting) {
      typed += ch;
      continue;
    }
    if (ch === '\x03') process.exit(0);
    if (ch === '\x1b') {
      if (busy) interrupted = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const prompt = typed.trim();
      typed = '';
      if (prompt && !busy) turn(prompt);
      continue;
    }
    if (ch === '\x7f') typed = typed.slice(0, -1);
    else typed += ch;
  }
});

(async () => {
  out(`\x1b[2J\x1b[H${ORANGE}✻${RESET} Welcome to ${'\x1b[1m'}Claude Code${RESET} ${DIM}(fake, for stress runs)${RESET}\r\n\r\n${DIM}  cwd: ${process.cwd()}${RESET}\r\n`);
  await hook('SessionStart', { source: flag('--resume') ? 'resume' : 'startup' });
  inputBox();
  if (firstPrompt) setTimeout(() => turn(firstPrompt), 200);
})();
