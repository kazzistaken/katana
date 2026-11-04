/**
 * The commands a task's session understands, for the / menu in the prompt bar.
 * Checked against the installed programs' own menus (Claude Code 2.1.316, Codex 0.166.0); your own
 * commands and skills come from main (slashcommands.js). A command is typed into
 * the session like anything else, so one that isn't here still works if you type it.
 *
 * `opens`: with nothing after its name it draws a picker or panel in the terminal,
 * which is where you then are; the others answer in the chat. `needs`: it does
 * nothing without what comes after its name. Pure, so scripts/test-slashcommands.mjs
 * runs it under Node.
 */

const cmd = (name, about, { hint = '', opens = false, aliases = [], needs = false, note = '' } = {}) => ({ name, about, hint, opens, aliases, needs, note });
const panel = (name, about, options = {}) => cmd(name, about, { opens: true, ...options });

export const CLAUDE_COMMANDS = [
  cmd('add-dir', "Add a new working directory", { hint: '<path>', needs: true }),
  panel('advisor', "Let Claude consult a stronger model at key moments"),
  panel('agents', "(removed) Ask Claude to create/manage subagents, or edit .claude/agents/"),
  panel('artifacts', "Browse your published and shared artifacts"),
  cmd('auto-mode-setup', "Teach auto mode about your environment, plus optional rule tweaks"),
  panel('autocompact', "Set how full the context gets before auto-summarizing", { hint: '[auto|<tokens>]' }),
  panel('autofix-pr', "Monitor and autofix any issues with the current PR"),
  panel('background', "Send this session to the background and free the terminal", { hint: '[prompt]', aliases: ['bg'] }),
  cmd('batch', "Plan a large change; background agents each open a PR", { hint: '<instruction>', needs: true }),
  panel('branch', "Create a branch of the current conversation at this point", { hint: '[name]' }),
  cmd('btw', "Ask a quick side question without interrupting the main conversation", { hint: '<question>', needs: true }),
  panel('cd', "Move this session to a new working directory", { hint: '[path]' }),
  panel('chrome', "Open Claude in Chrome settings"),
  cmd('claude-api', "Build and debug apps that use the Claude API"),
  cmd('clear', "Start a new session with empty context; previous session stays on disk (resumable with /resume)", { aliases: ['reset', 'new'] }),
  cmd('code-review', "3 free /ultrareview · Review the current diff or a PR for bugs and cleanups", { hint: '[level] [target]' }),
  panel('color', "Set the prompt bar color for this session", { hint: '[name]' }),
  cmd('compact', "Free up context by summarizing the conversation so far", { hint: '[instructions]', note: 'Compacting. This can take a minute; the result appears here.' }),
  panel('config', "Open settings", { aliases: ['settings'] }),
  cmd('context', "Visualize current context usage as a colored grid", { hint: '[all]' }),
  cmd('copy', "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)", { hint: '[N]' }),
  cmd('dataviz', "Chart and dashboard design guidance"),
  cmd('debug', "Turn on debug logging and investigate problems"),
  panel('design', "Make a new Design artifact from a brief"),
  panel('design-consent', "Grant Claude agent access to your Design projects"),
  panel('design-login', "Authorize design-system access for /design-sync with your claude.ai account"),
  panel('design-revoke', "Revoke Claude agent access to your Design projects"),
  panel('design-sync', "Push your design system components to claude.ai/design"),
  panel('desktop', "Continue the current session in Claude Desktop", { aliases: ['app'] }),
  panel('diff', "Toggle the diff panel showing uncommitted changes"),
  panel('doctor', 'Check your Claude Code installation'),
  panel('effort', "Set effort level for model usage", { hint: '[level]' }),
  cmd('exit', "Exit the CLI", { aliases: ['quit'] }),
  panel('export', "Export the current conversation to a file or clipboard", { hint: '[filename]' }),
  cmd('fast', "Toggle fast mode (Opus 5.5)"),
  panel('feedback', "Send feedback to Anthropic or report a bug", { hint: '[report]', aliases: ['bug', 'share'] }),
  cmd('fewer-permission-prompts', "Pre-approve safe read-only commands based on your usage"),
  cmd('focus', "Toggle focus view: just your prompt, summary, and response"),
  panel('fork', "Copy this conversation into a new background session and keep working here", { hint: '[name]' }),
  panel('goal', "Set a goal Claude checks before stopping", { hint: '[<condition>|clear]' }),
  panel('help', "Show help and available commands"),
  panel('hooks', "View hook configurations for tool events"),
  panel('ide', "Manage IDE integrations and show status"),
  panel('import', "Import config from another AI coding agent", { hint: '[codex|gemini|cursor]' }),
  cmd('init', "Initialize a new CLAUDE.md file with codebase documentation"),
  cmd('insights', "Generate a report analyzing your Claude Code sessions"),
  panel('install-github-app', "Set up Claude GitHub Actions for a repository"),
  panel('install-slack-app', "Install the Claude Slack app"),
  panel('keybindings', "Open your keyboard shortcuts file"),
  cmd('list-agents', "List subagents, teammates, and other Claude sessions you can message", { aliases: ['peers'] }),
  panel('login', "Sign in with your Anthropic account"),
  panel('logout', "Sign out from your Anthropic account"),
  cmd('loop', "Repeat a prompt or command on an interval (e.g. /loop 5m /foo)", { hint: '[interval] <prompt>' }),
  panel('mcp', "Manage MCP servers", { hint: '[reconnect|enable|disable]' }),
  panel('memory', "Edit CLAUDE.md files and memory settings"),
  panel('mobile', "Show QR code to download the Claude mobile app", { aliases: ['ios', 'android'] }),
  panel('model', "Set the AI model for Claude Code (currently Opus 5.5)", { hint: '[model]' }),
  panel('output-style', "List output styles or switch to one", { hint: '[style]' }),
  panel('passes', "Share a free week of Claude Code with friends and earn usage credits"),
  panel('permissions', "Manage allow and deny tool permission rules", { aliases: ['allowed-tools'] }),
  panel('plan', "Enable plan mode or view the current session plan", { hint: '[open|<description>]' }),
  panel('plugin', "(plugins) Manage Claude Code plugins", { aliases: ['plugins', 'marketplace'] }),
  panel('powerup', "Discover Claude Code features through quick interactive lessons"),
  panel('privacy-settings', "View and update your privacy settings"),
  panel('radio', "Listen to Claude FM lo-fi radio"),
  cmd('recap', "Generate a one-line session recap now"),
  panel('release-notes', "View release notes"),
  cmd('reload-plugins', "Activate pending plugin changes in the current session", { hint: '[--force]' }),
  cmd('reload-skills', "Pick up skills added or changed on disk during this session", { hint: '[--force]' }),
  panel('remote-control', "Control this session from your phone or claude.ai/code", { aliases: ['rc'] }),
  panel('remote-env', "Choose the default environment for cloud agents"),
  cmd('rename', "Rename the current conversation", { hint: '[name]' }),
  panel('resume', "Resume a previous conversation", { hint: '[name]', aliases: ['continue'] }),
  panel('rewind', "Restore the code and/or conversation to a previous point", { aliases: ['checkpoint', 'undo'] }),
  cmd('run', "Launch this project’s app to see your change working"),
  cmd('schedule', "Create and manage routines: cloud agents on a schedule"),
  panel('scroll-speed', "Adjust mouse wheel scroll speed"),
  cmd('security-review', "Complete a security review of the pending changes on the current branch"),
  panel('setup-bedrock', "Reconfigure Amazon Bedrock authentication, region, or model pins"),
  panel('setup-vertex', "Reconfigure Google Vertex AI authentication, project, region, or model pins"),
  cmd('simplify', "Clean up the changed code without changing behavior"),
  panel('skill-doctor', "Show which loaded skills are unused and costing context"),
  panel('skills', "List available skills"),
  panel('status', "Show Claude Code status including version, model, account, API connectivity, and tool statuses"),
  cmd('statusline', "Set up Claude Code's status line UI"),
  panel('stickers', "Order Claude Code stickers"),
  cmd('subtask', "Send a subagent off with your full context; its result comes back here", { hint: '<directive>', needs: true }),
  panel('tasks', "View and manage everything running in the background", { aliases: ['bashes'] }),
  cmd('team-onboarding', "Help teammates ramp on Claude Code with a guide from your usage"),
  panel('teleport', "Send this session to the cloud, or resume one from claude.ai", { aliases: ['tp'] }),
  panel('terminal-setup', "Install Shift+Enter key binding for newlines"),
  panel('theme', "Change the theme"),
  panel('tui', "Set the terminal UI renderer (default | fullscreen)", { hint: '[default|fullscreen]' }),
  panel('ultrareview', 'Deep multi-agent review in the cloud'),
  cmd('update-config', "Change settings: hooks, permissions, environment variables"),
  panel('upgrade', "Upgrade to Max for higher rate limits and more Opus"),
  panel('usage', "Show session cost, plan usage, and activity stats", { aliases: ['cost', 'stats'] }),
  panel('usage-credits', "Configure usage credits or request them from your admin when you hit a limit"),
  cmd('verify', "Try your change and report if it works"),
  panel('voice', "Toggle voice mode", { hint: '[hold|tap|off]' }),
  panel('web-setup', "Set up cloud sessions with your GitHub account"),
  panel('workflows', "Browse running and completed workflows"),
];

