import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFiles, sourceDigest, sourceFiles } from './release-files.mjs';

// Export only. The candidate is tested with its own npm ci, never the live link.
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') {
  console.error('Usage: npm run prepare:release -- --out <new-directory>\nExports audited source without Git history, dependencies or local runtime data. Then run npm ci and npm run check:release inside the export.');
  process.exitCode = 2;
} else {
  try {
    // Resolve the nearest existing parent as well, so a symlink alias cannot
    // export back into the source or its active web link.
    let ancestor = dirname(resolve(args[1]));
    let suffix = basename(resolve(args[1]));
    while (true) {
      try { ancestor = await realpath(ancestor); break; }
      catch (error) {
        if (error.code !== 'ENOENT' || ancestor === dirname(ancestor)) throw error;
        suffix = join(basename(ancestor), suffix); ancestor = dirname(ancestor);
      }
    }
    const destination = resolve(ancestor, suffix);
    if (destination === root || root.startsWith(destination + '/') || destination.startsWith(root + '/')) throw new Error('Export must be outside the plugin source directory');
    try { await lstat(destination); throw new Error('Export destination already exists; refusing to overwrite'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const files = await sourceFiles(root);
    await auditFiles(root, files);
    await mkdir(destination, { recursive: true });
    for (const file of files) {
      await mkdir(dirname(join(destination, file)), { recursive: true });
      await cp(join(root, file), join(destination, file), { dereference: false, errorOnExist: true, force: false });
    }
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(destination, '.release-source.json'), `${JSON.stringify({ schema: 1, name: manifest.name, version: manifest.version, sourceSha256: await sourceDigest(root, files) }, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'source-exported-not-published', name: manifest.name, version: manifest.version, files: files.length, gitHistory: false, next: ['npm ci --ignore-scripts --registry=https://registry.npmjs.org/', 'npx playwright install chromium', 'npm run check:release'] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
