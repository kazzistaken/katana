'use strict';

/**
 * A secret the app keeps for a service (an OpenAI key, an OpenRouter key):
 * <userData>/<name>.key, sealed by Windows when it can be (safeStorage), so
 * the file alone is useless elsewhere. An environment variable wins when
 * set. Only main reads it; the window only learns whether one is set.
 */

const fs = require('node:fs');
const path = require('node:path');

const SEALED = 'enc:';

function createKeyStore({ userDataDir, name, env, safeStorage = require('electron').safeStorage }) {
  const file = () => path.join(userDataDir(), `${name}.key`);

  function get() {
    if (env && process.env[env]) return process.env[env].trim();
    try {
      const raw = fs.readFileSync(file());
      if (raw.subarray(0, SEALED.length).toString() === SEALED) return safeStorage.decryptString(raw.subarray(SEALED.length)).trim();
      return raw.toString('utf8').trim();
    } catch {
      return '';
    }
  }

  /** Save it (sealed when Windows can); empty removes it. True when one is set. */
  function set(value) {
    const clean = String(value || '').trim();
    if (!clean) {
      fs.rmSync(file(), { force: true });
      return false;
    }
    const data = safeStorage.isEncryptionAvailable() ? Buffer.concat([Buffer.from(SEALED), safeStorage.encryptString(clean)]) : Buffer.from(clean);
    fs.writeFileSync(file(), data, { mode: 0o600 });
    return true;
  }

  return { get, set, has: () => Boolean(get()) };
}

module.exports = { createKeyStore };
