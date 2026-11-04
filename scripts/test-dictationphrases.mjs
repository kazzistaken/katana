// What the live engine heard of each phrase (src/renderer/js/dictationphrases.js): kept out of sight, for when hearing it properly fails.
import assert from 'node:assert/strict';
import { createPhrases } from '../src/renderer/js/dictationphrases.js';

// Its guesses replace each other, and stay once the phrase has been said.
{
  const p = createPhrases();
  const one = p.begin();
  assert.equal(p.rough(one), '', 'nothing until it hears something');
  p.live('fix');
  p.live('fixed login');
  assert.equal(p.rough(one), 'fixed login');
  assert.equal(p.end(), one);
  assert.equal(p.rough(one), 'fixed login');
}

// The next phrase is its own, while an earlier one is still out.
{
  const p = createPhrases();
  const one = p.begin();
  p.live('first words', true);
  p.end();
  const two = p.begin();
  p.live('second');
  p.end();
  assert.equal(p.rough(one), 'first words');
  assert.equal(p.rough(two), 'second');
}

// The live engine can settle several times within what you think of as one phrase.
{
  const p = createPhrases();
  const one = p.begin();
  p.live('one two');
  p.live('one two', true);
  p.live('three');
  assert.equal(p.rough(one), 'one two three');
}

// Words it hears when nobody's speaking are ignored.
{
  const p = createPhrases();
  p.live('the fan', true);
  assert.equal(p.rough(p.begin()), '');
}

// No phrase, no words.
assert.equal(createPhrases().rough(null), '');

// A long phrase cut in two mid-sentence: the second doesn't repeat the first's words.
{
  const p = createPhrases();
  p.begin();
  p.live('a very long');
  p.end();
  const two = p.begin();
  assert.equal(p.rough(two), '');
  p.live('a very long sentence');
  assert.equal(p.rough(two), 'sentence');
  // A new sentence, heard from the start, isn't mistaken for it.
  p.live('a very long sentence', true);
  p.live('another');
  assert.equal(p.rough(two), 'sentence another');
}

console.log('dictation phrases ok');
