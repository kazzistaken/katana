import assert from 'node:assert/strict';
import { matchWake } from '../src/renderer/js/wake.js';

// Her name at the start (a greeting before it is fine) wakes her; what follows is the request.
assert.deepEqual(matchWake('Katana.'), { wake: true, rest: '' });
assert.deepEqual(matchWake('Hey Katana!'), { wake: true, rest: '' });
assert.deepEqual(matchWake('Hey, Katana, start a task to fix the cart.'), { wake: true, rest: 'start a task to fix the cart.' });
assert.deepEqual(matchWake('Okay Katana what is running?'), { wake: true, rest: 'what is running?' });

// How speech to text mishears her name.
for (const heard of ['Catana', 'Katanna', 'hey Kitana', 'Hey Cotana, open the settings.', 'ka tana']) assert.equal(matchWake(heard).wake, true, heard);
assert.equal(matchWake('Hey Cotana, open the settings.').rest, 'open the settings.');

// Her name anywhere else, or other names, don't.
for (const heard of ['I left my katana at home.', 'Banana.', 'hey Canada', 'Hey Siri, play some music.', 'The weather is nice.', '']) assert.equal(matchWake(heard).wake, false, heard);

console.log('wake ok');
