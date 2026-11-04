import assert from 'node:assert/strict';
import { fixDictation } from '../src/renderer/js/dictationfixes.js';

assert.equal(fixDictation('open cloud code'), 'open Claude code');
assert.equal(fixDictation('Cloud and CLOUD'), 'Claude and Claude');
assert.equal(fixDictation('two clouds'), 'two Claudes');
assert.equal(fixDictation('a cloudy day, cloudflare'), 'a cloudy day, cloudflare');
assert.equal(fixDictation(''), '');

// "Uh" and "um" are left out, and what's around them still reads right.
for (const [said, written] of [
  ['Uh, fix the login bug.', 'Fix the login bug.'],
  ['uh fix the login bug', 'fix the login bug'],
  ['So, uh, we should run the tests.', 'So, we should run the tests.'],
  ['So uh we should run the tests.', 'So we should run the tests.'],
  ['So uh, we should run the tests.', 'So, we should run the tests.'],
  ['Run the tests, um, then ship it.', 'Run the tests, then ship it.'],
  ['I think, uh.', 'I think.'],
  ['I think uh.', 'I think.'],
  ['Done. Uh, what next?', 'Done. What next?'],
  ['Uhh, umm, okay.', 'Okay.'],
  ['Uhm.', ''],
  ['Uh.', ''],
  ['uh', ''],
  ['UH, stop.', 'Stop.'],
]) assert.equal(fixDictation(said), written, said);

// Words that only look like it stay; so does what has none (the "…" of a phrase being heard).
for (const kept of ['Uh-huh, that works.', 'The umbrella and the uhaul.', 'A summary of the plum.', 'Fix the thumb drive.', '…', '... and then, wait.']) assert.equal(fixDictation(kept), kept);
console.log('dictation fixes ok');
