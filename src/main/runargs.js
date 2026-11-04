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
 *  codex   interactive Codex (codexCommand): model, effort, permissions,
 *          the viewer's tools, and the first message; `resume <id>` later.
 *  shell   the chosen shell.
 * `found` holds what's installed: { claude: {file}, codex: {file, env}, shell: {file, args} }.
 */
// What a task's Claude is told about the browser (its tools come from mcpConfig).
const VIEWER_NOTE =
  'Katana (the app running you) has a browser beside this task. To show and test a web page or browser game you made (an HTML file), use the mcp__katana-viewer tools: run_app with its page, then app_screenshot, app_click, app_type, app_key, app_scroll, read_app_output, stop_app. Test pages there, not in separate browsers. read_app_output also lists errors the page logged. It only shows web pages: run anything else yourself from the shell.';

// Hierarchy mode (daemon/team.js): what each role's session may use. The
// leader plans and coordinates through the team tools and writes no code.
const ROLES = {
  task: { servers: ['katana-viewer'], disallowed: [] },
  worker: { servers: ['katana-viewer'], disallowed: [] },
  verifier: { servers: ['katana-viewer', 'katana-team'], disallowed: [] },
  leader: { servers: ['katana-team'], disallowed: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'Task'] },
};

/**
 * Sub-agents mode: one Claude Code session on Opus leads (plans, splits the
 * work, checks it) and hands every piece to a sub-agent (the Agent tool) it
 * picks for that piece: quick on Haiku, builder on Sonnet, deep on Opus. The
 * lead's model is fixed, whatever the task's model is. Passed per session
 * (--agents), never written into the project or ~/.claude.
 */
const SUBAGENTS_LEAD = 'claude-opus-5-5';
const SUBAGENT_BASE =
  'You are a sub-agent of a Claude Code session working in the user’s project. The main session gives you one piece of its work; its prompt is all you know, so read the code you need before changing it. Do the whole piece: make the edits in the style of the code around them and run the relevant tests or build when there are any. Stay inside the piece: no unrelated changes. When you finish, reply briefly to the main session: what you changed (files), how you checked it, and anything that failed or is left. If you couldn’t do it, say so plainly and why.';
const SUBAGENTS = {
  quick: {
    model: 'claude-haiku-5-5',
    description: 'Haiku. Only for super simple fixes: typos, copy, spacing, colours, alignment, renames, one-line bugs, simple config changes. Nothing that needs thinking through.',
    prompt: `${SUBAGENT_BASE}\n\nYou handle super simple fixes: make the smallest change that does it. If it turns out bigger than it looked, stop and say so rather than guess.`,
  },
  builder: {
    model: 'claude-sonnet-5-5',
    description: 'Sonnet. For hard work and logic: features, real code changes, algorithms, refactors, tests, UI that needs design.',
    prompt: `${SUBAGENT_BASE}\n\nYou handle real work and logic: features, code changes, refactors, tests. Think it through, and check it works.`,
  },
  deep: {
    model: 'claude-opus-5-5',
    description: 'Opus. For complicated systems and hard bugs: changes across many parts, architecture, concurrency and state, bugs whose cause isn’t clear, or a piece another sub-agent already failed.',
    prompt: `${SUBAGENT_BASE}\n\nYou are brought in for complicated systems and hard bugs. Understand how the parts fit and find the root cause before changing code; check your reasoning against the code and the tests.`,
  },
};

/** The --agents JSON: each sub-agent with its model (1M context window, as every session). */
const subagentDefs = () => Object.fromEntries(Object.entries(SUBAGENTS).map(([name, agent]) => [name, { ...agent, model: withLongContext(agent.model) }]));

// What the lead is told.
const SUBAGENTS_NOTE = `Sub-agents mode: you lead this task and sub-agents do the work. For each piece, pick the sub-agent (Agent tool) that fits it:
- quick (Haiku): super simple fixes: typos, copy, spacing, colours, alignment, renames, one-line bugs, simple config.
- builder (Sonnet): hard work and logic: features, real code changes, algorithms, refactors, tests.
- deep (Opus): complicated systems and hard bugs: changes across many parts, architecture, concurrency and state, a bug whose cause isn't clear, or a piece another sub-agent failed.
Use these three, not general-purpose. Read enough of the code yourself to plan, then give each sub-agent a self-contained prompt: the goal, the files and functions involved, constraints, and how to check it. Run independent pieces in parallel (several Agent calls in one message); keep pieces that touch the same files in one sub-agent. Run them in the foreground (run_in_background: false) and wait for them: the end of your turn is the task finishing. Don't set a model on the call: each sub-agent's model is fixed. Don't edit files yourself: every change goes to a sub-agent, even a one-line one (that is what quick is for). A question that needs no change you can answer yourself. Check what they report (the diff, the tests), retry a failed piece with a stronger sub-agent, and tell the user what was done and which sub-agent did it.`;

// What a Codex task is told about the viewer (Codex names MCP tools mcp__katana_viewer__…).
const CODEX_VIEWER_NOTE = VIEWER_NOTE.replace('the mcp__katana-viewer tools', 'the katana-viewer MCP tools');

