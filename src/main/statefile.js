'use strict';

const fs = require('node:fs');

/**
 * Read the saved state. Missing: null (a fresh start). Unreadable (bad JSON,
 * locked): the file is set aside as state.json.unreadable-<time> and null is
 * returned, so the next save can't overwrite the user's projects and chats.
 */
function readStateFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    setAside(file);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    setAside(file);
    return null;
  }
}

function setAside(file) {
  try {
    fs.copyFileSync(file, `${file}.unreadable-${Date.now()}`);
  } catch (error) {
    console.error('[state] could not keep the unreadable state file', error);
  }
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

module.exports = { readStateFile, writeIfChanged };
