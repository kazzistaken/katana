import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTranscript, exchanges, writtenFiles } from '../src/renderer/js/transcript.js';

const require = createRequire(import.meta.url);
const { codexModels, resolveCodex, findRollout, findNewRollout, readRollout, createConverter, rolloutTranscript, codexLastAnswer, scriptTools, patchTools, FALLBACK_MODELS } = require('../src/main/codex.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-codex-'));
const day = path.join(home, 'sessions', '2026', '10', '30');
fs.mkdirSync(day, { recursive: true });
const t0 = Date.parse('2026-10-30T19:00:00Z');
const ts = (s) => new Date(t0 + s * 1000).toISOString();
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

// A session as Codex writes it: a prompt, a script running a command, a patch, an MCP call, the answer.
const id = '01a18e5c-6b1c-7960-8fe9-5af3b56e90ee';
const cwd = path.join(home, 'project');
const session = [
  { timestamp: ts(0), type: 'session_meta', payload: { id, timestamp: ts(0), cwd } },
  { timestamp: ts(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
  { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
  { timestamp: ts(1), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'make a game page' }] } } },
  { timestamp: ts(2), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'On it.' }], phase: 'commentary' } } },
  { timestamp: ts(3), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"npm test",workdir:"C:\\\\p"}); text(r.output);' } },
  { timestamp: ts(4), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.8 seconds\nOutput:\n' }, { type: 'input_text', text: 'ok 3 tests' }] } },
  { timestamp: ts(5), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'const r = await tools.apply_patch("*** Begin Patch\\n*** Add File: C:\\\\p\\\\game.html\\n+<canvas></canvas>\\n*** Update File: C:\\\\p\\\\app.js\\n@@\\n-a\\n+b\\n*** End Patch");' } },
  { timestamp: ts(6), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: '{}' } },
  { timestamp: ts(7), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c3', name: 'exec', input: 'text(await tools.mcp__katana_viewer__run_app({command:"npm start"}));' } },
  { timestamp: ts(8), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'running' } },
  { timestamp: ts(9), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 } } } },
  { timestamp: ts(9), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'Made game.html.' }], phase: 'final_answer' } } },
  { timestamp: ts(10), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1', last_agent_message: 'Made game.html.' } },
  // A second turn, stopped with Esc.
  { timestamp: ts(20), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn2' } },
  { timestamp: ts(20), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'now wait' }] } } },
  { timestamp: ts(21), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'await tools.exec_command({cmd:"Start-Sleep 30"})' } },
  { timestamp: ts(25), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c4', output: 'aborted by user after 4s' } },
  { timestamp: ts(25), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn2', reason: 'interrupted' } },
];
const file = path.join(day, `rollout-2026-10-30T15-00-00-${id}.jsonl`);
fs.writeFileSync(file, jsonl(session));

/* ------------------------------ converting ------------------------------ */
{
  const { lines, events } = createConverter().convert(session);
  // The task view reads it as it reads Claude's.
  const transcript = createTranscript();
  transcript.add(lines);
  const list = exchanges(transcript.entries);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].prompts.map((p) => p.text), ['make a game page']);
  assert.deepEqual(list[0].texts.map((t) => t.text), ['On it.', 'Made game.html.']);
  assert.deepEqual(list[0].tools.map((t) => t.name), ['Bash', 'Write', 'Edit', 'mcp__katana-viewer__run_app']);
  assert.equal(list[0].tools[0].input.command, 'npm test');
  assert.equal(list[0].tools[0].result.text, 'ok 3 tests');
  assert.equal(list[0].tools[1].input.content, '<canvas></canvas>\n');
  assert.deepEqual(writtenFiles(list[0]), ['C:\\p\\game.html']);
  assert.equal(transcript.context(), 1280);
  // Esc: an interrupted turn, its command failed.
  assert.equal(list[1].interrupted, true);
  assert.equal(list[1].tools[0].result.isError, true);
  // ...and where it stands, as hooks.
  assert.deepEqual(
    events.map((e) => e.event),
    ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PreToolUse', 'PostToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure']
  );
  assert.equal(events[2].detail, 'npm test');
  assert.ok(events.every((e) => e.session === id || e.event === 'SessionStart'));
  // A resumed session's file is read from the top: what came before it started is history, no events.
  assert.deepEqual(createConverter({ since: t0 + 15000 }).convert(session).events.map((e) => e.event), ['UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure']);
  // Lines arriving in batches convert the same as all at once (a call and its output apart).
  const batched = createConverter();
  const parts = [...batched.convert(session.slice(0, 6)).lines, ...batched.convert(session.slice(6)).lines];
  assert.deepEqual(parts, lines);
}

