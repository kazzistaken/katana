// Where a task stands (src/daemon/taskstate.js): a wait for you that ends with Stop is a finish,
// and the tool in use read off the transcript (no hook per tool call).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTaskStates } = require('../src/daemon/taskstate.js');

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const toolUse = (id, name, input = {}) => ({ type: 'assistant', timestamp: iso(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, extra = {}) => ({ type: 'user', timestamp: iso(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra });

const seen = [];
const states = createTaskStates({ emit: (u) => seen.push(u) });
const last = () => seen.at(-1);

/* ---- shown waiting for you, then its turn ends: finished all the same ---- */
states.started('a', { kind: 'claude', prompt: 'fix it' });
states.hook('a', { event: 'UserPromptSubmit' });
// (Something on screen read as a question: the old false "Do you want to create a PR?".)
states.ask('a', 'Claude wants permission for its next step.');
assert.equal(last().state, 'needs');
states.hook('a', { event: 'Stop' });
assert.equal(last().state, 'idle');
assert.equal(last().finished, true, 'needs → idle on Stop is a finished turn (Katana is told)');
assert.ok(last().finishedAt > 0);
// Stopped by you while it waited: not finished.
states.said('a');
states.ask('a', 'Claude wants permission for its next step.');
states.stopping('a');
states.transcript('a', [{ type: 'user', timestamp: iso(), message: { content: '[Request interrupted by user for tool use]' } }]);
assert.equal(last().state, 'idle');
assert.equal(last().finished, false);
assert.equal(last().stopped, true);

/* ---- the tool in use, off the transcript ---- */
states.started('b', { kind: 'claude', prompt: 'run the tests' });
states.hook('b', { event: 'UserPromptSubmit' });
states.transcript('b', [toolUse('t1', 'Bash', { command: 'npm test', description: 'Run the tests' })]);
assert.equal(last().state, 'working');
assert.equal(last().tool.name, 'Bash');
assert.equal(last().tool.desc, 'Run the tests');
assert.equal(last().tool.detail, 'npm test');
states.transcript('b', [toolUse('t2', 'Read', { file_path: 'a.js' })]);
assert.equal(last().tool.name, 'Read', 'the latest shown');
states.transcript('b', [toolResult('t2')]);
assert.equal(last().tool.name, 'Bash', 'the one still running');
states.transcript('b', [toolResult('t1')]);
assert.equal(last().tool, null, 'thinking again');
assert.equal(last().state, 'working');

// A permission dialog for a tool: needs you; its result means you answered.
states.transcript('b', [toolUse('t3', 'Write', { file_path: 'b.js' })]);
states.ask('b', 'Claude wants permission for its next step.');
assert.equal(last().state, 'needs');
const clock = states.get('b').since;
states.transcript('b', [toolUse('t3', 'Write', { file_path: 'b.js' })]);
assert.equal(last().state, 'needs', 'its call read again (or late) does not end the wait');
states.transcript('b', [toolResult('t3')]);
assert.equal(last().state, 'working');
assert.equal(last().since, clock, 'it keeps its clock');

// Its question tool (its PreToolUse hook): asking; another tool finishing doesn't answer it, its own result does.
states.transcript('b', [toolUse('t4', 'Grep', { pattern: 'x' }), toolUse('q1', 'AskUserQuestion', { questions: [{ question: 'Which one?' }] })]);
states.hook('b', { event: 'PreToolUse', tool: 'AskUserQuestion', toolId: 'q1', detail: 'Which one?' });
assert.equal(last().state, 'needs');
assert.equal(last().need, 'asking');
states.transcript('b', [toolResult('t4')]);
assert.equal(last().state, 'needs', 'still asking');
states.transcript('b', [toolResult('q1')]);
assert.equal(last().state, 'working');
assert.equal(last().need, '');

// The turn ends; a late line of it doesn't start it again.
states.hook('b', { event: 'Stop' });
assert.equal(last().state, 'idle');
assert.equal(last().finished, true);
states.transcript('b', [toolUse('t5', 'Bash', { command: 'ls' })]);
assert.equal(states.get('b').state, 'idle');
assert.equal(states.get('b').tool, null);

// Lines from before this turn (a transcript read from further back) are history.
states.said('b');
states.transcript('b', [{ ...toolUse('t6', 'Bash'), timestamp: iso(Date.now() - 60_000) }]);
assert.equal(states.get('b').tool, null);

// A Codex session's tools come as hook events (its rollout), not from its converted lines.
states.started('c', { kind: 'codex', prompt: 'go' });
states.transcript('c', [toolUse('x1', 'Bash', { command: 'ls' })]);
assert.equal(states.get('c').tool, null);
states.hook('c', { event: 'PreToolUse', tool: 'Bash', toolId: 'x1' });
assert.equal(states.get('c').tool.name, 'Bash');
states.hook('c', { event: 'PostToolUse', toolId: 'x1' });
assert.equal(states.get('c').tool, null);

for (const id of ['a', 'b', 'c']) states.forget(id);
console.log('taskstate ok');
