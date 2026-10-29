/**
 * The microphone, for dictation and for talking with Katana: 24 kHz mono
 * chunks (openMic), whether they're speech (createPauseDetector: louder
 * than the room's own noise; a pause ends a phrase), and a phrase as a WAV
 * clip or PCM16 for the services that hear it (OpenAI, OpenRouter).
 * Closing it stops the capture itself, so Windows' mic light goes off.
 */

export const RATE = 24000;
export const CHUNK = 2048; // samples per chunk: about 85 ms
const PAUSE_MS = 700;
const LONGEST_MS = 20000; // a phrase this long is sent anyway
const LEAD_CHUNKS = 4; // the moment before speech starts, kept so no first word is cut
const FLOOR = 0.012; // quietest level that can count as speech

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
 * Speech or not, chunk by chunk: louder than the room's own noise (learned
 * while you're quiet) means speech; a pause long enough ends the phrase.
 * send(chunk) while speaking, commit() at each pause.
 */
export function createPauseDetector({ send, commit, chunkMs = (CHUNK / RATE) * 1000, pauseMs = PAUSE_MS }) {
  let noise = FLOOR / 2;
  let speaking = false;
  let quietMs = 0;
  let spokenMs = 0;
  const lead = [];
  return {
    push(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      const level = Math.sqrt(sum / samples.length);
      const loud = level > Math.max(FLOOR, noise * 2.5);
      if (!speaking) {
        if (!loud) {
          lead.push(samples);
          if (lead.length > LEAD_CHUNKS) lead.shift();
          noise = noise * 0.95 + level * 0.05;
          return;
        }
        speaking = true;
        quietMs = 0;
        spokenMs = 0;
        for (const chunk of lead.splice(0)) send(chunk);
        send(samples);
        return;
      }
      send(samples);
      spokenMs += chunkMs;
      quietMs = loud ? 0 : quietMs + chunkMs;
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
    },
    speaking: () => speaking,
  };
}

/**
 * Open the mic: onChunk(samples) for every `chunk` samples (~85 ms by
 * default); close() stops the capture itself. With `stream`, a mic already
 * open elsewhere (a GPT-Live call's) is heard through a copy of it.
 */
export async function openMic({ onChunk, chunk = CHUNK, stream: shared = null }) {
  // Echo cancellation and noise suppression: her voice from the speakers and the room stay out.
  const stream = shared ? shared.clone() : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
