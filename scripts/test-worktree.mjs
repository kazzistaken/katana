// Worktrees (src/main/worktree.js) against real throwaway git repos: create,
// merge into the recorded base, the refusals, conflicts, cleanup and the stale sweep.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const worktree = require('../src/main/worktree.js');

const scratch = fs.mkdtempSync(path.join(process.env.KATANA_TEST_TMP || os.tmpdir(), 'katana-worktree-'));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branches = (cwd) => git(cwd, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
let counter = 0;
/** A repo on branch main with one commit (a.txt, b.txt). */
function makeRepo() {
  const dir = path.join(scratch, `repo${++counter}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(path.join(dir, 'a.txt'), 'one\n');
  write(path.join(dir, 'b.txt'), 'bee\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

try {
  {
    // create: its own folder and branch under .xode/worktrees, from the branch the project is on
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'Fix the login form');
    assert.ok(!tree.error, tree.error);
    assert.equal(tree.base, 'main');
    assert.match(tree.branch, /^xode\/fix-the-login-form-/);
    assert.ok(same(path.dirname(tree.path), path.join(repo, '.xode', 'worktrees')));
    assert.ok(fs.existsSync(path.join(tree.path, 'a.txt')));
    assert.equal(tree.baseCommit, git(repo, 'rev-parse', 'main'));
    assert.ok(branches(repo).includes(tree.branch));
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.xode\/$/m);
    assert.equal(git(repo, 'status', '--porcelain'), ''); // the worktree doesn't dirty the project
    // not a repo: an error, not a crash
    const plain = path.join(scratch, 'plain');
    fs.mkdirSync(plain);
    assert.match((await worktree.create(plain, 'x')).error, /isn’t a git repository/);
  }

  {
    // merge: the task's work (even uncommitted) lands in the recorded base; worktree and branch go
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'add feature');
    write(path.join(tree.path, 'feature.txt'), 'new\n');
    const reply = await worktree.merge(tree, 'Katana: add feature');
    assert.deepEqual(reply, { ok: true });
    assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'new\n');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.ok(!fs.existsSync(tree.path));
    assert.ok(!branches(repo).includes(tree.branch));
    assert.match(git(repo, 'log', '-1', '--format=%s'), /^Merge xode\//);
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  }

  {
    // merge into a base other than main: the recorded one
    const repo = makeRepo();
    git(repo, 'switch', '-q', '-c', 'dev');
    const tree = await worktree.create(repo, 'on dev');
    assert.equal(tree.base, 'dev');
    write(path.join(tree.path, 'dev.txt'), 'd\n');
    assert.deepEqual(await worktree.merge(tree, 'm'), { ok: true });
    assert.ok(fs.existsSync(path.join(repo, 'dev.txt')));
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'dev');
    assert.ok(!git(repo, 'branch', '--contains', 'HEAD', '--list', 'main'));
  }

  {
    // merge refuses when the project is on another branch: says which, changes nothing, works after switching back
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'wrong branch');
    write(path.join(tree.path, 'x.txt'), 'x\n');
    git(repo, 'switch', '-q', '-c', 'other');
    const before = git(repo, 'rev-parse', 'HEAD');
    const reply = await worktree.merge(tree, 'm');
    assert.match(reply.error, /branch other/);
    assert.match(reply.error, /made from main/);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other'); // not switched
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.ok(fs.existsSync(tree.path)); // the task's work is still there
    assert.ok(!fs.existsSync(path.join(repo, 'x.txt')));
    git(repo, 'switch', '-q', 'main');
    assert.deepEqual(await worktree.merge(tree, 'm'), { ok: true });
    assert.ok(fs.existsSync(path.join(repo, 'x.txt')));
  }

  {
    // merge refuses a detached HEAD when a branch was recorded
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'detached');
    git(repo, 'switch', '-q', '--detach');
    assert.match((await worktree.merge(tree, 'm')).error, /detached HEAD/);
  }

  {
    // merge refuses when the project has uncommitted changes to tracked files; untracked files don't count
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'dirty');
    write(path.join(tree.path, 'x.txt'), 'x\n');
    write(path.join(repo, 'a.txt'), 'edited\n');
    const reply = await worktree.merge(tree, 'm');
    assert.match(reply.error, /uncommitted changes \(a\.txt\)/);
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'edited\n'); // untouched
    assert.ok(fs.existsSync(tree.path));
    assert.ok(!fs.existsSync(path.join(repo, 'x.txt')));
    git(repo, 'checkout', '--', 'a.txt');
    write(path.join(repo, 'notes-untracked.txt'), 'u\n');
    assert.deepEqual(await worktree.merge(tree, 'm'), { ok: true });
    assert.ok(fs.existsSync(path.join(repo, 'x.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'notes-untracked.txt')));
  }

  {
    // a conflict is aborted: the project is left as it was, the files are named, the worktree stays
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'conflict');
    write(path.join(tree.path, 'a.txt'), 'from the task\n');
    write(path.join(repo, 'a.txt'), 'from main\n');
    git(repo, 'commit', '-q', '-am', 'main edits a');
    const before = git(repo, 'rev-parse', 'HEAD');
    const reply = await worktree.merge(tree, 'm');
    assert.match(reply.error, /conflicts with main in a\.txt/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from main\n');
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')));
    assert.ok(fs.existsSync(tree.path));
    assert.ok(branches(repo).includes(tree.branch));
  }

  {
    // an old saved task has no base: merges into whatever is checked out
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'old');
    write(path.join(tree.path, 'old.txt'), 'o\n');
    const { base, baseCommit, ...old } = tree;
    git(repo, 'switch', '-q', '-c', 'somewhere');
    assert.deepEqual(await worktree.merge(old, 'm'), { ok: true });
    assert.ok(fs.existsSync(path.join(repo, 'old.txt')));
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'somewhere');
  }

  {
    // discard: folder and branch gone, work thrown away
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'throw away');
    write(path.join(tree.path, 'junk.txt'), 'j\n');
    assert.deepEqual(await worktree.discard(tree), { ok: true });
    assert.ok(!fs.existsSync(tree.path));
    assert.ok(!branches(repo).includes(tree.branch));
    assert.ok(!fs.existsSync(path.join(repo, 'junk.txt')));
  }

  {
    // cleanup of a deleted task: untouched worktree: folder and branch go
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'nothing done');
    const reply = await worktree.cleanup(tree);
    assert.deepEqual(reply, { ok: true });
    assert.ok(!fs.existsSync(tree.path));
    assert.ok(!branches(repo).includes(tree.branch));
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
    // doing it again (or on a folder already deleted by hand) is harmless
    assert.deepEqual(await worktree.cleanup(tree), { ok: true });
  }

  {
    // cleanup: a folder deleted by hand is pruned from git too
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'by hand');
    fs.rmSync(tree.path, { recursive: true, force: true });
    assert.deepEqual(await worktree.cleanup(tree), { ok: true });
    assert.ok(!branches(repo).includes(tree.branch));
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  }

  {
    // cleanup: a branch with commits not in the base is kept (folder removed), and uncommitted work is saved on it
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'has work');
    write(path.join(tree.path, 'kept.txt'), 'k\n');
    git(tree.path, 'add', '-A');
    git(tree.path, 'commit', '-q', '-m', 'task work');
    write(path.join(tree.path, 'late.txt'), 'l\n'); // never committed
    const reply = await worktree.cleanup(tree);
    assert.equal(reply.ok, true);
    assert.equal(reply.keptBranch, tree.branch);
    assert.ok(!fs.existsSync(tree.path));
    assert.ok(branches(repo).includes(tree.branch));
    assert.equal(git(repo, 'show', `${tree.branch}:kept.txt`), 'k');
    assert.equal(git(repo, 'show', `${tree.branch}:late.txt`), 'l');
    assert.ok(!fs.existsSync(path.join(repo, 'kept.txt'))); // nothing leaked into the project
  }

  {
    // cleanup: a branch already merged into the base is deleted
    const repo = makeRepo();
    const tree = await worktree.create(repo, 'merged elsewhere');
    write(path.join(tree.path, 'm.txt'), 'm\n');
    git(tree.path, 'add', '-A');
    git(tree.path, 'commit', '-q', '-m', 'work');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'by hand', tree.branch);
    const reply = await worktree.cleanup(tree);
    assert.deepEqual(reply, { ok: true });
    assert.ok(!branches(repo).includes(tree.branch));
    assert.ok(fs.existsSync(path.join(repo, 'm.txt')));
  }

  {
    // cleanup never touches anything outside .xode/worktrees, or a branch that isn't xode/...
    const repo = makeRepo();
    const outside = path.join(scratch, 'precious');
    write(path.join(outside, 'file.txt'), 'keep\n');
    assert.deepEqual(await worktree.cleanup({ top: repo, path: outside, branch: 'xode/x', base: 'main' }), { ok: true });
    assert.ok(fs.existsSync(path.join(outside, 'file.txt')));
    assert.deepEqual(await worktree.cleanup({ top: repo, path: path.join(repo, '.xode', 'worktrees'), branch: 'xode/x', base: 'main' }), { ok: true });
    assert.deepEqual(await worktree.cleanup({ top: repo, path: path.join(repo, '.xode', 'worktrees', '..', '..'), branch: 'xode/x', base: 'main' }), { ok: true });
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
    git(repo, 'branch', 'feature');
    const tree = await worktree.create(repo, 'guard');
    await worktree.cleanup({ ...tree, branch: 'feature' });
    assert.ok(branches(repo).includes('feature'));
    await worktree.cleanup(tree);
  }

  {
    // pruneStale: removes leftover checkouts git forgot; keeps live worktrees, ones a saved task uses, and unknown folders
    const repo = makeRepo();
    const live = await worktree.create(repo, 'live');
    const used = await worktree.create(repo, 'used');
    const gone = await worktree.create(repo, 'gone');
    const root = path.join(repo, '.xode', 'worktrees');
    // "gone": git forgets it (its admin entry is deleted) but the folder is left behind, as after a crash
    const adminName = fs.readdirSync(path.join(repo, '.git', 'worktrees')).find((name) => fs.readFileSync(path.join(repo, '.git', 'worktrees', name, 'gitdir'), 'utf8').toLowerCase().includes(path.basename(gone.path)));
    fs.rmSync(path.join(repo, '.git', 'worktrees', adminName), { recursive: true, force: true });
    // "used": same, but a saved task still points to it
    const usedAdmin = fs.readdirSync(path.join(repo, '.git', 'worktrees')).find((name) => fs.readFileSync(path.join(repo, '.git', 'worktrees', name, 'gitdir'), 'utf8').toLowerCase().includes(path.basename(used.path)));
    fs.rmSync(path.join(repo, '.git', 'worktrees', usedAdmin), { recursive: true, force: true });
    // an empty leftover, a folder git never made (has files, no .git), and a nested repo
    fs.mkdirSync(path.join(root, 'empty-leftover'));
    write(path.join(root, 'mine', 'notes.txt'), 'not git\n');
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');

    const removed = await worktree.pruneStale(repo, [used.path]);
    assert.deepEqual(removed.map((p) => path.basename(p)).sort(), [path.basename(gone.path), 'empty-leftover'].sort());
    assert.ok(!fs.existsSync(gone.path));
    assert.ok(fs.existsSync(used.path)); // a saved task points to it
    assert.ok(fs.existsSync(live.path)); // git knows it
    assert.ok(fs.existsSync(path.join(root, 'mine', 'notes.txt')));
    assert.ok(fs.existsSync(path.join(nested, '.git')));
    assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
    // idempotent, and fine on something that isn't a repo or has no worktrees
    assert.deepEqual(await worktree.pruneStale(repo, [used.path]), []);
    assert.deepEqual(await worktree.pruneStale(path.join(scratch, 'plain'), []), []);
    assert.deepEqual(await worktree.pruneStale(makeRepo(), []), []);
    // git's own record of a folder deleted by hand is pruned
    fs.rmSync(live.path, { recursive: true, force: true });
    await worktree.pruneStale(repo, [used.path]);
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  }

  console.log('worktree tests passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
