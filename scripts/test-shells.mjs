import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shellsFrom, pickShell } = require('../src/main/shells.js');

{
  // only installed shells are offered, PowerShell first on Windows
  const found = { powershell: 'C:\\W\\powershell.exe', pwsh: null, cmd: 'C:\\W\\cmd.exe' };
  const list = shellsFrom((bin) => found[bin] || null, 'win32');
  assert.deepEqual(list.map((s) => s.id), ['powershell', 'cmd']);
  assert.equal(list[0].label, 'PowerShell');
  assert.equal(list[0].file, 'C:\\W\\powershell.exe');
}

{
  // an unknown or empty choice falls back to the first shell
  const list = [{ id: 'powershell' }, { id: 'cmd' }];
  assert.equal(pickShell('cmd', list).id, 'cmd');
  assert.equal(pickShell('', list).id, 'powershell');
  assert.equal(pickShell('fish', list).id, 'powershell');
  assert.equal(pickShell('cmd', []), null);
}

{
  // elsewhere: the user's login shell
  const list = shellsFrom(() => null, 'linux', { SHELL: '/bin/zsh' });
  assert.equal(list[0].file, '/bin/zsh');
  assert.equal(list[0].label, 'zsh');
}

console.log('shells ok');
