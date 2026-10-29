import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runArgs, taskCommand, runGuard } = require('../src/main/runargs.js');

{
  // the agent: our instructions, a reader's tools, resumed by id
  const args = runArgs({ managerPromptFile: 'C:/u/agent.md', model: 'm', effort: 'low', sessionId: 'abc' });
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], 'C:/u/agent.md');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,WebSearch,WebFetch');
  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
  assert.ok(!args.includes('bypassPermissions'));
  assert.ok(!args.includes('--mcp-config'));
  // Katana's turns run with the 1M context window too, whichever model; never twice.
  const modelOf = (a) => a[a.indexOf('--model') + 1];
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.equal(modelOf(runArgs({ managerPromptFile: 'a.md', model })), `${model}[1m]`);
  assert.equal(modelOf(runArgs({ managerPromptFile: 'a.md', model: 'opus[1m]' })), 'opus[1m]');
}

{
  // with the app's tools (MCP), the folders she may read, and bypass: commands and edits too
  const args = runArgs({ managerPromptFile: 'a.md', mcpConfig: 'C:/u/katana-mcp.json', dirs: ['C:/code/shop', 'C:/code/site'], bypass: true, sessionId: 's' });
  assert.equal(args[args.indexOf('--mcp-config') + 1], 'C:/u/katana-mcp.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.match(args[args.indexOf('--allowedTools') + 1], /^mcp__katana,Read,.*Bash,Edit,Write$/);
  assert.match(args[args.indexOf('--tools') + 1], /Bash/);
  assert.ok(args.includes('bypassPermissions'));
  const dir = args.indexOf('--add-dir');
  assert.deepEqual(args.slice(dir + 1, dir + 3), ['C:/code/shop', 'C:/code/site']);
  // --add-dir takes several values: the next flag ends them.
  assert.equal(args[dir + 3], '--resume');
}

{
  // a Claude task: hooks settings, its own session id, then the first message last
  const found = { claude: { file: 'C:/claude.exe' }, codex: null, shell: { file: 'pwsh.exe', args: ['-NoLogo'] } };
  const fresh = taskCommand({ kind: 'claude', sessionId: 's1', model: 'm', effort: 'high', prompt: 'fix it', settingsFile: 'h.json' }, found);
  assert.equal(fresh.file, 'C:/claude.exe');
  assert.equal(fresh.args[fresh.args.indexOf('--settings') + 1], 'h.json');
  assert.equal(fresh.args[fresh.args.indexOf('--session-id') + 1], 's1');
  assert.ok(fresh.args.includes('bypassPermissions'));
  assert.equal(fresh.args.at(-1), 'fix it');
  const again = taskCommand({ kind: 'claude', sessionId: 's1', resume: true, bypass: false }, found);
  assert.equal(again.args[again.args.indexOf('--resume') + 1], 's1');
  assert.ok(!again.args.includes('bypassPermissions'));
  // Every model gets the 1M context window, new or resumed, Haiku too.
  const modelOf = (r) => r.args[r.args.indexOf('--model') + 1];
  assert.equal(modelOf(taskCommand({ kind: 'claude', sessionId: 's1', model: 'claude-opus-5-5' }, found)), 'claude-opus-5-5[1m]');
  assert.equal(modelOf(taskCommand({ kind: 'claude', sessionId: 's1', resume: true, model: 'claude-sonnet-5-5' }, found)), 'claude-sonnet-5-5[1m]');
  assert.equal(modelOf(taskCommand({ kind: 'claude', sessionId: 's1', model: 'opus[1m]' }, found)), 'opus[1m]');
  assert.equal(modelOf(taskCommand({ kind: 'claude', sessionId: 's1', model: 'claude-haiku-5-5' }, found)), 'claude-haiku-5-5[1m]');
  assert.match(taskCommand({ kind: 'codex', prompt: 'x' }, found).error, /Codex/);
  assert.deepEqual(taskCommand({ kind: 'shell' }, found), { file: 'pwsh.exe', args: ['-NoLogo'] });
  assert.match(taskCommand({ kind: 'claude' }, { ...found, claude: null }).error, /Claude Code not found/);
}

// runGuard refuses an untrusted cwd.
assert.equal(runGuard({ role: 'worker', cwd: 'C:\\Code\\Shop' }, ['c:\\code\\shop']), null);
assert.match(runGuard({ role: 'worker', cwd: 'C:\\Code\\Other' }, ['C:\\Code\\Shop']), /not a trusted folder/);
assert.equal(runGuard({ role: 'worker', cwd: 'C:\\Code\\Shop\\sub' }, ['C:\\Code\\Shop']), null);
assert.match(runGuard({ role: 'worker', cwd: 'C:\\Code\\Shopping' }, ['C:\\Code\\Shop']), /not a trusted folder/);
assert.match(runGuard({ role: 'worker', cwd: '' }, ['C:\\Code\\Shop']), /not a trusted folder/);
assert.equal(runGuard({ role: 'agent', cwd: 'anything' }, []), null);

// A drive root is a folder like any other; "C:" alone means "wherever the app is on C".
assert.equal(runGuard({ role: 'worker', cwd: 'C:\\' }, ['C:\\']), null);
assert.equal(runGuard({ role: 'worker', cwd: 'C:\\code' }, ['C:\\']), null);
assert.match(runGuard({ role: 'worker', cwd: 'C:' }, ['C:']), /not a trusted folder/);
assert.match(runGuard({ role: 'worker', cwd: 'code\\shop' }, ['C:\\code\\shop']), /not a trusted folder/);

// Stopping ends the whole process tree (commands a worker started too).
{
  const { killCommand } = require('../src/main/runargs.js');
  assert.deepEqual(killCommand(1234, 'win32'), ['taskkill', ['/pid', '1234', '/T', '/F']]);
  assert.equal(killCommand(1234, 'linux'), null);
}

// An unreadable state file is set aside, never overwritten.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readStateFile } = require('../src/main/statefile.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-'));
  const file = path.join(dir, 'state.json');
  assert.equal(readStateFile(file), null);
  fs.writeFileSync(file, '{"version":1,"projects":[]}');
  assert.deepEqual(readStateFile(file), { version: 1, projects: [] });
  fs.writeFileSync(file, '{"version":1,"proj');
  assert.equal(readStateFile(file), null);
  const kept = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.unreadable-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"version":1,"proj');
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // a Claude task with the app viewer's tools: its MCP config, allowed, told about them; the prompt still last
  const found = { claude: { file: 'C:/claude.exe' } };
  const args = taskCommand({ kind: 'claude', sessionId: 's1', prompt: 'build the game', settingsFile: 'h.json', mcpConfig: 'C:/u/viewer/t1.json' }, found).args;
  assert.equal(args[args.indexOf('--mcp-config') + 1], 'C:/u/viewer/t1.json');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__katana-viewer');
  // both take several values: the next thing after each value is a flag
  assert.match(args[args.indexOf('--mcp-config') + 2], /^--/);
  assert.match(args[args.indexOf('--allowedTools') + 2], /^--/);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /app_screenshot/);
  assert.equal(args.at(-1), 'build the game');
  // without one, none of it
  assert.ok(!taskCommand({ kind: 'claude', prompt: 'x' }, found).args.includes('--mcp-config'));
}

