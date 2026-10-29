'use strict';

/**
 * Hearing and speaking through OpenRouter, with the user's OpenRouter key:
 *
 *   transcribe(wav)  a spoken phrase (base64 WAV) as text: dictation, and
 *                    what you say to Katana when you talk with her
 *   speak(text)      words as speech (MP3, base64): Katana's voice
 *
 * Both are one request each: a phrase is sent when you pause, and her
 * answer is spoken once she has it. The key stays in this process.
 * openrouter.ai/docs/guides/overview/multimodal/stt.md, tts.md
 *
 * XODE2_OPENROUTER_URL: a stand-in server for tests.
 */

const { createKeyStore } = require('./keystore');

const BASE = () => process.env.XODE2_OPENROUTER_URL || 'https://openrouter.ai/api/v1';
const STT_MODEL = 'openai/gpt-4o-transcribe';
// Her voice: ElevenLabs Flash (a sentence in about a third of a second); if it
// fails, Google's Gemini speech (slower, 3 s or so), raw PCM made a WAV here.
const TTS_MODEL = 'elevenlabs/eleven-flash-v2.5';
const FALLBACK_TTS = { model: 'google/gemini-3.8-flash-tts', voice: 'Kore' };
const TIMEOUT_MS = 60_000;

// What her voice can be: ElevenLabs' voices, by name.
const VOICES = {
  Rachel: '21m00Tcm4TlvDq8ikWAM',
  Aria: '9BWtsMINqrJLrRacOk9x',
  Sarah: 'EXAVITQu4vr4xnSDxMaL',
  Charlotte: 'XB0fDUnXU5powFXDhCwa',
  Alice: 'Xb7hH8MSUJpSbSDYk0k2',
  Matilda: 'XrExE9yKIg1WjnnlVkGX',
  Lily: 'pFZP5JQG7iQjIQuC4Bku',
  Jessica: 'cgSgspJ2msm6clMCkdW9',
  Laura: 'FGY2WhTYpPnrIDTdsKH5',
  Brian: 'nPczCjzI2devNBz1zQrb',
  George: 'JBFqnCBsd6RMkjVDRZzb',
};
const DEFAULT_VOICE = 'Rachel';

/** Raw 16-bit PCM as a WAV file, so the window can play it. */
function pcmToWav(pcm, rate = 24000, channels = 1) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

function friendly(status, message) {
  if (status === 401) return 'OpenRouter didn’t accept the key. Check it in Settings → Katana.';
  if (status === 402) return 'The OpenRouter account is out of credit.';
  if (status === 429) return 'OpenRouter says to slow down (rate limit).';
  return `OpenRouter (${status}): ${String(message || '').slice(0, 200)}`;
}

function createOpenRouter({ userDataDir, safeStorage }) {
  const keys = createKeyStore({ userDataDir, name: 'openrouter', env: 'OPENROUTER_API_KEY', ...(safeStorage ? { safeStorage } : {}) });

  async function call(pathname, body) {
    const key = keys.get();
    if (!key) return { error: 'Add your OpenRouter key in Settings → Katana.' };
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

    /** Words as speech: { audio (base64), type } or { error }. */
    async speak(text, voice = DEFAULT_VOICE) {
      const words = String(text || '').trim().slice(0, 3000);
      if (!words) return { error: 'Nothing to say.' };
      let reply = await call('/audio/speech', { model: TTS_MODEL, input: words, voice: VOICES[voice] || VOICES[DEFAULT_VOICE], response_format: 'mp3' });
      // ElevenLabs didn't: Gemini's voice, slower, rather than none.
      if (reply.error && !/key|credit/i.test(reply.error)) {
        reply = await call('/audio/speech', { model: FALLBACK_TTS.model, input: words, voice: FALLBACK_TTS.voice, response_format: 'pcm', instructions: 'Calm, warm and brief, like a colleague sitting next to you.' });
      }
      if (reply.error) return reply;
      const bytes = await reply.response.arrayBuffer().then(Buffer.from, () => null);
      if (!bytes) return { error: 'Couldn’t read OpenRouter’s speech.' };
      const type = reply.response.headers.get('content-type') || 'audio/pcm';
      // "audio/pcm;rate=24000;channels=1": wrapped as a WAV with what it says.
      if (/^audio\/(pcm|l16)/i.test(type)) {
        const rate = Number(type.match(/rate=(\d+)/)?.[1]) || 24000;
        const channels = Number(type.match(/channels=(\d+)/)?.[1]) || 1;
        return { audio: pcmToWav(bytes, rate, channels).toString('base64'), type: 'audio/wav' };
      }
      return { audio: bytes.toString('base64'), type };
    },
  };
}

module.exports = { createOpenRouter, pcmToWav, VOICES, DEFAULT_VOICE, STT_MODEL, TTS_MODEL };
