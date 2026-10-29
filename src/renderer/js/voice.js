import { fixDictation } from './dictationfixes.js';
import { openMic, createPauseDetector, pcm16, wav } from './mic.js';

/**
 * Dictation into the chat's prompt bar, and only there: whatever else is focused or on screen (the terminal, Settings,
 * another box), the chat comes back and the words appear live in its prompt
 * bar as you speak; the finished phrase (with punctuation) replaces them
 * when you pause. Stopping it yourself (the mic, Ctrl+Shift+M,
 * ` (backtick) or Ctrl+Shift+M) sends what you said; Esc stops without sending. Windows'
 * speech engine by default; with a key, Deepgram, OpenAI (gpt-live-transcribe: words as you speak) or
 * OpenRouter (a phrase at a time, when you pause), in that order.
 */

export function initVoice(ctx) {
  let listening = false;
  let starting = false;
  // The box's text before the phrase being spoken, while one is in progress.
  let phraseBase = null;
  let dg = null;
  let oa = null; // OpenAI or OpenRouter dictation: { mic, gate }
  let clips = Promise.resolve(); // OpenRouter: phrases being heard, in order

  const input = () => document.querySelector('.composer-input');
  const mics = () => document.querySelectorAll('.mic-btn');

  function setListening(value) {
    listening = value;
    for (const mic of mics()) {
      mic.classList.toggle('is-listening', value);
      mic.setAttribute('aria-pressed', String(value));
      mic.title = value ? 'Stop and send (Ctrl+Shift+M)' : 'Dictate (Ctrl+Shift+M)';
    }
    const box = input();
    if (!box) return;
    if (value) {
      box.dataset.placeholder = box.placeholder;
      box.placeholder = 'Listening… speak now';
    } else if (box.dataset.placeholder !== undefined) {
      box.placeholder = box.dataset.placeholder;
      delete box.dataset.placeholder;
    }
  }

  function joined(base, text) {
    let clean = fixDictation(String(text || '').replace(/\s+/g, ' ').trim());
    if (!clean) return base;
    // Start of the prompt or a new sentence: capitalise the first letter.
    if (!base || /[.!?]$/.test(base)) clean = clean[0].toUpperCase() + clean.slice(1);
    return base ? `${base} ${clean}` : clean;
  }

  /** The prompt bar, on screen and focused. */
  function promptBar() {
    const box = input();
    if (!box) return null;
    if (!box.offsetParent) ctx.showChat();
    if (document.activeElement !== box) box.focus();
    return box;
  }

  function show(value) {
    const box = promptBar();
    if (!box) return;
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.setSelectionRange(box.value.length, box.value.length);
  }

  /** Live words while speaking: shown in the box, replaced by the final phrase. */
  function partial(text) {
    const box = input();
    if (!box) return;
    if (phraseBase === null) phraseBase = box.value.trimEnd();
    show(joined(phraseBase, text));
  }

  function append(text) {
    const box = input();
    if (!box) return;
    const base = phraseBase !== null ? phraseBase : box.value.trimEnd();
    phraseBase = null;
    show(joined(base, text));
  }

  // Typing yourself keeps what's in the box; the next phrase starts after it.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && event.target === input() && event.key.length === 1) phraseBase = null;
    },
    true
  );

  /* ---------------------- Deepgram, when keyed ----------------------- */

  async function startDeepgram(key) {
    const url = 'wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=true&endpointing=300&keywords=Claude:2';
    // Open the socket and the mic together; audio recorded before it opens is queued.
    const socket = new WebSocket(url, ['token', key]);
    const queue = [];
    dg = { socket, recorder: null, stream: null };
    socket.onopen = () => queue.splice(0).forEach((chunk) => socket.send(chunk));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      else partial(text);
    };
    socket.onclose = (event) => {
      if (dg && dg.socket === socket) {
        if (event.code !== 1000) ctx.flash(`Deepgram closed the connection (${event.code}).`);
        stopDeepgram();
        phraseBase = null;
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

  /** OpenAI: the mic streams while you speak; words come back as you say them. */
  async function startOpenAI() {
    const gate = createPauseDetector({
      send: (samples) => window.api.voice.audio(pcm16(samples)),
      commit: () => window.api.voice.commit(),
    });
    oa = { gate, mic: await openMic({ onChunk: (samples) => gate.push(samples) }) };
  }

  /** OpenRouter: each phrase is heard when you pause ("…" until its words come back). */
  async function startOpenRouter() {
    let phrase = [];
    const gate = createPauseDetector({
      send: (samples) => phrase.push(samples),
      commit: () => {
        const clip = wav(phrase);
        phrase = [];
        partial('…');
        clips = clips.then(async () => {
          const reply = await window.api.voice.clip(clip).catch((error) => ({ error: error.message }));
          if (reply?.error) ctx.flash(`Dictation: ${reply.error}`);
          append(reply?.text || '');
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
    const box = promptBar();
    if (!box) {
      ctx.flash('Open a chat to dictate into it.');
      return;
    }
    if (box.disabled) return;
    starting = true;
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
      else if (result?.ok && result.openrouter) await startOpenRouter();
      else if (!result?.ok) {
        setListening(false);
        ctx.flash(result?.error || 'Voice input is unavailable.');
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
    await clips;
    try {
      await window.api.voice.stop();
    } catch {
      /* already stopped */
    }
    phraseBase = null;
    setListening(false);
  }

  /** Stopping dictation yourself sends what you said. */
  async function stopAndSend() {
    await stop();
    const box = input();
    if (!box || !box.isConnected || !box.value.trim()) return;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  const toggle = () => (listening ? stopAndSend() : start());

  // Tab, anywhere (but the terminal): talk to Katana. ` (backtick) in a chat: dictation.
  document.addEventListener(
    'keydown',
    (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        toggle();
        return;
      }
      // Esc: stop listening and send nothing (talking with Katana, or dictating).
      if (event.key === 'Escape' && !document.querySelector('.dialog, .pop')) {
        const call = ctx.live?.();
        if (call?.active()) {
          event.preventDefault();
          call.stop();
        } else if (listening) {
          event.preventDefault();
          stop();
        }
        return;
      }
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || !event.isTrusted || event.repeat) return;
      if (event.target instanceof Element && event.target.closest('.xterm, .overlay, .pop, .dialog')) return;
      // Tab: Katana's key, on any tab (open the mic, then Tab again sends). Stops dictation if that's on.
      if (event.key === 'Tab') {
        event.preventDefault();
        if (listening) stopAndSend();
        else ctx.toggleVoice();
        return;
      }
      // `: dictation into the chat's prompt bar. With text already typed it's just a backtick
      // (code in a prompt), unless you're dictating, when it stops and sends.
      if (event.key === '`' && ctx.chatShown()) {
        const box = input();
        const typing = box && document.activeElement === box && box.value.trim() && !listening;
        if (typing) return;
        event.preventDefault();
        toggle();
      }
    },
    true
  );

  window.api.voice.onError?.((message) => ctx.flash(`Dictation: ${message}`));
  window.api.voice.onText((text) => append(text));
  window.api.voice.onPartial((text) => partial(text));
  window.api.voice.onState((state) => {
    if (state === 'stopped') setListening(false);
    else if (state === 'error') {
      setListening(false);
      ctx.flash('Voice input stopped. Check your microphone and Windows speech settings.');
    }
  });

  return { toggle, stop, isListening: () => listening };
}
