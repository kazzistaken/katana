'use strict';

/**
 * Dictation through OpenRouter, with the user's OpenRouter key:
 * transcribe(wav) turns a spoken phrase (base64 WAV) into text, one
 * request per phrase, sent when you pause. The key stays in this process.
 * openrouter.ai/docs/guides/overview/multimodal/stt.md
 *
 * XODE2_OPENROUTER_URL: a stand-in server for tests.
 */

const { createKeyStore } = require('./keystore');

const BASE = () => process.env.XODE2_OPENROUTER_URL || 'https://openrouter.ai/api/v1';
const STT_MODEL = 'openai/gpt-4o-transcribe';
const TIMEOUT_MS = 60_000;

function friendly(status, message) {
  if (status === 401) return 'OpenRouter didn’t accept the key. Check it in Settings → Dictation.';
  if (status === 402) return 'The OpenRouter account is out of credit.';
  if (status === 429) return 'OpenRouter says to slow down (rate limit).';
  return `OpenRouter (${status}): ${String(message || '').slice(0, 200)}`;
}

function createOpenRouter({ userDataDir, safeStorage }) {
  const keys = createKeyStore({ userDataDir, name: 'openrouter', env: 'OPENROUTER_API_KEY', ...(safeStorage ? { safeStorage } : {}) });

  async function call(pathname, body) {
    const key = keys.get();
    if (!key) return { error: 'Add your OpenRouter key in Settings → Dictation.' };
    try {
      const response = await fetch(`${BASE()}${pathname}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Katana' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
          message = JSON.parse(text)?.error?.message || text;
        } catch {
          /* not JSON */
        }
        return { error: friendly(response.status, message) };
      }
      return { response };
    } catch (error) {
      return { error: `Couldn’t reach OpenRouter: ${error.message}` };
    }
  }

  return {
    hasKey: keys.has,
    setKey: keys.set,

    /** A phrase (base64 WAV) as text: { text } or { error }. */
    async transcribe(wav) {
      if (!wav) return { text: '' };
      const reply = await call('/audio/transcriptions', { model: STT_MODEL, input_audio: { data: String(wav), format: 'wav' }, language: 'en' });
      if (reply.error) return reply;
      const json = await reply.response.json().catch(() => null);
      return { text: String(json?.text || '').trim() };
    },

  };
}

module.exports = { createOpenRouter, STT_MODEL };