// (Codex keeps no record of commands that the chat can read: they all show in its terminal.)
export const CODEX_COMMANDS = [
  panel('clear', "Clear the terminal and start a new chat"),
  panel('compact', "Summarize conversation to prevent hitting the context limit"),
  panel('copy', "Copy the last response or part of it"),
  panel('diff', "Show git diff (including untracked files)"),
  panel('exit', "Exit Codex", { aliases: ['quit'] }),
  panel('experimental', "Toggle experimental features"),
  panel('feedback', "Send logs to maintainers"),
  panel('fork', "Fork the current chat"),
  panel('goal', "Set or view the goal for a long-running task"),
  panel('hooks', "View and manage lifecycle hooks"),
  panel('ide', "Include current selection, open files, and other context from your IDE"),
  panel('init', "- create an AGENTS.md file with instructions for Codex"),
  panel('model', "- choose what model and reasoning effort to use"),
  panel('permissions', "- choose what Codex is allowed to do"),
  panel('plan', "Switch to Plan mode"),
  panel('plugins', "Browse plugins"),
  panel('ps', "List background terminals"),
  panel('rename', "Rename the current thread"),
  panel('resume', "Resume a saved chat"),
  panel('review', "- review any changes and find issues"),
  panel('skills', "Use skills to improve how Codex performs specific tasks"),
  panel('status', "- show current session configuration"),
  panel('statusline', "Configure which items appear in the status line"),
  panel('theme', "Choose a syntax highlighting theme"),
  panel('title', "Configure which items appear in the terminal title"),
  panel('usage', "View account usage or use a usage limit reset"),
  panel('voice', "Start or stop voice; use /voice settings to choose a voice", { hint: '[settings]' }),
];

