/**
 * Barge-in: talking over Katana while she speaks cuts her off. This is the
 * part that decides, chunk by chunk, whether the mic hears you or only the
 * room and her own voice coming back through the speakers. No DOM here, so
 * scripts/test-bargein.mjs runs it under Node.
 *
 * A chunk counts as your voice when it's louder than an adaptive threshold
 * (the room's noise floor, learned while it's quiet, and her playback level
 * times how much of it the mic picks up, learned while she speaks) and it
 * sounds like a voice: not a click (a sharp peak in a quiet chunk) and not
 * hiss or breath (mostly zero crossings). Only voice that lasts (`holdMs`,
 * short dips between syllables allowed) fires. Then the speech engine has
 * the last word: heardWords() says whether the clip held real words that
 * aren't hers echoed back.
 */

export const SENSITIVITIES = ['low', 'medium', 'high'];

// How sure it must be. Higher sensitivity: quieter and shorter speech fires.
export const LEVELS = {
  low: { holdMs: 500, noise: 4, echo: 4, min: 0.02 },
  medium: { holdMs: 400, noise: 3, echo: 3, min: 0.015 },
  high: { holdMs: 300, noise: 2.2, echo: 2.2, min: 0.01 },
};

const GAP_MS = 150; // a dip this short (between syllables) doesn't end the speech
const ECHO_MS = 250; // her playback this recent can still be coming back through the room
const MAX_ZCR = 0.3; // more zero crossings per sample than this: hiss, breath, a fan
const MAX_CREST = 9; // a peak this far above the chunk's level: a click or a key
const START_COUPLING = 0.6; // how much of her playback the mic hears, before it's learned
const MIN_COUPLING = 0.02;
const PLAYING = 0.005; // her playback louder than this: she's making sound
const RECOVER = 0.998; // a false alarm's raised bar falls back by this each chunk (about 20 s)

/** A chunk's loudness (RMS), zero crossings per sample, and peak over RMS. */
export function features(samples) {
  let sum = 0;
  let peak = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (i && (v >= 0) !== (samples[i - 1] >= 0)) crossings += 1;
  }
  const level = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { level, zcr: samples.length > 1 ? crossings / (samples.length - 1) : 0, crest: level ? peak / level : 0 };
}

/**
 * push(samples, playback) per mic chunk, with her playback level (RMS, 0
 * when she's silent): true on the chunk where sustained voice is confirmed,
 * once per stretch of speech. reject() after a false alarm (the speech
 * engine heard no words): what fired is learned as noise or echo, so the
 * same sound doesn't fire again.
 */
export function createBargeInDetector({ sensitivity = 'medium', chunkMs = (1024 / 24000) * 1000 } = {}) {
  const level = LEVELS[sensitivity] || LEVELS.medium;
  let floor = level.min / 4;
  let coupling = START_COUPLING;
  let recent = []; // her playback levels, newest last, over ECHO_MS
  let voicedMs = 0;
  let gapMs = 0;
  let fired = false;
  let heard = []; // levels of the chunks that counted as voice, this stretch
  let penalty = 1; // raised by a false alarm, falling back
  const keep = Math.max(1, Math.ceil(ECHO_MS / chunkMs));

  const echo = () => Math.max(0, ...recent);
  const threshold = () => Math.max(level.min, floor * level.noise, echo() * coupling * level.echo) * penalty;

  function quiet() {
    voicedMs = 0;
    gapMs = 0;
    fired = false;
    heard = [];
  }

  return {
    push(samples, playback = 0) {
      recent.push(Math.max(0, Number(playback) || 0));
      if (recent.length > keep) recent.shift();
      penalty = Math.max(1, penalty * RECOVER);
      const f = features(samples);
      const bar = threshold();
      const voiced = f.level > bar && f.zcr < MAX_ZCR && f.crest < MAX_CREST;
      if (!voiced) {
        // Not you: the room while she's silent, or her voice coming back while she isn't. Learn them.
        if (f.level <= bar) {
          const her = echo();
          if (her > PLAYING) coupling = Math.max(MIN_COUPLING, coupling * 0.9 + Math.min(2, f.level / her) * 0.1);
          else floor = f.level < floor ? floor * 0.7 + f.level * 0.3 : floor * 0.99 + f.level * 0.01;
        }
        if (voicedMs) {
          gapMs += chunkMs;
          if (gapMs > GAP_MS) quiet();
        }
        return false;
      }
      gapMs = 0;
      voicedMs += chunkMs;
      heard.push(f.level / bar);
      if (fired || voicedMs < level.holdMs) return false;
      fired = true;
      return true;
    },
    /**
     * A false alarm: that sound was noise or her echo. The bar rises above
     * most of it (each chunk's level was kept relative to the bar it beat)
     * and falls back over the next twenty seconds or so.
     */
    reject() {
      const over = heard.slice().sort((a, b) => a - b)[Math.floor(heard.length * 0.75)] || 1;
      penalty = Math.min(8, penalty * Math.max(1.25, over * 1.2));
      quiet();
    },
    /** Start a stretch over (what came before no longer counts). */
    reset: quiet,
    /** In a stretch of voice now (short dips included). */
    active: () => voicedMs > 0,
    threshold,
    floor: () => floor,
    coupling: () => coupling,
    penalty: () => penalty,
  };
}

// What speech to text makes of noise, breath or silence.
const FILLERS = new Set(['uh', 'um', 'umm', 'hm', 'hmm', 'mm', 'mhm', 'ah', 'oh', 'eh', 'er', 'erm', 'huh']);
// ...and what you say while listening, which isn't asking her to stop.
const PHANTOMS = new Set(['you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'bye', 'so', 'the', 'a', 'okay', 'ok', 'yeah', 'right', 'uh huh']);

const words = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The speech engine's check: did `text` (what it heard in the clip) hold
 * real words of yours? Not empty, not just fillers, not one of the phrases
 * it invents from noise (or a lone "yeah" of listening along), and not her
 * own words (`saying`) echoed back.
 */
export function heardWords(text, saying = '') {
  const heard = words(text).filter((word) => !FILLERS.has(word));
  if (!heard.length) return false;
  if (PHANTOMS.has(heard.join(' '))) return false;
  const hers = new Set(words(saying));
  if (!hers.size) return true;
  // Mostly her words: the mic heard her.
  const echoed = heard.filter((word) => hers.has(word)).length;
  return echoed / heard.length < 0.6;
}
