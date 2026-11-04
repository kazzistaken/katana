// The / menu's commands (renderer slashcommands.js) and your own read from disk (main slashcommands.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CLAUDE_COMMANDS, CODEX_COMMANDS, commandsFor, namingCommand, matchCommands, readCommand, opensTerminal } from '../src/renderer/js/slashcommands.js';
import { createTranscript, exchanges } from '../src/renderer/js/transcript.js';

const require = createRequire(import.meta.url);
const { createSlashCommands } = require('../src/main/slashcommands.js');

// Every name once, and each described.
for (const list of [CLAUDE_COMMANDS, CODEX_COMMANDS]) {
  const names = list.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'no repeats');
  for (const c of list) assert.ok(c.about.length > 5, `${c.name} says what it does`);
}
const names = CLAUDE_COMMANDS.map((c) => c.name);
for (const name of ['compact', 'clear', 'model', 'context', 'resume', 'help', 'usage', 'config', 'init', 'mcp']) assert.ok(names.includes(name), name);

// Which menu.
assert.equal(commandsFor('shell').length, 0, 'a shell has its own');
assert.equal(commandsFor('codex'), CODEX_COMMANDS);
const own = [{ name: 'deploy', about: 'Ship it' }, { name: 'compact', about: 'Mine' }];
const merged = commandsFor('claude', own);
assert.ok(merged.some((c) => c.name === 'deploy'), 'yours are there');
assert.equal(merged.filter((c) => c.name === 'compact').length, 1, 'a built-in is not doubled');

// When the menu shows.
assert.equal(namingCommand('/'), '');
assert.equal(namingCommand('/com'), 'com');
assert.equal(namingCommand('/superpowers:brain'), 'superpowers:brain');
assert.equal(namingCommand('/compact now'), null, 'past the name: you are writing');
assert.equal(namingCommand('hello /com'), null, 'only at the start');
assert.equal(namingCommand('/home/me'), null, 'a path');
assert.equal(namingCommand(''), null);

// What it offers.
const first = (typed) => matchCommands(CLAUDE_COMMANDS, typed)[0]?.name;
assert.equal(matchCommands(CLAUDE_COMMANDS, '').length, CLAUDE_COMMANDS.length, 'all of them to begin with');
assert.equal(first('comp'), 'compact');
assert.equal(first('cost'), 'usage', 'by another name');
assert.equal(first('quit'), 'exit');
assert.equal(first('review').includes('review'), true);
assert.equal(matchCommands(CLAUDE_COMMANDS, 'zzzz').length, 0);
assert.ok(matchCommands(CLAUDE_COMMANDS, 'summarizing').some((c) => c.name === 'compact'), 'by what it does');

// What sending means.
assert.equal(readCommand('/compact', CLAUDE_COMMANDS).command.name, 'compact');
assert.equal(readCommand('/compact keep the plan', CLAUDE_COMMANDS).args, 'keep the plan');
assert.equal(readCommand('/cost', CLAUDE_COMMANDS).command.name, 'usage');
assert.equal(readCommand('/home/me/file fix it', CLAUDE_COMMANDS), null, 'a path is a message');
assert.equal(readCommand('fix /compact', CLAUDE_COMMANDS), null);
assert.equal(readCommand('/nosuch', CLAUDE_COMMANDS), null);
assert.equal(opensTerminal(readCommand('/model', CLAUDE_COMMANDS)), true, 'the picker');
assert.equal(opensTerminal(readCommand('/model opus', CLAUDE_COMMANDS)), false, 'told which: no picker');
assert.equal(opensTerminal(readCommand('/compact', CLAUDE_COMMANDS)), false, 'answers in the chat');
assert.equal(opensTerminal(readCommand('fix it', CLAUDE_COMMANDS)), false);

// In the chat: what was typed, and what it answered, from Claude Code's own record of them.
{
  const t = createTranscript();
  const at = '2026-11-02T10:00:00.000Z';
  const user = (content, extra = {}) => ({ type: 'user', uuid: String(Math.random()), timestamp: at, message: { role: 'user', content }, ...extra });
  t.add([
    user('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep the plan</command-args>'),
    user('<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'),
  ]);
  assert.deepEqual(t.entries.map((e) => [e.kind, e.text]), [['prompt', '/compact keep the plan'], ['text', 'Compacted (ctrl+o to see full summary)']]);
  const [ex] = exchanges(t.entries);
  assert.equal(ex.prompts[0].text, '/compact keep the plan');
  assert.equal(ex.texts[0].text, 'Compacted (ctrl+o to see full summary)');

  const u = createTranscript();
  u.add([user('<command-name>/effort</command-name><command-message>effort</command-message><command-args></command-args><local-command-stdout>Set effort to high</local-command-stdout>')]);
  assert.deepEqual(u.entries.map((e) => [e.kind, e.text]), [['prompt', '/effort'], ['text', 'Set effort to high']], 'both in one line');

  const v = createTranscript();
  v.add([
    user('<command-name>/model</command-name>'),
    user('<local-command-stdout>(no content)</local-command-stdout>'),
    user('<local-command-stdout></local-command-stdout>'),
    user('<command-message>a-skill</command-message>\n<command-name>a-skill</command-name>\n<skill-format>true</skill-format>'),
    user('<command-name>/hidden</command-name>', { isMeta: true }),
    user('<local-command-caveat>Caveat: generated</local-command-caveat>'),
  ]);
  assert.deepEqual(v.entries.map((e) => e.text), ['/model'], 'nothing to say says nothing; a skill Claude chose itself is not something you typed');
}

