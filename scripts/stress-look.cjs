'use strict';

/**
 * The stress run's steps (a look test; scripts/stress.mjs starts it). Fake
 * Claude sessions (fake-claude.cjs) work in many tasks at once while this
 * measures, phase by phase: frame pacing (requestAnimationFrame), long tasks,
 * the page's heap and DOM size, and CPU and memory for each of the app's
 * processes. Each phase prints `STRESS {json}`; a screenshot of each goes to
 * XODE2_OUT (to check nothing looks different after an optimization).
 */

const { app } = require('electron');

const N = Number(process.env.STRESS_TASKS) || 10;
const SECS = Number(process.env.STRESS_SECS) || 12;
const PROJ = process.env.STRESS_PROJ;

// Runs in the page: frame times and long tasks while a phase is measured.
const PROBE = `(() => {
  if (window.__stress) return true;
  // The scene draws at 60 fps only while the window has focus; measure it as you'd use it.
  document.hasFocus = () => true;
  window.dispatchEvent(new Event('focus'));
  const s = { frames: [], long: [], last: 0, on: false };
  const loop = (t) => {
    if (!s.on) return;
    if (s.last) s.frames.push(t - s.last);
    s.last = t;
    requestAnimationFrame(loop);
  };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
  window.__stress = {
    start() { Object.assign(s, { frames: [], long: [], last: 0, on: true }); requestAnimationFrame(loop); },
    stop() {
      s.on = false;
      const f = s.frames.slice().sort((a, b) => a - b);
      const total = s.frames.reduce((a, b) => a + b, 0) || 1;
      const q = (p) => +(f[Math.min(f.length - 1, Math.floor(f.length * p))] || 0).toFixed(1);
      return {
        fps: +(s.frames.length / (total / 1000)).toFixed(1),
        p50: q(0.5), p95: q(0.95), p99: q(0.99), maxFrame: +(f.at(-1) || 0).toFixed(1),
        janky: s.frames.filter((d) => d > 34).length,
        longTasks: s.long.length,
        longMs: Math.round(s.long.reduce((a, b) => a + b, 0)),
        heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
        dom: document.getElementsByTagName('*').length,
      };
    },
  };
  return true;
})()`;

