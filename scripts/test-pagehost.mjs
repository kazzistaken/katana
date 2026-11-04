import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inside, broadRoot, pageAddress, lexicalFile, servedFile, parseRange, samePage, openable, PAGE_PERMISSIONS } = require('../src/main/pagefiles.js');

const root = path.resolve(os.tmpdir(), 'site');

{
  // inside: strictly under the folder; a sibling with the same start isn't
  assert.equal(inside(root, path.join(root, 'a.js')), true);
  assert.equal(inside(root, path.join(root, 'sub', 'b.js')), true);
  assert.equal(inside(root, path.join(root, '..foo')), true);
  assert.equal(inside(root, root), false);
  assert.equal(inside(root, `${root}2${path.sep}x`), false);
  assert.equal(inside(root, path.dirname(root)), false);
  if (process.platform === 'win32') {
    assert.equal(inside('C:\\Games\\Site', 'c:\\games\\site\\x.js'), true);
    assert.equal(inside('C:\\Games\\Site', 'D:\\Games\\Site\\x.js'), false);
  }
}

{
  // the page's own files, nested ones and %-encoded names
  assert.equal(lexicalFile(root, '/index.html'), path.join(root, 'index.html'));
  assert.equal(lexicalFile(root, '/js/game%20main.mjs'), path.join(root, 'js', 'game main.mjs'));
  assert.equal(lexicalFile(root, '/a//b.png'), path.join(root, 'a', 'b.png'));
  // never out of the folder, however it's spelled
  for (const bad of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/sub/%2E%2E/%2e%2e/secret.txt',
    '/..%5csecret.txt',
    '/sub%5c..%5c..%5csecret.txt',
    '/C:%5cWindows%5cwin.ini',
    '/C:/Windows/win.ini',
    '/a.txt:secret',
    '/x%00.png',
    '/%E0%A4%A',
    '/',
    '',
  ]) {
    assert.equal(lexicalFile(root, bad), null, bad);
  }
  // nor hidden files and folders, Windows' devices or names it would change
  for (const bad of ['/.env', '/.git/config', '/sub/.ssh/id_rsa', '/CON', '/nul.txt', '/sub/com1.js', '/a.txt.', '/a.txt ']) {
    assert.equal(lexicalFile(root, bad), null, bad);
  }
  // a broad folder (home): only the files right next to the page
  assert.equal(lexicalFile(root, '/game.js', { broad: true }), path.join(root, 'game.js'));
  assert.equal(lexicalFile(root, '/AppData/Roaming/xodecode-v2/katanad.json', { broad: true }), null);
}

{
  // broad folders: a drive's top, home, anything holding a sensitive folder; a project in home isn't
  const home = path.resolve(os.homedir());
  const sensitive = [home, path.join(home, 'AppData', 'Roaming')];
  assert.equal(broadRoot(path.parse(home).root, sensitive), true);
  assert.equal(broadRoot(home, sensitive), true);
  assert.equal(broadRoot(path.dirname(home), sensitive), true);
  assert.equal(broadRoot(path.join(home, 'Downloads', 'game'), sensitive), false);
  assert.equal(broadRoot(path.join(home, 'AppData', 'Roaming', 'x'), sensitive), false);
  assert.equal(broadRoot(path.join(home, 'AppData'), sensitive), true);
}

{
  // each folder its own origin, stable; the page's name encoded
  const a = pageAddress(path.join(root, 'my game.html'));
  assert.equal(a.root, root);
  assert.match(a.host, /^p[0-9a-f]{20}$/);
  assert.equal(a.url, `katana-page://${a.host}/my%20game.html`);
  assert.equal(pageAddress(path.join(root, 'other.html')).host, a.host);
  assert.notEqual(pageAddress(path.join(root, 'sub', 'x.html')).host, a.host);
  assert.equal(samePage(`katana-page://${a.host}/level/2.html`, a.host), true);
  assert.equal(samePage('katana-page://pdeadbeef/x.html', a.host), false);
  assert.equal(samePage('file:///C:/x.html', a.host), false);
  assert.equal(samePage('nonsense', a.host), false);
}

{
  // web links may go to your browser; nothing else
  assert.equal(openable('https://example.com/x'), true);
  assert.equal(openable('http://localhost:3000'), true);
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:', 'javascript:alert(1)', 'C:\\x.exe', '']) assert.equal(openable(bad), false, bad);
  // permissions: only a game's few
  for (const no of ['media', 'geolocation', 'notifications', 'clipboard-read', 'hid', 'serial', 'usb', 'openExternal', 'display-capture', 'midiSysex']) assert.equal(PAGE_PERMISSIONS.has(no), false, no);
}

{
  // byte ranges, for video and audio seeking
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-30', 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 10), null);
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange('', 10), null);
}

// Real files: links and junctions out of the folder, hidden ones, folders.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'katana-pagehost-test-'));
try {
  const site = path.join(base, 'site');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(site, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(site, '.secret'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(base, 'secret.txt'), 'no');
  fs.writeFileSync(path.join(outside, 'key.txt'), 'no');
  fs.writeFileSync(path.join(site, '.secret', 'token.txt'), 'no');
  fs.writeFileSync(path.join(site, 'index.html'), '<p>hi');
  fs.writeFileSync(path.join(site, 'sub', 'data.json'), '{}');
  let linked = true;
  try {
    fs.symlinkSync(outside, path.join(site, 'escape'), 'junction');
    fs.symlinkSync(path.join(site, '.secret'), path.join(site, 'peek'), 'junction');
    fs.symlinkSync(path.join(site, 'sub'), path.join(site, 'alias'), 'junction');
  } catch {
    linked = false; // no links here: the rest still runs
  }

  assert.equal(await servedFile(site, '/index.html'), fs.realpathSync.native(path.join(site, 'index.html')));
  assert.equal(await servedFile(site, '/sub/data.json'), fs.realpathSync.native(path.join(site, 'sub', 'data.json')));
  assert.equal(await servedFile(site, '/missing.png'), null);
  assert.equal(await servedFile(site, '/sub'), null, 'a folder is not a file');
  assert.equal(await servedFile(site, '/%2e%2e/secret.txt'), null);
  assert.equal(await servedFile(site, '/.secret/token.txt'), null);
  if (linked) {
    assert.equal(await servedFile(site, '/escape/key.txt'), null, 'a junction out of the folder');
    assert.equal(await servedFile(site, '/peek/token.txt'), null, 'a junction to a hidden folder');
    assert.equal(await servedFile(site, '/alias/data.json'), fs.realpathSync.native(path.join(site, 'sub', 'data.json')), 'a junction within the folder');
  }
  // a broad folder serves only what's next to the page
  assert.equal(await servedFile(site, '/index.html', { broad: true }), fs.realpathSync.native(path.join(site, 'index.html')));
  assert.equal(await servedFile(site, '/sub/data.json', { broad: true }), null);
  if (linked) assert.equal(await servedFile(site, '/alias/data.json', { broad: true }), null);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('pagehost: ok');
