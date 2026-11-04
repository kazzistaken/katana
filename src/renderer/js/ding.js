/** A soft two-note chime when a task finishes (made here, no sound file). */

let audio = null;

/**
 * Done pressed: a soft thunk as it closes, then two warm rising mallet notes. Made here too.
 * (`context` is only for checking the sound offline.)
 */
export function doneSound(context) {
  try {
    audio = context ? audio : audio || new AudioContext();
    const out = context || audio;
    if (out.state === 'suspended' && !context) out.resume();
    const now = out.currentTime;
    const tone = (type, freq, at, peak, fade, endFreq) => {
      const osc = out.createOscillator();
      const gain = out.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + at);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + at + fade);
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(peak, now + at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + fade);
      osc.connect(gain).connect(out.destination);
      osc.start(now + at);
      osc.stop(now + at + fade + 0.02);
    };
    tone('sine', 190, 0, 0.2, 0.09, 70);
    for (const [freq, at] of [
      [880, 0.03],
      [1318.5, 0.12],
    ]) {
      tone('sine', freq, at, 0.13, 0.55);
      tone('sine', freq * 2.76, at, 0.025, 0.09); // The mallet's knock on the bar.
    }
  } catch {
    /* no audio device */
  }
}

export function ding() {
  try {
    audio = audio || new AudioContext();
    const now = audio.currentTime;
    for (const [freq, at] of [
      [1318.5, 0],
      [1975.5, 0.12],
    ]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.1, now + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.9);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + at);
      osc.stop(now + at + 1);
    }
  } catch {
    /* no audio device */
  }
}