module.exports = async ({ run, shot, wait, win }) => {
  win.setSize(1600, 1000);
  win.center();
  await wait(1500);
  await run(PROBE);

  // CPU (% of one core) and memory per process type, averaged over the phase.
  const metrics = () => {
    const by = {};
    for (const m of app.getAppMetrics()) {
      const type = m.type === 'Tab' ? 'renderer' : m.type === 'Browser' ? 'main' : m.type.toLowerCase();
      const b = (by[type] = by[type] || { cpu: 0, memMB: 0 });
      b.cpu += m.cpu.percentCPUUsage;
      b.memMB += m.memory.workingSetSize / 1024;
    }
    return by;
  };

  // Where the page's main thread spends its time (Chrome's own counters), and a CPU profile per phase with STRESS_PROFILE.
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  await cdp.sendCommand('Performance.enable');
  const counters = async () => Object.fromEntries((await cdp.sendCommand('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  if (process.env.STRESS_PROFILE) await cdp.sendCommand('Profiler.enable');

  async function measure(name, during) {
    metrics(); // (resets the CPU counters)
    const before = await counters();
    if (process.env.STRESS_PROFILE) await cdp.sendCommand('Profiler.start');
    await run('__stress.start(); __x2.scene?.stats?.(); true');
    const samples = [];
    const started = Date.now();
    const end = Date.now() + SECS * 1000;
    let step = 0;
    while (Date.now() < end) {
      if (during) await during(step++);
      await wait(during ? 700 : 1000);
      samples.push(metrics());
    }
    const page = await run('__stress.stop()');
    const painted = await run('__x2.scene?.stats ? __x2.scene.stats() : null').catch(() => null);
    const scene = painted ? { fps: +(painted.frames / ((Date.now() - started) / 1000)).toFixed(1), msPerFrame: painted.frames ? +(painted.ms / painted.frames).toFixed(2) : 0, where: painted.where } : null;
    const after = await counters();
    const secs = after.Timestamp - before.Timestamp;
    const per = (key) => +(((after[key] - before[key]) * 1000) / secs).toFixed(1); // ms per second (or count per second)
    const main = { taskMs: per('TaskDuration'), scriptMs: per('ScriptDuration'), styleMs: per('RecalcStyleDuration'), layoutMs: per('LayoutDuration'), styles: +((after.RecalcStyleCount - before.RecalcStyleCount) / secs).toFixed(1), layouts: +((after.LayoutCount - before.LayoutCount) / secs).toFixed(1) };
    if (process.env.STRESS_PROFILE) {
      const { profile } = await cdp.sendCommand('Profiler.stop');
      require('node:fs').writeFileSync(require('node:path').join(process.env.STRESS_PROFILE, `${name}.cpuprofile`), JSON.stringify(profile));
    }
    const avg = {};
    for (const sample of samples.slice(1)) {
      for (const [type, v] of Object.entries(sample)) {
        const a = (avg[type] = avg[type] || { cpu: 0, memMB: 0, n: 0 });
        a.cpu += v.cpu;
        a.memMB = Math.max(a.memMB, v.memMB);
        a.n += 1;
      }
    }
    const procs = Object.fromEntries(Object.entries(avg).map(([t, a]) => [t, { cpu: +(a.cpu / a.n).toFixed(1), memMB: Math.round(a.memMB) }]));
    const working = await run(`[...document.querySelectorAll('.side-task')].length`);
    console.log(`STRESS ${JSON.stringify({ phase: name, ...page, main, scene, procs, rows: working })}`);
    await shot(name);
  }

  const ids = [];
  const open = (i) => run(`__x2.ctx.open(${JSON.stringify(ids[i])}); true`);
  const busy = () => run(`[...__x2.store.state.tasks].filter((t) => __x2.tasks.get?.(t.id)?.state === 'working').length`).catch(() => -1);

  // 1. Nothing running: the scene and the home screen.
  await measure('idle');

  // 2. N tasks, each a fake Claude working through tool calls.
  const projectId = await run(`(async () => { const p = __x2.store.addProject(${JSON.stringify(PROJ)}); await __x2.store.flush(); return p.id; })()`);
  for (let i = 0; i < N; i += 1) {
    const id = await run(`__x2.store.newTask(${JSON.stringify(projectId)}, { title: 'Stress task ${i + 1}', named: true }).id`);
    ids.push(id);
    const reply = await run(`__x2.tasks.send(__x2.store.task(${JSON.stringify(id)}), 'Refactor the parser and run the tests, part ${i + 1}', { cols: 120, rows: 34 })`);
    if (reply?.error) console.log(`STRESS_INFO send failed: ${reply.error}`);
  }
  await open(0);
  await wait(4000);
  console.log(`STRESS_INFO working=${await busy()} of ${N}`);
  // What animates on the page while they work (CSS and script animations, by name and element).
  const anims = await run(`(() => { const by = {}; for (const a of document.getAnimations()) { const t = a.effect?.target; const k = (a.animationName || a.constructor.name) + ' @ ' + (t ? t.tagName.toLowerCase() + '.' + [...t.classList].join('.') : '?'); by[k] = (by[k] || 0) + 1; } return by; })()`);
  console.log(`STRESS_INFO animations ${JSON.stringify(anims)}`);
  // Keeps every task busy: a task that finished gets another message.
  const keepBusy = async () =>
    run(`(() => { let n = 0; for (const t of __x2.store.state.tasks) { const s = __x2.tasks.get?.(t.id); if (s && s.running && s.state === 'idle') { __x2.tasks.send(t, 'Keep going: next part ' + Date.now()); n++; } } return n; })()`);
  await measure('busy-chat', (step) => step % 3 === 0 && keepBusy());

  // (STRESS_DIAG: which parts of the page change, and how often, while they work.)
  if (process.env.STRESS_DIAG) {
    await run(`(() => {
      const area = (n) => { for (let e = n.nodeType === 1 ? n : n.parentElement; e; e = e.parentElement) { if (e.id) return '#' + e.id + (n.nodeType === 1 && n.className && typeof n.className === 'string' ? ' .' + n.className.split(' ')[0] : ''); } return '?'; };
      window.__muts = {};
      window.__mo = new MutationObserver((list) => { for (const m of list) { const k = m.type + (m.attributeName ? ':' + m.attributeName : '') + ' ' + area(m.target); __muts[k] = (__muts[k] || 0) + 1; } });
      __mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      return true;
    })()`);
    await wait(5000);
    const muts = await run(`(() => { __mo.disconnect(); return Object.entries(__muts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => (v / 5).toFixed(1) + '/s ' + k); })()`);
    for (const line of muts) console.log(`STRESS_INFO mutation ${line}`);
  }
  if (process.env.STRESS_DIAG) {
    await run(`(() => { const s = document.createElement('style'); s.id = 'stress-pause'; s.textContent = '*, *::before, *::after { animation-play-state: paused !important; }'; document.head.append(s); return true; })()`);
    await measure('diag-paused', (step) => step % 3 === 0 && keepBusy());
    await run(`document.querySelector('#stress-pause').remove(); true`);
  }

  // 3. The same, watching a busy task's terminal.
  await run(`__x2.showPane('terminal'); true`);
  await wait(800);
  await measure('busy-terminal', (step) => step % 3 === 0 && keepBusy());
  await run(`__x2.showPane('chat'); true`);

  // 4. Hopping between tasks.
  await measure('busy-switching', async (step) => {
    await open(step % ids.length);
    if (step % 3 === 0) await keepBusy();
  });

  // 5. The other scene under the same load.
  await run(`__x2.store.setSetting('theme', 'rooftop-rain'); true`);
  await open(1);
  await wait(800);
  await measure('busy-rain', (step) => step % 3 === 0 && keepBusy());
  await run(`__x2.store.setSetting('theme', 'night-lake'); true`);

  // 6. Long conversations: opening the task that has said the most.
  await wait(500);
  const openMs = [];
  for (let i = 0; i < Math.min(ids.length, 6); i += 1) {
    const ms = await run(`(async () => { const t0 = performance.now(); __x2.ctx.open(${JSON.stringify(ids[i])}); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t0; })()`);
    openMs.push(Math.round(ms));
  }
  const entries = await run(`__x2.store.state.tasks.map((t) => __x2.tasks.get(t.id).transcript.entries.length)`).catch(() => []);
  console.log(`STRESS_INFO openMs=${JSON.stringify(openMs)} entries=${JSON.stringify(entries)}`);

  // 7. Everything stopped: back to how idle was?
  for (const id of ids) await run(`window.api.task.kill?.(${JSON.stringify(id)}); true`).catch(() => {});
  await wait(3000);
  await run(`__x2.ctx.open(null); true`);
  await wait(1000);
  await measure('idle-after');
};
