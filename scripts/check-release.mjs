import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFiles, runtimeFileAllowed, sourceDigest, sourceFiles } from './release-files.mjs';
import { resolveRuntimePackages } from './verify-runtime.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = join(root, '.release');
function run(command, args, { capture = false, cwd = root, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed (exit ${result.status ?? result.error?.code})`);
  return result.stdout;
}
function tests(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.equal(result.status, 0, 'Required tests failed');
  const count = key => Number(result.stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
  const summary = { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
  assert.ok(summary.tests > 0 && summary.passed === summary.tests && summary.failed === 0 && summary.skipped === 0, 'A release must pass all required tests without skips');
  return summary;
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  let projection;
  try { projection = JSON.parse(await readFile(join(root, '.release-source.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  const independentRepository = git.status === 0 && resolve(git.stdout.trim()) === root;
  assert.ok(projection || independentRepository, 'Release checks require an audited export or independent repository root; refusing to build the Lab live link');
  // Once the source has deliberately become an independent repository, normal
  // development is governed by its checkout rather than the old export marker.
  if (independentRepository) projection = undefined;
  assert.ok(!(await lstat(join(root, 'node_modules'))).isSymbolicLink(), 'Release checks require npm ci in a clean export, not a profile node_modules link');
  for (const variable of ['DSH_CACHE_HELPER_RUNTIME_MODULES', 'DSH_BROWSER_TEST_MODULES', 'DSH_REACT_TEST_MODULES', 'DSH_CACHE_HELPER_TEST_ARTIFACT']) assert.ok(!process.env[variable], `Unset ${variable} for standalone release verification`);
  for (const variable of Object.keys(process.env).filter(key => /^DSH_CLIENT_TEST_.*SCREENSHOT$/.test(key))) assert.ok(!process.env[variable], `Unset ${variable}; release verification must not rewrite approved images`);
  const files = await sourceFiles(root);
  const sourceAudit = await auditFiles(root, files);
  const sourceSha256 = await sourceDigest(root, files);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (projection) assert.ok(projection.schema === 1 && projection.name === manifest.name && projection.version === manifest.version && projection.sourceSha256 === sourceSha256, 'Exported source changed; fix the canonical source and export a new directory');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  const screenshots = JSON.parse(await readFile(join(root, 'screenshots.json'), 'utf8'));
  assert.ok(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8);
  for (const path of screenshots) {
    assert.match(path, /^docs\/images\/[\w-]+\.png$/);
    assert.ok(files.includes(path), 'Missing public screenshot');
  }
  assert.equal(manifest.name, 'dsh-cache-helper');
  assert.ok(manifest.engines.dsh, 'engines.dsh is required');
  assert.equal(manifest.dsh.compatibility, undefined, 'unsupported compatibility metadata');
  assert.equal(manifest.license, 'MIT');
  for (const [name, version] of Object.entries(manifest.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, `Pin devDependency ${name}`);
  assert.equal(manifest.dependencies, undefined, 'Host packages must remain peers');
  const { evaluatePluginCompatibility } = await import('@deepseek-ai/dsh-app-boot');
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.2'), undefined);
  for (const version of ['0.1.0', '0.2.0', '0.3.0-rc.1', '0.3.0']) assert.ok(evaluatePluginCompatibility(manifest, {}, version), `Must reject DSH ${version}`);

  // A release has no skip switch: the browser and native runtime suites are mandatory.
  const sourceTests = tests(npm, ['test']);
  assert.equal(await sourceDigest(root, await sourceFiles(root)), sourceSha256, 'Source changed during required tests');
  run(process.execPath, ['scripts/build.mjs']);
  await rm(out, { force: true, recursive: true });
  await mkdir(out);
  const listing = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--dry-run', '--json'], { capture: true }))[0];
  const packageFiles = listing.files.map(item => item.path).sort();
  assert.ok(packageFiles.every(runtimeFileAllowed), 'Unexpected file in runtime package');
  await auditFiles(root, packageFiles);
  const built = (await readdir(join(root, 'src'))).filter(file => /\.(?:mjs|js|css)$/.test(file)).sort();
  assert.deepEqual((await readdir(join(root, 'lib'))).sort(), built);
  for (const file of built) assert.deepEqual(await readFile(join(root, 'src', file)), await readFile(join(root, 'lib', file)));
  const pack = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', out], { capture: true }))[0];
  assert.deepEqual(pack.files.map(item => item.path).sort(), packageFiles);
  const archive = join(out, pack.filename);
  const stable = join(out, 'dsh-cache-helper.tgz');
  await cp(archive, stable);
  await rm(archive);
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-cache-helper-artifact-'));
  let artifactTests;
  try {
    run('tar', ['-xzf', stable, '-C', scratch], { capture: true });
    const packageRoot = join(scratch, 'package');
    const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const entries = [installed.main, ...Object.values(installed.exports), installed.dsh.bundle.patch];
    for (const path of entries) {
      assert.equal(typeof path, 'string');
      const absolute = resolve(packageRoot, path);
      assert.ok(absolute.startsWith(packageRoot + '/'), 'Entry escaped package root');
      assert.ok((await lstat(absolute)).isFile(), `Missing entry ${path}`);
    }
    // Only host peer dependencies come from this isolated checkout; never a profile.
    const { symlink } = await import('node:fs/promises');
    await symlink(join(root, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
    run(process.execPath, ['--input-type=module', '-e', 'const p=await import("./lib/index.mjs"); if(typeof p.createCacheHelper!=="function" || typeof p.apply!=="function") process.exit(1);'], { cwd: packageRoot, capture: true });
    artifactTests = tests(process.execPath, ['--test', '--test-reporter=tap', 'tests/integration.test.mjs', 'tests/client.test.mjs'], { ...process.env, DSH_CACHE_HELPER_TEST_ARTIFACT: packageRoot });
  } finally { await rm(scratch, { force: true, recursive: true }); }
  const sha256 = createHash('sha256').update(await readFile(stable)).digest('hex');
  assert.equal(await sourceDigest(root, await sourceFiles(root)), sourceSha256, 'Source changed during artifact verification');
  await writeFile(join(out, 'SHA256SUMS'), `${sha256}  dsh-cache-helper.tgz\n`);
  const runtime = (await resolveRuntimePackages()).map(({ name, version }) => ({ name, version }));
  const report = { name: manifest.name, version: manifest.version, status: 'local-candidate', sourceSha256, node: process.version, runtime, sourceTests, artifactTests, sourceAudit, tarball: { name: 'dsh-cache-helper.tgz', sha256, bytes: (await lstat(stable)).size, files: packageFiles }, checks: ['source-privacy', 'host-compatibility', 'full-tests', 'build-source-parity', 'pack-manifest', 'unpacked-entries', 'artifact-import', 'artifact-native-integration', 'artifact-browser'], identity: 'not-checked-local-preparation-only', publication: 'not-published' };
  await writeFile(join(out, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, version: manifest.version, sha256, artifacts: '.release/' }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
