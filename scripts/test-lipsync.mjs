import assert from 'node:assert/strict';
import { wordPhones, textPhones, numberWords, isVowel } from '../src/renderer/js/g2p.js';
import {
  visemesOf, phoneDuration, layoutWords, fromAlignment, alignToEnvelope, expectedCurve, envelopeOf, envAt, mouthAt, jawFrom,
  createWordTimer, createFollower, onSpeechCue, speechCue,
} from '../src/renderer/js/lipsync.js';
import { VISEMES, VISEME_NAMES, PARAMS, spring } from '../src/renderer/js/facecore.js';

const say = (w) => wordPhones(w).join(' ');
const syllables = (w) => wordPhones(w).filter(isVowel).length;

// Text to phonemes: common words from the list, the rest by rule, with endings, numbers, initials and pauses.
{
  assert.equal(say('the'), 'DH AH0');
  assert.equal(say('Katana'), 'K AH0 T AA1 N AH0');
  assert.equal(say("don't"), 'D OW1 N T');
  assert.equal(say('make'), 'M EY1 K', 'a silent e makes the vowel long');
  assert.equal(say('phone'), 'F OW1 N');
  assert.equal(say('moon'), 'M UW1 N');
  assert.equal(say('night'), 'N AY1 T');
  assert.equal(say('station'), 'S T EY1 SH AH0 N');
  assert.equal(say('think'), 'TH IH1 NG K');
  assert.equal(say('speech'), 'S P IY1 CH');
  assert.equal(say('cat'), 'K AE1 T');
  assert.equal(say('city'), 'S IH1 T IY0', 'c before i is s');
  assert.equal(say('kitten').split(' ')[0], 'K');
  assert.equal(say('knew'), 'N UW1', 'a silent k');
  assert.equal(say('watches'), 'W AA1 CH IH0 Z');
  assert.equal(say('started'), 'S T AA1 R T IH0 D', 'a known word with an ending');
  assert.equal(say('finished').split(' ').at(-1), 'D');
  assert.equal(say('running'), 'R AH1 N IH0 NG', 'its doubled n is one');
  assert.equal(say('API'), 'EY1 P IY1 AY1', 'initials are spelled');
  assert.equal(say('npm'), 'EH1 N P IY1 EH1 M', 'so is a word with no vowel');
  assert.equal(syllables('beautiful'), 3);
  assert.equal(syllables('computer'), 3);
  assert.equal(syllables('simple'), 2);
  assert.equal(syllables('table'), 2);
  // Every word gets one main stress.
  for (const w of ['computer', 'station', 'problem', 'remember', 'window', 'terminal']) assert.equal(wordPhones(w).filter((p) => p.endsWith('1')).length, 1, w);
  assert.equal(numberWords(42), 'forty two');
  assert.equal(numberWords(1905), 'one thousand nine hundred five');
  assert.deepEqual(textPhones('3.5').map((w) => w.phones.join(' ')), ['TH R IY1 P OY1 N T F AY1 V']);
  const words = textPhones('Hi, there. OK — 2 tasks & done');
  assert.deepEqual(words.map((w) => w.text), ['Hi', 'there', 'OK', '2', 'tasks', '&', 'done']);
  assert.deepEqual(words.map((w) => w.pause), ['comma', 'stop', 'comma', '', '', '', 'stop']);
  assert.deepEqual([words[1].start, words[1].end], [4, 9], 'where each word is in the text');
  assert.deepEqual(textPhones('… !'), []);
}

