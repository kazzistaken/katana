// Tasks naming themselves (src/daemon/tasktitle.js), with a stand-in for the model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTitler, cleanTitle } = require('../src/daemon/tasktitle.js');

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
let uuid = 0;
const said = (text, extra = {}) => ({ type: 'user', uuid: `u${(uuid += 1)}`, timestamp: new Date().toISOString(), message: { role: 'user', content: text }, ...extra });

function setup({ named = {}, answer = (n) => `Title ${n}`, slow = 0 } = {}) {
  const asked = [];
  const titles = [];
  let live = 0;
  let peak = 0;
  const titler = createTitler({
    generate: async ({ prompt }) => {
      asked.push(prompt);
      live += 1;
      peak = Math.max(peak, live);
      if (slow) await tick(slow);
      live -= 1;
      return answer(asked.length);
    },
    emit: (channel, payload) => titles.push({ channel, ...payload }),
    taskOf: (id) => ({ title: 'Now', named: Boolean(named[id]) }),
  });
  return { titler, asked, titles, named, peak: () => peak };
}

/* Every message gets a new title, from what was said lately. */
{
  const { titler, asked, titles } = setup();
  titler.lines('a', [said('Fix the login bug')]);
  await tick();
  assert.deepEqual(titles, [{ channel: 'task:title', id: 'a', title: 'Title 1' }]);
  titler.lines('a', [said('Now add a dark mode')]);
  await tick();
  assert.equal(titles.at(-1).title, 'Title 2');
  assert.match(asked[1], /Current title: Now/);
  assert.match(asked[1], /1\. Fix the login bug\n2\. Now add a dark mode/);
}

/* Renamed: never again, even if the rename lands while a call is out. */
{
  const s = setup({ named: { a: true } });
  s.titler.lines('a', [said('Fix it')]);
  await tick();
  assert.equal(s.asked.length, 0, 'no call at all for a named task');
  assert.equal(s.titles.length, 0);
  const late = setup({ slow: 20 });
  late.titler.lines('b', [said('Fix it')]);
  await tick();
  late.named.b = true;
  await tick(40);
  assert.equal(late.asked.length, 1);
  assert.equal(late.titles.length, 0, 'the answer is dropped');
}

/* Only what you wrote counts. */
{
  const { titler, asked } = setup();
  titler.lines('a', [
    said('<system-reminder>hello</system-reminder>'),
    said('<command-name>/clear</command-name>'),
    said('[Request interrupted by user]'),
    said('meta', { isMeta: true }),
    said('from a sub-agent', { isSidechain: true }),
    { type: 'user', uuid: 'tool', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } },
  ]);
  await tick();
  assert.equal(asked.length, 0);
}

/* A resumed session's old lines, or the same line read twice, aren't new messages. */
{
  const { titler, asked } = setup();
  titler.lines('a', [said('from last week', { timestamp: new Date(Date.now() - 86_400_000).toISOString() })]);
  await tick();
  assert.equal(asked.length, 0);
  const line = said('once');
  titler.lines('a', [line]);
  titler.lines('a', [line]);
  await tick();
  assert.equal(asked.length, 1);
}

/* Messages during a call become one more call, with all of them. */
{
  const { titler, asked } = setup({ slow: 20 });
  titler.lines('a', [said('one')]);
  await tick();
  titler.lines('a', [said('two')]);
  titler.lines('a', [said('three')]);
  await tick(70);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /one[\s\S]*two[\s\S]*three/);
}

/* Many tasks at once: only a couple of calls at a time, and each still gets its title. */
{
  const s = setup({ slow: 10 });
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) s.titler.lines(id, [said(`work on ${id}`)]);
  await tick(80);
  assert.equal(s.peak(), 2);
  assert.equal(new Set(s.titles.map((t) => t.id)).size, 6);
}

/* A failed call is quiet, and the next message tries again. */
{
  const titles = [];
  let fail = true;
  const titler = createTitler({
    generate: async () => {
      if (fail) throw new Error('offline');
      return 'Back online';
    },
    emit: (_c, p) => titles.push(p.title),
  });
  titler.lines('a', [said('one')]);
  await tick();
  assert.equal(titles.length, 0);
  fail = false;
  titler.lines('a', [said('two')]);
  await tick();
  assert.deepEqual(titles, ['Back online']);
}

/* No generator (a test run with Claude blocked): nothing happens. */
createTitler({ emit: () => assert.fail() }).lines('a', [said('hi')]);

/* What the model says, as a title. */
assert.equal(cleanTitle('Fix login redirect'), 'Fix login redirect');
assert.equal(cleanTitle('"Fix login redirect."'), 'Fix login redirect');
assert.equal(cleanTitle('**Title: Fix login**\n\nHere is why'), 'Fix login');
assert.equal(cleanTitle('  \n Dark mode toggle \n'), 'Dark mode toggle');
assert.equal(cleanTitle(''), '');
assert.equal(cleanTitle('I can certainly help you with that but first let me explain what I would do'), '', 'an answer, not a title');
assert.ok(cleanTitle(`${'Longword '.repeat(8)}end`).length <= 60);

console.log('tasktitle ok');
