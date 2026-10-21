import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFiles, sourceFiles } from '../scripts/release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-release-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test('release: npm pack from clean source builds every runtime entry without prebuilt lib', async t => {
  const directory = await temporary(t);
  for (const item of ['package.json', 'src', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs']) await cp(join(root, item), join(directory, item), { recursive: true });
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--cache', join(directory, '.npm-cache')], { cwd: directory, encoding: 'utf8' });
  assert.equal(packed.status, 0, 'Clean-source prepack must succeed without local dependencies');
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  for (const file of ['lib/index.mjs', 'lib/client.js', 'lib/history.mjs', 'cordis.patch.yml', 'LICENSE']) assert.ok(files.includes(file), file);
  assert.ok(!files.some(file => /^(?:src|scripts|tests|node_modules)\//.test(file)));
  assert.deepEqual(await readFile(join(directory, 'lib/index.mjs')), await readFile(join(directory, 'src/index.mjs')));
});

test('release: public source rejects symlinked files even inside an allowed directory', async t => {
  const directory = await temporary(t);
  for (const item of ['package.json', 'package-lock.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore']) await writeFile(join(directory, item), '{}');
  for (const item of ['src', 'tests', 'scripts', 'docs', '.github']) await mkdir(join(directory, item));
  await symlink(join(directory, 'package.json'), join(directory, 'src/leak.mjs'));
  await assert.rejects(sourceFiles(directory), /symbolic link: src\/leak.mjs/);
});

test('release: privacy failures expose only the rule and file, never the matched identity', async t => {
  const directory = await temporary(t);
  // Construct values at runtime so the synthetic regression itself stays public.
  const path = '/' + ['Users', 'private-person', 'work'].join('/');
  const email = ['private-person', 'company.test'].join('@');
  await writeFile(join(directory, 'example.txt'), `${path}\n${email}\n`);
  await assert.rejects(auditFiles(directory, ['example.txt']), error => {
    assert.match(error.message, /personal-absolute-path/);
    assert.match(error.message, /non-public-email/);
    assert.ok(!error.message.includes(path));
    assert.ok(!error.message.includes(email));
    return true;
  });
});

test('release: outside links and private-registry lockfiles block public export', async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, 'README.md'), '[private](../local-record.md)');
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ packages: { node: { resolved: 'https://registry.example.invalid/package.tgz' } } }));
  await assert.rejects(auditFiles(directory, ['README.md', 'package-lock.json']), error => /link-outside-public-root/.test(error.message) && /non-public-dependency-source/.test(error.message));
});

test('release: an email in a filename blocks export without exposing it in diagnostics', async t => {
  const directory = await temporary(t);
  const email = ['private-person', 'company.test'].join('@');
  const file = `${email}.md`;
  await writeFile(join(directory, file), '');
  await assert.rejects(auditFiles(directory, [file]), error => error.message.includes('non-public-email-in-path') && !error.message.includes(email));
});

test('release: nested and symlink-alias destinations cannot export back into source', async t => {
  const directory = await temporary(t);
  const source = join(directory, 'source');
  await mkdir(source);
  for (const item of ['scripts', 'package.json']) await cp(join(root, item), join(source, item), { recursive: true });
  const alias = join(directory, 'alias');
  await symlink(source, alias, 'dir');
  for (const destination of [join(source, 'nested'), join(alias, 'nested')]) {
    const result = spawnSync(process.execPath, [join(source, 'scripts/prepare-release.mjs'), '--out', destination], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the plugin source/);
  }
  await assert.rejects(readFile(join(source, 'nested/package.json')), { code: 'ENOENT' });
});
