'use strict';

/**
 * Codex sessions, read the way Claude Code's are. Codex keeps each session
 * in a rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
 * later compressed to .jsonl.zst) and sends no hooks Katana can use (its
 * own need a trust review first), so its rollout is the one source:
 *
 *   find      a new session's file (the one started in this folder since
 *             then), or a known session's by its id
 *   convert   rollout lines into what a Claude task gives: transcript lines
 *             (user / assistant with text, tool_use, tool_result) for the
 *             task view, and hook-like events (UserPromptSubmit, PreToolUse,
 *             PostToolUse, Stop) for where it stands (daemon/taskstate.js)
 *   models    the models Codex offers, from its own cache
 *
 * Pure apart from reading files, so scripts/test-codex.mjs runs it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const sessionsDir = (home = codexHome()) => path.join(home, 'sessions');

// Used when Codex's model cache can't be read (it has never run, say).
const FALLBACK_MODELS = [
  { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
];

/** The models Codex lists for picking (its models_cache.json, best first): [{ id, label, efforts }]. */
function codexModels(home = codexHome()) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    const models = (cache.models || [])
      .filter((m) => m && m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ id: String(m.slug), label: String(m.display_name || m.slug), efforts: (m.supported_reasoning_levels || []).map((e) => e.effort).filter(Boolean) }));
    if (models.length) return models;
  } catch {
    /* no cache yet */
  }
  return FALLBACK_MODELS;
}

/**
 * What runs Codex: { file, env } or null. On Windows npm installs a .cmd
 * shim, and cmd.exe would mangle a prompt's quotes and % signs, so its
 * native codex.exe runs directly, with what the shim would have set.
 * `existsInPath` is claude.js's.
 */
function resolveCodex(existsInPath) {
  const found = existsInPath('codex');
  if (!found) return null;
  if (!/\.(cmd|bat|ps1)$/i.test(found)) return { file: found, env: {} };
  const root = path.join(path.dirname(found), 'node_modules', '@openai', 'codex');
  const triple = process.arch === 'arm64' ? ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'] : ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'];
  for (const vendor of [path.join(root, 'node_modules', ...triple[0].split('/'), 'vendor'), path.join(root, 'vendor')]) {
    const exe = path.join(vendor, triple[1], 'bin', 'codex.exe');
    if (fs.existsSync(exe)) return { file: exe, env: { CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: '1' } };
  }
  return { file: found, env: {} };
}

const sameFolder = (a, b) => {
  const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Day folders (YYYY/MM/DD) newest first. */
function dayDirs(root) {
  const list = (dir) => {
    try {
      return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort().reverse();
    } catch {
      return [];
    }
  };
  const days = [];
  for (const y of list(root)) for (const m of list(path.join(root, y))) for (const d of list(path.join(root, y, m))) days.push(path.join(root, y, m, d));
  return days;
}

/** A session's rollout by its id: the live .jsonl over a compressed one; '' when there is none. */
function findRollout(sessionId, home = codexHome()) {
  const id = String(sessionId || '').toLowerCase();
  if (!/^[0-9a-f-]{8,}$/.test(id)) return '';
  for (const dir of dayDirs(sessionsDir(home))) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const live = names.find((n) => n.toLowerCase().endsWith(`${id}.jsonl`));
    if (live) return path.join(dir, live);
    const packed = names.find((n) => n.toLowerCase().endsWith(`${id}.jsonl.zst`));
    if (packed) return path.join(dir, packed);
  }
  return '';
}

