'use strict';

/**
 * Dictation through NVIDIA Canary-Qwen 2.5B, on this PC (nothing leaves it):
 * a Python helper (scripts/canary-server.py) that keeps the model loaded and
 * hears a phrase at a time. Set up once with `npm run setup:canary`, into
 * <project>/.canary. The window sends each phrase as a WAV when you pause.
 *
 * The model takes minutes to load (measured about 4 on a Xeon E3 and GTX 1080
 * Ti), far too long to wait for mid-sentence, so main starts it in the
 * background when the app opens and it stays loaded (about 5 GB of graphics
 * memory) until the app quits. Phrases spoken while it loads wait for it, in
 * order. If it crashes while loading it tries once more; if it still can't load
 * it's marked broken for this run, and dictation falls back to the next engine.
 * If it goes away once it's up, the next phrase starts it again.
 *
 * XODE2_CANARY_PYTHON, XODE2_CANARY_SERVER: a stand-in helper for tests.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const IDLE_MS = Infinity; // stays loaded: loading again would cost minutes
const ANSWER_MS = 120_000; // one phrase, once the model is up
const LOAD_MS = 45 * 60_000; // loading; the very first time it also downloads the model

function createCanary({ dir = process.env.XODE2_CANARY_DIR || path.join(ROOT, '.canary'), idleMs = IDLE_MS, answerMs = ANSWER_MS, loadMs = LOAD_MS, log = () => {} } = {}) {
  const python = () => process.env.XODE2_CANARY_PYTHON || path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const server = () => process.env.XODE2_CANARY_SERVER || path.join(ROOT, 'scripts', 'canary-server.py');
  let proc = null;
  let ready = null; // resolves once the model is loaded: { ok } or { ok: false, error }
  let broken = '';
  let up = false; // the model is loaded and answering
  let retried = false; // one more go after a crash while loading
  let idleTimer = null;
  let nextId = 1;
  const waiting = new Map(); // request id -> { resolve, timer }

  function finishAll(error) {
    for (const { resolve, timer } of waiting.values()) {
      clearTimeout(timer);
      resolve({ error });
    }
    waiting.clear();
  }

  function stop() {
    clearTimeout(idleTimer);
    const running = proc;
    proc = null;
    ready = null;
    up = false;
    finishAll('Dictation stopped.');
    if (running) {
      // Closing its input ends it; the kill is for one stuck in the model.
      try {
        running.stdin.end();
      } catch {
        /* already gone */
      }
      running.kill();
    }
  }

  function touch() {
    clearTimeout(idleTimer);
    if (waiting.size || !Number.isFinite(idleMs)) return;
    idleTimer = setTimeout(stop, idleMs);
    idleTimer.unref?.();
  }

  /** Starts the helper if it isn't running; resolves once the model is up. */
  function start() {
    if (ready) return ready;
    if (broken) return Promise.resolve({ ok: false, error: broken });
    ready = new Promise((resolve) => {
      let child;
      const fail = (message) => {
        broken = message;
        log('canary', message);
        clearTimeout(loadTimer);
        resolve({ ok: false, error: message });
        if (proc === child) stop();
      };
      const loadTimer = setTimeout(() => fail('Canary took too long to load.'), loadMs);
      loadTimer.unref?.();
      try {
        child = spawn(python(), [server()], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HF_HOME: path.join(dir, 'hf'),
            // Once it's downloaded it never needs the network.
            ...(fs.existsSync(path.join(dir, 'hf', 'hub', 'models--nvidia--canary-qwen-2.5b', 'snapshots')) ? { HF_HUB_OFFLINE: '1' } : {}),
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1',
          },
        });
      } catch (error) {
        fail(error.message);
        return;
      }
      proc = child;
      let carry = '';
      let lastErr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        carry += chunk;
        let nl;
        while ((nl = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, nl).trim();
          carry = carry.slice(nl + 1);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.ready) {
            clearTimeout(loadTimer);
            up = true;
            log('canary', `ready on ${message.device} in ${message.ms} ms`);
            resolve({ ok: true, device: message.device });
            touch();
          } else if (message.failed) fail(`Canary couldn’t load: ${message.failed}`);
          else if (waiting.has(message.id)) {
            const { resolve: answer, timer } = waiting.get(message.id);
            waiting.delete(message.id);
            clearTimeout(timer);
            answer(message.error ? { error: message.error } : { text: message.text || '' });
            touch();
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        lastErr = (lastErr + chunk).slice(-600);
      });
      child.on('error', (error) => fail(error.message));
      child.on('exit', (code) => {
        if (proc !== child) return;
        log('canary', `stopped (${code}). ${lastErr.trim().split('\n').pop() || ''}`);
        // Going away once it was up: the next phrase starts it again.
        if (up) {
          stop();
          return;
        }
        clearTimeout(loadTimer);
        // Crashed while loading: once more (a crash here can be passing: the card or memory busy for a moment).
        if (!retried) {
          retried = true;
          proc = null;
          ready = null;
          start().then(resolve);
          return;
        }
        fail(`Canary stopped (${code}). ${lastErr.trim().split('\n').pop() || ''}`.trim());
      });
    });
    return ready;
  }

  /** A phrase (base64 WAV) as { text } or { error }; it waits for the model if that's still loading. */
  async function transcribe(wav) {
    const up = await start();
    if (!up.ok) return { error: up.error };
    const file = path.join(os.tmpdir(), `katana-phrase-${process.pid}-${nextId}.wav`);
    try {
      fs.writeFileSync(file, Buffer.from(String(wav || ''), 'base64'));
    } catch (error) {
      return { error: error.message };
    }
    const id = nextId++;
    clearTimeout(idleTimer);
    return new Promise((resolve) => {
      const answer = (reply) => {
        waiting.delete(id);
        fs.rm(file, { force: true }, () => {});
        resolve(reply);
      };
      const timer = setTimeout(() => answer({ error: 'Canary took too long on that phrase.' }), answerMs);
      waiting.set(id, { timer, resolve: answer });
      proc.stdin.write(`${JSON.stringify({ id, wav: file })}\n`);
    });
  }

  return {
    start,
    stop,
    transcribe,
    /** Set up, and hasn't failed in this run. */
    usable: () => !broken && fs.existsSync(python()),
    /** Its helper is running (it may still be loading). */
    loaded: () => Boolean(proc),
    /** The model is up: a phrase goes straight in. */
    isUp: () => up,
    why: () => broken,
  };
}

module.exports = { createCanary };
