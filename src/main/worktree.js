'use strict';

/**
 * Worktrees: a task can run on its own copy of the project (a git worktree
 * on its own branch) so it can't trip over other tasks. Merge brings its
 * work back into the branch the project is on and removes the copy;
 * Discard removes it unmerged. Worktrees live in <project>/.xode/worktrees
 * (inside the trusted folder; git is told to ignore .xode/).
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

/** Make a worktree for a task: { path, branch, base } or { error }. */
async function create(project, title) {
  if (!(await isRepo(project))) return { error: 'This folder isn’t a git repository, so it can’t have worktrees.' };
  const top = (await git(project, ['rev-parse', '--show-toplevel'])).out || project;
  const base = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])).out || 'HEAD';
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
  return { path: where, branch, base, top };
}

/** Commit what the task left, merge its branch into the base, remove the worktree. */
async function merge(tree, message) {
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
    await git(tree.top, ['merge', '--abort']);
    // Git says why (CONFLICT …) on stdout; stderr only has "Command failed".
    return { error: `Couldn’t merge: ${(merged.out || merged.err).split('\n').slice(-3).join(' ')}` };
  }
  const removed = await discard(tree);
  return { ok: true, ...(removed.warning ? { warning: removed.warning } : {}) };
}

/** Remove the worktree and its branch, unmerged; `warning` when its folder couldn't be deleted (a file in use). */
async function discard(tree) {
  const removed = await git(tree.top, ['worktree', 'remove', '--force', tree.path]);
  await git(tree.top, ['branch', '-D', tree.branch]);
  if (!removed.ok && fs.existsSync(tree.path)) {
    return { ok: true, warning: `Couldn’t delete its folder (something may be using a file in it): ${tree.path}. Delete it by hand once it’s free.` };
  }
  return { ok: true };
}

/** What the worktree changed compared with its base: short stat lines, then the files (new ones too). */
async function changes(tree) {
  const committed = await git(tree.path, ['diff', '--shortstat', tree.base]);
  const status = await git(tree.path, ['status', '--short']);
  return { ok: true, text: [committed.out, status.out].filter(Boolean).join('\n') };
}

module.exports = { create, merge, discard, changes, slugOf, isRepo };