/** The first line of a rollout: its session_meta payload, or null. */
function sessionMeta(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.toString('utf8', 0, read).split('\n')[0];
    const line = JSON.parse(first);
    return line.type === 'session_meta' ? line.payload || null : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * The session a Codex just started in `cwd` writes to: the newest live
 * rollout begun since `since` (ms) in that folder that no other task has
 * claimed. { file, sessionId } or null (not written yet).
 */
function findNewRollout({ cwd, since, claimed = new Set(), home = codexHome() }) {
  const found = [];
  // Today's and yesterday's folders (a session started just before midnight).
  for (const dir of dayDirs(sessionsDir(home)).slice(0, 2)) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (claimed.has(file)) continue;
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (Math.max(stat.birthtimeMs || 0, stat.mtimeMs) < since - 2000) continue;
      const meta = sessionMeta(file);
      if (!meta || !sameFolder(meta.cwd, cwd)) continue;
      const started = Date.parse(meta.timestamp || '') || stat.birthtimeMs || stat.mtimeMs;
      if (started < since - 2000) continue;
      found.push({ file, sessionId: String(meta.id || meta.session_id || ''), started });
    }
  }
  found.sort((a, b) => b.started - a.started);
  return found[0] || null;
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** A whole rollout's lines (decompressed when it's a .zst). */
function readRollout(file) {
  try {
    let data = fs.readFileSync(file);
    if (file.endsWith('.zst')) data = zlib.zstdDecompressSync(data);
    return data.toString('utf8').split('\n').map(parse).filter(Boolean);
  } catch {
    return [];
  }
}

/* ------------------------------ converting ------------------------------ */

// A JavaScript string literal at the start of `text`: its value, or null.
function literal(text) {
  const m = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/s.exec(text);
  if (!m) return null;
  const raw = m[1];
  if (raw[0] === '"') {
    try {
      return JSON.parse(raw);
    } catch {
      /* not JSON after all */
    }
  }
  return raw.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_all, c) => (c[0] === 'u' && c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : { n: '\n', t: '\t', r: '\r' }[c] ?? c));
}

/** The files a patch touches, as the tools Claude would have used: Write for a new file (with its text), Edit otherwise. */
function patchTools(patch) {
  const tools = [];
  const lines = String(patch || '').split('\n');
  let current = null;
  for (const line of lines) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      current = head[1] === 'Add' ? { name: 'Write', input: { file_path: head[2].trim(), content: '' } } : { name: 'Edit', input: { file_path: head[2].trim(), description: head[1] === 'Delete' ? 'Delete' : '' } };
      tools.push(current);
      continue;
    }
    if (/^\*\*\* (End Patch|Move to:)/.test(line)) continue;
    if (current?.name === 'Write' && line.startsWith('+')) current.input.content += `${line.slice(1)}\n`;
  }
  return tools.length ? tools : [{ name: 'Edit', input: {} }];
}

// Codex's MCP tool names (mcp__katana_viewer__run_app) back as the servers are named.
const mcpName = (name) => name.replace(/^mcp__katana_viewer__/, 'mcp__katana-viewer__').replace(/^mcp__katana_team__/, 'mcp__katana-team__');

/** One named tool call with its arguments, as Claude's tools: [{ name, input }]. */
function namedTool(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'exec_command' || name === 'shell' || name === 'local_shell' || name === 'shell_command') {
    const command = Array.isArray(input.command) ? input.command.join(' ') : input.cmd || input.command || '';
    return [{ name: 'Bash', input: { command: String(command) } }];
  }
  if (name === 'apply_patch') return patchTools(typeof args === 'string' ? args : input.input || input.patch || '');
  if (name === 'web_search' || name === 'web_search_call') return [{ name: 'WebSearch', input: { query: String(input.query || '') } }];
  if (name === 'view_image') return [{ name: 'Read', input: { file_path: String(input.path || '') } }];
  if (name === 'update_plan') return [{ name: 'TodoWrite', input: {} }];
  return [{ name: mcpName(name), input }];
}

/**
 * The tools a code-mode `exec` script calls (`await tools.exec_command({cmd: "…"})`,
 * `tools.apply_patch("…")`, `tools.mcp__…({…})`), first to last. Only what can
 * be read without running it: commands' text and patches' files.
 */
