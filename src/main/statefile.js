'use strict';

const fs = require('node:fs');

/**
 * state.json, the app's saved state, as main (for the window) and katanad
 * (headless.js, with no window open) read and write it.
 *
 * Written whole beside it (flushed to disk), then swapped in, so a crash
 * mid-write can't leave half a file. The last good copy is kept as
 * state.json.bak: when state.json can't be read, that is used instead.
 * When neither can be read, loadStateFile says so ({ error }) and the
 * callers write nothing over it (the window asks the user first).
 */

const BACKUP_EVERY_MS = 10_000;
const RETRIES = 5;

// What this process last saw of each file as good JSON (written or parsed): "size:mtime:inode".
const known = new Map();
// When this process last refreshed each file's .bak.
const backedUp = new Map();
// The unreadable copies this process already set aside, so each bad file is kept once: { key, kept }.
const setAsideOnce = new Map();

const stamp = (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
const statOf = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

function parse(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { missing: error.code === 'ENOENT', error: error.code || error.message };
  }
  try {
    const state = JSON.parse(text);
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { error: 'not a saved state' };
    return { state };
  } catch (error) {
    return { error: `bad JSON: ${error.message}` };
  }
}

/**
 * The saved state: { state, from } where from is 'file', 'backup' (state.json
 * was unreadable; the .bak was used) or 'none' (no saved state yet: state null).
 * Neither readable: { state: null, error } (and the bad file is copied aside once,
 * as state.json.unreadable-<time>).
 */
function loadStateFile(file) {
  const before = statOf(file);
  const main = parse(file);
  if (main.state) {
    if (before) known.set(file, stamp(before));
    return { state: main.state, from: 'file' };
  }
  if (!main.missing) setAside(file);
  const backup = parse(`${file}.bak`);
  if (backup.state) return { state: backup.state, from: 'backup', ...(main.missing ? {} : { problem: main.error }) };
  if (main.missing && backup.missing) return { state: null, from: 'none' };
  return { state: null, error: main.missing ? `state.json is missing and its backup is unreadable (${backup.error})` : main.error };
}

/** The saved state, or null (none yet, or unreadable: see loadStateFile). */
function readStateFile(file) {
  return loadStateFile(file).state;
}

function setAside(file) {
  const stat = statOf(file);
  if (!stat) return;
  if (setAsideOnce.get(file)?.key === stamp(stat)) return;
  const kept = `${file}.unreadable-${Date.now()}`;
  setAsideOnce.set(file, { key: stamp(stat), kept });
  try {
    fs.copyFileSync(file, kept);
  } catch (error) {
    console.error('[state] could not keep the unreadable state file', error);
  }
}

/** Retry a rename a few times: on Windows a reader or a virus scanner can hold the file for a moment. */
function renameSync(from, to) {
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (i >= RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

async function renameAsync(from, to) {
  for (let i = 0; ; i += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      if (i >= RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (i + 1)));
    }
  }
}

/** Keep the file as it is now as file.bak, when it's good (now and then, not on every save). */
function backup(file) {
  if (Date.now() - (backedUp.get(file) || 0) < BACKUP_EVERY_MS) return;
  const stat = statOf(file);
  if (!stat) return;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    if (known.get(file) !== stamp(stat)) JSON.parse(text);
  } catch {
    return; // not good: the old .bak stays
  }
  try {
    const tmp = `${file}.bak.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, `${file}.bak`);
    backedUp.set(file, Date.now());
  } catch (error) {
    console.error('[state] could not keep a backup', error);
  }
}

/** Write the state now: flushed to disk beside it, then swapped in. */
function writeStateFile(file, state) {
  const text = JSON.stringify(state);
  backup(file);
  // Each process its own temp file: main and katanad never write into the same one.
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameSync(tmp, file);
  const stat = statOf(file);
  if (stat) known.set(file, stamp(stat));
  return true;
}

/**
 * The same, off the main thread's back: saves made while one is being
 * written wait, and only the latest of them is written. Resolves once the
 * given state (or a later one) is on disk.
 */
const queues = new Map(); // file -> { latest, running }
function writeStateFileAsync(file, state) {
  let queue = queues.get(file);
  if (!queue) {
    queue = { latest: null, running: null, waiters: [] };
    queues.set(file, queue);
  }
  queue.latest = state;
  const done = new Promise((resolve, reject) => queue.waiters.push({ resolve, reject }));
  if (!queue.running) queue.running = drain(file, queue);
  return done;
}

async function drain(file, queue) {
  while (queue.latest) {
    const state = queue.latest;
    const waiters = queue.waiters;
    queue.latest = null;
    queue.waiters = [];
    try {
      const text = JSON.stringify(state);
      backup(file);
      const tmp = `${file}.${process.pid}.tmp`;
      const handle = await fs.promises.open(tmp, 'w');
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameAsync(tmp, file);
      const stat = statOf(file);
      if (stat) known.set(file, stamp(stat));
      for (const w of waiters) w.resolve(true);
    } catch (error) {
      for (const w of waiters) w.reject(error);
    }
  }
  queue.running = null;
}

/** Whether an async write of the file is still going (quitting waits for it: stateWritesDone). */
const stateWriting = (file) => Boolean(queues.get(file)?.running);

/** Resolves when no async write of the file is still going (failed or not). */
function stateWritesDone(file) {
  return queues.get(file)?.running || Promise.resolve();
}

/** Put a state file that can't be read out of the way (the user chose to start fresh): its new name. */
function setAsideBad(file) {
  // Already copied aside when it was read: that copy is the one kept.
  const stat = statOf(file);
  const copy = setAsideOnce.get(file);
  if (stat && copy?.key === stamp(stat) && fs.existsSync(copy.kept)) {
    fs.rmSync(file, { force: true });
    return copy.kept;
  }
  const kept = `${file}.unreadable-${Date.now()}`;
  try {
    renameSync(file, kept);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  return kept;
}

/**
 * The saved state, parsed once and kept until the file changes (its size
 * or time) or `invalidate()` (this process wrote it). Read only: don't
 * change what it returns.
 */
function createStateReader(file) {
  let cached = null; // { key, state }
  return {
    read() {
      const stat = statOf(file);
      const key = stat ? stamp(stat) : 'none';
      if (cached && cached.key === key) return cached.state;
      const state = readStateFile(file);
      // (Unreadable or missing: not kept, so a fixed file is seen at once.)
      cached = state ? { key, state } : null;
      return state;
    },
    invalidate() {
      cached = null;
    },
  };
}

/**
 * Write a file only when its text changes. A turn starting at the same
 * moment in another chat may be reading it; rewriting it (which truncates
 * first) could hand that turn an empty file. true when it was written.
 */
function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false;
  } catch {
    /* missing: write it */
  }
  fs.writeFileSync(`${file}.tmp`, text, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

module.exports = { loadStateFile, readStateFile, writeStateFile, writeStateFileAsync, stateWriting, stateWritesDone, setAsideBad, createStateReader, writeIfChanged };
