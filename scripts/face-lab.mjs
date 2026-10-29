// Opens Katana's face lab (src/renderer/face-lab.html) in a test run, with a
// throwaway data folder: `node scripts/face-lab.mjs` (add `app` for the whole
// app in test mode instead). Never touches your real data.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env, XODE2_TEST: process.env.XODE2_TEST || '1', XODE2_USERDATA: process.env.XODE2_USERDATA || mkdtempSync(join(tmpdir(), 'katana-face-')) };
// This shell may run Electron as Node; the app needs it as itself.
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv[2] !== 'app') env.XODE2_DEVPAGE = 'face-lab';
console.log(`data: ${env.XODE2_USERDATA}`);
const child = spawn(electron, [root], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
