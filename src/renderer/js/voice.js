import { fixDictation } from './dictationfixes.js';
import { MIC_AUDIO, openMic, createPauseDetector, pcm16, wav } from './mic.js';
import { createPhrases } from './dictationphrases.js';

/**
 * Dictation into the text box you're in (a rename, a Settings field, the prompt
 * bar; move to another mid-sentence and the words follow). Anywhere else (the
 * terminal, a button, the mic itself) the chat comes back and they go in its
 * prompt bar. Never a password or key field. Only finished words go in the box,
 * a phrase at a time, so what's there doesn't change under you; the mic shows when
 * a phrase is still being heard. Stopping it (the mic, Ctrl+Shift+M,
 * ` (backtick) or Esc) leaves what you said in the box to edit and send
 * yourself (Enter).
 *
 * NVIDIA Canary-Qwen 2.5B on this PC, a phrase at a time (main canary.js). If
 * it isn't set up or can't load: with a key, Deepgram, OpenAI
 * (gpt-live-transcribe) or OpenRouter, in that order; else Windows' speech engine.
 */

export function initVoice(ctx) {
  let listening = false;
  let starting = false;
  let dg = null;
  let oa = null; // OpenAI or OpenRouter dictation: { mic, gate }
  let clips = Promise.resolve(); // Canary, OpenRouter: phrases being heard, in order
  let clipsOut = 0; // Canary, OpenRouter: how many of them
  const phrases = createPhrases(); // Canary: the live engine's rough words, should hearing a phrase fail

  const input = () => document.querySelector('.composer-input');
  const mics = () => document.querySelectorAll('.mic-btn');
  // A box we may write in: no password or key fields, and not the terminal's hidden one.
  const isTextBox = (node) => node instanceof HTMLElement && node.matches('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"]') && !node.disabled && !node.readOnly && !node.closest('.xterm');
  // Where the words go: a text box other than the prompt bar; null: the prompt bar.
  let target = null;
  let marked = null; // the box saying "Listening…"
  let sessions = 0; // each start and stop: what a stop's late steps check before acting

  function mark(box) {
    if (marked && marked.dataset.placeholder !== undefined) {
      marked.placeholder = marked.dataset.placeholder;
      delete marked.dataset.placeholder;
    }
    marked = box;
    if (!box) return;
    box.dataset.placeholder = box.placeholder;
    box.placeholder = 'Listening… speak now';
  }

  function setListening(value) {
    listening = value;
    for (const mic of mics()) {
      mic.classList.toggle('is-listening', value);
      mic.setAttribute('aria-pressed', String(value));
      mic.title = value ? 'Stop dictating (Ctrl+Shift+M)' : 'Dictate (Ctrl+Shift+M)';
    }
    mark(value ? target || input() : null);
  }

  function joined(base, text) {
    let clean = fixDictation(String(text || '').replace(/\s+/g, ' ').trim());
    if (!clean) return base;
    // Start of the prompt or a new sentence: capitalise the first letter.
    if (!base || /[.!?]$/.test(base)) clean = clean[0].toUpperCase() + clean.slice(1);
    return base ? `${base} ${clean}` : clean;
  }

  /** Where the words go now: the box you chose while it's still there, else the prompt bar, on screen and focused. */
  function destination() {
    if (target?.isConnected && target.getClientRects().length) return target;
    if (target) mark(input());
    target = null;
    const box = input();
    if (!box) return null;
    // (A last phrase landing after you stopped goes in quietly: you may have moved on.)
    if (listening && !box.offsetParent) ctx.showChat();
    if (listening && document.activeElement !== box) box.focus();
    return box;
  }

  function show(value) {
    const box = destination();
    if (!box) return;
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.setSelectionRange(box.value.length, box.value.length);
  }

  /** A finished phrase, after whatever's in the box now. */
  function append(text) {
    const box = destination();
    if (!box) return;
    const base = box.value.trimEnd();
    const value = joined(base, text);
    if (value === base) return;
    show(value);
    // (A Settings field saves on change; the prompt bar has no need of it.)
    if (target) box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** The mic says whether a phrase is still being heard: until its words land, there's nothing in the box to say so. */
  function clipOut(change) {
    clipsOut += change;
    for (const mic of mics()) mic.classList.toggle('is-hearing', clipsOut > 0);
  }

  // Moved to another box while dictating: the words follow.
  document.addEventListener('focusin', (event) => {
    if (!listening || !isTextBox(event.target)) return;
    const next = event.target === input() ? null : event.target;
    if (next === target) return;
    target = next;
    mark(event.target);
  });

  /* ---------------------- Deepgram, when keyed ----------------------- */

  async function startDeepgram(key) {
    const url = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&endpointing=300&keywords=Claude:2&keywords=Katana:2';
    // Open the socket and the mic together; audio recorded before it opens is queued.
    const socket = new WebSocket(url, ['token', key]);
    const queue = [];
    dg = { socket, recorder: null, stream: null };
    socket.onopen = () => queue.splice(0).forEach((chunk) => socket.send(chunk));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO });
    if (!dg || dg.socket !== socket) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const recorder = new MediaRecorder(stream);
    dg.recorder = recorder;
    dg.stream = stream;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
      else if (socket.readyState === WebSocket.CONNECTING) queue.push(event.data);
    };
    recorder.start(100);
    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const text = data?.channel?.alternatives?.[0]?.transcript;
      if (!text) return;
      if (data.is_final) append(text);
    };
    socket.onclose = (event) => {
      if (dg && dg.socket === socket) {
        if (event.code !== 1000) ctx.flash(`Deepgram closed the connection (${event.code}).`);
        stopDeepgram();
        setListening(false);
      }
    };
  }

  function stopDeepgram() {
    if (!dg) return;
    const { socket, recorder, stream } = dg;
    dg = null;
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* already stopped */
    }
    stream?.getTracks().forEach((track) => track.stop());
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
      socket.close();
    } catch {
      /* already closed */
    }
  }

  /* ----------------------- OpenAI, when keyed ----------------------- */

  /** OpenAI: the mic streams while you speak; each phrase's words come back once you pause. */
  async function startOpenAI() {
    const gate = createPauseDetector({
      send: (samples) => window.api.voice.audio(pcm16(samples)),
      commit: () => window.api.voice.commit(),
    });
    oa = { gate, mic: await openMic({ onChunk: (samples) => gate.push(samples) }) };
  }

  /** Canary or OpenRouter: each phrase is heard when you pause, and its words land when they come back. */
  async function startClips(hear) {
    let audio = [];
    const gate = createPauseDetector({
      send: (samples) => {
        phrases.begin();
        audio.push(samples);
      },
      commit: () => {
        const clip = wav(audio);
        audio = [];
        const phrase = phrases.end();
        clipOut(1);
        clips = clips.then(async () => {
          const reply = await hear(clip).catch((error) => ({ error: error.message }));
          if (reply?.error) ctx.flash(`Dictation: ${reply.error}`);
          // (It couldn't be heard properly: the rough words are better than none.)
          append(reply?.error ? phrases.rough(phrase) : reply?.text);
          clipOut(-1);
        });
      },
    });
    oa = { gate, mic: await openMic({ onChunk: (samples) => gate.push(samples) }) };
  }

  /** The phrase in progress is sent; the mic itself is closed. */
  function stopMic() {
    if (!oa) return;
    const { gate, mic } = oa;
    oa = null;
    gate.end();
    mic.close();
  }

  /* --------------------------- start, stop --------------------------- */

  async function start() {
    if (starting || listening) return;
    // The text box you're in; anywhere else, the prompt bar.
    const active = document.activeElement;
    target = isTextBox(active) && active !== input() ? active : null;
    const box = destination();
    if (!box) {
      ctx.flash('Open a chat to dictate into it.');
      return;
    }
    if (box.disabled) return;
    starting = true;
    sessions += 1;
    // Show the listening state at once; undo it if the engine fails to start.
    setListening(true);
    try {
      const result = await window.api.voice.start();
      if (result?.notice) ctx.flash(result.notice);
      // Stopped (Esc, the mic) while the engine was still starting: don't let it run on unseen.
      if (!listening) {
        if (result?.ok && !result.deepgramKey) window.api.voice.stop().catch(() => {});
        return;
      }
      if (result?.ok && result.deepgramKey) await startDeepgram(result.deepgramKey);
      else if (result?.ok && result.openai) await startOpenAI();
      else if (result?.ok && result.canary) await startClips((clip) => window.api.voice.canary(clip));
      else if (result?.ok && result.openrouter) await startClips((clip) => window.api.voice.clip(clip));
      else if (!result?.ok) {
        setListening(false);
        ctx.flash(result?.error || 'Voice input is unavailable.');
      }
      // Stopped while the mic was still opening: close it, or it would stay on unseen.
      if (!listening) {
        stopDeepgram();
        oa?.mic.close();
        oa = null;
      }
    } catch (error) {
      stopDeepgram();
      stopMic();
      window.api.voice.stop().catch(() => {});
      setListening(false);
      ctx.flash(error?.name === 'NotAllowedError' ? 'The microphone is blocked.' : error?.message || 'Could not start voice input.');
    } finally {
      starting = false;
    }
  }

  async function stop() {
    stopDeepgram();
    // The phrase in progress is sent and its words awaited (main does it for OpenAI).
    stopMic();
    // The mic is off now: it says so at once, whatever the last phrase still takes.
    const session = (sessions += 1);
    setListening(false);
    await clips;
    // (Dictating again already: its session is its own.)
    if (session !== sessions) return;
    try {
      await window.api.voice.stop();
    } catch {
      /* already stopped */
    }
    if (session !== sessions) return;
    setListening(false);
  }

  /** Stopping dictation leaves what you said in the prompt bar; you send it yourself. */
  const toggle = () => (listening ? stop() : start());

  // Ctrl+Shift+M, or ` (backtick) in a chat: dictation.
  document.addEventListener(
    'keydown',
    (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        toggle();
        return;
      }
      // Esc: stop dictating.
      if (event.key === 'Escape' && listening && !document.querySelector('.dialog:not(.is-leaving), .pop:not(.is-leaving)')) {
        event.preventDefault();
        stop();
        return;
      }
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || !event.isTrusted || event.repeat) return;
      if (event.target instanceof Element && event.target.closest('.xterm, .overlay, .pop, .dialog')) return;
      // `: dictation. In a box with text in it it's just a backtick (code in a prompt), as in a
      // key field, unless you're dictating, when it stops (without sending).
      if (event.key === '`' && ctx.chatShown()) {
        const box = document.activeElement;
        const field = box instanceof HTMLElement && box.matches('input, textarea');
        const typing = field && !listening && (!isTextBox(box) || box.value.trim());
        if (typing) return;
        event.preventDefault();
        toggle();
      }
    },
    true
  );

  window.api.voice.onError?.((message) => ctx.flash(`Dictation: ${message}`));
  window.api.voice.onText((text) => append(text));
  // The live engine's rough words, while a voice is being heard. (Not shown.)
  window.api.voice.onLive?.(({ text, settled }) => phrases.live(text, settled));
  window.api.voice.onState((state) => {
    if (state === 'stopped') setListening(false);
    else if (state === 'error') {
      setListening(false);
      ctx.flash('Voice input stopped. Check your microphone and Windows speech settings.');
    }
  });

  return { toggle, stop, isListening: () => listening };
}
