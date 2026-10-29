import { openMic, createPauseDetector, wav, RATE } from './mic.js';
import { meterElement, rms } from './meter.js';
import { createBargeInDetector, heardWords } from './bargein.js';
import { speechCue } from './lipsync.js';

/**
 * Talking with Katana through OpenRouter: voice that pauses instead of
 * calling. One tap opens the mic (mint while it's open, and only then);
 * it keeps listening through pauses, each phrase heard (speech to text) as
 * you go, and nothing is sent until the next tap: then what you said is
 * answered by Katana (her own turn, Opus) and said out loud (text to
 * speech). Esc (stop) throws it away unsent. If she asked you something, the mic opens again and waits at
 * least 20 s for the answer; "let's talk this through" keeps it opening
 * after each answer until you say you're done. Closing the mic stops the
 * capture itself, so Windows' mic light goes off; the conversation goes on
 * (she remembers), so the next tap carries on where you left off.
 *
 * Barge-in (Settings → Katana): while she speaks the mic listens too, and
 * talking over her (sustained speech, not a noise or her own voice back:
 * bargein.js) pauses her at once. If the speech engine hears words of yours
 * in it she stops for good, the rest of her reply is dropped, and what
 * you're saying is your next turn; if not, she carries on.
 *
 * Seen by the face like a GPT-Live call (chatview): active, state, heard,
 * said, speaking, label, micOpen. Events (on): { type: 'state' }.
 */

// Her voice (ElevenLabs through OpenRouter; main/openrouter.js has the same names).
export const SPEECH_VOICES = ['Rachel', 'Aria', 'Sarah', 'Charlotte', 'Alice', 'Matilda', 'Lily', 'Jessica', 'Laura', 'Brian', 'George'];

/**
 * Her reply in pieces to say one after another: sentences, joined while
 * short, so the first is ready to play almost at once while the rest are made.
 */
export function pieces(text) {
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)\s*/g) || [];
  const out = [];
  for (const sentence of sentences.map((x) => x.trim()).filter(Boolean)) {
    const last = out.at(-1);
    // The first piece stays short (it decides how soon she starts); later ones may grow.
    if (last && last.length + sentence.length < (out.length === 1 ? 60 : 220)) out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out;
}

const ONE_OFF_MS = 6000; // a tap and no words this long: the mic closes
const ASKED_MS = 20000; // she asked you something: it waits at least this

// What she says when you call her name: alone, she's listening; with a request, she heard it.
export const WAKE_REPLIES = {
  alone: ['Mhm?', 'What’s up?', 'Yeah?', 'I’m here.', 'Go ahead.', 'What do you need?', 'Listening.', 'Hey, what’s up?'],
  request: ['Mhm.', 'Got it.', 'Okay.', 'Sure.'],
};
const TALK_MS = 60000; // talking it through: each turn waits this long
const BARGE_CHUNK = 1024; // about 43 ms: barge-in hears in finer steps than a phrase needs
const BARGE_CHUNK_MS = (BARGE_CHUNK / RATE) * 1000;
const BARGE_RING = Math.ceil(900 / BARGE_CHUNK_MS); // kept from before she's cut off, so your first words are heard
const BARGE_CHECK = Math.ceil(450 / BARGE_CHUNK_MS); // this much more of you, then the speech engine checks for words
const OPENS = /\blet'?s talk (this|it) (through|over|out)\b|\btalk (this|it) through with me\b/i;
const ENDS = /\b(that'?s all|that'?s it for now|i'?m done|we'?re done|good ?bye|bye|stop listening)\b/i;

