'use strict';

/**
 * The port Katana's tools are asked through. mcp-app.cjs (started by her
 * Claude turns) calls it over local HTTP, only with this daemon's secret
 * token: GET /tools lists them (main/apptooldefs.js), POST /call runs one
 * through `route(name, args)` — to a window when one is open, otherwise
 * headless.js — which answers { result } or { error }.
 *
 * A task's own Claude Code session gets the app viewer's tools too (to run
 * and test its app there): /view/tools and /view/call, with a token that
 * names its task and is good only for that task and only for those tools.
 *
 * Hierarchy mode (team.js): a team member's session gets the team's tools
 * the same way (/team/tools, /team/call), with a token that names that
 * session; `team.tools(id)` says which (the leader's, a verifier's).
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { TOOLS, VIEW_TOOLS } = require('../main/apptooldefs');

const MAX_BODY = 1_000_000;

function createToolPort({ route, team = null }) {
  const token = crypto.randomBytes(24).toString('hex');
  const secret = crypto.randomBytes(32);
  const names = new Set(TOOLS.map((t) => t.name));
  const viewNames = new Set(VIEW_TOOLS.map((t) => t.name));
  let listening = null;

  /** A session's token for its viewer (or team) tools: its id, signed. */
  const signed = (kind, id) => `${id}.${crypto.createHmac('sha256', secret).update(`${kind}:${id}`).digest('hex')}`;
  const viewToken = (taskId) => signed('view', taskId);
  const teamToken = (id) => signed('team', id);

  /** The session a token is for, or null. */
  function tokenFor(kind, header) {
    const match = /^Bearer ([\w-]{1,80})\.[0-9a-f]{64}$/.exec(String(header || ''));
    if (!match) return null;
    const given = Buffer.from(String(header).slice(7));
    const wanted = Buffer.from(signed(kind, match[1]));
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted) ? match[1] : null;
  }

  /** A task's session calling a viewer tool: always on its own task. */
  async function callView(taskId, name, args) {
    if (!viewNames.has(name)) return { error: `There’s no tool called ${name}.` };
    try {
      return await route(name, { ...(args || {}), task: taskId, from: 'task' });
    } catch (error) {
      return { error: error.message };
    }
  }

  async function call(name, args) {
    if (!names.has(name)) return { error: `There’s no tool called ${name}.` };
    try {
      return await route(name, args || {});
    } catch (error) {
      return { error: error.message };
    }
  }

  const reply = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const server = http.createServer((request, response) => {
    const viewing = String(request.url || '').startsWith('/view/');
    const teaming = String(request.url || '').startsWith('/team/');
    const taskId = viewing ? tokenFor('view', request.headers.authorization) : teaming ? tokenFor('team', request.headers.authorization) : null;
    if (teaming) {
      if (!taskId || !team) return reply(response, 401, { error: 'no' });
      if (request.method === 'GET' && request.url === '/team/tools') return reply(response, 200, team.tools(taskId));
      if (request.method !== 'POST' || request.url !== '/team/call') return reply(response, 404, { error: 'no such thing' });
    } else if (viewing) {
      if (!taskId) return reply(response, 401, { error: 'no' });
      if (request.method === 'GET' && request.url === '/view/tools') return reply(response, 200, VIEW_TOOLS);
      if (request.method !== 'POST' || request.url !== '/view/call') return reply(response, 404, { error: 'no such thing' });
    } else {
      const given = Buffer.from(String(request.headers.authorization || ''));
      const wanted = Buffer.from(`Bearer ${token}`);
      if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return reply(response, 401, { error: 'no' });
      if (request.method === 'GET' && request.url === '/tools') return reply(response, 200, TOOLS);
      if (request.method !== 'POST' || request.url !== '/call') return reply(response, 404, { error: 'no such thing' });
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) request.destroy();
    });
    request.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return reply(response, 400, { error: 'unreadable' });
      }
      const name = String(parsed?.name || '');
      if (teaming) return reply(response, 200, await Promise.resolve(team.call(taskId, name, parsed?.args || {})).catch((error) => ({ error: error.message })));
      return reply(response, 200, viewing ? await callView(taskId, name, parsed?.args) : await call(name, parsed?.args));
    });
    return undefined;
  });

  /** The port, once listening: { url, token }. */
  function start() {
    listening =
      listening ||
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, token }));
      });
    return listening;
  }

  return { start, call, viewToken, teamToken, close: () => server.close() };
}

module.exports = { createToolPort };
