import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTeams, parseMember, memberId, keyOf, claimsOverlap, trustKeys, TEAM_TOOLS, VERIFIER_TOOLS } = require('../src/daemon/team.js');

/** A team with fake sessions and git: what it started, said, killed and merged. */
function harness({ git = true, settings = {} } = {}) {
  const calls = { start: [], say: [], kill: [], merge: [], trees: 0, inbox: [] };
  const words = new Map(); // sessionId -> last words
  let n = 0;
  let clock = 1000;
  const views = [];
  const saved = [];
  const io = {
    start: async (id, options) => {
      calls.start.push({ id, ...options });
      return { started: true };
    },
    say: (id, text) => {
      calls.say.push({ id, text });
      return true;
    },
    kill: (id) => calls.kill.push(id),
    uuid: () => `sess-${(n += 1)}`,
    isRepo: async () => git,
    makeTree: async (cwd, title) => {
      calls.trees += 1;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return { path: `${cwd}\\.xode\\worktrees\\${slug}`, branch: `xode/${slug}`, base: 'main', top: cwd };
    },
    merge: async (tree, message) => {
      calls.merge.push({ tree, message });
      return { ok: true };
    },
    changes: async (tree) => ` 2 files changed (${tree.branch})`,
    lastAnswer: (_cwd, sessionId) => words.get(sessionId) || '',
    settings: () => ({ workerModel: 'claude-haiku-5-5', workerEffort: 'low', verifierModel: 'claude-sonnet-5-5', verifierEffort: 'high', ...settings }),
    inbox: (taskId) => calls.inbox.push(taskId),
  };
  const teams = createTeams({ io, emit: (v) => views.push(v), save: (d) => saved.push(d), now: () => (clock += 10) });
  teams.ensure('task_1', { cwd: 'C:\\code\\shop', title: 'Shop' });
  const member = (key) => teams.get('task_1').members[key];
  /** A member's turn ends with these last words. */
  const finish = (key, said = '') => {
    words.set(member(key).sessionId, said);
    teams.sessionEvent(memberId('task_1', key), { state: 'idle', finished: true });
  };
  return { teams, calls, member, finish, views, saved, words };
}

// ids and names
assert.deepEqual(parseMember('task_ab12--w3'), { taskId: 'task_ab12', key: 'w3' });
assert.equal(parseMember('task_ab12--w9'), null);
assert.equal(parseMember('task_ab12'), null);
assert.equal(keyOf('Worker 2'), 'w2');
assert.equal(keyOf('3'), 'w3');
assert.equal(keyOf(4), 'w4');
assert.equal(keyOf('Worker 5'), null);
assert.equal(keyOf('Verifier 2', 'verifier'), 'v2');
assert.equal(keyOf('Verifier 3', 'verifier'), null);

// file claims: the same file, a folder and what's in it, a glob and its folder overlap; siblings don't
assert.ok(claimsOverlap('src/app.js', './src/app.js'));
assert.ok(claimsOverlap('src/auth', 'src/auth/login.js'));
assert.ok(claimsOverlap('src\\auth\\', 'SRC/auth/x.js'));
assert.ok(claimsOverlap('src/**/*.css', 'src/ui/a.css'));
assert.ok(claimsOverlap('*', 'anything.js'));
assert.ok(!claimsOverlap('src/a.js', 'src/a.json'));
assert.ok(!claimsOverlap('src/auth/**', 'src/cart/**'));
assert.ok(!claimsOverlap('README.md', 'src/readme.js'));

// a member's "trust this folder?": yes, wherever the pointer starts (Enter alone on "No, exit" would quit)
assert.deepEqual(trustKeys('Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm'), ['\x1b[B', '\r']);
assert.deepEqual(trustKeys('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit'), ['\r']);
assert.equal(trustKeys('Do you trust the files in this folder?\n(drawing…)'), null); // not drawn yet: ask the user
assert.equal(trustKeys('❯ No, exit'), null);

