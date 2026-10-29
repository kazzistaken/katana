import { meterStream, rms } from './meter.js';
import { openMic, RATE } from './mic.js';
import { createBargeInDetector, heardWords } from './bargein.js';
import { speechCue } from './lipsync.js';

/**
 * Talking with Katana out loud, through GPT-Live (OpenAI's voice model).
 * GPT-Live listens and speaks, full duplex; whenever there's something to
 * do or find out it delegates (client delegation), and the request goes to
 * Katana herself (agent.js: her Claude turn, Opus, with the app's tools).
 * Her answer goes back as commentary, which GPT-Live says in its own words.
 *
 * The connection is WebRTC: the mic on one track, her voice on the other,
 * JSON events on the "oai-events" channel. Main makes the session (it holds
 * the key): we send it our offer, it returns OpenAI's answer.
 *
 * GPT-Live sends no request text with a delegation, only an id, so what
 * you said since the last one (the input transcript) is the request.
 *
 * Barge-in: while she's audible the mic sends GPT-Live silence, so a
 * noise or her own voice coming back can't cut her off. A copy of the mic
 * is heard here (bargein.js); sustained speech mutes her at once and lets
 * the mic through, and GPT-Live hearing words of yours (its input
 * transcript) makes it stick. None within a moment and she's heard again.
 * With barge-in off, the mic stays shut while she speaks.
 *
 * Events (on): { type: 'state' | 'heard' | 'said' }.
 */

export const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'juni', 'willow', 'vesper', 'quartz'];

// GPT-Live's own prompt: how to talk and when to hand things to Katana.
const INSTRUCTIONS = `You are Katana, the voice of a coding app on the user's computer. You talk with the user; Katana's backend (delegate to it) does every piece of real work: it can see and control the whole app (start, check, stop and finish coding tasks, read their terminals and answers, change settings, themes and what is on screen, folders, reminders, recurring checks like "tell me when CI is green") and can read files and search the web.

Delegate every request that needs something done, looked up, or known about the app, the user's tasks or their code. Never guess what a task is doing. Answer only greetings, small talk and quick clarifying questions yourself.

When you delegate, say a very short acknowledgement (two or three words, varied, like "On it." or "Checking.") and wait. When the result arrives, say it briefly in your own words. If something needs the user's decision, ask it plainly.

Speak in short, calm sentences, like a colleague sitting next to them. Never read out ids, long paths, code or Markdown; summarise them. If the user says goodbye or asks you to stop listening, delegate that too.`;

const SPEAKING_MS = 900; // words this recent: she's still speaking
const SETTLE_MS = 450; // a delegation lands a moment before your last words do
const CLOSE_MS = 8000;
const APPEND_CHARS = 1600; // about the 500-token limit of an append
const EAR_CHUNK = 1024; // about 43 ms
const AUDIBLE_MS = 500; // her voice this recent: she may still be coming through the speakers
const QUIET_MS = 400; // cut off, and her stream silent this long: whatever comes next is heard
const CONFIRM_MS = 2500; // cut off, and no words of yours heard by then: a false alarm

