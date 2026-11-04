'use strict';

/**
 * Worktrees: a task can run on its own copy of the project (a git worktree
 * on its own branch) so it can't trip over other tasks. Merge brings its
 * work back into the branch the project was on when the worktree was made
 * (and refuses if the project is on another branch or has uncommitted
 * changes) and removes the copy; Discard removes it unmerged. Worktrees live
 * in <project>/.xode/worktrees (inside the trusted folder; git is told to
 * ignore .xode/).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout || '').trim(), err: String(stderr || error?.message || '').trim() });
    });
  });
}

const slugOf = (text) =>
  String(text || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'task';

async function isRepo(folder) {
  return (await git(folder, ['rev-parse', '--is-inside-work-tree'])).out === 'true';
}

/** Make a worktree for a task: { path, branch, base, baseCommit, top } or { error }. */
async function create(project, title) {
  if (!(await isRepo(project))) return { error: 'This folder isn’t a git repository, so it can’t have worktrees.' };
  const top = (await git(project, ['rev-parse', '--show-toplevel'])).out || project;
  const base = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
  const baseCommit = (await git(top, ['rev-parse', 'HEAD'])).out;
  const slug = `${slugOf(title)}-${Date.now().toString(36).slice(-4)}`;
  const branch = `xode/${slug}`;
  const where = path.join(top, '.xode', 'worktrees', slug);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  // Keep the worktrees out of the project's own git status.
  const exclude = path.join(top, '.git', 'info', 'exclude');
  try {
    const now = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!/^\.xode\/$/m.test(now)) fs.appendFileSync(exclude, `${now && !now.endsWith('\n') ? '\n' : ''}.xode/\n`);
  } catch {
    /* .git may be a file (a worktree itself); git still works */
  }
  const made = await git(top, ['worktree', 'add', '-b', branch, where, 'HEAD']);
  if (!made.ok) return { error: made.err || 'git worktree add failed.' };
  return { path: where, branch, base, ...(baseCommit ? { baseCommit } : {}), top };
}

/** The files git tracks that are changed in `cwd` (untracked ones can't be lost by a merge; git itself refuses if one would be overwritten). */
async function trackedChanges(cwd) {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  return status.ok ? status.out.split('\n').filter(Boolean).map((line) => line.replace(/^\S{1,2}\s+/, '')) : [];
}

/**
 * Commit what the task left, merge its branch into the base it was made
 * from, remove the worktree. The project must be on that base branch and
 * have no uncommitted changes: nothing is switched or stashed for you.
 */