/** A value for Codex's `-c key=value`, as TOML: strings and lists as JSON writes them (valid TOML), objects as inline tables. */
const toml = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.entries(value)
        .map(([key, v]) => `${key}=${toml(v)}`)
        .join(', ')}}`
    : JSON.stringify(value);

/**
 * A Codex task's terminal: interactive Codex, new or `resume <id>`, with
 * the model, effort, permissions, the app viewer's MCP server (`mcpServers`,
 * as in a Claude --mcp-config) and what it's told, all as session flags:
 * nothing is written into ~/.codex or the project.
 */
function codexCommand({ sessionId, resume, model, effort, bypass, prompt, mcpServers, note }, found) {
  if (!found.codex) return { error: 'Codex isn’t installed. Install it (npm i -g @openai/codex) and sign in, then try again.' };
  const args = resume && sessionId ? ['resume', sessionId] : [];
  // The folder is trusted (runGuard); with bypass off Codex asks in its terminal.
  if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${toml(effort)}`);
  const servers = mcpServers && typeof mcpServers === 'object' ? mcpServers : {};
  for (const [name, server] of Object.entries(servers)) {
    args.push('-c', `mcp_servers.${name}.command=${toml(server.command)}`, '-c', `mcp_servers.${name}.args=${toml(server.args || [])}`);
    if (server.env) args.push('-c', `mcp_servers.${name}.env=${toml(server.env)}`);
  }
  const told = [servers['katana-viewer'] ? CODEX_VIEWER_NOTE : '', note].filter(Boolean).join('\n\n');
  if (told) args.push('-c', `developer_instructions=${toml(told)}`);
  // (After --, a message starting with "-" is still the message.)
  if (prompt) args.push('--', prompt);
  return { file: found.codex.file, args, env: found.codex.env || {} };
}

function taskCommand({ kind, sessionId, resume, forkFrom = '', model, effort, bypass = true, prompt = '', settingsFile, mcpConfig = '', mcpServers = null, role = 'task', mode = 'single', note = '' }, found) {
  if (kind === 'shell') {
    if (!found.shell) return { error: 'No shell found.' };
    return { file: found.shell.file, args: found.shell.args || [] };
  }
  if (kind === 'codex') return codexCommand({ sessionId, resume, model, effort, bypass, prompt, mcpServers, note }, found);
  if (!found.claude) return { error: 'Claude Code not found. Install it and sign in, then restart.' };
  const { servers, disallowed } = ROLES[role] || ROLES.task;
  const args = [];
  // These take several values: the flag after them ends the list (never the prompt).
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--allowedTools', servers.map((s) => `mcp__${s}`).join(','));
  if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
  // Sub-agents mode (a task's own session only): its sub-agents, and how to route.
  const delegating = role === 'task' && mode === 'subagents';
  if (delegating) args.push('--agents', JSON.stringify(subagentDefs()));
  const told = [mcpConfig && servers.includes('katana-viewer') ? VIEWER_NOTE : '', delegating ? SUBAGENTS_NOTE : '', note].filter(Boolean).join('\n\n');
  if (told) args.push('--append-system-prompt', told);
  if (settingsFile) args.push('--settings', settingsFile);
  // A branch: a copy of another session's conversation, as this new session (`forkFrom`'s own goes on untouched).
  if (sessionId && forkFrom && !resume) args.push('--resume', forkFrom, '--fork-session', '--session-id', sessionId);
  else if (sessionId) args.push(resume ? '--resume' : '--session-id', sessionId);
  // (Sub-agents mode: the lead is always Opus.)
  const lead = delegating ? SUBAGENTS_LEAD : model;
  if (lead) args.push('--model', withLongContext(lead));
  if (effort) args.push('--effort', effort);
  // The folder is trusted (runGuard); with bypass off Claude asks in its terminal.
  if (bypass) args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
  // The first message goes after --, so one starting with "-" is still the message (Claude Code
  // reads everything after -- as its prompt). One word alone could be taken for a subcommand
  // ("update", "doctor"), and a command line through cmd.exe (the .cmd fallback) mangles text:
  // then it's typed in once its input box is up instead (tasks.js).
  const typed = prompt && (found.claude.shell || /^\S+$/.test(prompt.trim())) ? prompt : '';
  if (prompt && !typed) args.push('--', prompt);
  // Sub-agents mode: Claude Code sends an interactive session's sub-agents to the background,
  // ending the lead's turn while they work; without background tasks they run in its turn.
  const env = delegating ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : undefined;
  const all = [...(found.claude.args || []), ...args];
  // Only a .cmd wrapper we couldn't see through: run by cmd.exe, every argument escaped for it.
  const command = found.claude.shell ? { file: process.env.ComSpec || 'cmd.exe', args: cmdLine(found.claude.file, all) } : { file: found.claude.file, args: all };
  return { ...command, ...(env ? { env } : {}), ...(typed ? { typed } : {}) };
}

// cmd.exe's special characters, escaped with ^ (as cross-spawn does).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a program cmd.exe starts: quoted for the program, then escaped for cmd (twice through a .cmd wrapper's %*). No line breaks: cmd ends the command there. */
function cmdArg(value, wrapper = true) {
  let arg = String(value ?? '').replace(/[\r\n]+/g, ' ');
  // (Backslashes before a quote, or at the end, are doubled: the program reads them as escapes there.)
  arg = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  arg = `"${arg}"`.replace(CMD_META, '^$1');
  return wrapper ? arg.replace(CMD_META, '^$1') : arg;
}

/** The arguments of `cmd.exe` running `file` with `args`, as one command line (node-pty and spawn take it as is). */
function cmdLine(file, args) {
  const program = path.normalize(String(file)).replace(CMD_META, '^$1');
  return `/d /s /c "${[program, ...args.map((arg) => cmdArg(arg))].join(' ')}"`;
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

module.exports = { runArgs, taskCommand, runGuard, killCommand, cmdLine, cmdArg, ROLES, SUBAGENTS, SUBAGENTS_LEAD, subagentDefs };
