/**
 * The microphone, for dictation and for talking with Katana: 24 kHz mono
 * chunks (openMic), whether they're speech (createPauseDetector: a voice,
 * louder than the room's own noise; a pause ends a phrase), and a phrase as a
 * WAV clip or PCM16 for the services that hear it (OpenAI, OpenRouter).
 * Closing it stops the capture itself, so Windows' mic light goes off.
 */

export const RATE = 24000;
export const CHUNK = 2048; // samples per chunk: about 85 ms
// Echo cancellation and noise suppression: the speakers and the room stay out.
export const MIC_AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const PAUSE_MS = 950; // since the last of a voice (a word's last consonants aren't voiced)
const LONGEST_MS = 20000; // a phrase this long is sent anyway
const FLOOR = 0.012; // quietest level that can count as speech
const LOUDER = 2.5; // how far above the room's noise a voice has to be
const NOISE_CHUNKS = 35; // about 3 s: the room's noise is the quietest moment in this long
const ONSET_WINDOW = 5; // a phrase starts with ONSET_VOICED chunks of voice among the last ONSET_WINDOW,
const ONSET_VOICED = 3; // about 250 ms: a click, a thump or a cough doesn't last
const LEAD_CHUNKS = ONSET_WINDOW + 4; // the moment before that, kept so no first word is cut
const HIGH_PASS = Math.exp((-2 * Math.PI * 90) / RATE); // below about 90 Hz there's no voice: rumble, thumps
const LAG_MIN = Math.round(RATE / 400); // a voice's pitch is between 400 Hz
const LAG_MAX = Math.round(RATE / 80); // and 80 Hz
const VOICED = 0.5; // how alike one pitch period has to be to the next

/** Float samples as little-endian 16-bit PCM bytes. */
function pcmBytes(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Float samples as base64 16-bit PCM (OpenAI's live transcription takes it). */
export const pcm16 = (samples) => base64(pcmBytes(samples));

/** Chunks of float samples as one base64 WAV file (24 kHz, mono, 16-bit). */
export function wav(chunks) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  let at = 44;
  for (const chunk of chunks) {
    bytes.set(pcmBytes(chunk), at);
    at += chunk.length * 2;
  }
  return base64(bytes);
}

/**
 * How strongly samples repeat at a voice's pitch, 0 to 1, and the period it
 * repeats at (in samples). A voice repeats; typing, breath and fans don't.
 */
export function pitchOf(samples) {
  const length = samples.length - LAG_MAX - 1;
  if (length < LAG_MAX) return { strength: 0, lag: 0 };
  let front = 0;
  for (let i = 0; i < length; i += 1) front += samples[i] * samples[i];
  if (!front) return { strength: 0, lag: 0 };
  const alike = (lag) => {
    let cross = 0;
    let back = 0;
    for (let i = 0; i < length; i += 1) {
      const later = samples[i + lag];
      cross += samples[i] * later;
      back += later * later;
    }
    return back ? cross / Math.sqrt(front * back) : 0;
  };
  // The best real peak: right after a low rumble the signal is merely still like itself.
  let best = { strength: 0, lag: 0 };
  let before = alike(LAG_MIN - 1);
  let here = alike(LAG_MIN);
  for (let lag = LAG_MIN; lag < LAG_MAX; lag += 1) {
    const after = alike(lag + 1);
    if (here > before && here >= after && here > best.strength) best = { strength: here, lag };
    before = here;
    here = after;
  }
  return best;
}

/**
 * Speech or not, chunk by chunk. Speech is a voice (it repeats at a pitch)
 * louder than the room's noise, for long enough; a pause long enough ends the
 * phrase, and only a voice holds a pause open. The room's noise is the quietest
 * moment of the last few seconds, so a fan that comes on soon counts as the
 * room, and a machine's hum holds its pitch and level as no voice does.
 * send(chunk) while speaking, commit() at each pause.
 */
export function createPauseDetector({ send, commit, chunkMs = (CHUNK / RATE) * 1000, pauseMs = PAUSE_MS }) {
  const levels = new Array(NOISE_CHUNKS).fill(FLOOR / 2);
  let levelAt = 0;
  let inputWas = 0;
  let outputWas = 0;
  let last = { level: 0, lag: 0 };
  let speaking = false;
  let quietMs = 0;
  let spokenMs = 0;
  let onset = [];
  const lead = [];

  /** Is this chunk a voice? (Keeps the filter and the noise level going, so it's called once per chunk.) */
  function hear(samples) {
    const filtered = new Float32Array(samples.length);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      outputWas = HIGH_PASS * (outputWas + samples[i] - inputWas);
      inputWas = samples[i];
      filtered[i] = outputWas;
      sum += outputWas * outputWas;
    }
    const level = Math.sqrt(sum / samples.length);
    const noise = Math.min(...levels);
    levels[levelAt] = level;
    levelAt = (levelAt + 1) % NOISE_CHUNKS;
    if (level <= Math.max(FLOOR, noise * LOUDER)) {
      last = { level, lag: 0 };
      return false;
    }
    const { strength, lag } = pitchOf(filtered);
    const held = lag && last.lag && Math.abs(lag - last.lag) <= 1 && Math.abs(level - last.level) <= level * 0.1;
    last = { level, lag };
    return strength >= VOICED && !held;
  }

  return {
    push(samples) {
      const voice = hear(samples);
      if (!speaking) {
        lead.push(samples);
        if (lead.length > LEAD_CHUNKS) lead.shift();
        onset.push(voice);
        if (onset.length > ONSET_WINDOW) onset.shift();
        if (onset.filter(Boolean).length < ONSET_VOICED) return;
        speaking = true;
        quietMs = 0;
        spokenMs = 0;
        onset = [];
        for (const chunk of lead.splice(0)) send(chunk);
        return;
      }
      send(samples);
      spokenMs += chunkMs;
      quietMs = voice ? 0 : quietMs + chunkMs;
      if (quietMs >= pauseMs || spokenMs >= LONGEST_MS) {
        speaking = false;
        commit();
      }
    },
    /** Stopping mid-phrase: what was said is a phrase. */
    end() {
      if (speaking) commit();
      speaking = false;
      lead.length = 0;
      onset = [];
    },
    speaking: () => speaking,
  };
}

/**
 * Open the mic: onChunk(samples) for every `chunk` samples (~85 ms by
 * default); close() stops the capture itself.
 */
export async function openMic({ onChunk, chunk = CHUNK }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO });
  const context = new AudioContext({ sampleRate: RATE });
  const source = context.createMediaStreamSource(stream);
  // A ScriptProcessor needs no module file (which the page's rules would have to allow).
  const node = context.createScriptProcessor(chunk, 1, 1);
  node.onaudioprocess = (event) => onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(context.destination);
  let open = true;
  return {
    close() {
      if (!open) return;
      open = false;
      node.onaudioprocess = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        /* already apart */
      }
      stream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    },
  };
}