{
  // hierarchy mode: the leader gets the team tools, its role note, and no tools that write code
  const found = { claude: { file: 'C:/claude.exe' } };
  const leader = taskCommand({ kind: 'claude', role: 'leader', note: 'You are the Leader.', sessionId: 's1', model: 'claude-sonnet-5-5', prompt: 'add login', settingsFile: 'h.json', mcpConfig: 'C:/u/team/t1.json' }, found).args;
  assert.equal(leader[leader.indexOf('--allowedTools') + 1], 'mcp__katana-team');
  assert.match(leader[leader.indexOf('--disallowedTools') + 1], /^Edit,.*Write.*Bash/);
  assert.match(leader[leader.indexOf('--disallowedTools') + 2], /^--/);
  const told = leader[leader.indexOf('--append-system-prompt') + 1];
  assert.equal(told, 'You are the Leader.'); // no viewer tools, so not told about them
  assert.equal(leader[leader.indexOf('--model') + 1], 'claude-sonnet-5-5[1m]');
  assert.equal(leader.at(-1), 'add login');
  // a verifier: the viewer and its verdict tool, told both
  const verifier = taskCommand({ kind: 'claude', role: 'verifier', note: 'Check it.', sessionId: 's2', prompt: 'check', settingsFile: 'h.json', mcpConfig: 'C:/u/team/v1.json' }, found).args;
  assert.equal(verifier[verifier.indexOf('--allowedTools') + 1], 'mcp__katana-viewer,mcp__katana-team');
  assert.ok(!verifier.includes('--disallowedTools'));
  assert.match(verifier[verifier.indexOf('--append-system-prompt') + 1], /app_screenshot[\s\S]*Check it\./);
  // a worker is a normal task session with the viewer
  const worker = taskCommand({ kind: 'claude', role: 'worker', sessionId: 's3', prompt: 'do it', settingsFile: 'h.json', mcpConfig: 'C:/u/viewer/w1.json' }, found).args;
  assert.equal(worker[worker.indexOf('--allowedTools') + 1], 'mcp__katana-viewer');
  assert.equal(worker.at(-1), 'do it');
}

console.log('runargs ok');
