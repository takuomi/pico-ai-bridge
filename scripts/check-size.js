// Plugin folder limits: https://claude.com/docs/plugins/pre-submission-checklist (Files in the plugin folder).
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let files;
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch (error) {
  throw new Error('Cannot list tracked files: git is unavailable or the directory is not a git repository', { cause: error });
}
let count = 0;
async function checkFiles() {
  for (const file of files) {
    const path = join(root, file);
    const bytes = (await stat(path)).size;
    count++;
    if (bytes >= 256 * 1024) throw new Error(`${path} is ${bytes} bytes; limit is below 256 KiB`);
    const contents = await readFile(path);
    if (contents.includes(0)) throw new Error(`${path} contains NUL bytes`);
    new TextDecoder('utf-8', { fatal: true }).decode(contents);
  }
}
await checkFiles();
if (count > 512) throw new Error(`${count} files; the plugin directory checklist allows at most 512`);
console.log(`Checked ${count} text files: all below 256 KiB; 512-file limit respected.`);
