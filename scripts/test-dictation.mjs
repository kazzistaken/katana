import assert from 'node:assert/strict';
import { fixDictation } from '../src/renderer/js/dictationfixes.js';

assert.equal(fixDictation('open cloud code'), 'open Claude code');
assert.equal(fixDictation('Cloud and CLOUD'), 'Claude and Claude');
assert.equal(fixDictation('two clouds'), 'two Claudes');
assert.equal(fixDictation('a cloudy day, cloudflare'), 'a cloudy day, cloudflare');
assert.equal(fixDictation(''), '');
console.log('dictation fixes ok');