/** The commands for a kind of task, with your own after the built-in ones. */
export function commandsFor(kind, own = []) {
  if (kind === 'codex') return CODEX_COMMANDS;
  if (kind !== 'claude') return [];
  const known = new Set(CLAUDE_COMMANDS.map((c) => c.name));
  return [...CLAUDE_COMMANDS, ...own.filter((c) => !known.has(c.name)).map((c) => cmd(c.name, c.about || 'Your command', { hint: c.hint || '' }))];
}

/** What the bar holds is a command still being named: the text after its /, else null. */
export const namingCommand = (text) => /^\/([\w:-]*)$/.exec(String(text || ''))?.[1] ?? null;

/** Commands matching what's been typed, best first: the start of its name, a word in it, an alias, then its description. */
export function matchCommands(commands, typed) {
  const q = String(typed || '').toLowerCase();
  if (!q) return commands;
  const score = (c) => {
    if (c.name === q || c.aliases.includes(q)) return 0;
    if (c.name.startsWith(q)) return 1;
    if (c.aliases.some((a) => a.startsWith(q))) return 2;
    if (c.name.split(/[:-]/).some((part) => part.startsWith(q))) return 3;
    if (c.name.includes(q)) return 4;
    if (q.length > 3 && c.about.toLowerCase().includes(q)) return 5;
    return -1;
  };
  return commands
    .map((c) => [score(c), c])
    .filter(([s]) => s >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .map(([, c]) => c);
}

/** What a message means if it's a command: { command, args }, or null. (A path like /home/me/x isn't one.) */
export function readCommand(text, commands) {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*\S))?\s*$/.exec(String(text || '').trim());
  if (!match) return null;
  const command = commands.find((c) => c.name === match[1] || c.aliases.includes(match[1]));
  return command ? { command, args: match[2] || '' } : null;
}

/** Does sending this leave a picker or panel in the terminal for you to use? (With what it needs given, it just does it.) */
export const opensTerminal = (read) => Boolean(read?.command.opens && !read.args);
