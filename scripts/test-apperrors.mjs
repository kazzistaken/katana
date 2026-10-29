import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { addError, errorCount, summarize, errorsForPrompt, askToFix, MAX_ERRORS } from '../src/renderer/js/apperrors.js';

const require = createRequire(import.meta.url);
const { MARK, markedError, stderrError, crashError, lineSplitter } = require('../src/main/applog.js');

{
  // the log: new errors added, a repeat counts up instead of piling up, long text clipped, capped
  let log = addError([], { kind: 'console', message: 'Uncaught TypeError: x is undefined', detail: 'game.js:12', at: 1 });
  log = addError(log, { kind: 'console', message: 'Uncaught TypeError: x is undefined', at: 2 });
  log = addError(log, { kind: 'load-failed', message: 'ERR_FILE_NOT_FOUND (-6)', detail: 'file:///C:/g/missing.png', at: 3 });
  assert.equal(log.length, 2);
  assert.equal(log[0].count, 2);
  assert.equal(log[0].detail, 'game.js:12');
  assert.equal(errorCount(log), 3);
  assert.equal(addError([], { message: 'x'.repeat(900) })[0].message.length, 500);
  let many = [];
  for (let i = 0; i < MAX_ERRORS + 10; i += 1) many = addError(many, { kind: 'console', message: `e${i}` });
  assert.equal(many.length, MAX_ERRORS);
  assert.equal(many[0].message, 'e10', 'the oldest go first');
  assert.equal(errorCount(undefined), 0);
}

{
  // the question: a count and the first few, short
  let log = [];
  for (const m of ['a broke', 'b broke', 'c broke', 'd broke']) log = addError(log, { kind: 'uncaught', message: m });
  log = addError(log, { kind: 'uncaught', message: 'a broke' });
  const s = summarize(log);
  assert.equal(s.count, 5);
  assert.match(s.title, /logged 5 errors/);
  assert.deepEqual(s.lines, ['uncaught exception ×2: a broke', 'uncaught exception: b broke', 'uncaught exception: c broke', 'and 1 more']);
  assert.match(summarize(addError([], { kind: 'crash', message: 'quit' })).title, /1 error while it ran\. Fix it/);
}

{
  // what the agent gets: every error, with where it happened
  const text = errorsForPrompt(addError([], { kind: 'console', message: 'Boom', detail: 'app.js:3\nat f (app.js:3)' }));
  assert.match(text, /^\[App errors\]/);
  assert.match(text, /1\. \[console error\] Boom\n {3}app\.js:3\n {3}at f/);
}

{
  // ask-to-fix: nothing logged, nothing asked
  let asked = 0;
  const ask = async () => (asked += 1, true);
  assert.deepEqual(await askToFix('make it blue', [], ask), { text: 'make it blue', clear: false });
  assert.equal(asked, 0);
  // yes: the errors go with the message, and the log is handled
  const log = addError([], { kind: 'console', message: 'Boom' });
  const yes = await askToFix('make it blue', log, ask);
  assert.equal(asked, 1);
  assert.ok(yes.text.startsWith('make it blue\n\n[App errors]'));
  assert.match(yes.text, /Boom/);
  assert.equal(yes.clear, true);
  // no: the message goes as it is, and the log is still handled (dismissed)
  let seen = null;
  const no = await askToFix('make it blue', log, async (summary) => ((seen = summary), false));
  assert.deepEqual(no, { text: 'make it blue', clear: true });
  assert.equal(seen.count, 1);
}

{
  // what the app prints: the hook's marked lines are errors; Chromium's own logging isn't
  const line = `${MARK}${JSON.stringify({ kind: 'uncaught', message: 'x is not defined', detail: 'stack' })}`;
  assert.deepEqual(markedError(line), { kind: 'uncaught', message: 'x is not defined', detail: 'stack' });
  assert.deepEqual(markedError(`junk before ${line}`)?.kind, 'uncaught');
  assert.equal(markedError(`${MARK}{not json`), null);
  assert.equal(markedError('plain output'), null);
  assert.equal(stderrError('[1234:5678:1029/162743.598:ERROR:wgc_capture_session.cc(277)] The target source has been closed.'), null);
  assert.equal(stderrError('(node:1) DeprecationWarning: Buffer() is deprecated'), null);
  assert.equal(stderrError('listening on 3000'), null);
  assert.equal(stderrError('   '), null);
  assert.deepEqual(stderrError('TypeError: Cannot read properties of undefined'), { kind: 'stderr', message: 'TypeError: Cannot read properties of undefined', detail: '' });
  // ended with a failure code: a crash with its last words; a clean end or a stop isn't
  assert.equal(crashError(0, null), null);
  assert.equal(crashError(null, null), null);
  const crash = crashError(3, null, ['a', 'b']);
  assert.match(crash.message, /exit code 3/);
  assert.equal(crash.detail, 'a\nb');
  // whole lines only, as they arrive
  const split = lineSplitter();
  assert.deepEqual(split('one\r\ntw'), ['one']);
  assert.deepEqual(split('o\nthree\n'), ['two', 'three']);
}

console.log('apperrors ok');