// assign: a worker on its own worktree, its brief, its model; working at once
{
  const { teams, calls, member, views } = harness();
  const reply = await teams.assign('task_1', { title: 'Login form', prompt: 'Build the login form.', files: ['src/login.js'] });
  assert.equal(reply.worker, 'Worker 1');
  assert.equal(reply.branch, 'xode/login-form');
  const started = calls.start[0];
  assert.equal(started.id, 'task_1--w1');
  assert.equal(started.role, 'worker');
  assert.equal(started.cwd, 'C:\\code\\shop\\.xode\\worktrees\\login-form');
  assert.equal(started.model, 'claude-haiku-5-5');
  assert.equal(started.effort, 'low');
  assert.match(started.prompt, /Worker 1 · from your Leader\] Your subtask: Login form/);
  assert.match(started.prompt, /Files you own: src\/login\.js/);
  assert.match(started.prompt, /branch xode\/login-form/);
  assert.equal(member('w1').state, 'working');
  assert.equal(views.at(-1).members[0].state, 'working');
  assert.equal(views.at(-1).log.at(-1).text, 'started · Login form');

  // the next free worker; a named busy one is refused; overlapping claims are refused
  assert.equal((await teams.assign('task_1', { title: 'Cart', prompt: 'p', files: ['src/cart/**'] })).worker, 'Worker 2');
  assert.match((await teams.assign('task_1', { worker: 'Worker 1', title: 'X', prompt: 'p' })).error, /busy/);
  assert.match((await teams.assign('task_1', { title: 'Cart tests', prompt: 'p', files: ['src/cart/cart.test.js'] })).error, /overlaps Worker 2/);
  assert.match((await teams.assign('task_1', { worker: 'Worker 7', title: 'X', prompt: 'p' })).error, /no Worker 7/);
  assert.match((await teams.assign('task_1', { title: '', prompt: 'p' })).error, /title and a prompt/);
  assert.equal(calls.start.length, 2);
  // all four busy
  await teams.assign('task_1', { title: 'Three', prompt: 'p', files: ['a'] });
  await teams.assign('task_1', { title: 'Four', prompt: 'p', files: ['b'] });
  assert.match((await teams.assign('task_1', { title: 'Five', prompt: 'p', files: ['c'] })).error, /All four workers/);
}

// outside git: workers share the folder, so each must claim files
{
  const { teams, calls } = harness({ git: false });
  assert.match((await teams.assign('task_1', { title: 'Docs', prompt: 'p' })).error, /isn’t a git repository/);
  const reply = await teams.assign('task_1', { title: 'Docs', prompt: 'p', files: ['docs/'] });
  assert.equal(reply.shared, true);
  assert.equal(calls.start[0].cwd, 'C:\\code\\shop');
  assert.match(calls.start[0].prompt, /share the folder/);
  assert.equal(calls.trees, 0);
}

// hearing back: a finished turn is a result for the leader, who is woken about it once
{
  const { teams, calls, member, finish } = harness();
  await teams.assign('task_1', { title: 'Login form', prompt: 'p', files: ['src/login.js'] });
  assert.equal(teams.settled('task_1'), false); // a leader turn ending now isn't the task finishing
  assert.equal(teams.busy('task_1'), true);
  assert.equal(teams.wantsNudge('task_1'), false);
  finish('w1', 'Added the form; tests pass.');
  assert.equal(member('w1').state, 'done');
  assert.equal(member('w1').result, 'Added the form; tests pass.');
  assert.deepEqual(calls.inbox, ['task_1']);
  assert.equal(teams.busy('task_1'), false);
  assert.equal(teams.settled('task_1'), false); // uncollected
  assert.equal(teams.wantsNudge('task_1'), true);
  assert.equal(teams.nudgeText('task_1'), '[team] Worker 1 finished "Login form". Call team_collect for the details, then carry on.');
  assert.equal(teams.wantsNudge('task_1'), false); // told once
  const got = await teams.collect('task_1');
  assert.equal(got.results.length, 1);
  assert.equal(got.results[0].kind, 'finished');
  assert.equal(got.results[0].summary, 'Added the form; tests pass.');
  assert.match(got.results[0].changes, /2 files changed \(xode\/login-form\)/);
  assert.equal(got.stillWorking, undefined);
  assert.equal(teams.settled('task_1'), true);
  assert.equal((await teams.collect('task_1')).note, 'Nothing new, and nobody is working.');
}

// collect can wait for the next result while someone works
{
  const { teams, finish } = harness();
  await teams.assign('task_1', { title: 'Slow one', prompt: 'p', files: ['x'] });
  const waiting = teams.collect('task_1', { wait: 30 });
  setTimeout(() => finish('w1', 'done'), 20);
  const got = await waiting;
  assert.equal(got.results[0].member, 'Worker 1');
}

