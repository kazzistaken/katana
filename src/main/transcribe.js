'use strict';

/**
 * Dictation through OpenAI (gpt-live-transcribe), used when an OpenAI key
 * is set (Settings → Katana): steadier than Windows' speech engine. The
 * window records the mic and sends 24 kHz PCM16 here only while you speak
 * (its own pause detection), with a commit at each pause; this process
 * holds the key and the WebSocket. Words come back as you say them (the
 * phrase so far: voice:partial) and, once committed, finished with
 * punctuation (voice:text). developers.openai.com/api/docs/guides/realtime-transcription
 *
 * XODE2_TRANSCRIBE_URL: a stand-in server for tests.
 */

const URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const OPEN_MS = 10_000;
const FINAL_MS = 4000; // stopping: how long the last phrase may take to come back

function createTranscriber({ apiKey, send, log = () => {} }) {
  let socket = null;
  let opening = null;
  const phrases = new Map(); // item id -> text so far
  let waiting = 0; // commits not yet answered
  let drained = null; // resolves when nothing is waiting

  function settle() {
    if (waiting > 0 || !drained) return;
    const done = drained;
    drained = null;
    done();
  }

  function onMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const text = (phrases.get(event.item_id) || '') + String(event.delta || '');
      phrases.set(event.item_id, text);
      send('voice:partial', text);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      phrases.delete(event.item_id);
      const text = String(event.transcript || '').trim();
      if (text) send('voice:text', text);
      waiting = Math.max(0, waiting - 1);
      settle();
    } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
      phrases.delete(event.item_id);
      waiting = Math.max(0, waiting - 1);
      settle();
      send('voice:error', event.error?.message || 'OpenAI couldn’t transcribe that.');
    } else if (event.type === 'error') {
      const message = String(event.error?.message || 'OpenAI dictation failed.');
      // A commit with (almost) nothing in it: nothing to say, nothing to wait for.
      if (/buffer/i.test(message)) {
        waiting = Math.max(0, waiting - 1);
        settle();
        return;
      }
      log('transcribe', message);
      send('voice:error', message);
    }
  }

  /** Open the session: { ok } or { ok: false, error }. */
  function start() {
    if (socket?.readyState === 1) return Promise.resolve({ ok: true });
    if (opening) return opening;
    const key = apiKey();
    if (!key) return Promise.resolve({ ok: false, error: 'No OpenAI key.' });
    opening = new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(process.env.XODE2_TRANSCRIBE_URL || URL, { headers: { Authorization: `Bearer ${key}` } });
      } catch (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        resolve({ ok: false, error: 'OpenAI didn’t answer.' });
      }, OPEN_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        socket = ws;
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: {
                    model: 'gpt-live-transcribe',
                    prompt: 'Someone dictating instructions to a coding assistant: tasks, files, code, commands.',
                    keywords: ['Claude', 'Claude Code', 'Katana', 'Codex', 'GitHub', 'npm', 'worktree'],
                    delay: 'low',
                  },
                  turn_detection: null,
                },
              },
            },
          })
        );
        resolve({ ok: true });
      });
      ws.addEventListener('message', (event) => onMessage(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')));
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, error: 'Couldn’t reach OpenAI for dictation. Check the key in Settings → Katana.' });
      });
      ws.addEventListener('close', (event) => {
        clearTimeout(timer);
        if (socket === ws) {
          socket = null;
          if (event.code !== 1000) send('voice:error', event.reason || 'OpenAI closed the dictation connection.');
          send('voice:state', 'stopped');
        }
        waiting = 0;
        settle();
      });
    }).finally(() => {
      opening = null;
    });
    return opening;
  }

  const ready = () => socket?.readyState === 1;

  return {
    start,
    /** A chunk of the mic, base64 PCM16 at 24 kHz. */
    append(audio) {
      if (ready() && audio) socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    },
    /** A pause: what was said since the last one is a phrase. */
    commit() {
      if (!ready()) return;
      waiting += 1;
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    },
    /** Stop: the last phrase comes back first (briefly), then the line closes. */
    async stop() {
      if (!socket) return;
      if (waiting) {
        await new Promise((resolve) => {
          drained = resolve;
          setTimeout(resolve, FINAL_MS);
        });
      }
      const ws = socket;
      socket = null;
      phrases.clear();
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    },
    active: () => Boolean(socket),
  };
}

module.exports = { createTranscriber };
