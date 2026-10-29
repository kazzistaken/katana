'use strict';

/**
 * Hidden Claude turns for the Katana agent. Each turn is one `claude -p`
 * process: the message goes in on stdin, stream-json comes out and is turned
 * into small UI events, and the process ends with the turn. The next turn
 * resumes the same Claude session by id, so nothing stays running between
 * turns. Claude is reached through the `claude` CLI, so it uses the account
 * that CLI is signed into (the user's subscription).
 *
 * The finding, spawning and parsing helpers are Katana's (src/main/main.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runArgs, killCommand } = require('./runargs');

/* ------------------------- finding claude --------------------------- */

function existsInPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, bin + ext)).isFile()) return path.join(dir, bin + ext);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * The environment a Claude session starts with: ours, minus the markers a
 * Claude Code session leaves for its children (when this app was started
 * from one). With them, Claude would think it's a sub-session and keep no
 * transcript, so tasks would have nothing to show and nothing to resume.
 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_)/.test(key)) delete env[key];
  return { ...env, ...extra };
}

/** Make a value safe to pass as a single quoted argument to the shell. */
function quote(value) {
  const clean = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim();
  return `"${clean}"`;
}

/**
 * Find the real Claude Code executable. npm installs a `.cmd` shim on Windows
 * that just forwards to a bundled `claude.exe`; launching that exe directly
 * skips cmd.exe, so arguments need no shell quoting.
 */
function resolveClaude() {
  const found = existsInPath('claude');
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) {
    const exe = path.join(path.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return { file: exe, shell: false };
    return { file: found, shell: true };
  }
  return { file: found, shell: false };
}

/** Spawn `claude` headless with real argv (falls back to a quoted shell line). */
function spawnClaudeProcess(args, { cwd, env }) {
  const bin = resolveClaude();
  if (!bin) throw new Error('Claude Code not found. Install it and sign in, then restart.');
  // Elsewhere than Windows each turn gets its own process group, so Stop can
  // end it together with everything it started.
  const options = { cwd, env, windowsHide: true, detached: process.platform !== 'win32' };
  if (!bin.shell) return spawn(bin.file, args, options);
  const line = [quote(bin.file), ...args.map((arg) => (/^[\w.:\\/=@,-]+$/.test(arg) ? arg : quote(arg)))];
  return spawn(line.join(' '), { ...options, shell: true });
}

/* ------------------------ stream-json parsing ------------------------ */

/** Short, human description of a tool call. */
function describeTool(block) {
  const name = String(block.name || 'tool');
  const input = block.input || {};
  const detail =
    input.command || input.file_path || input.path || input.pattern || input.url || input.description || '';
  return { name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 140) };
}

