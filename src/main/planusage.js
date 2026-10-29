'use strict';

/**
 * The plan's live usage, from the same place Claude Code's /usage reads it:
 * the 5-hour and weekly windows, each { used 0..1, resetsAt ms }.
 *
 * The login token is read fresh from ~/.claude/.credentials.json on every
 * call and goes only to Anthropic's usage endpoint: it is never returned,
 * kept, logged or put in an error. Claude Code refreshes the token itself;
 * an expired one just means no figure until it has.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT = 10000;

/** { fiveHour, week } from the endpoint's answer; a window it didn't report is null. */
function parseUsage(json) {
  const window = (w) => {
    const used = Number(w?.utilization);
    const resetsAt = Date.parse(w?.resets_at || '');
    if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return null;
    // Utilization comes as a percent (28 = 28%).
    return { used: Math.max(0, used) / 100, resetsAt };
  };
  return { fiveHour: window(json?.five_hour), week: window(json?.seven_day) };
}

function createPlanUsage({ credentialsFile = path.join(os.homedir(), '.claude', '.credentials.json'), fetch = globalThis.fetch, now = Date.now } = {}) {
  function token() {
    try {
      const oauth = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).claudeAiOauth;
      if (!oauth?.accessToken || (oauth.expiresAt && oauth.expiresAt <= now())) return '';
      return oauth.accessToken;
    } catch {
      return '';
    }
  }

  /** The live windows, or null (no login, expired, offline, refused). */
  async function read() {
    const bearer = token();
    if (!bearer) return null;
    try {
      const reply = await fetch(ENDPOINT, {
        headers: { Authorization: `Bearer ${bearer}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!reply.ok) return null;
      const usage = parseUsage(await reply.json());
      return usage.fiveHour || usage.week ? usage : null;
    } catch {
      return null;
    }
  }

  return { read };
}

module.exports = { createPlanUsage, parseUsage, ENDPOINT };