/* ------------------------- tools in a script ------------------------- */
{
  assert.deepEqual(scriptTools('await tools.exec_command({ cmd: \'git status\' })'), [{ name: 'Bash', input: { command: 'git status' } }]);
  assert.deepEqual(scriptTools('ALL_TOOLS.filter(x => x)').map((t) => t.name), ['Script']);
  assert.deepEqual(patchTools('*** Begin Patch\n*** Delete File: old.js\n*** End Patch'), [{ name: 'Edit', input: { file_path: 'old.js', description: 'Delete' } }]);
}

/* ------------------------------ finding ------------------------------ */
{
  assert.equal(findRollout(id, home), file);
  assert.equal(findRollout(id.toUpperCase(), home), file);
  assert.equal(findRollout('not an id', home), '');
  assert.equal(codexLastAnswer(id, home), 'Made game.html.');
  // A finished session, compressed: still read back.
  const old = '01a15fe3-9887-7a32-85b0-d8d2705e65a1';
  const packed = path.join(day, `rollout-2026-10-21T15-15-15-${old}.jsonl.zst`);
  fs.writeFileSync(packed, zlib.zstdCompressSync(Buffer.from(jsonl(session.slice(0, 5)))));
  assert.equal(findRollout(old, home), packed);
  assert.equal(readRollout(packed).length, 5);
  assert.equal(rolloutTranscript(packed).filter((l) => l.type === 'user').length, 1);

  // A new session: the one begun in the task's folder since it started, not one another task reads.
  const since = Date.now() - 1000;
  const freshId = '01a19000-0000-7000-8000-000000000001';
  const fresh = path.join(day, `rollout-2026-10-30T16-00-00-${freshId}.jsonl`);
  fs.writeFileSync(fresh, jsonl([{ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: freshId, timestamp: new Date().toISOString(), cwd } }]));
  const elsewhere = path.join(day, 'rollout-2026-10-30T16-00-01-01a19000-0000-7000-8000-000000000002.jsonl');
  fs.writeFileSync(elsewhere, jsonl([{ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'x', timestamp: new Date().toISOString(), cwd: path.join(home, 'other') } }]));
  const found = findNewRollout({ cwd, since, home });
  assert.deepEqual({ file: found.file, sessionId: found.sessionId }, { file: fresh, sessionId: freshId });
  // (Windows folders are case-blind.)
  if (process.platform === 'win32') assert.equal(findNewRollout({ cwd: cwd.toUpperCase(), since, home })?.file, fresh);
  assert.equal(findNewRollout({ cwd: path.join(home, 'none'), since, home }), null);
  // Another task reads it already; the old session in that folder began long before: neither is taken.
  assert.equal(findNewRollout({ cwd, since, home, claimed: new Set([fresh]) }), null);
}

/* ------------------------------ models ------------------------------ */
{
  assert.deepEqual(codexModels(home), FALLBACK_MODELS);
  fs.writeFileSync(
    path.join(home, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'hidden', visibility: 'hide', priority: 1 }, { slug: 'b', display_name: 'B', visibility: 'list', priority: 9, supported_reasoning_levels: [{ effort: 'low' }] }, { slug: 'a', display_name: 'A', visibility: 'list', priority: 2 }] })
  );
  assert.deepEqual(codexModels(home).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(codexModels(home)[1].efforts, ['low']);
}

/* ------------------------------ running it ------------------------------ */
{
  assert.equal(resolveCodex(() => null), null);
  assert.deepEqual(resolveCodex(() => '/usr/bin/codex'), { file: '/usr/bin/codex', env: {} });
  // An npm shim: its native codex.exe, with what the shim sets.
  const npm = path.join(home, 'npm');
  const triple = process.arch === 'arm64' ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc'] : ['codex-win32-x64', 'x86_64-pc-windows-msvc'];
  const exe = path.join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', triple[0], 'vendor', triple[1], 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const shim = resolveCodex(() => path.join(npm, 'codex.cmd'));
  assert.equal(shim.file, exe);
  assert.equal(shim.env.CODEX_MANAGED_BY_NPM, '1');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('codex ok');
