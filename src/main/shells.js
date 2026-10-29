'use strict';

/**
 * The shells a shell task can run (tasks.js opens them in a real terminal,
 * only ever inside a trusted folder).
 */

const path = require('node:path');

const WINDOWS_SHELLS = [
  { id: 'powershell', label: 'PowerShell', bin: 'powershell', args: ['-NoLogo'] },
  { id: 'pwsh', label: 'PowerShell 7', bin: 'pwsh', args: ['-NoLogo'] },
  { id: 'cmd', label: 'Command Prompt', bin: 'cmd', args: [] },
];

/** Installed shells, in order of preference. `find(bin)` returns a full path or null. */
function shellsFrom(find, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return WINDOWS_SHELLS.map((shell) => ({ ...shell, file: find(shell.bin) }))
      .filter((shell) => shell.file)
      .map(({ id, label, file, args }) => ({ id, label, file, args }));
  }
  const file = env.SHELL || '/bin/bash';
  return [{ id: path.basename(file), label: path.basename(file), file, args: ['-l'] }];
}

/** The chosen shell, or the first one when the choice isn't installed. */
function pickShell(id, list) {
  return list.find((shell) => shell.id === id) || list[0] || null;
}

module.exports = { shellsFrom, pickShell };