// The newer record of a command that needed no model: system lines, and /context's table.
{
  const t = createTranscript();
  const at = '2026-11-02T10:00:00.000Z';
  const sys = (content) => ({ type: 'system', subtype: 'local_command', uuid: String(Math.random()), timestamp: at, content });
  t.add([
    sys('<command-name>/context</command-name>\n <command-message>context</command-message>\n <command-args></command-args>'),
    sys('<local-command-stdout> \u001b[1mContext Usage\u001b[22m\n\u26c0 \u26c1 \u26c1 \u26c0 \u26f6 \u26f6</local-command-stdout>'),
    { type: 'user', uuid: 'meta', timestamp: at, isMeta: true, message: { role: 'user', content: '## Context Usage\n\n| Category | Tokens |\n|---|---|\n| System | 2.6k |' } },
    { type: 'user', uuid: 'hidden', timestamp: at, isMeta: true, message: { role: 'user', content: 'Something else for the model' } },
    sys('<command-name>/effort</command-name><command-args>low</command-args>'),
    sys('<local-command-stdout>Set effort to low</local-command-stdout>'),
    { type: 'system', subtype: 'turn_duration', uuid: 'x', timestamp: at, content: 'not a command' },
  ]);
  assert.deepEqual(t.entries.map((e) => [e.kind, e.text.split('\n')[0]]), [['prompt', '/context'], ['text', '## Context Usage'], ['prompt', '/effort low'], ['text', 'Set effort to low']]);
  const seen = t.entries.length;
  t.add([sys('<local-command-stdout>another</local-command-stdout>')]);
  assert.equal(t.entries.length, seen + 1);
}

// Yours, from disk.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-slash-'));
  const cwd = path.join(home, 'project');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(home, '.claude', 'commands', 'deploy.md'), '---\ndescription: Ship it\nargument-hint: <env>\n---\nDo it');
  write(path.join(home, '.claude', 'commands', 'git', 'tidy.md'), 'No front matter');
  write(path.join(home, '.claude', 'skills', 'writing', 'SKILL.md'), '---\nname: my-writing\ndescription: "Write well"\n---\n');
  write(path.join(home, '.claude', 'skills', 'quiet', 'SKILL.md'), '---\nname: quiet\nuser-invocable: false\n---\n');
  write(path.join(cwd, '.claude', 'commands', 'deploy.md'), '---\ndescription: This folder wins\n---\n');
  write(path.join(cwd, '.claude', 'skills', 'local', 'SKILL.md'), '---\ndescription: Only here\n---\n');
  const plugin = path.join(home, 'plug');
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"tools"}');
  write(path.join(plugin, 'skills', 'fix', 'SKILL.md'), `---\nname: fix\ndescription: ${'long '.repeat(40)}\n---\n`);
  const off = path.join(home, 'off');
  write(path.join(off, 'skills', 'nope', 'SKILL.md'), '---\nname: nope\n---\n');
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tools@m': [{ installPath: plugin }], 'off@m': [{ installPath: off }] } }));
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@m': false } }));
  const synced = path.join(home, '.claude', 'plugins', 'synced', 'account', 'abc');
  write(path.join(synced, '.claude-plugin', 'plugin.json'), '{"name":"shared"}');
  write(path.join(synced, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: From your account\n---\n');
  const list = createSlashCommands({ home })(cwd);
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(by.deploy.about, 'This folder wins');
  assert.equal(by['git:tidy'].about, '', 'a command in a folder; no description is fine');
  assert.equal(by['my-writing'].about, 'Write well');
  assert.ok(by.local, 'this folder’s skill');
  assert.ok(!by.quiet, 'not one you can call');
  assert.ok(by['tools:fix'], 'a plugin’s, under its name');
  assert.ok(by['tools:fix'].about.length <= 90, 'kept short');
  assert.ok(!by['off:nope'] && !by.nope, 'a plugin you turned off');
  assert.ok(by['shared:one'], 'synced from your account');
  assert.deepEqual(createSlashCommands({ home: path.join(home, 'nothing') })(''), [], 'nothing set up is fine');
}

console.log('slash commands ok');