async function merge(tree, message) {
  const current = (await git(tree.top, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  // An old saved task has no base, and one started on a detached HEAD has "HEAD": merge into what's checked out.
  const base = tree.base && tree.base !== 'HEAD' ? tree.base : current;
  if (current !== base) {
    return { error: `Couldn’t merge: the project is on ${current === 'HEAD' ? 'no branch (detached HEAD)' : `branch ${current}`}, but ${tree.branch} was made from ${base}. Switch the project back to ${base} (git switch ${base}), then Merge again.` };
  }
  const dirty = await trackedChanges(tree.top);
  if (dirty.length) {
    const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? `, and ${dirty.length - 5} more` : '');
    return { error: `Couldn’t merge: the project has uncommitted changes (${shown}). Commit or stash them, then Merge again.` };
  }
  const status = await git(tree.path, ['status', '--porcelain']);
  if (status.out) {
    await git(tree.path, ['add', '-A']);
    const commit = await git(tree.path, ['commit', '-m', message || 'Katana task']);
    if (!commit.ok) {
      if (/Author identity unknown|tell me who you are/i.test(commit.err)) {
        return { error: 'Git doesn’t know your name and email yet, so it can’t commit. Run git config --global user.name "…" and user.email "…", then Merge again.' };
      }
      return { error: commit.err.split('\n').slice(-2).join(' ') };
    }
  }
  const merged = await git(tree.top, ['merge', '--no-ff', '-m', `Merge ${tree.branch}`, tree.branch]);
  if (!merged.ok) {
    const conflicts = (await git(tree.top, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
    await git(tree.top, ['merge', '--abort']);
    if (conflicts.length) {
      return { error: `Couldn’t merge: ${tree.branch} conflicts with ${base} in ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''}. Nothing was changed; resolve it in the task, then Merge again.` };
    }
    // Git says why on stdout; stderr only has "Command failed".
    return { error: `Couldn’t merge: ${(merged.out || merged.err).split('\n').slice(-3).join(' ')}` };
  }
  const removed = await discard(tree);
  return { ok: true, ...(removed.warning ? { warning: removed.warning } : {}) };
}

/** Remove the worktree and its branch, unmerged; `warning` when its folder couldn't be deleted (a file in use). */
async function discard(tree) {
  const removed = await git(tree.top, ['worktree', 'remove', '--force', tree.path]);
  await git(tree.top, ['branch', '-D', tree.branch]);
  await git(tree.top, ['worktree', 'prune']);
  if (!removed.ok && fs.existsSync(tree.path)) {
    return { ok: true, warning: `Couldn’t delete its folder (something may be using a file in it): ${tree.path}. Delete it by hand once it’s free.` };
  }
  return { ok: true };
}

const worktreesDir = (top) => path.join(top, '.xode', 'worktrees');
const sameKey = (p) => {
  const key = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? key.toLowerCase() : key;
};
/** `child` is strictly inside `parent`. */
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * A deleted task's worktree: the folder goes; its branch goes too when it
 * holds nothing the base doesn't (no commits, or already merged). Work the
 * task left uncommitted is committed onto the branch first, so a branch with
 * work on it is kept. Only ever touches a folder inside <top>/.xode/worktrees
 * and a branch named xode/...; returns { ok, keptBranch?, warning? }.
 */
async function cleanup(tree) {
  if (!tree || !tree.top || !tree.path || !tree.branch) return { ok: true };
  if (!inside(worktreesDir(tree.top), tree.path) || !/^xode\//.test(tree.branch)) return { ok: true };
  if (fs.existsSync(tree.path)) {
    const status = await git(tree.path, ['status', '--porcelain']);
    if (status.out) {
      await git(tree.path, ['add', '-A']);
      const commit = await git(tree.path, ['commit', '-m', 'Katana: work left in a deleted task']);
      if (!commit.ok) return { ok: true, warning: `Kept its worktree, which has uncommitted work git couldn’t save: ${tree.path}` };
    }
  }
  const removed = await git(tree.top, ['worktree', 'remove', '--force', tree.path]);
  await git(tree.top, ['worktree', 'prune']);
  const warning = !removed.ok && fs.existsSync(tree.path) ? `Couldn’t delete its folder (something may be using a file in it): ${tree.path}.` : '';
  let keptBranch = '';
  if ((await git(tree.top, ['rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`])).ok) {
    // Compared with where it started: the base branch if it still exists, else the commit it was made at, else where the project is now.
    let against = 'HEAD';
    if (tree.base && tree.base !== 'HEAD' && (await git(tree.top, ['rev-parse', '--verify', '--quiet', `refs/heads/${tree.base}`])).ok) against = `refs/heads/${tree.base}`;
    else if (tree.baseCommit) against = tree.baseCommit;
    if ((await git(tree.top, ['merge-base', '--is-ancestor', `refs/heads/${tree.branch}`, against])).ok) await git(tree.top, ['branch', '-D', tree.branch]);
    else keptBranch = tree.branch;
  }
  return { ok: true, ...(keptBranch ? { keptBranch } : {}), ...(warning ? { warning } : {}) };
}

/**
 * Startup tidy for a repo: `git worktree prune`, then remove leftover
 * folders in <top>/.xode/worktrees that git no longer knows and no saved task
 * points to. Conservative: a folder is only removed when it is empty or is a
 * checkout whose link back into git (its .git file) is dead; anything else
 * stays. `keep`: worktree paths saved tasks still use. Returns the folders removed.
 */
async function pruneStale(folder, keep = []) {
  const removed = [];
  if (!folder || !fs.existsSync(folder) || !(await isRepo(folder))) return removed;
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).out || folder;
  await git(top, ['worktree', 'prune']);
  const root = worktreesDir(top);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return removed;
  }
  const known = new Set((await git(top, ['worktree', 'list', '--porcelain'])).out.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => sameKey(line.slice(9).trim())));
  const used = new Set(keep.filter(Boolean).map(sameKey));
  for (const name of names) {
    const where = path.join(root, name);
    if (known.has(sameKey(where)) || used.has(sameKey(where))) continue;
    try {
      const contents = fs.readdirSync(where);
      let dead = contents.length === 0;
      const link = path.join(where, '.git');
      if (!dead && contents.includes('.git') && fs.lstatSync(link).isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(link, 'utf8'))?.[1]?.trim();
        dead = Boolean(target) && !fs.existsSync(path.resolve(where, target));
      }
      if (!dead) continue;
      fs.rmSync(where, { recursive: true, force: true });
      if (!fs.existsSync(where)) removed.push(where);
    } catch {
      /* in use or unreadable: leave it */
    }
  }
  return removed;
}

/** What the worktree changed compared with its base: short stat lines, then the files (new ones too). */
async function changes(tree) {
  const committed = await git(tree.path, ['diff', '--shortstat', tree.base]);
  const status = await git(tree.path, ['status', '--short']);
  return { ok: true, text: [committed.out, status.out].filter(Boolean).join('\n') };
}

module.exports = { create, merge, discard, cleanup, pruneStale, changes, slugOf, isRepo };
