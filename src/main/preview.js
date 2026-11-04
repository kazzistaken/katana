'use strict';

/**
 * A rough copy of what's dictated: Windows' classic speech engine, on this PC, through
 * a small helper (scripts/katana-preview.cs, compiled once with the .NET compiler
 * Windows ships). It's never shown: only if Canary fails on a phrase do these words
 * stand in for it, rather than losing what you said.
 * It runs only while the mic is on. If it can't run, dictation works as before.
 *
 * XODE2_PREVIEW_WAV (tests): hears that file in real time instead of the mic.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const SOURCE = path.join(__dirname, '..', '..', 'scripts', 'katana-preview.cs');

function createPreview({ userDataDir, send, log = () => {} }) {
  let proc = null;
  let starts = 0; // each start and stop: a slow build's late finish checks it's still wanted

  /** Builds the helper once per version of its source; null when it can't be. */
  function helper() {
    return new Promise((resolve) => {
      try {
        const hash = crypto.createHash('sha1').update(fs.readFileSync(SOURCE)).digest('hex').slice(0, 10);
        const out = path.join(userDataDir(), 'bin', `katana-preview-${hash}.exe`);
        if (fs.existsSync(out)) return resolve(out);
        const fw = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
        const csc = path.join(fw, 'csc.exe');
        if (!fs.existsSync(csc)) return resolve(null);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        return execFile(csc, ['-nologo', '-optimize', `-out:${out}`, `-r:${path.join(fw, 'WPF', 'System.Speech.dll')}`, SOURCE], { windowsHide: true, timeout: 60000 }, (error, stdout) => {
          if (error || !fs.existsSync(out)) {
            log('preview', `could not build: ${String(stdout || error).slice(0, 300)}`);
            resolve(null);
          } else resolve(out);
        });
      } catch (error) {
        log('preview', error.message);
        return resolve(null);
      }
    });
  }

  function stop() {
    starts += 1;
    const running = proc;
    proc = null;
    if (!running) return;
    try {
      running.stdin.end();
    } catch {
      /* already gone */
    }
    running.kill();
  }

  /** Builds the helper ahead of the first use (it takes about a second). */
  const prepare = () => (process.platform === 'win32' ? helper() : Promise.resolve(null));

  async function start() {
    if (proc || process.platform !== 'win32') return;
    const start = (starts += 1);
    const exe = await helper();
    if (!exe || start !== starts) return;
    const wav = process.env.XODE2_PREVIEW_WAV;
    let child;
    try {
      child = spawn(exe, wav ? ['--wav', wav] : [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      log('preview', error.message);
      return;
    }
    proc = child;
    let carry = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      carry += chunk;
      let at;
      while ((at = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, at).replace(/\r$/, '');
        carry = carry.slice(at + 1);
        const [kind, ...rest] = line.split('\t');
        const text = rest.join('\t');
        if (kind === 'PARTIAL') send('voice:live', { text, settled: false });
        else if (kind === 'FINAL') send('voice:live', { text, settled: true });
        else if (kind === 'ERROR') log('preview', text);
      }
    });
    child.on('error', (error) => log('preview', error.message));
    child.on('exit', () => {
      if (proc === child) proc = null;
    });
  }

  return { start, stop, prepare };
}

module.exports = { createPreview };
