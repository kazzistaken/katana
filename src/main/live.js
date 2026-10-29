'use strict';

/**
 * GPT-Live: OpenAI's voice model, for talking with Katana out loud. It
 * listens and speaks; anything to do or look into it delegates (client
 * delegation), and the window hands that to Katana's Claude turn (Opus),
 * whose answer GPT-Live then says. See developers.openai.com/api/docs/guides/live.
 *
 * The window makes the WebRTC offer; this process exchanges it for an
 * answer (POST /v1/live/sessions) with the user's OpenAI key, so the key
 * never reaches the page. It's kept in <userData>/openai.key, encrypted
 * by Windows when it can be (safeStorage); OPENAI_API_KEY also works.
 */

const { createKeyStore } = require('./keystore');

const SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';
const MODEL = 'gpt-live-1';

function friendly(status, message) {
  if (status === 401) return 'OpenAI didn’t accept the key. Check it in Settings → Katana.';
  if (status === 403 || status === 404) return 'This OpenAI key has no access to GPT-Live.';
  if (status === 429) return 'OpenAI says the key is out of quota or rate-limited.';
  return `GPT-Live couldn’t start (${status}): ${String(message || '').slice(0, 200)}`;
}

function createLive({ userDataDir }) {
  const keys = createKeyStore({ userDataDir, name: 'openai', env: 'OPENAI_API_KEY' });
  const key = keys.get;
  const setKey = keys.set;

  /** Start a session for the window's offer: { id, sdp } or { error }. */
  async function start({ sdp, voice, instructions } = {}) {
    const apiKey = key();
    if (!apiKey) return { error: 'Add your OpenAI API key in Settings → Katana to talk with GPT-Live.' };
    if (typeof sdp !== 'string' || !sdp.trim()) return { error: 'No connection offer.' };
    const session = {
      model: MODEL,
      instructions: String(instructions || ''),
      audio: { output: { voice: String(voice || 'marin') } },
      // Katana (the app, then Opus) does the work and says when it's done.
      delegation: { type: 'client' },
    };
    try {
      const response = await fetch(SESSIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an error page */
      }
      if (!response.ok) return { error: friendly(response.status, json?.error?.message || text) };
      if (!json?.transport?.sdp) return { error: 'GPT-Live sent no answer.' };
      return { id: json.session?.id || '', sdp: json.transport.sdp };
    } catch (error) {
      return { error: `Couldn’t reach OpenAI: ${error.message}` };
    }
  }

  // `key` stays in this process (dictation uses it too); the window only learns whether there is one.
  return { hasKey: () => Boolean(key()), key, setKey, start };
}

module.exports = { createLive };
