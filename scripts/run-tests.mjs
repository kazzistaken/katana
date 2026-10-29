// Runs every scripts/test-*.mjs in its own process; fails if any fails.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((name) => /^test-.*\.mjs$/.test(name)).sort();
let failed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, ['--no-warnings', join(here, name)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${name}`);
  }
}
console.log(failed ? `${failed} of ${files.length} test files failed` : `all ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
