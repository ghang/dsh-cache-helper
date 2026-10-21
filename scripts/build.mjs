import { mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// Rebuild from scratch so a renamed/deleted source cannot survive in a tarball.
await rm(join(root, 'lib'), { recursive: true, force: true });
await mkdir(join(root, 'lib'), { recursive: true });
for (const name of await readdir(join(root, 'src'))) {
  if (/\.(?:mjs|js|css)$/.test(name)) await copyFile(join(root, 'src', name), join(root, 'lib', name));
}
// Keep npm pack --json machine-readable even when its prepack hook runs.
console.error('dsh-cache-helper: copied dependency-free host and client modules to lib/');