/** Copy a tool's input for the UI, trimming huge strings (file bodies, diffs). */
function compactInput(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > 6000 ? `${value.slice(0, 6000)}\n… (${value.length - 6000} more characters)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => compactInput(item, depth + 1));
  if (value && typeof value === 'object' && depth < 4) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = compactInput(item, depth + 1);
    return out;
  }
  return value;
}

function toolResultText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' ? part.text || '' : part.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return String(content ?? '');
}

/** Turn one stream-json line into zero or more UI events. */
function parseClaudeLine(line, emit) {
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return;
  }
  if (json.type === 'system' && json.subtype === 'init') {
    emit({ type: 'init', sessionId: json.session_id, model: json.model });
    return;
  }
  if (json.type === 'assistant' && json.message) {
    for (const block of json.message.content || []) {
      if (block.type === 'text' && block.text) emit({ type: 'assistant', text: block.text });
      else if (block.type === 'tool_use') {
        emit({ type: 'tool', id: block.id, tool: block.name, input: compactInput(block.input || {}), ...describeTool(block) });
      }
    }
    // How much of the context window this turn has filled so far.
    const usage = json.message.usage;
    if (usage) {
      const used =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.output_tokens || 0);
      // `out` per message id: the UI counts tokens written this request.
      emit({ type: 'usage', used, out: usage.output_tokens || 0, msgId: json.message.id || '' });
    }
    return;
  }
  if (json.type === 'user' && json.message && Array.isArray(json.message.content)) {
    for (const block of json.message.content) {
      if (block.type !== 'tool_result') continue;
      const text = toolResultText(block.content);
      emit({
        type: 'tool-result',
        id: block.tool_use_id,
        isError: Boolean(block.is_error),
        text: text.length > 20000 ? text.slice(0, 20000) : text,
        lines: text ? text.split('\n').length : 0,
      });
      if (block.is_error) emit({ type: 'tool-error', text: text.replace(/\s+/g, ' ').slice(0, 300) });
    }
    return;
  }
  if (json.type === 'rate_limit_event' && json.rate_limit_info) {
    // How much of the plan's 5-hour / weekly allowance is used (the sidebar shows it).
    const info = json.rate_limit_info;
    emit({ type: 'limits', limitType: info.rateLimitType || '', utilization: info.utilization ?? null, resetsAt: info.resetsAt || 0, status: info.status || '' });
    return;
  }
  if (json.type === 'result') {
    emit({
      type: 'result',
      ok: !json.is_error,
      result: json.result,
      costUsd: json.total_cost_usd,
      durationMs: json.duration_ms,
    });
    // The model's context window size, when Claude reports it.
    const windows = Object.values(json.modelUsage || {}).map((model) => model?.contextWindow).filter((n) => n > 0);
    if (windows.length) emit({ type: 'usage', window: Math.max(...windows) });
  }
}

function pipeLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
  // The last line may have no newline; it still counts (it is often the result).
  stream.on('end', () => {
    const line = buffer.trim();
    buffer = '';
    if (line) onLine(line);
  });
}

/* ------------------------------- runs -------------------------------- */

/** Running turns by run id (a worker's id, or "<chat>:mgr"). */
const runs = new Map();
// Every turn gets a number, carried on its events: a turn that replaced
// another with the same run id can tell the old one's late events apart.
let nextSeq = 0;

/**
 * Start one turn. Events go to `emit({ runId, seq, type, ... })`. A turn that is
 * cancelled (or replaced by a new one with the same id) goes quiet at once.
 * A Manager turn that ends without a result also sends `dead`, so whatever
 * waits on it fails instead of hanging.
 */
function startRun(options, emit) {
  const { runId, cwd, message, sessionId, model, effort, managerPromptFile, mcpConfig, dirs, bypass } = options;
  cancelRun(runId);
  const args = runArgs({ model, effort, sessionId, managerPromptFile, mcpConfig, dirs, bypass });

  let proc;
  try {
    proc = spawnClaudeProcess(args, { cwd, env: cleanEnv({ FORCE_COLOR: '0' }) });
  } catch (error) {
    // Reported once, through the reply: the caller shows it (workers.js
    // fail, manager.js ask). An event as well would show it twice.
    return { error: error.message };
  }

  const seq = ++nextSeq;
  const run = { proc, cancelled: false };
  runs.set(runId, run);
  let sawResult = false;
  let stderr = '';
  const send = (event) => {
    if (!run.cancelled) emit({ runId, seq, ...event });
  };

  pipeLines(proc.stdout, (line) =>
    parseClaudeLine(line, (event) => {
      if (event.type === 'result') sawResult = true;
      send(event);
    })
  );
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  proc.on('error', (error) => send({ type: 'error', message: error.message }));
  proc.on('close', (code) => {
    if (runs.get(runId) === run) runs.delete(runId);
    const tail = stderr.trim().slice(-300);
    if (code !== 0 && code !== null && tail) send({ type: 'error', message: tail });
    if (!sawResult) send({ type: 'dead', message: tail || 'Katana stopped without answering.' });
    send({ type: 'exit', code });
  });

  try {
    proc.stdin.on('error', () => {});
    proc.stdin.write(`${String(message || '')}\n`);
    proc.stdin.end();
  } catch {
    /* the close handler reports it */
  }
  return { started: true, seq };
}

function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  run.cancelled = true;
  runs.delete(runId);
  killTree(run.proc);
}

/** End a turn and everything it started (a worker's npm test, a dev server). */
function killTree(proc) {
  const command = proc.pid ? killCommand(proc.pid) : null;
  try {
    if (command) spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
    else if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, 'SIGTERM');
    else proc.kill();
  } catch {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}

function cancelAll() {
  for (const runId of [...runs.keys()]) cancelRun(runId);
}

module.exports = { startRun, cancelRun, cancelAll, resolveClaude, existsInPath, pipeLines, parseClaudeLine, cleanEnv };
