#!/usr/bin/env node
/**
 * Stress run: Katana with many fake Claude sessions working at once
 * (scripts/fake-claude.cjs, so it costs nothing), measured phase by phase
 * (scripts/stress-look.cjs). Uses a throwaway data folder, never yours.
 *
 *   node scripts/stress.mjs [--tasks 10] [--secs 12] [--pace 3] [--out dir] [--label name]
 *
 * Prints a table and writes <out>/<label>.json; screenshots of each phase go to <out>/<label>/.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const label = arg('label', 'run');
const outDir = path.resolve(arg('out', path.join(os.tmpdir(), 'katana-stress')));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-stress-'));
const proj = path.join(scratch, 'project');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(outDir, label), { recursive: true });

const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  XODE2_TEST: 'look',
  XODE2_USERDATA: path.join(scratch, 'userdata'),
  XODE2_LOOK: path.join(root, 'scripts', 'stress-look.cjs'),
  XODE2_OUT: path.join(outDir, label),
  XODE2_FAKE_CLAUDE: path.join(root, 'scripts', 'fake-claude.cjs'),
  XODE2_FAKE_PACE: arg('pace', '3'),
  XODE2_FAKE_STEPS: arg('steps', '6'),
  STRESS_TASKS: arg('tasks', '10'),
  STRESS_SECS: arg('secs', '12'),
  STRESS_PROJ: proj,
});
// --profile: a CPU profile (.cpuprofile, opens in DevTools) of each phase, next to the screenshots.
if (process.argv.includes('--profile')) env.STRESS_PROFILE = path.join(outDir, label);
// --diag: extra phases that switch things off, to see what they cost.
if (process.argv.includes('--diag')) env.STRESS_DIAG = '1';

const phases = [];
const info = [];
const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.startsWith('STRESS ')) {
      const phase = JSON.parse(line.slice(7));
      phases.push(phase);
      const p = phase.procs || {};
      console.log(`${phase.phase.padEnd(15)} fps ${String(phase.fps).padStart(5)}  p95 ${String(phase.p95).padStart(5)}ms  p99 ${String(phase.p99).padStart(5)}ms  max ${String(phase.maxFrame).padStart(6)}ms  janky ${String(phase.janky).padStart(3)}  long ${String(phase.longTasks).padStart(3)}/${String(phase.longMs).padStart(5)}ms  heap ${phase.heapMB}MB  dom ${phase.dom}  cpu main ${p.main?.cpu ?? '-'}% rend ${p.renderer?.cpu ?? '-'}% gpu ${p.gpu?.cpu ?? '-'}%  mem rend ${p.renderer?.memMB ?? '-'}MB`);
      const m = phase.main || {};
      console.log(`${''.padEnd(15)} page thread per s: busy ${m.taskMs}ms  js ${m.scriptMs}ms  style ${m.styleMs}ms (${m.styles}x)  layout ${m.layoutMs}ms (${m.layouts}x)${phase.scene ? `  scene ${phase.scene.fps}fps ${phase.scene.msPerFrame}ms/frame (${phase.scene.where})` : ''}`);
    } else if (line.startsWith("STRESS_INFO") || line.startsWith("LOOK_")) {
      info.push(line);
      console.log(line);
    }
  }
});
child.stderr.on('data', () => {});
child.on('exit', (code) => {
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), phases, info }, null, 2));
  console.log(`report: ${path.join(outDir, `${label}.json`)}  (exit ${code})`);
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* a process still holds a file: left in temp */
  }
});
