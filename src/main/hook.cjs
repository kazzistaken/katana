'use strict';

/**
 * Claude Code hook for Katana tasks (copied to the app's data folder and
 * named in the settings each task's `claude` starts with). Claude Code runs
 * it on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification and Stop
 * with the event as JSON on stdin; it appends one short line to the task's
 * file, which the app reads to know whether the task is working, finished
 * or waiting for you. It never blocks or changes what Claude does.
 */

const fs = require('node:fs');
const path = require('node:path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const task = String(process.env.XODE_TASK || '').replace(/[^\w-]/g, '');
    const dir = process.env.XODE_HOOKS;
    if (!task || !dir) return;
    const event = JSON.parse(raw || '{}');
    const input = event.tool_input || {};
    const line = {
      at: Date.now(),
      event: event.hook_event_name || '',
      session: event.session_id || '',
      transcript: event.transcript_path || '',
      tool: event.tool_name || '',
      desc: String(input.description || '').slice(0, 200),
      detail: String(input.command || input.file_path || input.pattern || input.url || input.questions?.[0]?.question || input.question || '').slice(0, 300),
      message: String(event.message || '').slice(0, 300),
    };
    fs.appendFileSync(path.join(dir, `${task}.jsonl`), `${JSON.stringify(line)}\n`);
  } catch {
    /* a hook must never get in Claude's way */
  }
});
