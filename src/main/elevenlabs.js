'use strict';

/**
 * Katana's voice straight from ElevenLabs, with the user's own ElevenLabs
 * key (optional: without one her voice comes through OpenRouter). The one
 * thing it adds: ElevenLabs' with-timestamps speech gives when each
 * character is said, so her lips are timed exactly (renderer lipsync.js).
 *
 *   speak(text, voice)  { audio (MP3, base64), type, alignment } or { error }
 *
 * Same voices, by name, as openrouter.js. The key stays in this process.
 * elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 *
 * XODE2_ELEVENLABS_URL: a stand-in server for tests.
 */

const { createKeyStore } = require('./keystore');
const { VOICES, DEFAULT_VOICE } = require('./openrouter');

const BASE = () => process.env.XODE2_ELEVENLABS_URL || 'https://api.elevenlabs.io';
const MODEL = 'eleven_flash_v2_5';
const TIMEOUT_MS = 60_000;

function friendly(status, message) {
  if (status === 401) return 'ElevenLabs didn’t accept the key. Check it in Settings → Katana.';
  if (status === 402) return 'The ElevenLabs account is out of credit.';
  if (status === 429) return 'ElevenLabs says to slow down (rate limit).';
  return `ElevenLabs (${status}): ${String(message || '').slice(0, 200)}`;
}

function createElevenLabs({ userDataDir, safeStorage }) {
  const keys = createKeyStore({ userDataDir, name: 'elevenlabs', env: 'ELEVENLABS_API_KEY', ...(safeStorage ? { safeStorage } : {}) });

  return {
    hasKey: keys.has,
    setKey: keys.set,

    /** Words as speech, with when each character is said. */
    async speak(text, voice = DEFAULT_VOICE) {
      const key = keys.get();
      if (!key) return { error: 'Add your ElevenLabs key in Settings → Katana.' };
      const words = String(text || '').trim().slice(0, 3000);
      if (!words) return { error: 'Nothing to say.' };
      const id = VOICES[voice] || VOICES[DEFAULT_VOICE];
      try {
        const response = await fetch(`${BASE()}/v1/text-to-speech/${id}/with-timestamps?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: words, model_id: MODEL }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          const body = await response.text();
          let message = body;
          try {
            const json = JSON.parse(body);
            message = json?.detail?.message || json?.detail || body;
          } catch {
            /* not JSON */
          }
          return { error: friendly(response.status, typeof message === 'string' ? message : JSON.stringify(message)) };
        }
        const json = await response.json();
        if (!json?.audio_base64) return { error: 'ElevenLabs sent no audio.' };
        const a = json.alignment;
        const alignment = a && Array.isArray(a.characters) ? { characters: a.characters, character_start_times_seconds: a.character_start_times_seconds, character_end_times_seconds: a.character_end_times_seconds } : null;
        return { audio: json.audio_base64, type: 'audio/mpeg', alignment };
      } catch (error) {
        return { error: `Couldn’t reach ElevenLabs: ${error.message}` };
      }
    },
  };
}

module.exports = { createElevenLabs, MODEL };