// Phonemes to mouth shapes.
{
  const v = (p) => visemesOf(p).map(([name]) => name).join('+');
  for (const [phones, viseme] of [
    ['M B P', 'mbp'], ['F V', 'fv'], ['TH DH', 'th'], ['S Z', 'sz'], ['SH ZH CH JH', 'sh'], ['K G NG', 'kg'], ['T D N', 'tdn'], ['L', 'l'], ['W', 'w'],
    ['R ER1', 'er'], ['IY1 Y', 'ee'], ['UW1 UH1', 'uw'], ['AA1', 'ah'], ['AE1 AH0', 'ae'], ['EH1 IH0', 'eh'], ['AO1', 'oh'],
  ])
    for (const p of phones.split(' ')) assert.equal(v(p), viseme, p);
  assert.equal(v('AY1'), 'ah+ee', 'a gliding vowel is two shapes');
  assert.equal(v('OW1'), 'oh+uw');
  assert.deepEqual(visemesOf('HH'), [], 'h takes its vowel’s shape');
  // Every shape a sound can have is one she can make.
  const all = 'AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH'.split(' ');
  for (const p of all) for (const [name] of visemesOf(p)) assert.ok(VISEMES[name], `${p}: ${name}`);
  assert.ok(phoneDuration('AA1') > phoneDuration('AH0'), 'unstressed vowels are short');
  for (const name of ['ae', 'eh', 'uw', 'er', 'w', 'l', 'th', 'sz', 'sh', 'kg', 'tdn']) assert.ok(VISEME_NAMES.includes(name), name);
  assert.ok(VISEMES.uw.width < VISEMES.oh.width && VISEMES.uw.open < VISEMES.oh.open, 'oo rounder and closer than oh');
  assert.ok(VISEMES.th.tongue > 0.5 && VISEMES.rest.tongue === 0, 'th shows her tongue');
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
const vowelsOf = (segs) => segs.filter((s) => s.stress >= 0);

// Laying words out: in order, back to back, their pauses as silence, faster at a faster rate.
{
  const words = textPhones('Hello there, Katana. Make it so.');
  const { segs, end, starts } = layoutWords(words);
  for (let i = 1; i < segs.length; i += 1) near(segs[i].s, segs[i - 1].e, 1e-9, `back to back at ${i}`);
  assert.equal(starts[0], 0);
  assert.ok(end > 1.2 && end < 3.2, `a natural pace (${end.toFixed(2)} s)`);
  const pauses = segs.filter((s) => !s.p && s.word >= 0);
  assert.equal(pauses.length, 3, 'a pause after the comma and each full stop');
  assert.ok(pauses[0].e - pauses[0].s < pauses[1].e - pauses[1].s, 'a comma is shorter than a full stop');
  const fast = layoutWords(words, { rate: 2 });
  near(fast.end, end / 2, 1e-9, 'twice the rate, half the time');
}

// Exact times (ElevenLabs' characters): each word where its characters are, a pause where they leave a gap.
{
  const text = 'Make it, now';
  const st = [];
  const en = [];
  // M a k e: 0.10–0.42; space; i t: 0.45–0.60; ", ": a gap until 1.0; n o w: 1.0–1.3.
  const times = [[0.1, 0.18], [0.18, 0.3], [0.3, 0.38], [0.38, 0.42], [0.42, 0.45], [0.45, 0.52], [0.52, 0.6], [0.6, 0.7], [0.7, 1.0], [1.0, 1.1], [1.1, 1.2], [1.2, 1.3]];
  for (const [s, e] of times) st.push(s), en.push(e);
  const { segs, words } = fromAlignment({ characters: [...text], character_start_times_seconds: st, character_end_times_seconds: en });
  assert.equal(words.length, 3);
  const first = (k) => segs.find((s) => s.word === k && s.p);
  const last = (k) => segs.findLast((s) => s.word === k && s.p);
  near(first(0).s, 0.1, 1e-9, 'make starts with its m');
  near(last(0).e, 0.42, 1e-9, 'and ends with its e');
  near(first(1).s, 0.45, 1e-9, 'it');
  near(first(2).s, 1.0, 1e-9, 'now');
  assert.ok(segs.some((s) => !s.p && s.s >= 0.6 - 1e-9 && s.e <= 1.0 + 1e-9), 'the comma’s gap is a pause');
  assert.equal(fromAlignment(null), null);
  assert.equal(fromAlignment({ characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [] }), null);
}

// Windows' word boundaries: each word starts when the voice says so, and the rest follows at the pace it keeps.
{
  const text = 'one two three four five six seven eight';
  const timer = createWordTimer(text, 1);
  timer.start(0);
  const words = timer.words;
  // (What was already shown of a word before its boundary stays in the past.)
  const startOf = (k, after = -1) => timer.segs().find((s) => s.word === k && s.p && s.s >= after - 1e-9).s;
  // The voice is slower than the usual lengths: each word 1.6 times as long.
  let t = 0.06;
  for (let k = 0; k < 5; k += 1) {
    timer.word(words[k].start, t);
    near(startOf(k, t), t, 1e-9, `word ${k} starts at its boundary`);
    const usual = words[k].phones.reduce((a, p) => a + phoneDuration(p), 0);
    t += usual * 1.6;
  }
  assert.ok(timer.pace() < 0.85, `she's learnt the slower pace (${timer.pace().toFixed(2)})`);
  // What's ahead is laid out at that pace: the next word's start is near where it'll really be.
  near(startOf(5, t - 0.2), t, 0.08, 'the next word, predicted');
  for (const s of timer.segs()) assert.ok(s.e >= s.s, 'no sound runs backwards');
  timer.stop(t + 0.1);
  assert.ok(timer.end() <= t + 0.1 + 1e-9);
  assert.ok(mouthAt(timer.segs(), t + 0.45).open < 0.3, 'at rest after');
}

// Fitting to the sound: words laid out by usual lengths, moved to where the envelope says they were said.
{
  const words = textPhones('So I started the build, and it passed. Now I am checking the logs for you.');
  const guess = layoutWords(words).segs;
  // The real voice: words stretched unevenly, a longer pause, starting late.
  let t = 0.35;
  const real = [];
  words.forEach((w, k) => {
    const stretch = 0.8 + 0.5 * Math.abs(Math.sin(k * 1.7));
    const lay = layoutWords([w], { start: t, rate: 1 / stretch, lead: 0, tail: 0 });
    real.push(...lay.segs.map((s) => ({ ...s, word: k })));
    t = lay.end + (w.pause === 'stop' ? 0.25 : 0);
  });
  const fps = 100;
  const length = Math.ceil((t + 0.4) * fps);
  const curve = expectedCurve(real, fps, length);
  // A little noise, as a recording has.
  const values = curve.map((v, i) => Math.min(1, Math.max(0, v + 0.04 * Math.sin(i * 12.9898) * Math.cos(i * 4.1))));
  const aligned = alignToEnvelope(guess, { fps, values });
  const centres = (segs) => vowelsOf(segs).map((s) => (s.s + s.e) / 2);
  const truth = centres(real);
  const fit = centres(aligned);
  assert.equal(fit.length, truth.length);
  const err = fit.map((c, i) => Math.abs(c - truth[i])).sort((a, b) => a - b);
  const median = err[err.length >> 1];
  // Against only stretching the guess over the voiced span.
  const s0 = guess.find((s) => s.p).s;
  const s1 = guess.findLast((s) => s.p).e;
  const r0 = real[0].s;
  const r1 = real.at(-1).e;
  const linear = centres(guess).map((c, i) => Math.abs(r0 + ((c - s0) * (r1 - r0)) / (s1 - s0) - truth[i])).sort((a, b) => a - b);
  assert.ok(median < 0.045, `vowels land near where they were said (median ${(median * 1000).toFixed(0)} ms)`);
  assert.ok(median < linear[linear.length >> 1] * 0.75, `better than stretching (${(median * 1000).toFixed(0)} vs ${(linear[linear.length >> 1] * 1000).toFixed(0)} ms)`);
  for (let i = 1; i < aligned.length; i += 1) assert.ok(aligned[i].s >= aligned[i - 1].s && aligned[i].e > aligned[i].s, 'in order, none vanished');
  // Nothing to fit to: as it was.
  assert.equal(alignToEnvelope(guess, { fps, values: new Float32Array(200) }), guess);
}

// The envelope of a recording: loud where it's loud, on a 0..1 scale; read between frames.
{
  const rate = 8000;
  const samples = new Float32Array(rate);
  for (let i = rate * 0.25; i < rate * 0.5; i += 1) samples[i] = 0.5 * Math.sin(i * 0.3);
  for (let i = rate * 0.6; i < rate * 0.7; i += 1) samples[i] = 0.05 * Math.sin(i * 0.9);
  const env = envelopeOf(samples, rate);
  assert.equal(env.values.length, 100);
  assert.ok(envAt(env, 0.35) > 0.9 && envAt(env, 0.1) < 0.05, 'loud, and silent');
  assert.ok(envAt(env, 0.65) > 0.2 && envAt(env, 0.65) < envAt(env, 0.35), 'quieter, but heard');
  assert.equal(envAt(env, 5), 0);
  assert.deepEqual([...envelopeOf(new Float32Array(800), rate).values], new Array(10).fill(0), 'silence is all 0');
  // At a recording's own rate (an odd number of samples a frame), too.
  const odd = new Float32Array(22050);
  for (let i = 5000; i < 9000; i += 1) odd[i] = 0.3 * Math.sin(i * 0.05);
  const oddEnv = envelopeOf(odd, 22050);
  assert.ok(oddEnv.values.every(Number.isFinite), 'no gaps between frames');
  assert.ok(envAt(oddEnv, 0.3) > 0.9 && envAt(oddEnv, 0.8) < 0.05);
  assert.ok(jawFrom(0) < jawFrom(0.5) && jawFrom(0.5) < jawFrom(1) && jawFrom(1) <= 1.1);
}

// Her mouth: lips close for m/b/p and touch her teeth for f/v however fast; fast speech undershoots; stressed vowels hold; pauses rest.
{
  const lay = (text, rate = 1) => layoutWords(textPhones(text), { rate }).segs;
  for (const rate of [1, 2.2]) {
    const segs = lay('mama papa bob, five vivid fives', rate);
    for (const s of segs.filter((x) => x.v === 'mbp')) {
      const m = mouthAt(segs, (s.s + s.e) / 2);
      assert.ok(m.press > 0.95 && m.open < 0.4, `lips closed for ${s.p} at rate ${rate} (press ${m.press.toFixed(2)}, open ${m.open.toFixed(2)})`);
    }
    for (const s of segs.filter((x) => x.v === 'fv')) assert.ok(mouthAt(segs, (s.s + s.e) / 2).tuck > 0.75, `lip to teeth for ${s.p} at rate ${rate}`);
  }
  // A stressed ah: wide open, and held through its middle.
  const father = lay('father');
  const ah = father.find((s) => s.v === 'ah');
  const peak = mouthAt(father, (ah.s + ah.e) / 2).open;
  assert.ok(peak > VISEMES.ah.open * 0.75, `ah opens (${peak.toFixed(1)})`);
  for (let f = 0.3; f <= 0.7; f += 0.05) assert.ok(mouthAt(father, ah.s + (ah.e - ah.s) * f).open > peak * 0.85, 'held');
  // Fast, the same vowel isn't reached as fully.
  const quick = lay('father', 2.5);
  const qa = quick.find((s) => s.v === 'ah');
  assert.ok(mouthAt(quick, (qa.s + qa.e) / 2).open < peak * 0.95, 'fast speech undershoots');
  // A t or k takes the vowel's lips (o rounds them early, before the t).
  const too = lay('too');
  const tt = too.find((s) => s.p === 'T');
  assert.ok(mouthAt(too, (tt.s + tt.e) / 2).round > 0.4, 'lips already rounding on the t of too');
  const tea = lay('tea');
  assert.ok(mouthAt(tea, (tea[1].s + tea[1].e) / 2).width > 1.05, 'and spreading on the t of tea');
  // A full stop's pause: back to rest; before and after the words: rest.
  const two = lay('I am here. You are there.');
  const stop = two.find((s) => !s.p && s.word === 2);
  const mid = mouthAt(two, (stop.s + stop.e) / 2);
  for (const p of PARAMS) near(mid[p], VISEMES.rest[p], p === 'open' ? 0.4 : 0.12, `rest in the pause: ${p}`);
  assert.ok(mouthAt(two, -1).open < 0.05 && mouthAt(two, 99).open < 0.05);
  // Smooth: between frames her mouth never jumps (raw, and through the face's springs).
  const segs = lay('Hello, I am Katana. I can start a task for you, watch it, and tell you when it is done.');
  const end = segs.at(-1).e;
  let jump = 0;
  for (let t = -0.2; t < end; t += 0.001) jump = Math.max(jump, Math.abs(mouthAt(segs, t + 0.001).open - mouthAt(segs, t).open));
  assert.ok(jump < 0.5, `no step in her mouth (${jump.toFixed(2)} px a millisecond)`);
  const springs = Object.fromEntries(PARAMS.map((p) => [p, { x: VISEMES.rest[p], v: 0 }]));
  let frame = 0;
  let prev = 0;
  for (let t = -0.2; t < end; t += 1 / 60) {
    const m = mouthAt(segs, t);
    for (const p of PARAMS) spring(springs[p], m[p], 1 / 60, 38);
    frame = Math.max(frame, Math.abs(springs.open.x - prev));
    prev = springs.open.x;
  }
  assert.ok(frame < VISEMES.ah.open * 0.3, `no snapping at 60 fps (${frame.toFixed(2)} px a frame)`);
  // Cheap enough for every frame.
  const t0 = performance.now();
  for (let i = 0; i < 20000; i += 1) mouthAt(segs, (i / 20000) * end);
  const each = (performance.now() - t0) / 20000;
  assert.ok(each < 0.05, `${(each * 1000).toFixed(1)} µs a frame`);
}

// A live voice: words as they come, followed while she's heard; quiet skips to the pause; nothing to show without words.
{
  const f = createFollower();
  assert.equal(f.step(1 / 60, 0.5), null, 'no words yet');
  f.add('Sure, I can do ');
  assert.ok(f.segs().length > 0, 'whole words are taken as they come');
  f.add('that.');
  f.flush();
  let t = 0;
  for (let i = 0; i < 20; i += 1) t = f.step(1 / 60, 0.6);
  assert.ok(t > 0.2 && t < 0.5, `moving along while heard (${t?.toFixed(2)})`);
  const before = t;
  for (let i = 0; i < 30; i += 1) t = f.step(1 / 60, 0);
  const pause = f.segs().find((s) => !s.p && s.word >= 0);
  assert.ok(t >= pause.s, `quiet: at the comma's pause (${t.toFixed(2)} ≥ ${pause.s.toFixed(2)})`);
  assert.ok(t > before);
  for (let i = 0; i < 400; i += 1) t = f.step(1 / 60, 0.6);
  assert.equal(f.step(1 / 60, 0.6), null, 'past her words: the sound alone');
  f.reset();
  assert.equal(f.segs().length, 0);
  // Heard before its words came: when they do, she's already into them.
  const g = createFollower();
  for (let i = 0; i < 12; i += 1) g.step(1 / 60, 0.6);
  g.add('Hello there friend ');
  near(g.step(1 / 60, 0.6), 0.2 + 1 / 60, 0.03, 'caught up');
}

// Cues: where her voice plays tells her face.
{
  const got = [];
  const stop = onSpeechCue((type, data) => got.push([type, data.text]));
  speechCue('stream', { text: 'hi' });
  stop();
  speechCue('stream', { text: 'unheard' });
  assert.deepEqual(got, [['stream', 'hi']]);
}

console.log('lipsync: ok');
