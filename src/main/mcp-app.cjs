'use strict';

/**
 * Katana's app tools as an MCP server, for her Claude turns. Claude starts
 * it (--mcp-config) and talks JSON-RPC over stdin/stdout, a line per
 * message; each tool call is asked of the running app over a local port
 * (KATANA_TOOLS_URL, with KATANA_TOOLS_TOKEN), which carries it out and
 * answers. No dependencies: it runs under plain Node or Electron as Node.
 *
 * Started for a task's own Claude Code session instead (KATANA_VIEW_TOKEN),
 * it serves only the app viewer's tools, for that task (toolport.js); with
 * KATANA_TEAM_TOKEN, a hierarchy team member's team tools (daemon/team.js).
 * A result with an image (a screenshot) comes back as one Claude can see.
 */

const http = require('node:http');

const BASE = process.env.KATANA_TOOLS_URL || '';
// Hierarchy mode: a team member's team tools (the leader's, a verifier's verdict).
const TEAM = Boolean(process.env.KATANA_TEAM_TOKEN);
const VIEW = !TEAM && Boolean(process.env.KATANA_VIEW_TOKEN);
const TOKEN = process.env.KATANA_TEAM_TOKEN || process.env.KATANA_VIEW_TOKEN || process.env.KATANA_TOOLS_TOKEN || '';
const ROOT = TEAM ? '/team' : VIEW ? '/view' : '';
const NAME = TEAM ? 'katana-team' : VIEW ? 'katana-viewer' : 'katana';

function ask(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request(
      `${BASE}${path}`,
      { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`the app answered ${response.statusCode}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('the app sent something unreadable'));
          }
        });
      }
    );
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  // Notifications (initialized, cancelled) need no answer.
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      write({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: NAME, version: '1.0.0' } } });
    } else if (method === 'ping') {
      write({ id, result: {} });
    } else if (method === 'tools/list') {
      write({ id, result: { tools: await ask('GET', `${ROOT}/tools`) } });
    } else if (method === 'tools/call') {
      const out = await ask('POST', `${ROOT}/call`, { name: params?.name, args: params?.arguments || {} });
      if (!out.error && out.result && typeof out.result.image === 'string') {
        const { image, ...rest } = out.result;
        write({ id, result: { content: [{ type: 'image', data: image, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(rest) }], isError: false } });
        return;
      }
      const text = out.error ? String(out.error) : typeof out.result === 'string' ? out.result : JSON.stringify(out.result ?? { ok: true });
      write({ id, result: { content: [{ type: 'text', text }], isError: Boolean(out.error) } });
    } else {
      write({ id, error: { code: -32601, message: `No method ${method}` } });
    }
  } catch (error) {
    if (method === 'tools/call') write({ id, result: { content: [{ type: 'text', text: `Katana’s app didn’t answer: ${error.message}` }], isError: true } });
    else write({ id, error: { code: -32603, message: error.message } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