export function createTalk({ api, agent, store, ctx }) {
  let state = 'off'; // off | listening | hearing | thinking | speaking
  let mic = null;
  let gate = null;
  let phrase = [];
  let spoken = []; // phrases heard so far this turn, not yet sent
  let hearing = Promise.resolve(); // phrases being heard, in order
  let waitTimer = 0;
  let player = null; // { audio, url, done }
  let heard = '';
  let said = '';
  let talking = false; // "let's talk this through"
  let turn = 0; // a newer turn makes an older one's late answer moot
  let watch = null; // barge-in while she speaks: { mic, detector, ring, captured, hold, ... }
  const listeners = new Set();
  // Her wake replies, made in her voice once and kept: "voice|words" -> a speech (or its promise).
  const replies = new Map();
  let lastReply = '';

  /** A wake reply in her voice, made now if it wasn't already. */
  function replyClip(words) {
    const voice = store.state.settings.speechVoice;
    const key = `${voice}|${words}`;
    if (!replies.has(key)) {
      replies.set(
        key,
        api.speech.say(words, voice).then(
          (speech) => {
            if (speech?.error) replies.delete(key);
            return speech;
          },
          () => (replies.delete(key), null)
        )
      );
    }
    return replies.get(key);
  }

  /** One she didn't just say. */
  function pickReply(list) {
    const choices = list.filter((words) => words !== lastReply);
    lastReply = choices[Math.floor(Math.random() * choices.length)] || list[0];
    return lastReply;
  }

  function set(next) {
    state = next;
    listeners.forEach((fn) => fn({ type: 'state' }));
  }

  function closeMic() {
    clearTimeout(waitTimer);
    gate = null;
    mic?.close();
    mic = null;
    unwatch();
  }

  function hush() {
    if (!player) return;
    const { audio, url, done } = player;
    player = null;
    audio.pause();
    URL.revokeObjectURL(url);
    done();
  }

  function off() {
    turn += 1;
    closeMic();
    hush();
    talking = false;
    said = '';
    if (state !== 'off') set('off');
  }

  /**
   * Open the mic for a phrase; no words within `waitMs` and it closes.
   * `carry`: you talked over her, and the mic that heard it carries on,
   * what it heard first (`backlog`) the start of this phrase.
   */
  async function listen(waitMs, carry = null) {
    closeMic();
    phrase = [];
    spoken = [];
    hearing = Promise.resolve();
    heard = '';
    set('listening');
    const mine = turn;
    gate = createPauseDetector({
      send: (samples) => {
        phrase.push(samples);
        if (state === 'listening') {
          clearTimeout(waitTimer);
          set('hearing');
        }
      },
      commit: () => hearPhrase(mine),
      // Thinking out loud has longer pauses.
      pauseMs: talking ? 1100 : 800,
      chunkMs: carry ? BARGE_CHUNK_MS : undefined,
    });
    if (carry) {
      mic = carry.mic;
      carry.route((samples) => gate?.push(samples));
      for (const samples of carry.backlog) gate.push(samples);
    } else {
      try {
        const opened = await openMic({ onChunk: (samples) => gate?.push(samples) });
        if (mine !== turn || state === 'off') return opened.close();
        mic = opened;
      } catch (error) {
        ctx.flash(error?.name === 'NotAllowedError' ? 'Katana can’t hear you: the microphone is blocked.' : error?.message || 'The microphone didn’t open.');
        return off();
      }
    }
    waitTimer = setTimeout(() => state === 'listening' && off(), waitMs);
    return undefined;
  }

  /* ----------------------------- barge-in ----------------------------- */

  /** While she says `words`, the mic listens for you talking over her. */
  async function watchForYou(words, mine) {
    const { bargeIn, bargeInSensitivity } = store.state.settings;
    if (bargeIn === false) return undefined;
    unwatch();
    const w = { mic: null, detector: createBargeInDetector({ sensitivity: bargeInSensitivity, chunkMs: BARGE_CHUNK_MS }), ring: [], captured: null, checking: false, sink: null, hold: null, release: null, words, mine };
    watch = w;
    try {
      const opened = await openMic({ chunk: BARGE_CHUNK, onChunk: (samples) => (w.sink ? w.sink(samples) : overheard(w, samples)) });
      if (watch !== w || mine !== turn) return opened.close();
      w.mic = opened;
    } catch {
      // No barge-in this time (Tab still interrupts her).
      if (watch === w) watch = null;
    }
    return undefined;
  }

  function unwatch() {
    const w = watch;
    watch = null;
    if (!w) return;
    w.mic?.close();
    w.mic = null;
    letGo(w);
  }

  /** Her paused reply may go on (or, after a barge-in, find it's moot). */
  function letGo(w) {
    const release = w.release;
    w.hold = null;
    w.release = null;
    release?.();
  }

  /** A mic chunk while she speaks. */
  function overheard(w, samples) {
    if (watch !== w || w.mine !== turn) return;
    if (w.captured) {
      // She's paused: what you're saying is kept, and checked once there's enough of it.
      w.captured.push(samples);
      if (!w.checking && w.captured.length >= w.checkAt) checkWords(w);
      return;
    }
    w.ring.push(samples);
    if (w.ring.length > BARGE_RING) w.ring.shift();
    if (!w.detector.push(samples, rms())) return;
    // Speech before her voice started: it counts once she's speaking.
    if (state !== 'speaking') {
      w.detector.reset();
      return;
    }
    // You, talking over her: she pauses at once.
    player?.audio.pause();
    w.captured = w.ring.splice(0);
    w.checkAt = w.captured.length + BARGE_CHECK;
    w.hold = new Promise((resolve) => (w.release = resolve));
  }

  /** The speech engine decides: words of yours, and she stops; none (a noise, her echo), and she goes on. */
  async function checkWords(w) {
    w.checking = true;
    const reply = await api.voice.clip(wav(w.captured)).catch((error) => ({ error: error.message }));
    if (watch !== w || w.mine !== turn) return;
    // (Couldn't check: it was sustained speech, so she stays stopped.)
    if (!reply?.error && !heardWords(reply?.text, w.words)) {
      w.detector.reject();
      w.captured = null;
      w.checking = false;
      w.ring = [];
      player?.audio.play().catch(() => {});
      letGo(w);
      return;
    }
    // Everything she had left to say is dropped; the mic that heard you carries on into your turn.
    const carry = { mic: w.mic, backlog: w.captured, route: (fn) => (w.sink = fn) };
    w.mic = null;
    turn += 1;
    hush();
    said = '';
    listen(talking ? TALK_MS : ONE_OFF_MS, carry);
  }

  /** A pause: the phrase is heard and added to what you've said; the mic stays open. */
  function hearPhrase(mine) {
    if (!phrase.length) return;
    const clip = wav(phrase);
    phrase = [];
    hearing = hearing.then(async () => {
      const reply = await api.voice.clip(clip).catch((error) => ({ error: error.message }));
      if (mine !== turn) return;
      if (reply?.error) ctx.flash(reply.error);
      else if (reply?.text?.trim()) {
        spoken.push(reply.text.trim());
        heard = spoken.join(' ');
        set(state);
      }
    });
  }

  /** The tap that finishes: the mic closes, and what you said is answered and said out loud. */
  async function send() {
    const mine = turn;
    gate?.end(); // the phrase in progress is heard too
    closeMic();
    if (!heard) heard = '…';
    set('thinking');
    await hearing;
    if (mine !== turn) return;
    const text = spoken.join(' ');
    spoken = [];
    heard = text;
    if (!text) return talking ? listen(TALK_MS) : off();
    return answer(text, mine);
  }

  /** What you said, answered by her out loud; then the mic again if she asked something. */
  async function answer(text, mine) {
    if (OPENS.test(text)) talking = true;
    const ending = ENDS.test(text);
    if (ending) talking = false;
    set('thinking');
    const reply = await agent.ask(text, { kind: 'voice' }).catch((error) => ({ error: error?.message || 'Something went wrong.' }));
    if (mine !== turn) return;
    const words = reply.error ? `That didn’t work: ${reply.error}` : reply.reply || 'Done.';
    // Still "thinking" (no words on screen) until her voice is ready.
    try {
      await sayAloud(words, mine);
    } catch (error) {
      // A sound that wouldn't decode or play must not leave her stuck "thinking".
      if (mine !== turn) return;
      unwatch();
      said = '';
      ctx.flash(`Katana’s voice: ${error?.message || 'couldn’t play'}`);
    }
    if (mine !== turn) return;
    if (ending) return off();
    if (talking) return listen(TALK_MS);
    if (/\?\s*["”’)]?\s*$/.test(words)) return listen(ASKED_MS);
    return off();
  }

  /**
   * Her words out loud, a piece at a time: every piece is asked for at once,
   * each plays as soon as the one before it ends, and her words show as
   * they're said (none before her voice is ready).
   */
  async function sayAloud(words, mine) {
    const parts = pieces(words);
    const voice = store.state.settings.speechVoice;
    const speeches = parts.map((part) => api.speech.say(part, voice).catch((error) => ({ error: error.message })));
    watchForYou(words, mine);
    let shown = '';
    for (const [i, speech] of speeches.entries()) {
      const sound = await speech;
      // Paused between pieces by you talking: the next waits for the speech engine's word.
      while (watch?.hold && mine === turn) await watch.hold;
      if (mine !== turn) return;
      if (sound?.error) {
        ctx.flash(`Katana’s voice: ${sound.error}`);
        break;
      }
      shown = shown ? `${shown} ${parts[i]}` : parts[i];
      await play(
        sound,
        () => {
          said = shown;
          set('speaking');
        },
        parts[i]
      );
      if (mine !== turn) return;
    }
    while (watch?.hold && mine === turn) await watch.hold;
    if (mine !== turn) return;
    unwatch();
    said = '';
  }

  /** Play one piece (saying `text`); `started` when its sound begins. */
  function play({ audio: data, type, alignment }, started = () => {}, text = '') {
    return new Promise((resolve) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: type || 'audio/wav' }));
      const audio = new Audio(url);
      // Measured as it plays, and her face told what it says: her mouth moves with it.
      meterElement(audio);
      speechCue('clip', { audio, text, bytes, alignment });
      player = { audio, url, done: resolve };
      const end = () => {
        if (player?.audio === audio) hush();
      };
      audio.addEventListener('playing', started, { once: true });
      audio.addEventListener('ended', end);
      audio.addEventListener('error', end);
      // Paused at once by a barge-in is no failure: she may go on.
      audio.play().catch((error) => error?.name !== 'AbortError' && end());
    });
  }

  return {
    /** The one key: open the mic; while open, finish now; while she speaks, interrupt and listen. */
    tap() {
      if (state === 'off') {
        talking = false;
        return listen(ONE_OFF_MS);
      }
      if (state === 'listening') return off();
      if (state === 'hearing') return send();
      if (state === 'speaking') {
        turn += 1;
        hush();
        said = '';
        return listen(talking ? TALK_MS : ONE_OFF_MS);
      }
      return off();
    },
    /**
     * Woken by her name ("Katana", wake.js): the mic opens as a tap would, and
     * Tab sends, as always. A request said with her name ("Katana, start a…")
     * is the start of what you're saying: say more, or just press Tab.
     */
    async wake(request = '') {
      if (state !== 'off') return;
      talking = false;
      // She answers to her name out loud first ("Mhm?"), then listens: the mic
      // opens once she's said it, so it doesn't hear her.
      const mine = turn;
      const words = pickReply(request ? WAKE_REPLIES.request : WAKE_REPLIES.alone);
      const clip = await replyClip(words);
      if (mine !== turn || state !== 'off') return;
      if (clip?.audio) {
        await play(
          clip,
          () => {
            said = words;
            set('speaking');
          },
          words
        );
        said = '';
        if (mine !== turn) return;
      }
      await listen(ASKED_MS);
      const text = String(request || '').trim();
      if (!text || state === 'off') return;
      clearTimeout(waitTimer);
      spoken.push(text);
      heard = text;
      set('hearing');
    },
    /** Make her wake replies ahead of time (and again when her voice changes), so they play at once. */
    warm() {
      for (const words of [...WAKE_REPLIES.alone, ...WAKE_REPLIES.request]) replyClip(words);
    },
    stop: off,
    active: () => state !== 'off',
    state: () => state,
    heard: () => heard,
    said: () => said,
    speaking: () => state === 'speaking' || state === 'thinking',
    /** What the Talk key says now. */
    label: () => ({ listening: 'Listening', hearing: 'Listening', thinking: 'Thinking…', speaking: 'Speaking' })[state] || 'Talk to Katana',
    /** Mint means the mic is open, and nothing else does. */
    micOpen: () => state === 'listening' || state === 'hearing',
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