// the loop: verify → FAIL → send back → verify → PASS → merge
{
  const { teams, calls, member, finish } = harness();
  await teams.assign('task_1', { title: 'Login form', prompt: 'Build it.', files: ['src/login.js'] });
  assert.match((await teams.verify('task_1', { worker: 'Worker 1' })).error, /still working/);
  assert.match((await teams.merge('task_1', { worker: 'Worker 1' })).error, /still working/);
  finish('w1', 'Built it.');
  await teams.collect('task_1');
  assert.match((await teams.merge('task_1', { worker: 'Worker 1' })).error, /hasn’t been verified/);
  const check = await teams.verify('task_1', { worker: 'Worker 1' });
  assert.deepEqual(check, { verifier: 'Verifier 1', checking: 'Worker 1', attempt: 1 });
  const v = calls.start.at(-1);
  assert.equal(v.id, 'task_1--v1');
  assert.equal(v.role, 'verifier');
  assert.equal(v.cwd, member('w1').cwd); // in the worker's worktree
  assert.equal(v.model, 'claude-sonnet-5-5');
  assert.match(v.prompt, /git diff main\.\.\.HEAD/);
  assert.match(v.prompt, /Its summary:\nBuilt it\./);
  assert.match(v.prompt, /team_verdict/);
  assert.match((await teams.verify('task_1', { worker: 'Worker 1' })).error, /already being checked/);
  // only a verifier can give a verdict, and only the leader has the leader's tools
  assert.deepEqual(teams.toolsFor('task_1'), TEAM_TOOLS);
  assert.deepEqual(teams.toolsFor('task_1--v1'), VERIFIER_TOOLS);
  assert.deepEqual(teams.toolsFor('task_1--w1'), []);
  assert.match((await teams.call('task_1', 'team_verdict', { pass: true })).error, /no tool called team_verdict/);
  assert.match((await teams.call('task_1--w1', 'team_merge', { worker: 1 })).error, /no tool called/);
  const said = await teams.call('task_1--v1', 'team_verdict', { pass: false, details: 'src/login.js:12 submits an empty password.' });
  assert.deepEqual(said, { result: { recorded: true, pass: false } });
  assert.equal(member('w1').state, 'failed');
  assert.equal(member('v1').state, 'done');
  // the rest of its turn doesn't make it "working" again, nor does its end change the verdict
  teams.sessionEvent('task_1--v1', { state: 'working' });
  assert.equal(member('v1').state, 'done');
  finish('v1', 'Done checking.');
  assert.equal(member('v1').state, 'done');
  const verdicts = (await teams.call('task_1', 'team_collect', {})).result.results;
  assert.equal(verdicts.length, 1);
  assert.deepEqual([verdicts[0].kind, verdicts[0].worker, verdicts[0].pass], ['verdict', 'Worker 1', false]);
  assert.match((await teams.merge('task_1', { worker: 'Worker 1' })).error, /failed verification/);
  // back for fixes: typed into the same session; a new attempt with no verdict yet
  const back = await teams.sendBack('task_1', { worker: 'Worker 1', feedback: 'Reject empty passwords (login.js:12).' });
  assert.deepEqual(back, { worker: 'Worker 1', attempt: 2 });
  assert.equal(calls.say.at(-1).id, 'task_1--w1');
  assert.match(calls.say.at(-1).text, /Fixes needed on “Login form”:\n\nReject empty passwords/);
  assert.equal(member('w1').state, 'working');
  finish('w1', 'Fixed.');
  await teams.collect('task_1');
  assert.match((await teams.merge('task_1', { worker: 'Worker 1' })).error, /hasn’t been verified/);
  await teams.verify('task_1', { worker: 'Worker 1', verifier: 'Verifier 2', focus: 'empty passwords' });
  assert.match(calls.start.at(-1).prompt, /look especially at: empty passwords/);
  await teams.call('task_1--v2', 'team_verdict', { pass: true, details: 'Tests pass; tried it in the viewer.' });
  assert.equal(member('w1').state, 'done');
  const merged = await teams.merge('task_1', { worker: 'Worker 1' });
  assert.deepEqual(merged, { merged: 'Worker 1', branch: 'xode/login-form', into: 'main' });
  assert.equal(calls.merge.length, 1);
  assert.equal(calls.merge[0].message, 'Worker 1: Login form');
  // its session and the verifiers in its folder end before the folder goes
  assert.ok(calls.kill.includes('task_1--w1'));
  assert.ok(calls.kill.includes('task_1--v2'));
  assert.equal(member('w1').merged, true);
  assert.match((await teams.merge('task_1', { worker: 'Worker 1' })).error, /already merged/);
  // free again, with a fresh worktree and session for the next subtask
  const next = await teams.assign('task_1', { worker: 'Worker 1', title: 'Logout', prompt: 'p', files: ['src/login.js'] });
  assert.equal(next.branch, 'xode/logout');
  assert.notEqual(calls.start.at(-1).sessionId, calls.start.find((s) => s.id === 'task_1--w1').sessionId);
  assert.equal(member('w1').attempt, 1);
}

