import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE, REPOSITORY, hash, versionFromTag, checkManifest, checkRelease, checkChecksums, checkCI, checkNpmMetadata, checkPublishContext, cleanNpmEnvironment, checkLatest, waitForStableLatest, completePublication } from '../scripts/publish-npm.mjs';

const bytes = Buffer.from('synthetic frozen package');
const version = '0.3.2', tag = 'v' + version, commit = 'a'.repeat(40);
const manifest = () => ({ name: PACKAGE, version, repository: { url: `git+https://github.com/${REPOSITORY}.git` }, publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' } });
const metadata = () => ({ ...manifest(), dist: { shasum: hash(bytes, 'sha1'), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'), tarball: `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz` } });
const release = () => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-29T00:00:00Z', assets: [`${PACKAGE}.tgz`, 'SHA256SUMS'].map((name, index) => ({ id: index + 1, name, state: 'uploaded', digest: 'sha256:' + hash(bytes), size: bytes.length, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}` })) });
const run = () => ({ head_sha: commit, status: 'completed', conclusion: 'success', event: 'push', path: '.github/workflows/check.yml', repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } });
const jobs = () => ['check (22.19.0)', 'check (24.18.1)'].map(name => ({ name, status: 'completed', conclusion: 'success' }));

test('only exact package, repository, public target and safe version tags are accepted', () => {
  assert.equal(versionFromTag(tag), version); assert.equal(versionFromTag('v0.3.3-rc.1'), '0.3.3-rc.1');
  for (const value of ['main', '../v0.3.2', 'v01.2.2', 'v0.3.2?x=1', 'v0.3.2\n', 'v0.3.2;echo']) assert.throws(() => versionFromTag(value));
  checkManifest(manifest(), version);
  for (const change of [{ name: 'other' }, { version: '0.3.1' }, { repository: { url: 'git+https://github.com/example/other.git' } }, { publishConfig: { registry: 'https://example.invalid/', access: 'public' } }]) assert.throws(() => checkManifest({ ...manifest(), ...change }, version));
});
test('published assets require trustworthy server digests, the stable tarball and its exact checksum file', () => {
  const assets = checkRelease(release(), tag);
  const downloaded = release(); downloaded.assets[0].download_count = 99;
  assert.deepEqual(checkRelease(downloaded, tag), assets);
  checkChecksums(Buffer.from(assets.filter(asset => asset.name.endsWith('.tgz')).map(asset => asset.digest.slice(7) + '  ' + asset.name).join('\n') + '\n'), assets);
  for (const mutate of [item => { item.draft = true; }, item => { item.prerelease = true; }, item => { item.assets.push(item.assets[0]); }, item => { item.assets[0].digest = null; }, item => { item.assets[1].name = 'other-checksums'; }, item => { item.assets[0].browser_download_url = 'https://example.invalid/pkg.tgz'; }, item => { item.assets[0].size = 0; }]) {
    const item = release(); mutate(item); assert.throws(() => checkRelease(item, tag));
  }
  assert.throws(() => checkChecksums(Buffer.from('tampered'), assets));
});
test('release CI must cover the same SHA, approved workflow and both successful Node jobs', () => {
  checkCI(run(), jobs(), commit);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { conclusion: 'failure' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'example/fork' } }]) assert.throws(() => checkCI({ ...run(), ...change }, jobs(), commit));
  for (const value of [jobs().slice(0, 1), [...jobs(), jobs()[0]], jobs().map(job => ({ ...job, conclusion: 'skipped' }))]) assert.throws(() => checkCI(run(), value, commit));
});
test('npm metadata must identify the same tarball through both digests and its public URL', () => {
  checkNpmMetadata(metadata(), bytes, version);
  for (const change of [{ shasum: '0'.repeat(40) }, { integrity: 'sha512-other' }, { tarball: 'https://example.invalid/package.tgz' }]) assert.throws(() => checkNpmMetadata({ ...metadata(), dist: { ...metadata().dist, ...change } }, bytes, version));
});
test('actual publishing requires the tagged SHA, hosted runner and OIDC; inherited auth is removed', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: commit, GITHUB_REF: 'refs/tags/' + tag, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic' };
  checkPublishContext(env, tag, commit);
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/main' }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }]) assert.throws(() => checkPublishContext({ ...env, ...change }, tag, commit));
  assert.deepEqual(cleanNpmEnvironment({ ...env, npm_config_registry: 'other', NPM_CONFIG_USERCONFIG: 'other', NPM_TOKEN: 'synthetic', NODE_AUTH_TOKEN: 'synthetic', NPM_AUTH_TOKEN: 'synthetic', NPM_ID_TOKEN: 'synthetic', GH_TOKEN: 'synthetic', GITHUB_TOKEN: 'synthetic', PATH: '/bin' }), { ...env, PATH: '/bin' });
});
test('new stable versions cannot move latest backwards', () => {
  checkLatest({ version: '0.3.1' }, version); checkLatest({ version }, version); checkLatest({ version: '1.0.0' }, '0.3.3-rc.1');
  assert.throws(() => checkLatest({ version: '0.3.3' }, version));
});
test('latest propagation is awaited without another write, including existing-version recovery', async () => {
  let reads = 0, waits = 0;
  const observed = await waitForStableLatest(async () => ({ version: ++reads < 3 ? '0.3.1' : version }), version, async () => { waits++; });
  assert.equal(observed, version); assert.equal(reads, 3); assert.equal(waits, 2);
  assert.equal(await waitForStableLatest(async () => ({ version: '0.3.3' }), version), '0.3.3');
  await assert.rejects(waitForStableLatest(async () => ({ version: '0.3.1' }), version, async () => {}), /latest-needs-inspection/);
});
test('read-only verification and matching repeated releases never attempt an npm write', async () => {
  const forbidden = () => assert.fail('unexpected npm write');
  assert.deepEqual(await completePublication({ mode: 'verify', existing: null, latest: { version: '0.3.1' }, bytes, version, publish: forbidden }), { status: 'verified-ready', npmWriteAttempted: false });
  let reads = 0;
  const result = await completePublication({ mode: 'publish', existing: metadata(), bytes, version, publish: forbidden, verifyPublic: async () => { reads++; } });
  assert.deepEqual(result, { status: 'already-published-verified', npmWriteAttempted: false }); assert.equal(reads, 1);
  await assert.rejects(completePublication({ mode: 'publish', existing: { ...metadata(), dist: { ...metadata().dist, shasum: 'wrong' } }, bytes, version, publish: forbidden }));
});
test('a new publication writes once, waits for visibility and verifies the public package', async () => {
  let writes = 0, reads = 0, publicChecks = 0;
  const result = await completePublication({ mode: 'publish', existing: null, latest: { version: '0.3.1' }, bytes, version, publish: async () => { writes++; }, readVersion: async () => ++reads === 1 ? null : metadata(), verifyPublic: async () => { publicChecks++; }, wait: async () => {} });
  assert.deepEqual(result, { status: 'published-verified', npmWriteAttempted: true });
  assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(publicChecks, 1);
});
test('an uncertain npm write or unavailable public package is not retried or counted as success', async () => {
  let writes = 0;
  const input = { mode: 'publish', existing: null, latest: { version: '0.3.1' }, bytes, version, publish: async () => { writes++; throw new Error('uncertain-write'); } };
  await assert.rejects(completePublication(input), /uncertain-write/); assert.equal(writes, 1);
  await assert.rejects(completePublication({ ...input, publish: async () => {}, readVersion: async () => metadata(), verifyPublic: async () => { throw new Error('not-public'); } }), /not-public/);
  await assert.rejects(completePublication({ ...input, publish: async () => {}, readVersion: async () => null, wait: async () => {} }), /not-visible/);
});
