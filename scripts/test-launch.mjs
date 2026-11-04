// How a Claude task's first message reaches it (runargs.js) and how claude is found and run
// behind a .cmd wrapper (claude.js): a message starting with "-" stays the message, and
// cmd.exe never reads & | % ^ in one.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { taskCommand, cmdLine } = require('../src/main/runargs.js');
const { shimTarget } = require('../src/main/claude.js');

const found = { claude: { file: 'C:/claude.exe' } };

{
  // The first message after --: one starting with "-" is still the message.
  const dashed = taskCommand({ kind: 'claude', sessionId: 's1', prompt: '--help me fix the tests', settingsFile: 'h.json' }, found);
  assert.deepEqual(dashed.args.slice(-2), ['--', '--help me fix the tests']);
  assert.equal(dashed.typed, undefined);
  // One word alone could be read as a subcommand ("update"): typed in once its input box is up.
  const word = taskCommand({ kind: 'claude', sessionId: 's1', prompt: 'update', settingsFile: 'h.json' }, found);
  assert.ok(!word.args.includes('update') && !word.args.includes('--'));
  assert.equal(word.typed, 'update');
  // No message: nothing after the flags.
  assert.ok(!taskCommand({ kind: 'claude', sessionId: 's1', settingsFile: 'h.json' }, found).args.includes('--'));
  // What goes first (node and cli.js, an older install behind a wrapper).
  const viaNode = taskCommand({ kind: 'claude', sessionId: 's1', prompt: 'fix it' }, { claude: { file: 'C:/node.exe', args: ['C:/cc/cli.js'] } });
  assert.equal(viaNode.file, 'C:/node.exe');
  assert.equal(viaNode.args[0], 'C:/cc/cli.js');
  // A wrapper we can't see through: cmd.exe runs it, and the message is typed in, not passed.
  const shell = taskCommand({ kind: 'claude', sessionId: 's1', prompt: 'fix a & b | c %PATH% ^x', settingsFile: 'h.json' }, { claude: { file: 'C:/x/claude.cmd', shell: true } });
  assert.match(shell.file, /cmd\.exe$/i);
  assert.equal(typeof shell.args, 'string');
  assert.ok(!shell.args.includes('fix a'));
  assert.equal(shell.typed, 'fix a & b | c %PATH% ^x');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-launch-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

{
  // npm's wrapper: what it really runs, found without cmd.exe.
  const dir = path.join(root, 'npm');
  const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  assert.deepEqual(shimTarget(path.join(dir, 'claude.cmd')), { file: exe, args: [] });
  assert.equal(shimTarget(path.join(dir, 'missing.cmd')), null);
}

if (process.platform === 'win32') {
  // Through cmd.exe and a .cmd wrapper's %*, every argument arrives as it was.
  const echo = path.join(root, 'echo-args.cjs');
  fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const wrapper = path.join(root, 'wrap me.cmd');
  fs.writeFileSync(wrapper, `@"${process.execPath}" "${echo}" %*\r\n`);
  const args = ['--append-system-prompt', 'a & b | c > d < e', '100% sure %PATH% %%', '^caret^', 'say "hi" (now)!', 'back\\slash\\', '-dash', '{"json":"x, y; z"}', '', 'one,two;three', "it's *fine*?"];
  const out = spawnSync(process.env.ComSpec || 'cmd.exe', [cmdLine(wrapper, args)], { windowsVerbatimArguments: true, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), args);
}

console.log('launch ok');
