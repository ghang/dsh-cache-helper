import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFiles, runtimeFileAllowed, sourceFiles } from '../scripts/release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-release-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test('release: npm pack from clean source builds every runtime entry without prebuilt lib', async t => {
  const directory = await temporary(t);
  for (const item of ['package.json', 'src', 'scripts', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs']) await cp(join(root, item), join(directory, item), { recursive: true });
  const userconfig = join(directory, 'empty-user.npmrc');
  const globalconfig = join(directory, 'empty-global.npmrc');
  await writeFile(userconfig, ''); await writeFile(globalconfig, '');
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--offline', '--update-notifier=false', '--userconfig', userconfig, '--globalconfig', globalconfig, '--cache', join(directory, '.npm-cache')], { cwd: directory, env, encoding: 'utf8' });
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

test('release: npm tokens in public text, malformed locks and filenames are rejected without leaking values', async t => {
  const directory = await temporary(t);
  const token = ['npm', 'aB1'.repeat(12)].join('_');
  for (const file of ['README.md', 'package-lock.json']) {
    await writeFile(join(directory, file), `synthetic public heading\n${token}\n`);
    await assert.rejects(auditFiles(directory, [file]), error => {
      assert.match(error.message, /credential-pattern/);
      assert.ok(!error.message.includes(token));
      if (file === 'package-lock.json') assert.match(error.message, /invalid-lockfile/);
      return true;
    });
  }
  const filename = `${token}.md`;
  await writeFile(join(directory, filename), '');
  await assert.rejects(auditFiles(directory, [filename]), error => error.message.includes('credential-pattern-in-path') && !error.message.includes(token));
});

test('release: authenticated loopback URLs block public text without echoing the URL or its secret', async t => {
  const directory = await temporary(t);
  const secret = ['synthetic', 'bC2'.repeat(12)].join('-');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    for (const kind of ['query', 'encoded-query', 'fragment', 'userinfo']) {
      const url = new URL(`http://${host}:3299/`);
      if (kind === 'query') url.searchParams.set('token', secret);
      if (kind === 'encoded-query') url.search = ['?', '%74oken', '=', secret].join('');
      if (kind === 'fragment') url.hash = new URLSearchParams({ access_token: secret }).toString();
      if (kind === 'userinfo') { url.username = 'synthetic'; url.password = secret; }
      await writeFile(join(directory, 'README.md'), `synthetic heading\n${url.href}\n`);
      await assert.rejects(auditFiles(directory, ['README.md']), error => {
        assert.match(error.message, /authenticated-loopback-url/);
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes(url.href));
        return true;
      });
    }
  }
});

test('release: sensitive config and raw session paths cannot enter source exports or runtime docs', async t => {
  const directory = await temporary(t);
  for (const file of ['package.json', 'package-lock.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore']) await writeFile(join(directory, file), '{}');
  for (const file of ['src', 'tests', 'scripts', 'docs', '.github']) await mkdir(join(directory, file));
  const privateFiles = ['docs/.npmrc', 'docs/.npmrc.backup', 'docs/.yarnrc', 'docs/.yarnrc.yml', 'docs/.netrc', 'docs/credentials.yaml', 'docs/auth.json', 'docs/secrets.yml', 'docs/.ssh/id_ed25519', 'docs/profiles/web/config.yml', 'docs/config/session.v4.jsonl', 'docs/raw-dialogue.jsonl.zstd', 'tests/raw-dialogue.jsonl'];
  for (const file of privateFiles) {
    await mkdir(join(directory, file, '..'), { recursive: true });
    await writeFile(join(directory, file), 'synthetic contents without a recognizable secret');
  }
  const files = await sourceFiles(directory);
  for (const file of privateFiles) {
    assert.ok(files.includes(file), 'Directory traversal must not silently skip files before the source audit');
    await assert.rejects(auditFiles(directory, [file]), /private-path/);
    assert.equal(runtimeFileAllowed(file), false, 'Runtime docs use the same sensitive path policy');
  }
});

test('release: ordinary documentation and npm environment names remain allowed', async t => {
  const directory = await temporary(t);
  const placeholder = ['http://127.0.0.1:3299/', '?', 'token=', '<redacted>'].join('');
  await writeFile(join(directory, 'README.md'), [`http://localhost:3299/`, placeholder, 'npm_config_' + 'long'.repeat(10), 'NPM_TOKEN and NODE_AUTH_TOKEN are environment variable names.', 'Describe .npmrc and session.v4.jsonl without exporting those files.'].join('\n'));
  await auditFiles(directory, ['README.md']);
  assert.equal(runtimeFileAllowed('docs/RELEASING.md'), true);
  await auditFiles(root, await sourceFiles(root));
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