const clip = (text, max) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export function createLive({ api, store, agent, ctx }) {
  let state = 'off'; // off | connecting | live | closing
  let peer = null;
  let channel = null;
  let mic = null;
  let audio = null;
  let closeTimer = 0;
  let unmeter = () => {};
  let nextEvent = 0;
  // What you've said since Katana last heard it; this turn's words, for the screen.
  let pending = '';
  let heard = '';
  let said = '';
  let lastSaid = '';
  let saidAt = 0;
  let saidTimer = 0;
  let delegated = false; // this turn went to Katana (her reply is logged, not this voice's)
  // Barge-in: the copy of the mic heard here, when her voice last sounded, and whether you cut her off.
  let ear = null;
  let detector = null;
  let soundAt = 0;
  let cut = ''; // '' | 'checking' (muted, waiting for your words) | 'cut' (muted until she's done)
  let cutHeard = '';
  let cutTimer = 0;
  const listeners = new Set();
  const emit = (type) => listeners.forEach((fn) => fn({ type }));

  const send = (event) => {
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify({ event_id: `katana_${Date.now()}_${(nextEvent += 1)}`, ...event }));
    return true;
  };

  function setState(next) {
    state = next;
    emit('state');
  }

  /* ------------------------------ turns ------------------------------ */

  /** This voice's turn ended: keep what it said, unless Katana's reply already is. */
  function closeSaid() {
    const text = said.trim();
    said = '';
    if (!text) return;
    lastSaid = text;
    if (!delegated) store.agentSay('agent', text, { voice: true });
  }

  /** Your turn ended: it goes into the conversation. */
  function closeHeard() {
    const text = heard.trim();
    heard = '';
    if (text) store.agentSay('user', text, { voice: true });
  }

  function onInput(delta) {
    if (said && Date.now() - saidAt > SPEAKING_MS) closeSaid();
    if (!heard) delegated = false;
    heard += delta;
    pending += delta;
    if (cut === 'checking') {
      cutHeard += delta;
      // Your words, not hers coming back: she stays cut off.
      if (heardWords(cutHeard, `${lastSaid} ${said}`)) {
        cut = 'cut';
        clearTimeout(cutTimer);
      }
    }
    emit('heard');
  }

  /* ----------------------------- barge-in ----------------------------- */

  /** A copy of the call's mic, heard here for you talking over her. */
  async function listenOver(stream) {
    detector = createBargeInDetector({ sensitivity: store.state.settings.bargeInSensitivity, chunkMs: (EAR_CHUNK / RATE) * 1000 });
    try {
      const opened = await openMic({ stream, chunk: EAR_CHUNK, onChunk: overheard });
      if (mic !== stream) return opened.close();
      ear = opened;
    } catch (error) {
      // Without it the mic simply isn't shut while she speaks: GPT-Live's own turn-taking decides.
      console.warn('[live] no barge-in', error);
    }
    return undefined;
  }

  /** A mic chunk: is she audible, are you talking over her; then the mic open or shut. */
  function overheard(samples) {
    if (!detector || !mic) return;
    const now = Date.now();
    const her = rms();
    if (her > 0.005) soundAt = now;
    const audible = now - soundAt < AUDIBLE_MS || (Boolean(said) && now - saidAt < SPEAKING_MS);
    const fired = detector.push(samples, her);
    if (fired && audible && !cut && store.state.settings.bargeIn !== false) cutOff();
    // Cut off, and she's gone quiet (GPT-Live stopped her, or she finished): she's heard again.
    if (cut === 'cut' && now - soundAt > QUIET_MS) restore();
    const open = !audible || Boolean(cut);
    for (const track of mic.getAudioTracks()) if (track.enabled !== open) track.enabled = open;
  }

  /** You talking over her: she's muted at once, and GPT-Live hears you. */
  function cutOff() {
    cut = 'checking';
    cutHeard = '';
    if (audio) audio.muted = true;
    clearTimeout(cutTimer);
    const started = Date.now();
    const check = () => {
      if (cut !== 'checking') return;
      // Still talking: GPT-Live may send its words once you pause.
      if (detector?.active() && Date.now() - started < CONFIRM_MS * 4) {
        cutTimer = setTimeout(check, 300);
        return;
      }
      // No words of yours: a noise, or her echo. She's heard again, and that sound is learned.
      detector?.reject();
      restore();
    };
    cutTimer = setTimeout(check, CONFIRM_MS);
  }

  function restore() {
    cut = '';
    cutHeard = '';
    clearTimeout(cutTimer);
    if (audio) audio.muted = false;
  }

  function onOutput(delta) {
    if (heard) closeHeard();
    said += delta;
    // Her face follows the words as they come, at the pace her voice is heard.
    speechCue('stream', { text: delta });
    saidAt = Date.now();
    clearTimeout(saidTimer);
    saidTimer = setTimeout(() => {
      closeSaid();
      emit('said');
    }, SPEAKING_MS * 3);
    emit('said');
  }

  /** GPT-Live handed something over: Katana does it, then GPT-Live says how it went. */
  async function onDelegation(id) {
    delegated = true;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const words = (pending.trim() || heard.trim() || lastSaid).trim();
    pending = '';
    const context = lastSaid ? `\nJust before, Katana's voice had said: "${clip(lastSaid, 300)}"` : '';
    const reply = await agent.ask(`The user said: "${clip(words, 2000)}"${context}`, { kind: 'voice', log: false }).catch((error) => ({ error: error?.message || 'Something went wrong.' }));
    if (state !== 'live') return;
    const text = reply.error ? `That didn't work: ${reply.error}` : reply.reply || 'Done.';
    send({ type: 'session.commentary.append', delegation_id: id, content: clip(text, APPEND_CHARS) });
  }

  function onEvent(event) {
    switch (event.type) {
      case 'session.started':
        setState('live');
        greet();
        break;
      case 'session.input_transcript.delta':
        onInput(String(event.delta || ''));
        break;
      case 'session.output_transcript.delta':
        onOutput(String(event.delta || ''));
        break;
      case 'session.delegation.created':
        if (event.delegation?.target === 'client' || !event.delegation?.target) onDelegation(event.delegation?.id);
        break;
      case 'session.closed':
        cleanup();
        break;
      case 'error':
        console.warn('[live]', event.error);
        if (event.error?.message) ctx.flash(`GPT-Live: ${event.error.message}`);
        break;
      default:
        break;
    }
  }

  /** What she knows from the start (quietly), then hello. */
  function greet() {
    const { projects, agent: talk } = store.state;
    const open = store.openTasks();
    const recent = talk.messages
      .filter((m) => m.role === 'user' || m.role === 'agent')
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'User' : 'Katana'}: ${clip(m.text, 160)}`)
      .join('\n');
    const name = ctx.userName();
    send({
      type: 'session.thinking.append',
      delegation_id: null,
      content: clip(
        `The user${name ? ` is ${name}` : ''}. Trusted folders: ${projects.map((p) => p.name).join(', ') || 'none yet'}. Open tasks: ${open.length}.${recent ? `\nThe conversation so far:\n${recent}` : ''}`,
        APPEND_CHARS
      ),
    });
    send({ type: 'session.commentary.append', delegation_id: null, content: `Say hi${name ? ` to ${name}` : ''} in a few words and wait.` });
  }

  // Katana spoke up on her own (a reminder, a typed reply): say it. A finished task is only written.
  agent.on(({ type, text, kind }) => {
    if (type === 'reply' && kind !== 'voice' && kind !== 'finished' && state === 'live') send({ type: 'session.commentary.append', delegation_id: null, content: clip(`Tell the user: ${text}`, APPEND_CHARS) });
  });

  /* --------------------------- connection ---------------------------- */

  async function start() {
    if (state !== 'off') return;
    setState('connecting');
    try {
      const connection = new RTCPeerConnection();
      peer = connection;
      audio = new Audio();
      audio.autoplay = true;
      connection.addEventListener('track', (event) => {
        audio.srcObject = new MediaStream([event.track]);
        audio.play().catch(() => {});
        // Measured as it comes: her mouth moves with GPT-Live's voice.
        unmeter = meterStream(audio.srcObject);
      });
      connection.addEventListener('connectionstatechange', () => {
        if (peer === connection && ['failed', 'closed'].includes(connection.connectionState) && state !== 'off') {
          ctx.flash('The voice connection dropped.');
          cleanup();
        }
      });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // Hung up while the mic was being allowed: close it again, or its light stays on.
      if (peer !== connection) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mic = stream;
      for (const track of mic.getAudioTracks()) connection.addTrack(track, mic);
      listenOver(mic);
      // The event channel exists before the offer, so the offer includes it.
      channel = connection.createDataChannel('oai-events');
      channel.addEventListener('message', ({ data }) => {
        try {
          onEvent(JSON.parse(data));
        } catch (error) {
          console.warn('[live] bad event', error);
        }
      });
      channel.addEventListener('close', () => state !== 'off' && cleanup());
      await connection.setLocalDescription(await connection.createOffer());
      await gathered(connection);
      if (peer !== connection) return;
      const reply = await api.live.start({ sdp: connection.localDescription.sdp, voice: store.state.settings.liveVoiceName, instructions: INSTRUCTIONS });
      if (peer !== connection) return;
      if (reply?.error) throw new Error(reply.error);
      await connection.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
    } catch (error) {
      ctx.flash(error?.name === 'NotAllowedError' ? 'Katana can’t hear you: the microphone is blocked.' : error?.message || String(error));
      cleanup();
    }
  }

  /** Every route out found (the offer carries them all). */
  function gathered(connection) {
    if (connection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (connection.iceGatheringState !== 'complete') return;
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', done);
        resolve();
      };
      // Whatever was found by then will do.
      const timer = setTimeout(() => {
        connection.removeEventListener('icegatheringstatechange', done);
        resolve();
      }, 4000);
      connection.addEventListener('icegatheringstatechange', done);
    });
  }

  /** Hang up: GPT-Live finishes up (session.closed), then everything stops. */
  function stop() {
    if (state === 'off' || state === 'closing') return;
    if (state === 'connecting' || !send({ type: 'session.close' })) {
      cleanup();
      return;
    }
    setState('closing');
    closeTimer = setTimeout(cleanup, CLOSE_MS);
  }

  function cleanup() {
    clearTimeout(closeTimer);
    clearTimeout(saidTimer);
    closeHeard();
    closeSaid();
    pending = '';
    restore();
    ear?.close();
    ear = null;
    detector = null;
    mic?.getTracks().forEach((track) => track.stop());
    const closing = channel;
    channel = null;
    try {
      closing?.close();
    } catch {
      /* already closed */
    }
    unmeter();
    unmeter = () => {};
    speechCue('stream-end');
    peer?.close();
    peer = null;
    mic = null;
    if (audio) audio.srcObject = null;
    audio = null;
    if (state !== 'off') setState('off');
  }

  window.addEventListener('beforeunload', () => {
    send({ type: 'session.close' });
    cleanup();
  });

  return {
    start,
    stop,
    toggle: () => (state === 'off' ? start() : stop()),
    active: () => state !== 'off',
    state: () => state,
    /** What you're saying now, and what she's saying (or just said). */
    heard: () => heard,
    said: () => said,
    // Cut off by you, she isn't (whatever GPT-Live is still sending).
    speaking: () => !cut && Boolean(said) && Date.now() - saidAt < SPEAKING_MS,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
