import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createPlanUsage, parseUsage, ENDPOINT } = require('../src/main/planusage.js');

const dir = mkdtempSync(join(tmpdir(), 'planusage-'));
const credentialsFile = join(dir, '.credentials.json');
const login = (oauth) => writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: oauth }));
const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
const ANSWER = {
  five_hour: { utilization: 10, resets_at: '2026-10-30T01:00:00.5+00:00' },
  seven_day: { utilization: 28, resets_at: '2026-11-03T21:00:00+00:00' },
  seven_day_opus: null,
};

try {
  // the answer: percents to 0..1, reset times to ms, a missing window null
  assert.deepEqual(parseUsage(ANSWER), {
    fiveHour: { used: 0.1, resetsAt: Date.parse('2026-10-30T01:00:00.5Z') },
    week: { used: 0.28, resetsAt: Date.parse('2026-11-03T21:00:00Z') },
  });
  assert.deepEqual(parseUsage({ five_hour: null, seven_day: { utilization: 5 } }), { fiveHour: null, week: null });

  {
    // the token goes only to the usage endpoint, read fresh each call, and never comes back
    let seen = null;
    login({ accessToken: 'tok-1', expiresAt: Date.now() + 60000 });
    const plan = createPlanUsage({ credentialsFile, fetch: async (url, options) => ((seen = { url, options }), reply(200, ANSWER)()) });
    const usage = await plan.read();
    assert.equal(seen.url, ENDPOINT);
    assert.equal(seen.options.headers.Authorization, 'Bearer tok-1');
    assert.equal(usage.week.used, 0.28);
    assert.ok(!JSON.stringify(usage).includes('tok-1'));
    login({ accessToken: 'tok-2', expiresAt: Date.now() + 60000 });
    await plan.read();
    assert.equal(seen.options.headers.Authorization, 'Bearer tok-2');
  }

  {
    // no figure (and no request) without a live login; none on a refusal or a network error
    let calls = 0;
    const counting = (inner) => async (...args) => ((calls += 1), inner(...args));
    login({ accessToken: 'old', expiresAt: Date.now() - 1 });
    assert.equal(await createPlanUsage({ credentialsFile, fetch: counting(reply(200, ANSWER)) }).read(), null);
    assert.equal(await createPlanUsage({ credentialsFile: join(dir, 'missing.json'), fetch: counting(reply(200, ANSWER)) }).read(), null);
    assert.equal(calls, 0);
    login({ accessToken: 'tok', expiresAt: Date.now() + 60000 });
    assert.equal(await createPlanUsage({ credentialsFile, fetch: reply(401, {}) }).read(), null);
    assert.equal(await createPlanUsage({ credentialsFile, fetch: async () => { throw new Error('offline'); } }).read(), null);
    assert.equal(await createPlanUsage({ credentialsFile, fetch: reply(200, { five_hour: null, seven_day: null }) }).read(), null);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('planusage ok');
