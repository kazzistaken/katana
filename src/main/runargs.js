'use strict';

/**
 * What a hidden Claude turn is started with, and whether it may run at all.
 * Pure (no Electron), so scripts/test-runargs.mjs checks it under Node.
 */

const path = require('node:path');

// A normal agent's own tools for Katana: reading, searching and the web; with
// bypass on, also commands and edits, as a task has.
const AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const AGENT_TOOLS_BYPASS = [...AGENT_TOOLS, 'Bash', 'Edit', 'Write'];

/** Every Claude session (Katana's turns and tasks, any model) runs with the 1M-token context window (`[1m]`). */
const withLongContext = (model) => (/\[1m\]$/i.test(model) ? model : `${model}[1m]`);

/**
 * Arguments for one hidden `claude -p` turn of Katana: our instructions
 * file, the app's tools (mcp-app.cjs, from `mcpConfig`) and a normal
 * agent's, the trusted folders she may read (`dirs`), resumed by id.
 */
function runArgs({ model, effort, sessionId, managerPromptFile, mcpConfig = '', dirs = [], bypass = false }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) args.push('--model', withLongContext(model));
  if (effort) args.push('--effort', effort);
  args.push('--system-prompt-file', managerPromptFile, '--setting-sources', 'project');
  const builtins = bypass ? AGENT_TOOLS_BYPASS : AGENT_TOOLS;
  args.push('--tools', builtins.join(','));
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  args.push('--allowedTools', [...(mcpConfig ? ['mcp__katana'] : []), ...builtins].join(','));
  if (bypass) args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
  if (dirs.length) args.push('--add-dir', ...dirs);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}


/**
 * What a task's terminal runs.
 *  claude  interactive Claude Code: our hooks settings, its own session id
 *          (or --resume), model, effort, permissions, and the first message.
 *  codex   the Codex CLI with the first message.
 *  shell   the chosen shell.
 * `found` holds what's installed: { claude: {file}, codex: path, shell: {file, args} }.
 */
// What a task's Claude is told about the app viewer (its tools come from mcpConfig).
const VIEWER_NOTE =
  'Katana (the app running you) has an app viewer beside this task. To run and test the app you are working on, or a web page or browser game you made, use the mcp__katana-viewer tools: run_app, app_screenshot, app_click, app_type, app_key, app_scroll, read_app_output, stop_app. Test there, not in separate windows or browsers. read_app_output also lists errors the app logged.';

// Hierarchy mode (daemon/team.js): what each role's session may use. The
// leader plans and coordinates through the team tools and writes no code.
const ROLES = {
  task: { servers: ['katana-viewer'], disallowed: [] },
  worker: { servers: ['katana-viewer'], disallowed: [] },
  verifier: { servers: ['katana-viewer', 'katana-team'], disallowed: [] },
  leader: { servers: ['katana-team'], disallowed: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'Task'] },
};

function taskCommand({ kind, sessionId, resume, model, effort, bypass = true, prompt = '', settingsFile, mcpConfig = '', role = 'task', note = '' }, found) {
  if (kind === 'shell') {
    if (!found.shell) return { error: 'No shell found.' };
    return { file: found.shell.file, args: found.shell.args || [] };
  }
  if (kind === 'codex') {
    if (!found.codex) return { error: 'Codex isn’t installed. Install it (npm i -g @openai/codex) and sign in, then try again.' };
    return { file: found.codex, args: prompt ? [prompt] : [] };
  }
  if (!found.claude) return { error: 'Claude Code not found. Install it and sign in, then restart.' };
  const { servers, disallowed } = ROLES[role] || ROLES.task;
  const args = [];
  // These take several values: the flag after them ends the list (never the prompt).
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--allowedTools', servers.map((s) => `mcp__${s}`).join(','));
  if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
  const told = [mcpConfig && servers.includes('katana-viewer') ? VIEWER_NOTE : '', note].filter(Boolean).join('\n\n');
  if (told) args.push('--append-system-prompt', told);
  if (settingsFile) args.push('--settings', settingsFile);
  if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);
  if (model) args.push('--model', withLongContext(model));
  if (effort) args.push('--effort', effort);
  // The folder is trusted (runGuard); with bypass off Claude asks in its terminal.
  if (bypass) args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
  if (prompt) args.push(prompt);
  return { file: found.claude.file, args };
}

const normalize = (value) => {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * A full path. "C:" alone or a relative path would resolve against wherever
 * the app happens to be running, not a folder the user picked.
 */
const isFullPath = (value) => /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]/.test(value) || (process.platform !== 'win32' && value.startsWith('/'));

/** null when a task (or shell) may run here; otherwise why not. Only trusted folders. */
function runGuard({ role, cwd }, trustedPaths) {
  if (role === 'agent') return null;
  if (!cwd || !isFullPath(String(cwd))) return `${cwd || 'This folder'} is not a trusted folder.`;
  const target = normalize(cwd);
  const trusted = (trustedPaths || []).some((folder) => {
    if (!isFullPath(String(folder || ''))) return false;
    const base = normalize(folder);
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
  return trusted ? null : `${cwd} is not a trusted folder.`;
}

/**
 * How to end a turn's whole process tree on Windows, where killing the
 * process alone leaves what it started (a shim's real claude, a worker's
 * `npm test` or dev server) running unseen. null: elsewhere the turn runs
 * in its own process group and the group is killed (claude.js).
 */
function killCommand(pid, platform = process.platform) {
  return platform === 'win32' ? ['taskkill', ['/pid', String(pid), '/T', '/F']] : null;
}

module.exports = { runArgs, taskCommand, runGuard, killCommand, ROLES };
