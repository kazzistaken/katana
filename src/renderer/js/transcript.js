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

const at = (line) => Date.parse(line.timestamp || '') || 0;

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
      if (line.type !== 'user' && line.type !== 'assistant') continue;
      const key = line.uuid || `${line.type}:${line.timestamp}:${JSON.stringify(line.message?.content).slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const message = line.message || {};
      if (line.type === 'user') {
        if (line.isMeta || line.isCompactSummary) continue;
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const tool = tools.get(block.tool_use_id);
            if (tool) {
              tool.result = { text: resultText(block.content), isError: Boolean(block.is_error) };
              changed = true;
            }
          }
        }
        const text = textOf(content).trim();
        if (!text || NOT_TYPED.test(text)) continue;
        entries.push(INTERRUPTED.test(text) ? { kind: 'interrupt', text, at: at(line) } : { kind: 'prompt', text, at: at(line) });
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
