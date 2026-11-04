/**
 * Reading a Claude Code session's transcript (the .jsonl Claude Code keeps
 * in ~/.claude/projects) into what a task view shows: what you asked, the
 * tool calls with their results, what Claude said, and the tokens written.
 * Lines come whole or in later batches, in any overlap: each is kept once,
 * by its uuid. Pure, so scripts/test-transcript.mjs runs it under Node.
 */

// User lines that are Claude Code's own bookkeeping, not something you wrote.
const NOT_TYPED = /^\s*(<(command-|local-command|system-reminder|bash-|user-memory|task-notification)|Caveat:)/;
const INTERRUPTED = /^\[Request interrupted by user/;
const BACKGROUND_DONE = /^\s*<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/;

// A slash command you typed, and what it printed: Claude Code's own record of them.
const COMMAND = /<command-name>\/([^<\s]+)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_OUTPUT = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/;
// eslint-disable-next-line no-control-regex
const TERMINAL_COLOURS = /\u001b\[[0-9;]*[A-Za-z]/g;

const CONTEXT_PICTURE = /[\u26c0-\u26ff]{1}.*[\u26c0-\u26ff]/;
const CONTEXT_TABLE = /^\s*## Context Usage/;

const at = (line) => Date.parse(line.timestamp || '') || 0;

// Pictures pasted into the prompt bar go as paths in Katana's own folder
// (main.js image:save); Claude Code may turn them into [Image #1] and an image block.
const IMAGE_PATH = /^[ \t]*([A-Za-z]:[\\/][^\r\n]*?[\\/]xode-images[\\/][^\\/\r\n]+\.(?:png|jpe?g|gif|webp))[ \t]*$/gim;
const IMAGE_TAG = /\[Image #\d+\]/g;

/** What you wrote, apart from the pictures in it: { text, images } (paths or data URLs). */
export function splitImages(text, content) {
  const images = [];
  let rest = String(text || '').replace(IMAGE_PATH, (_all, file) => {
    images.push(file);
    return '';
  });
  if (!images.length && Array.isArray(content)) {
    for (const block of content) if (block.type === 'image' && block.source?.type === 'base64' && block.source.data) images.push(`data:${block.source.media_type || 'image/png'};base64,${block.source.data}`);
  }
  if (images.length) rest = rest.replace(IMAGE_TAG, '');
  return { text: rest.trim(), images };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part.type === 'text' ? part.text || '' : part.type === 'image' ? '[image]' : '')).join('\n');
}

export function createTranscript() {
  const seen = new Set();
  const entries = [];
  const tools = new Map();
  const tokens = new Map(); // message id -> { out, at }
  let ended = false;
  let context = 0; // tokens in the window at the last answer
  let title = ''; // Claude Code's own short title for the session

  /** A command you typed and what it printed, from Claude Code's own record of them: true if there was any. */
  function addCommand(text, line) {
    const command = COMMAND.exec(text);
    const printed = COMMAND_OUTPUT.exec(text);
    if (!command && !printed) return false;
    if (command) {
      const args = COMMAND_ARGS.exec(text)?.[1].trim();
      entries.push({ kind: 'prompt', text: `/${command[1]}${args ? ` ${args}` : ''}`, images: [], at: at(line) });
    }
    const words = printed?.[1].replace(TERMINAL_COLOURS, '').trim();
    // (/context's picture of blocks means nothing here: its table comes next.)
    if (words && words !== '(no content)' && !CONTEXT_PICTURE.test(words)) entries.push({ kind: 'text', text: words, at: at(line), msgId: '' });
    ended = false;
    return true;
  }

  /** A sub-agent that ran in the background finished: its call says how. True if this was that news. */
  function backgroundDone(text) {
    const note = BACKGROUND_DONE.exec(text);
    const call = note && tools.get(note[1].trim());
    if (!call?.result) return false;
    call.result.status = note[2].trim();
    return true;
  }

  /** Take some lines in; true when anything new was read. */
  function add(lines) {
    let changed = false;
    for (const line of lines || []) {
      if (!line || typeof line !== 'object' || line.isSidechain) continue;
      if (line.type === 'ai-title' && line.aiTitle) {
        if (line.aiTitle !== title) {
          title = String(line.aiTitle);
          changed = true;
        }
        continue;
      }
      // Finished while the lead was busy: the news is queued and handed over as an attachment, never as a user line.
      if (line.type === 'queue-operation' || (line.type === 'attachment' && line.attachment?.type === 'queued_command')) {
        if (backgroundDone(textOf(line.type === 'attachment' ? line.attachment.prompt : line.content))) changed = true;
        continue;
      }
      // A command that needed no model is recorded as a system line.
      if (line.type === 'system' && line.subtype === 'local_command') {
        const key = line.uuid || `system:${line.timestamp}:${String(line.content).slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          if (addCommand(String(line.content || ''), line)) changed = true;
        }
        continue;
      }
      if (line.type !== 'user' && line.type !== 'assistant') continue;
      const key = line.uuid || `${line.type}:${line.timestamp}:${JSON.stringify(line.message?.content).slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const message = line.message || {};
      if (line.type === 'user') {
        // /context's table, which it records just for the model: it's what you asked to see.
        if (line.isMeta && typeof message.content === 'string' && CONTEXT_TABLE.test(message.content)) {
          entries.push({ kind: 'text', text: message.content.trim(), at: at(line), msgId: '' });
          changed = true;
          continue;
        }
        if (line.isMeta || line.isCompactSummary) continue;
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const tool = tools.get(block.tool_use_id);
            if (tool) {
              tool.result = { text: resultText(block.content), isError: Boolean(block.is_error) };
              // A sub-agent's call: the model it really ran on, and whether it went to the background.
              const meta = line.toolUseResult;
              if (meta && typeof meta === 'object') Object.assign(tool.result, { model: String(meta.resolvedModel || ''), status: String(meta.status || '') });
              changed = true;
            }
          }
        }
        const text = textOf(content).trim();
        if (backgroundDone(text)) changed = true;
        if (addCommand(text, line)) {
          changed = true;
          continue;
        }
        const hasImage = Array.isArray(content) && content.some((block) => block.type === 'image');
        if ((!text && !hasImage) || NOT_TYPED.test(text)) continue;
        if (INTERRUPTED.test(text)) entries.push({ kind: 'interrupt', text, at: at(line) });
        else entries.push({ kind: 'prompt', ...splitImages(text, content), at: at(line) });
        ended = false;
        changed = true;
        continue;
      }
      for (const block of message.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          entries.push({ kind: 'text', text: block.text.trim(), at: at(line), msgId: message.id || '' });
          changed = true;
        } else if (block.type === 'tool_use') {
          const tool = { kind: 'tool', id: block.id, name: block.name || 'Tool', input: block.input || {}, at: at(line), result: null };
          tools.set(block.id, tool);
          entries.push(tool);
          changed = true;
        }
      }
      const usage = message.usage;
      if (usage) context = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
      const out = usage?.output_tokens;
      if (message.id && out) tokens.set(message.id, { out: Math.max(out, tokens.get(message.id)?.out || 0), at: at(line) });
      ended = message.stop_reason === 'end_turn';
    }
    return changed;
  }

  return {
    add,
    entries,
    /** Tokens Claude wrote since a moment (the Working line). */
    tokensSince(since) {
      let total = 0;
      for (const { out, at: when } of tokens.values()) if (when >= since - 1000) total += out;
      return total;
    },
    /** The title Claude Code gave the session ('' until it has one). */
    title: () => title,
    /** How full the session's memory was at its last answer, in tokens. */
    context: () => context,
    /** The last assistant line ended its turn (Stop's hook may be missing). */
    ended: () => ended,
  };
}

