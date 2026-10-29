import { openMic, createPauseDetector, wav, RATE, CHUNK } from './mic.js';

/**
 * "Katana" / "hey Katana": a wake word, so you can talk to her without
 * touching anything. While the window is open (and Settings → Katana →
 * "Listen for Katana" is on, with an OpenRouter key), the mic listens in the
 * background; each short burst of speech (up to a few seconds) is heard by
 * OpenRouter's speech to text, and if it starts with her name she wakes,
 * wherever you are in the app: Talk opens (the mic turns mint) and Tab sends,
 * as always; a request said with her name ("Katana, start a task to…") is
 * already the start of what you're saying.
 * It pauses while you talk to her, dictate, or she speaks, so she never
 * wakes herself.
 */

const PAUSE_MS = 550; // a wake phrase is short: a shorter pause ends it
const SHORTEST_MS = 300; // a cough, a click
const LONGEST_MS = 6000; // anything longer isn't asking for her

// Her name, and how speech to text tends to mishear it.
const NAMES = ['katana', 'katanna', 'katanah', 'catana', 'cattana', 'kutana', 'cutana', 'cotana', 'kotana', 'katona', 'kitana', 'katan', 'katarna', 'catanna'];
const GREETINGS = new Set(['hey', 'hi', 'ok', 'okay', 'yo', 'hello', 'oi', 'hay', 'a']);

/** Edit distance, small words only. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
}

const isName = (word) => NAMES.includes(word) || (word.length >= 5 && word.length <= 8 && distance(word, 'katana') <= 2 && /^[kc]/.test(word));

/**
 * Whether what was heard calls her: { wake, rest } — `rest` is what came
 * after her name ("start a task to…"), '' when it was her name alone.
 */
export function matchWake(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // "Ka tana" heard as two words.
  for (let i = 0; i < words.length - 1; i += 1) {
    if (isName(words[i] + words[i + 1]) && !isName(words[i])) words.splice(i, 2, words[i] + words[i + 1]);
  }
  let at = 0;
  while (at < words.length && GREETINGS.has(words[at]) && at < 2) at += 1;
  const name = words[at]?.replace(/'s$/, '');
  if (!name || !isName(name)) return { wake: false, rest: '' };
  // The rest, as it was said (punctuation kept), after her name.
  const original = String(text || '').trim();
  const found = original.toLowerCase().search(new RegExp(`${name.slice(0, 3)}[a-z]*`));
  const rest = found >= 0 ? original.slice(found).replace(/^[a-z']+[\s,.!?:;-]*/i, '').trim() : '';
  return { wake: true, rest };
}

export function createWake({ api, store, ctx, busy, onWake }) {
  let mic = null;
  let starting = false;
  let phrase = [];
  let heldBack = false; // paused while she's in use
  let hearing = Promise.resolve();
  const chunkMs = (CHUNK / RATE) * 1000;

  const wanted = () => store.state.settings.wakeWord !== false && ctx.routerKey() && !heldBack;

  async function start() {
    if (mic || starting || !wanted()) return;
    starting = true;
    const gate = createPauseDetector({
      send: (samples) => phrase.push(samples),
      commit: () => {
        const clip = phrase;
        phrase = [];
        const ms = clip.length * chunkMs;
        if (ms < SHORTEST_MS || ms > LONGEST_MS) return;
        // One at a time, in order; a wake while another is being heard is fine.
        hearing = hearing.then(() => listen(clip)).catch((error) => console.warn('[wake]', error));
      },
      pauseMs: PAUSE_MS,
    });
    try {
      const opened = await openMic({ onChunk: (samples) => gate.push(samples) });
      if (!wanted()) opened.close();
      else mic = opened;
    } catch (error) {
      console.warn('[wake] no mic', error);
    } finally {
      starting = false;
    }
  }

  function stop() {
    mic?.close();
    mic = null;
    phrase = [];
  }

  async function listen(clip) {
    if (!mic || busy()) return;
    const heard = await api.voice.clip(wav(clip)).catch(() => null);
    if (!heard?.text || !mic || busy()) return;
    const { wake, rest } = matchWake(heard.text);
    if (wake) onWake(rest);
  }

  /** Listen or not, as things stand: on, keyed, and she's not already in use. */
  function update() {
    heldBack = busy();
    if (wanted()) start();
    else stop();
  }

  // Checked now and then (a key added, a setting changed, a conversation over).
  setInterval(update, 1000);
  update();
  return { update, listening: () => Boolean(mic) };
}