// a verifier that never calls team_verdict: its last words decide, or it failed
{
  const { teams, member, finish } = harness();
  await teams.assign('task_1', { title: 'A', prompt: 'p', files: ['a'] });
  await teams.assign('task_1', { title: 'B', prompt: 'p', files: ['b'] });
  finish('w1', 'ok');
  finish('w2', 'ok');
  await teams.verify('task_1', { worker: 1 });
  await teams.verify('task_1', { worker: 2 });
  assert.match((await teams.verify('task_1', { worker: 1 })).error, /Both verifiers are busy/);
  finish('v1', 'All good.\nVERDICT: PASS');
  assert.equal(member('w1').verdict.pass, true);
  finish('v2', 'I ran out of time.');
  assert.equal(member('v2').state, 'failed');
  assert.equal(member('w2').verdict, null);
  const results = (await teams.collect('task_1')).results;
  assert.equal(results.at(-1).kind, 'failed');
  assert.match(results.at(-1).note, /without a verdict/);
}

// stopped or crashed mid-turn: failed, and the leader hears of it; asking the user: a needs flag
{
  const { teams, member } = harness();
  await teams.assign('task_1', { title: 'A', prompt: 'p', files: ['a'] });
  // its session opening says "idle" before its first message lands: not a failure
  teams.sessionEvent('task_1--w1', { state: 'idle', finished: false, stopped: false, running: true });
  assert.equal(member('w1').state, 'working');
  teams.sessionEvent('task_1--w1', { state: 'needs', need: 'permission' });
  assert.equal(member('w1').needs, true);
  assert.equal(member('w1').state, 'working');
  teams.sessionEvent('task_1--w1', { state: 'working' });
  assert.equal(member('w1').needs, false);
  teams.sessionEvent('task_1--w1', { state: 'idle', stopped: true, running: true });
  assert.equal(member('w1').state, 'failed');
  assert.equal(member('w1').note, 'Stopped before it finished.');
  assert.equal((await teams.collect('task_1')).results[0].kind, 'failed');
  // the user types into it again: working again
  teams.sessionEvent('task_1--w1', { state: 'working' });
  assert.equal(member('w1').state, 'working');
}

// leaving hierarchy mode: every member's session ends; unmerged branches are named, not deleted
{
  const { teams, calls } = harness();
  await teams.assign('task_1', { title: 'A', prompt: 'p', files: ['a'] });
  const out = teams.stopAll('task_1');
  assert.deepEqual(out.unmerged, ['xode/a']);
  assert.equal(calls.kill.length, 6);
  assert.equal(teams.get('task_1').members.w1.state, 'failed');
  assert.equal(teams.get('task_1').inbox.length, 0);
  assert.equal(teams.settled('task_1'), true);
  teams.stopAll('task_1', { forget: true });
  assert.equal(teams.has('task_1'), false);
}

// saved and loaded (the daemon restarted): nobody is working any more
{
  const { teams, saved } = harness();
  await teams.assign('task_1', { title: 'A', prompt: 'p', files: ['a'] });
  const again = harness();
  again.teams.load(JSON.parse(JSON.stringify(saved.at(-1))));
  const w1 = again.teams.get('task_1').members.w1;
  assert.equal(w1.state, 'failed');
  assert.match(w1.note, /restarted/);
  assert.equal(w1.subtask, 'A');
  assert.deepEqual(again.teams.summary('task_1'), ['Worker 1 failed: A']);
}

// Katana's view: one line per member with work; nothing for a task without a team
{
  const { teams } = harness();
  await teams.assign('task_1', { title: 'Login form', prompt: 'p', files: ['a'] });
  assert.deepEqual(teams.summary('task_1'), ['Worker 1 working: Login form']);
  assert.deepEqual(teams.summary('task_2'), []);
  assert.equal(teams.settled('task_2'), true);
  const status = teams.status('task_1');
  assert.equal(status.members.length, 6);
  assert.match(status.mode, /git worktrees/);
  assert.equal(status.members[0].verdict, 'unverified');
}

console.log('team ok');
