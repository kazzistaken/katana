import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planPage, runEnv, KEEP_PAINTING } = require('../src/main/runplan.js');
const { descendants } = require('../src/main/win32.js');

const EXE = 'C:/app/node_modules/electron/dist/electron.exe';

{
  // a web page: this program again, as a small browser
  const page = planPage({ file: 'C:\\code\\game\\index.html', exe: EXE, appPath: 'C:/src/katana' });
  assert.deepEqual([page.file, page.label, page.page, page.shell], [EXE, 'index.html', 'C:\\code\\game\\index.html', false]);
  assert.deepEqual(page.args, [...KEEP_PAINTING, 'C:/src/katana']);
  assert.deepEqual(planPage({ file: 'C:/g/a.html', exe: EXE }).args, KEEP_PAINTING);
  assert.match(planPage({ file: '', exe: EXE }).error, /page/);
}

{
  // what a page's browser starts with: none of this app's own switches, and its own data folder
  const env = runEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', XODE2_TEST: 'look', XODE2_USERDATA: 'C:/real' }, { self: true, dataDir: 'C:/tmp/run' });
  assert.deepEqual(env, { PATH: 'p', XODE2_USERDATA: 'C:/tmp/run' });
  // anything else keeps no XODE2_ settings at all
  assert.deepEqual(runEnv({ PATH: 'p', XODE2_USERDATA: 'C:/real' }), { PATH: 'p' });
}

{
  // a process tree from parent links (npm → node → electron → its helpers), cycles and strangers left out
  const parents = new Map([[10, 1], [11, 10], [12, 11], [13, 12], [14, 12], [20, 1], [30, 30]]);
  assert.deepEqual([...descendants(10, parents)].sort(), [10, 11, 12, 13, 14]);
  assert.deepEqual([...descendants(30, parents)], [30]);
  // a "child" that started before its parent had the number of one that ended: not ours (nor what it started)
  const reused = new Map([[10, 1], [11, 10], [99, 10], [100, 99]]);
  const born = new Map([[10, 500], [11, 600], [99, 100], [100, 700]]);
  assert.deepEqual([...descendants(10, reused, { born })].sort(), [10, 11]);
  // never this app itself, even if it looks like a child
  assert.deepEqual([...descendants(10, new Map([[11, 10], [12, 10]]), { exclude: 12 })].sort(), [10, 11]);
  // a process that can't be asked when it started: left out
  assert.deepEqual([...descendants(10, new Map([[11, 10]]), { born: new Map([[10, 5]]) })], [10]);
}

{
  // where windows wait off-screen: beside Katana's display, on a side no other display touches
  const { parking } = require('../src/main/appview.js');
  const main = { x: 0, y: 0, width: 1920, height: 1080 };
  const size = { width: 800, height: 600 };
  assert.deepEqual(parking([main], main, size), { x: -864, y: 0 });
  // a display to the left: go right
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(parking([left, main], main, size), { x: 1984, y: 0 });
  // left and right taken: above
  const right = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(parking([left, main, right], main, size), { x: 0, y: -664 });
  // surrounded on all four sides: left of everything
  const up = { x: 0, y: -1080, width: 1920, height: 1080 };
  const down = { x: 0, y: 1080, width: 1920, height: 1080 };
  assert.deepEqual(parking([left, main, right, up, down], main, size), { x: -1920 - 864, y: 0 });
  // another window already waiting there (another run, another Katana): the next spot out
  assert.deepEqual(parking([main], main, size, [{ x: -900, y: 100, width: 700, height: 500 }]), { x: -864 - 864, y: 0 });
  assert.deepEqual(parking([left, main], main, size, [{ x: 1984, y: 0, width: 800, height: 600 }]), { x: 1984 + 864, y: 0 });
  // something off-screen but out of the way changes nothing
  assert.deepEqual(parking([main], main, size, [{ x: -3000, y: 2000, width: 100, height: 100 }]), { x: -864, y: 0 });
}

console.log('runplan ok');
