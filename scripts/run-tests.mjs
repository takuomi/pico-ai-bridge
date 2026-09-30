import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir || process.argv.length !== 3) {
  console.error('Usage: node scripts/run-tests.mjs DIR');
  process.exit(1);
}

let files;
try {
  const entries = await readdir(resolve(dir), { withFileTypes: true });
  files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => join(resolve(dir), entry.name)).sort();
} catch (error) {
  console.error(error);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No .test.js files found in ${dir}`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
const args = ['--test', ...(major >= 21 || major === 20 && minor >= 11 ? ['--test-timeout=60000'] : []), ...files];
const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (child.error) {
  console.error(child.error);
  process.exit(1);
}
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
