import assert from 'node:assert/strict';
import { browserGame, createTranscript, exchanges, writtenFiles } from '../src/renderer/js/transcript.js';

const t0 = '2026-10-28T10:00:00.000Z';
const line = (type, content, { message = {}, ...extra } = {}) => ({ type, uuid: `${type}-${Math.random()}`, timestamp: t0, ...extra, message: { role: type, content, ...message } });

{
  // a prompt, a tool call and its result, then the answer
  const transcript = createTranscript();
  const prompt = line('user', 'make the page');
  const use = line('assistant', [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'C:\\p\\page.html' } }], {
    message: { id: 'm1', usage: { output_tokens: 120 }, stop_reason: 'tool_use' },
  });
  const result = line('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'File created' }]);
  const answer = line('assistant', [{ type: 'text', text: 'I made the page. It has three diagrams.' }], {
    message: { id: 'm2', usage: { output_tokens: 40 }, stop_reason: 'end_turn' },
  });
  assert.equal(transcript.add([prompt, use]), true);
  assert.equal(transcript.ended(), false);
  // The same lines again (a reread) change nothing.
  assert.equal(transcript.add([prompt, use]), false);
  transcript.add([result, answer]);
  assert.equal(transcript.ended(), true);
  const list = exchanges(transcript.entries);
  assert.equal(list.length, 1);
  assert.equal(list[0].prompts[0].text, 'make the page');
  assert.equal(list[0].tools[0].result.text, 'File created');
  assert.equal(list[0].texts.at(-1).text, 'I made the page. It has three diagrams.');
  assert.deepEqual(writtenFiles(list[0]), ['C:\\p\\page.html']);
  assert.equal(transcript.tokensSince(Date.parse(t0)), 160);
}

{
  // Claude Code's own lines are not prompts; side agents and meta lines are skipped
  const transcript = createTranscript();
  transcript.add([
    line('user', '<command-name>/model</command-name>'),
    line('user', 'Caveat: the messages below were generated'),
    line('user', 'hidden', { isMeta: true }),
    line('assistant', [{ type: 'text', text: 'from a subagent' }], { isSidechain: true }),
    line('system', 'x'),
  ]);
  assert.deepEqual(transcript.entries, []);
}

{
  // notes written before Claude answered join the same exchange; an interrupt ends one
  const transcript = createTranscript();
  transcript.add([line('user', 'first'), line('user', 'and also this')]);
  transcript.add([line('user', [{ type: 'text', text: '[Request interrupted by user]' }]), line('user', 'second')]);
  const list = exchanges(transcript.entries);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].prompts.map((p) => p.text), ['first', 'and also this']);
  assert.equal(list[0].interrupted, true);
  assert.equal(list[1].prompts[0].text, 'second');
}

{
  // Claude Code's own title for the session
  const transcript = createTranscript();
  assert.equal(transcript.title(), '');
  assert.equal(transcript.add([{ type: 'ai-title', aiTitle: 'Hello from katana' }]), true);
  assert.equal(transcript.title(), 'Hello from katana');
  assert.equal(transcript.add([{ type: 'ai-title', aiTitle: 'Hello from katana' }]), false);
}

{
  // browser games: an HTML page plus a game prompt/title or game code; other pages are not
  const write = (file_path, content = '') => ({ kind: 'tool', name: 'Write', input: { file_path, content } });
  const ex = (prompt, ...tools) => ({ prompts: [{ kind: 'prompt', text: prompt }], texts: [], tools, interrupted: false });
  assert.equal(browserGame(ex('make a snake game', write('C:\g\index.html'))), 'C:\g\index.html');
  assert.equal(browserGame(ex('build it', write('C:\g\index.html')), 'Space game'), 'C:\g\index.html');
  assert.equal(browserGame(ex('build it', write('C:\g\index.html', '<script src="main.js">'), write('C:\g\main.js', 'function loop(){ requestAnimationFrame(loop) }'))), 'C:\g\index.html');
  assert.equal(browserGame(ex('build it', write('C:\g\play.html', 'const c = canvas.getContext("webgl")'))), 'C:\g\play.html');
  assert.equal(browserGame(ex('build it', write('C:\g\play.html', 'new Phaser.Game(config)'))), 'C:\g\play.html');
  assert.equal(browserGame(ex('make a landing page', write('C:\p\index.html', '<h1>Hello</h1><button onclick="go()">Go</button>'))), '');
  assert.equal(browserGame(ex('write a game design doc', write('C:\p\design.md'))), '');
  assert.equal(browserGame(ex('the gamepad docs, plus a gameplan', write('C:\p\index.html'))), '');
}

console.log('transcript ok');