/** Requests: what you wrote (and notes added while it ran), then what came back. */
export function exchanges(entries) {
  const list = [];
  let current = null;
  for (const entry of entries) {
    if (entry.kind === 'prompt') {
      if (current && !current.texts.length && !current.tools.length && !current.interrupted) current.prompts.push(entry);
      else {
        current = { prompts: [entry], texts: [], tools: [], interrupted: false, at: entry.at };
        list.push(current);
      }
      continue;
    }
    if (!current) {
      current = { prompts: [], texts: [], tools: [], interrupted: false, at: entry.at };
      list.push(current);
    }
    if (entry.kind === 'text') current.texts.push(entry);
    else if (entry.kind === 'tool') current.tools.push(entry);
    else if (entry.kind === 'interrupt') current.interrupted = true;
  }
  return list;
}

/** Files a request wrote (the Write tool), newest last, no repeats. */
export function writtenFiles(exchange) {
  const files = [];
  for (const tool of exchange.tools) {
    const file = tool.input?.file_path || tool.input?.notebook_path;
    if ((tool.name === 'Write' || tool.name === 'NotebookEdit') && file && !files.includes(file)) files.push(file);
  }
  return files;
}

// Sub-agents mode: its lead's model, its sub-agents and theirs (runargs.js's SUBAGENTS_LEAD and SUBAGENTS; test-runargs checks they match).
export const SUBAGENTS_LEAD = 'claude-opus-5-5';
export const SUBAGENT_MODELS = { quick: 'claude-haiku-5-5', builder: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' };

/**
 * The sub-agents a request called (the Agent tool, once Task), in order:
 * { agent, model, what, state }; state is running, background (sent there
 * and not back yet), done or failed. The model is the one it ran on once it
 * started, else the one it was given.
 */
export function subagentCalls(exchange) {
  return exchange.tools
    .filter((tool) => (tool.name === 'Agent' || tool.name === 'Task') && tool.input?.subagent_type)
    .map((tool) => {
      const agent = String(tool.input.subagent_type);
      const result = tool.result;
      const state = !result ? 'running' : result.isError || /fail|error|kill/i.test(result.status) ? 'failed' : result.status === 'async_launched' ? 'background' : 'done';
      return { agent, model: result?.model || tool.input.model || SUBAGENT_MODELS[agent] || '', what: String(tool.input.description || ''), state };
    });
}

/**
 * The sub-agents of a request that are still at work. One called in the foreground
 * while the request's turn runs (`turnLive`), or one in the background until its
 * news comes, as long as the session that launched it is open: `sessionOpen`, and
 * `since` when it started (a background agent dies with its session, so an old one
 * that never reported is over, even in a resumed session). None once it's interrupted.
 */
export function liveSubagents(exchange, { turnLive = false, sessionOpen = false, since = 0 } = {}) {
  if (exchange.interrupted) return [];
  const tools = exchange.tools.filter((tool) => (tool.result ? sessionOpen && tool.at >= since : turnLive));
  return subagentCalls({ tools }).filter((call) => call.state === 'running' || call.state === 'background');
}

const GAME_WORDS = /\bgames?\b/i;
const GAME_CODE = /requestAnimationFrame|getContext\(\s*['"](?:2d|webgl2?)['"]|\b(?:Phaser|PIXI|THREE|kaboom|Babylon)\.|\bkey(?:down|up)\b[\s\S]*\b(?:ArrowLeft|ArrowRight|KeyW|keyCode)\b/;

/**
 * The page a request made if it is a browser game, else ''. It wrote an HTML
 * file, and the prompt or task title says "game", or something it wrote
 * runs a game loop, draws to a canvas, steers by arrow keys or uses a game
 * library. Only the Write tool's text is read, so this costs nothing extra.
 */
export function browserGame(exchange, title = '') {
  const page = writtenFiles(exchange).filter((file) => /\.html?$/i.test(file)).at(-1);
  if (!page) return '';
  if (GAME_WORDS.test(title) || exchange.prompts.some((p) => GAME_WORDS.test(p.text || ''))) return page;
  const code = exchange.tools.some((tool) => tool.name === 'Write' && GAME_CODE.test(String(tool.input?.content || '')));
  return code ? page : '';
}