function scriptTools(code) {
  const tools = [];
  const calls = /tools\.([A-Za-z_][\w]*)\(/g;
  let m;
  while ((m = calls.exec(code))) {
    const name = m[1];
    const rest = code.slice(m.index + m[0].length);
    if (name === 'apply_patch') tools.push(...patchTools(literal(rest) || ''));
    else if (name === 'exec_command' || name === 'shell' || name === 'shell_command') {
      const cmd = /\b(?:cmd|command)\s*:\s*/.exec(rest.slice(0, 4000));
      tools.push({ name: 'Bash', input: { command: cmd ? literal(rest.slice(cmd.index + cmd[0].length)) || '' : '' } });
    } else tools.push(...namedTool(name, {}));
  }
  if (!tools.length) tools.push({ name: 'Script', input: { description: String(code || '').trim().split('\n')[0].slice(0, 200) } });
  return tools;
}

const at = (line) => Date.parse(line.timestamp || '') || 0;

/** A tool call's output as text (a code-mode script's "Script completed … Output:" header dropped). */
function outputText(output) {
  const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map((part) => part?.text || '').join('') : output && typeof output === 'object' ? String(output.content ?? output.output ?? JSON.stringify(output)) : '';
  return text.replace(/^Script completed\s*\nWall time [^\n]*\nOutput:\n/, '');
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((part) => part && /^(text|input_text|output_text)$/i.test(part.type) && part.text)
    .map((part) => part.text)
    .join('\n');

// How a tool call reads in the Working line: { desc, detail }, as hook.cjs writes them.
const hookDetail = (tool) => ({
  desc: String(tool.input.description || '').slice(0, 200),
  detail: String(tool.input.command || tool.input.file_path || tool.input.query || '').slice(0, 300),
});

/**
 * A converter for one session: feed it rollout lines (whole, in order) and
 * get back { lines, events }. `lines` are Claude-shaped transcript lines
 * (uuid, type, timestamp, message); `events` are hook events for lines from
 * `since` on (what came before is history: a resumed session's file is read
 * from the top).
 */
function createConverter({ since = 0 } = {}) {
  const calls = new Map(); // call_id -> tool_use ids
  let sessionId = '';

  function convert(rollout) {
    const lines = [];
    const events = [];
    for (const line of rollout || []) {
      if (!line || typeof line !== 'object') continue;
      const p = line.payload || {};
      const when = at(line);
      const timestamp = line.timestamp || new Date(when || Date.now()).toISOString();
      const live = when >= since - 1000;
      const event = (name, extra = {}) => live && events.push({ at: when || Date.now(), event: name, session: sessionId, ...extra });
      if (line.type === 'session_meta') {
        sessionId = String(p.id || p.session_id || sessionId);
        event('SessionStart');
        continue;
      }
      if (line.type === 'event_msg') {
        if (p.type === 'task_started') event('UserPromptSubmit');
        else if (p.type === 'task_complete') {
          // The turn's end, as a Claude answer that ended its turn.
          lines.push({ uuid: `end:${p.turn_id || when}`, type: 'assistant', timestamp, message: { id: `end:${p.turn_id || when}`, role: 'assistant', content: [], stop_reason: 'end_turn' } });
          event('Stop');
        } else if (p.type === 'turn_aborted') {
          // Esc (or Stop): as Claude Code writes an interrupt; taskstate shows it stopped.
          lines.push({ uuid: `abort:${p.turn_id || when}`, type: 'user', timestamp, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
          for (const ids of calls.values()) for (const toolId of ids) event('PostToolUseFailure', { toolId });
          calls.clear();
        } else if (p.type === 'token_count' && p.info?.last_token_usage) {
          const usage = p.info.last_token_usage;
          lines.push({ uuid: `tokens:${when}:${usage.total_tokens || 0}`, type: 'assistant', timestamp, message: { id: `tokens:${when}`, role: 'assistant', content: [], usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 } } });
        } else if (p.type === 'error' || p.type === 'stream_error') {
          if (p.type === 'error') lines.push({ uuid: `error:${when}`, type: 'assistant', timestamp, isApiErrorMessage: true, message: { id: `error:${when}`, role: 'assistant', content: [{ type: 'text', text: String(p.message || 'Codex hit an error.') }] } });
        } else if (p.type === 'item_completed' && p.item) {
          const item = p.item;
          const text = textOf(item.content).trim();
          if (item.type === 'UserMessage' && text) lines.push({ uuid: String(item.id || `user:${when}`), type: 'user', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
          else if (item.type === 'AgentMessage' && text) lines.push({ uuid: String(item.id || `agent:${when}`), type: 'assistant', timestamp, message: { id: String(item.id || `agent:${when}`), role: 'assistant', content: [{ type: 'text', text }] } });
        }
        continue;
      }
      if (line.type !== 'response_item') continue;
      if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'web_search_call') {
        const callId = String(p.call_id || p.id || `call:${when}`);
        let tools;
        if (p.type === 'custom_tool_call' && p.name === 'exec') tools = scriptTools(String(p.input || ''));
        else if (p.type === 'custom_tool_call') tools = namedTool(p.name, p.name === 'apply_patch' ? String(p.input || '') : parse(p.input) || {});
        else if (p.type === 'local_shell_call') tools = namedTool('local_shell', p.action || {});
        else if (p.type === 'web_search_call') tools = namedTool('web_search', p.action || {});
        else tools = namedTool(String(p.name || 'tool'), typeof p.arguments === 'string' ? parse(p.arguments) || {} : p.arguments || {});
        const ids = tools.map((_t, i) => (i ? `${callId}#${i}` : callId));
        calls.set(callId, ids);
        lines.push({ uuid: `call:${callId}`, type: 'assistant', timestamp, message: { id: `call:${callId}`, role: 'assistant', content: tools.map((tool, i) => ({ type: 'tool_use', id: ids[i], name: tool.name, input: tool.input })) } });
        tools.forEach((tool, i) => event('PreToolUse', { tool: tool.name, toolId: ids[i], ...hookDetail(tool) }));
        // A web search comes back with its call: done at once.
        if (p.type === 'web_search_call') {
          lines.push({ uuid: `result:${callId}`, type: 'user', timestamp, message: { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '' })) } });
          ids.forEach((toolId) => event('PostToolUse', { toolId }));
          calls.delete(callId);
        }
        continue;
      }
      if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const callId = String(p.call_id || '');
        const ids = calls.get(callId) || [callId];
        calls.delete(callId);
        const text = outputText(p.output);
        const isError = /^(aborted by user|Script failed|Error:)/i.test(text.trim());
        lines.push({ uuid: `result:${callId}`, type: 'user', timestamp, message: { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: text, is_error: isError })) } });
        ids.forEach((toolId) => event(isError ? 'PostToolUseFailure' : 'PostToolUse', { toolId }));
      }
    }
    return { lines, events };
  }

  return { convert, sessionId: () => sessionId };
}

/** A finished session's whole transcript, as Claude-shaped lines. */
function rolloutTranscript(file) {
  return file ? createConverter().convert(readRollout(file)).lines : [];
}

/** The last thing Codex said in a session ('' when it said nothing yet). */
function codexLastAnswer(sessionId, home = codexHome()) {
  const lines = rolloutTranscript(findRollout(sessionId, home));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.type !== 'assistant' || line.isApiErrorMessage) continue;
    const text = textOf(line.message.content).trim();
    if (text) return text;
  }
  return '';
}

module.exports = { codexHome, codexModels, resolveCodex, findRollout, findNewRollout, readRollout, createConverter, rolloutTranscript, codexLastAnswer, scriptTools, patchTools, FALLBACK_MODELS };
