// The sidebar's collapse button and hover-to-open, in the real app with a real mouse. Throwaway data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-peek-'));
const proj = path.join(scratch, 'project');
fs.mkdirSync(proj, { recursive: true });
const env = { ...process.env, XODE2_TEST: 'look', XODE2_USERDATA: path.join(scratch, 'userdata'), XODE2_LOOK: path.join(root, 'scripts', 'sidebarpeek-look.cjs'), XODE2_OUT: process.env.PEEK_OUT || path.join(scratch, 'out'), PEEK_PROJ: proj };
delete env.ELECTRON_RUN_AS_NODE;
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const timer = setTimeout(() => child.kill(), 90000);
child.on('close', () => {
  clearTimeout(timer);
  const fail = /LOOK_FAIL[\s\S]*/.exec(out)?.[0];
  const errors = out.split('\n').filter((line) => line.startsWith('LOOK_CONSOLE') && /error/i.test(line));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (fail || !out.includes('LOOK_DONE')) {
    console.error(fail ? fail.slice(0, 1500) : out.slice(-2000) || 'no output');
    process.exit(1);
  }
  if (errors.length) console.error(errors.join('\n'));
  console.log(`sidebarpeek: ok${errors.length ? ` (${errors.length} page errors above)` : ''}`);
});
