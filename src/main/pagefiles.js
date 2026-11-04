'use strict';

/**
 * Which files a web page in the viewer may load (pagehost.js). A page is
 * served from its own folder, under its own address
 * (katana-page://<folder's id>/<path>), never as file://, so it can't read
 * anything else on the computer: your keys, Katana's data, other projects.
 *
 *   - only files inside the page's folder (its subfolders too), after
 *     links and junctions are followed;
 *   - never a hidden file or folder in it (.git, .env, .ssh, .claude);
 *   - a page right in your home folder, a drive's top or a folder that
 *     holds AppData: only the files next to it, not the folders under it.
 *
 * Pure but for the file system calls, which tests can pass in.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PAGE_SCHEME = 'katana-page';

// What a page may be granted: copying text (a "copy score" button) and the
// mouse kept by a game (it only works while its window has the keyboard).
// Fullscreen stays inside the window (pagehost.js). Never the microphone,
// camera, location, notifications, devices or reading the clipboard.
const PAGE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'pointerLock', 'fullscreen']);

// Names Windows opens as devices, not files, whatever folder they're in.
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** True if `target` is strictly inside `root` (not `root` itself). Case as the platform compares it. */
function inside(root, target, p = path) {
  const rel = p.relative(root, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

/** The same folder, or one inside it. */
const within = (root, target, p = path) => p.relative(root, target) === '' || inside(root, target, p);

/** Folders whose tree holds your secrets: a page there only gets the files next to it. */
function sensitiveFolders(env = process.env, home = os.homedir()) {
  return [home, env.APPDATA, env.LOCALAPPDATA, env.PROGRAMDATA, env.USERPROFILE].filter(Boolean).map((dir) => path.resolve(dir));
}

/** A folder too wide to serve with its subfolders: a drive's top, or one that holds a sensitive folder. */
function broadRoot(root, sensitive = sensitiveFolders(), p = path) {
  const dir = p.resolve(root);
  if (p.parse(dir).root === dir) return true;
  return sensitive.some((s) => within(dir, s, p));
}

/** A page's own address: its folder's id as the host (each folder its own origin), and the page's name. */
function pageAddress(file, p = path) {
  const full = p.resolve(file);
  const root = p.dirname(full);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const host = `p${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  return { root, host, url: `${PAGE_SCHEME}://${host}/${encodeURIComponent(p.basename(full))}` };
}

/**
 * Pure: the file a request's path names inside `root`, or null if it
 * isn't one a page may have. `pathname` is the URL's (still %-encoded).
 */
function lexicalFile(root, pathname, { broad = false } = {}, p = path) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || ''));
  } catch {
    return null;
  }
  // Drive letters, streams (a:b), wildcards and NULs never name a file in the folder.
  if (/[\0:*?"<>|]/.test(decoded)) return null;
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    // Hidden files and folders, `.` and `..`; Windows drops trailing dots and spaces.
    if (part.startsWith('.') || /[. ]$/.test(part) || DEVICE_NAME.test(part)) return null;
  }
  if (broad && parts.length > 1) return null;
  const full = p.resolve(root, ...parts);
  return inside(root, full, p) ? full : null;
}

/**
 * The real file to serve for a request, or null: lexically inside the
 * folder, and still inside it (and not hidden) once links and junctions
 * are followed; a file, not a folder.
 */
async function servedFile(root, pathname, { broad = false, realpath = fsp.realpath, stat = fsp.stat } = {}, p = path) {
  const lexical = lexicalFile(root, pathname, { broad }, p);
  if (!lexical) return null;
  let realRoot;
  let real;
  try {
    realRoot = await realpath(root);
    real = await realpath(lexical);
  } catch {
    return null;
  }
  if (!inside(realRoot, real, p)) return null;
  const parts = p.relative(realRoot, real).split(/[\\/]+/);
  if (parts.some((part) => part.startsWith('.'))) return null;
  if (broad && parts.length > 1) return null;
  try {
    if (!(await stat(real)).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Pure: one byte range of a file `size` long, from a Range header, as
 * { start, end } (inclusive); 'unsatisfiable' past the end; null to send
 * the whole file (no header, several ranges, or one that can't be read).
 */
function parseRange(header, size) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(String(header || ''));
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    // The last n bytes.
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

/** A page's address (`katana-page://<host>/…`) that belongs to this folder's host; false for anything else. */
function samePage(url, host) {
  try {
    const u = new URL(url);
    return u.protocol === `${PAGE_SCHEME}:` && u.host === host;
  } catch {
    return false;
  }
}

/** Links a page may hand to your own browser: web addresses only. */
function openable(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { PAGE_SCHEME, PAGE_PERMISSIONS, inside, broadRoot, sensitiveFolders, pageAddress, lexicalFile, servedFile, parseRange, samePage, openable };
