'use strict';

/**
 * Dictation: Windows' own speech engine through
 * a small helper (scripts/katana-speech.cs, compiled once with the .NET
 * compiler Windows ships) with no Windows UI; without it, a PowerShell
 * fallback (scripts/dictate.ps1). Both print READY, then PARTIAL lines while
 * you speak and FINAL lines with punctuation when you pause. With a Deepgram
 * key (DEEPGRAM_API_KEY, or <userData>/deepgram.key) the renderer streams the
 * mic to Deepgram itself instead; with an OpenAI key, to OpenAI through
 * main (transcribe.js; main.js decides).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const VOICE_SCRIPT = path.join(ROOT, 'scripts', 'dictate.ps1');
const SPEECH_SOURCE = path.join(ROOT, 'scripts', 'katana-speech.cs');
const START_TIMEOUT = 8000;

function createVoice({ userDataDir, send, existsInPath }) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let voiceProc = null;
  let voiceStopping = false;

  /** Build the helper once per source version; null when it can't be built. */
  function speechHelper() {
    return new Promise((resolve) => {
      try {
        const source = fs.readFileSync(SPEECH_SOURCE);
        const hash = require('node:crypto').createHash('sha1').update(source).digest('hex').slice(0, 10);
        const out = path.join(userDataDir(), 'bin', `katana-speech-${hash}.exe`);
        if (fs.existsSync(out)) {
          resolve(out);
          return;
        }
        const windir = process.env.WINDIR || 'C:\\Windows';
        const fw = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
        const meta = path.join(windir, 'System32', 'WinMetadata');
        const csc = path.join(fw, 'csc.exe');
        if (!fs.existsSync(csc)) {
          resolve(null);
          return;
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        execFile(
          csc,
          [
            '-nologo',
            '-optimize',
            '-nowarn:1701',
            `-out:${out}`,
            `-r:${path.join(meta, 'Windows.Foundation.winmd')}`,
            `-r:${path.join(meta, 'Windows.Media.winmd')}`,
            `-r:${path.join(meta, 'Windows.Globalization.winmd')}`,
            `-r:${path.join(fw, 'System.Runtime.dll')}`,
            `-r:${path.join(fw, 'System.Runtime.InteropServices.WindowsRuntime.dll')}`,
            SPEECH_SOURCE,
          ],
          { windowsHide: true, timeout: 60000 },
          (error, stdout) => {
            if (error || !fs.existsSync(out)) {
              console.warn('[voice] could not build the dictation helper', String(stdout || error).slice(0, 400));
              resolve(null);
            } else {
              resolve(out);
            }
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  function stop() {
    if (!voiceProc) return;
    voiceStopping = true;
    const proc = voiceProc;
    voiceProc = null;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  function deepgramKey() {
    try {
      const fromFile = fs.readFileSync(path.join(userDataDir(), 'deepgram.key'), 'utf8').trim();
      return process.env.DEEPGRAM_API_KEY || fromFile || '';
    } catch {
      return process.env.DEEPGRAM_API_KEY || '';
    }
  }

  async function start() {
    const key = deepgramKey();
    if (key) return { ok: true, deepgramKey: key };
    // XODE2_SPEECH_HELPER: a stand-in helper for tests (prints the same lines).
    const helper = process.env.XODE2_SPEECH_HELPER || (process.platform === 'win32' ? await speechHelper() : null);
    return launch(helper);
  }

  function launch(helper) {
    return new Promise((resolve) => {
      if (voiceProc) {
        resolve({ ok: true });
        return;
      }
      if (process.platform !== 'win32') {
        resolve({ ok: false, error: 'Dictation uses the Windows speech engine.' });
        return;
      }
      if (!helper && !fs.existsSync(VOICE_SCRIPT)) {
        resolve({ ok: false, error: 'The dictation script is missing.' });
        return;
      }
      const powershell = existsInPath('powershell') || 'powershell.exe';
      let proc;
      try {
        proc = helper
          ? /\.js$/i.test(helper)
            ? spawn(process.execPath, [helper], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
            : spawn(helper, [], { windowsHide: true })
          : spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VOICE_SCRIPT], { windowsHide: true });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }

      voiceProc = proc;
      voiceStopping = false;
      let settled = false;
      let stdout = '';
      let stderr = '';
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        stdout += chunk;
        let index;
        while ((index = stdout.indexOf('\n')) !== -1) {
          const line = stdout.slice(0, index).replace(/\r$/, '').trim();
          stdout = stdout.slice(index + 1);
          if (!line) continue;
          const [kind, ...rest] = line.split('\t');
          const text = rest.join('\t');
          if (kind === 'READY') {
            send('voice:state', 'listening');
            settle({ ok: true });
          } else if (kind === 'PARTIAL') send('voice:partial', text);
          else if (kind === 'FINAL') send('voice:text', text);
          else if (kind === 'ERROR') stderr += text;
          else send('voice:text', line);
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      proc.on('error', (error) => {
        if (voiceProc === proc) voiceProc = null;
        settle({ ok: false, error: error.message });
        send('voice:state', 'error');
      });
      proc.on('exit', (code) => {
        if (voiceProc === proc) voiceProc = null;
        const intentional = voiceStopping;
        voiceStopping = false;
        if (!settled) settle({ ok: false, error: stderr.trim() || 'The speech engine could not start.' });
        // A newer session already started: this late exit must not flip its state.
        if (voiceProc) return;
        send('voice:state', intentional || code === 0 ? 'stopped' : 'error');
      });
      setTimeout(() => {
        if (settled) return;
        stop();
        settle({ ok: false, error: 'The speech engine did not respond.' });
      }, START_TIMEOUT);
    });
  }

  return { start, stop, hasDeepgram: () => Boolean(deepgramKey()) };
}

module.exports = { createVoice };
