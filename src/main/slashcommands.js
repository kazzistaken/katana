'use strict';

/**
 * Your own Claude Code commands and skills, for the / menu: what Claude Code would
 * pick up from ~/.claude and the task's folder, and from your installed plugins
 * (as plugin:name). Only names and descriptions are read, and only from disk.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_MS = 30000;

function frontMatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  for (const line of (block?.[1] || '').split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1].toLowerCase()] = field[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

const dirs = (folder) => {
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Command files: a file in a subfolder is folder:name. */
function commandsIn(folder, prefix, out) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) commandsIn(full, `${prefix}${entry.name}:`, out);
    else if (entry.name.toLowerCase().endsWith('.md')) add(out, `${prefix}${entry.name.slice(0, -3)}`, frontMatter(full));
  }
}

function skillsIn(folder, prefix, out) {
  for (const name of dirs(folder)) {
    const fields = frontMatter(path.join(folder, name, 'SKILL.md'));
    if (!fields || fields['user-invocable'] === 'false') continue;
    add(out, `${prefix}${fields.name || name}`, fields);
  }
}

function add(out, name, fields) {
  if (!/^[\w:.-]+$/.test(name) || out.has(name)) return;
  const about = String(fields?.description || '').replace(/\s+/g, ' ').trim();
  out.set(name, { name, about: about.length > 90 ? `${about.slice(0, 89).trimEnd()}…` : about, hint: fields?.['argument-hint'] || '' });
}

function pluginName(root, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name || fallback;
  } catch {
    return fallback;
  }
}

function fromPlugin(root, fallback, out) {
  const name = pluginName(root, fallback);
  skillsIn(path.join(root, 'skills'), `${name}:`, out);
  commandsIn(path.join(root, 'commands'), `${name}:`, out);
}

function plugins(home, out) {
  const base = path.join(home, '.claude', 'plugins');
  let enabled = {};
  try {
    enabled = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {};
  } catch {
    /* none set */
  }
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(base, 'installed_plugins.json'), 'utf8')).plugins || {};
    for (const [id, copies] of Object.entries(installed)) {
      if (enabled[id] === false) continue;
      const root = Array.isArray(copies) ? copies[0]?.installPath : null;
      if (root) fromPlugin(root, id.split('@')[0], out);
    }
  } catch {
    /* no plugins */
  }
  // Plugins synced from your account: synced/<account>/<plugin id>/.
  for (const account of dirs(path.join(base, 'synced'))) {
    for (const id of dirs(path.join(base, 'synced', account))) fromPlugin(path.join(base, 'synced', account, id), id, out);
  }
}

function createSlashCommands({ home = os.homedir() } = {}) {
  const cache = new Map(); // folder -> { at, list }
  return function list(cwd) {
    const key = String(cwd || '');
    const had = cache.get(key);
    if (had && Date.now() - had.at < CACHE_MS) return had.list;
    const out = new Map();
    // The nearest wins: this folder's, then yours, then your plugins'.
    if (key) {
      commandsIn(path.join(key, '.claude', 'commands'), '', out);
      skillsIn(path.join(key, '.claude', 'skills'), '', out);
    }
    commandsIn(path.join(home, '.claude', 'commands'), '', out);
    skillsIn(path.join(home, '.claude', 'skills'), '', out);
    plugins(home, out);
    const found = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache.set(key, { at: Date.now(), list: found });
    return found;
  };
}

module.exports = { createSlashCommands };
