/** A soft two-note chime when a task finishes (made here, no sound file). */

let audio = null;

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
