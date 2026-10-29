import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const REPOSITORY = 'ghang/dsh-cache-helper';
export const PACKAGE = 'dsh-cache-helper';
const REGISTRY = 'https://registry.npmjs.org/';
const JOBS = ['check (22.19.0)', 'check (24.18.1)'];
const MAX_BYTES = 32 * 1024 * 1024;
const require = (condition, rule) => { if (!condition) throw new Error(rule); };
export const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function versionFromTag(tag) {
  require(typeof tag === 'string' && tag.trim() === tag && tag.length < 100 && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(tag), 'invalid-release-tag');
  return tag.slice(1);
}
function repositoryOf(manifest) {
  return typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
}
export function checkManifest(manifest, version) {
  require(manifest.name === PACKAGE && manifest.version === version, 'package-name-or-version-mismatch');
  require(repositoryOf(manifest) === `git+https://github.com/${REPOSITORY}.git`, 'package-repository-mismatch');
  require(manifest.publishConfig?.registry === REGISTRY && manifest.publishConfig?.access === 'public', 'package-publishing-target-mismatch');
}
export function checkRelease(release, tag) {
  const version = versionFromTag(tag);
  require(release.tag_name === tag && release.draft === false && !!release.published_at && release.prerelease === version.includes('-'), 'release-not-published-or-tag-mismatch');
  const names = [`${PACKAGE}.tgz`, 'SHA256SUMS'];
  require(Array.isArray(release.assets) && release.assets.length === names.length, 'unexpected-release-assets');
  const assets = names.map(name => {
    const matches = release.assets.filter(asset => asset.name === name);
    require(matches.length === 1, 'missing-or-duplicate-release-asset');
    const asset = matches[0];
    require(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= (name === 'SHA256SUMS' ? 4096 : MAX_BYTES), 'invalid-release-asset-size-or-state');
    require(/^sha256:[0-9a-f]{64}$/.test(asset.digest), 'release-server-digest-unavailable');
    require(asset.browser_download_url === `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`, 'release-asset-url-mismatch');
    // Download counters and timestamps may change while this job reads assets.
    return { id: asset.id, name, size: asset.size, digest: asset.digest, browser_download_url: asset.browser_download_url };
  });
  return assets;
}
export function checkChecksums(bytes, assets) {
  const expected = assets.filter(asset => asset.name.endsWith('.tgz')).map(asset => asset.digest.slice(7) + '  ' + asset.name).sort();
  const actual = bytes.toString('utf8').trimEnd().split('\n').sort();
  require(JSON.stringify(actual) === JSON.stringify(expected), 'checksum-sidecar-mismatch');
}
export function checkCI(run, jobs, commit) {
  require(run.head_sha === commit && run.status === 'completed' && run.conclusion === 'success' && ['push', 'workflow_dispatch'].includes(run.event), 'ci-source-or-status-mismatch');
  require(run.path === '.github/workflows/check.yml' && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY, 'ci-workflow-or-repository-mismatch');
  for (const name of JOBS) {
    const matches = jobs.filter(job => job.name === name);
    require(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success', 'required-ci-job-not-successful');
  }
}
export function checkNpmMetadata(metadata, bytes, version) {
  checkManifest({ ...metadata, publishConfig: { registry: REGISTRY, access: 'public' } }, version);
  require(metadata.dist?.shasum === hash(bytes, 'sha1'), 'npm-sha1-mismatch');
  require(metadata.dist?.integrity?.split(/\s+/).includes('sha512-' + hash(bytes, 'sha512', 'base64')), 'npm-integrity-mismatch');
  require(metadata.dist?.tarball === `${REGISTRY}${PACKAGE}/-/${PACKAGE}-${version}.tgz`, 'npm-tarball-url-mismatch');
}
export function checkPublishContext(env, tag, commit) {
  require(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === REPOSITORY, 'publish-requires-github-hosted-runner');
  require(env.GITHUB_SHA === commit && env.GITHUB_REF === 'refs/tags/' + tag, 'publish-workflow-must-run-from-release-tag');
  require(!!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'oidc-permission-unavailable');
}
export function cleanNpmEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key) && !/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|NPM_ID_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/i.test(key)));
}
export function checkLatest(latest, version) {
  if (!latest || version.includes('-')) return;
  require(compareStableVersions(version, latest.version) >= 0, 'refusing-to-downgrade-latest');
}
function compareStableVersions(left, right) {
  require(/^\d+\.\d+\.\d+$/.test(left) && /^\d+\.\d+\.\d+$/.test(right), 'unexpected-latest-version');
  const target = left.split('.').map(BigInt), current = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (target[index] > current[index]) return 1;
    if (target[index] < current[index]) return -1;
  }
  return 0;
}
export async function waitForStableLatest(readLatest, version, wait = delay) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const latest = await readLatest();
    if (compareStableVersions(latest.version, version) >= 0) return latest.version;
    await wait(5000);
  }
  throw new Error('published-but-latest-needs-inspection');
}
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  require(result.status === 0, program === 'npm' ? 'npm-command-failed-query-state-before-retry' : 'required-command-failed');
  return result.stdout.trim();
}
const git = (...args) => command('git', args);
function github(endpoint) {
  return JSON.parse(command('gh', ['api', '--hostname', 'github.com', '--method', 'GET', `repos/${REPOSITORY}/${endpoint}`], { env: { ...process.env, GH_DEBUG: '', GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } }));
}
async function json(url, missing = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (missing && response.status === 404) return null;
  require(response.status === 200, 'public-registry-read-failed');
  require(Number(response.headers.get('content-length') || 0) <= MAX_BYTES, 'registry-response-too-large');
  return response.json();
}
async function download(asset) {
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(90000) });
  require(response.status === 200, 'public-release-download-failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    require(size <= asset.size, 'release-download-too-large'); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  require(size === asset.size && 'sha256:' + hash(bytes) === asset.digest, 'release-download-digest-mismatch');
  return bytes;
}
export async function readReleaseArtifacts(assets, readAsset = download) {
  const [bytes, sums] = await Promise.all([
    readAsset(assets.find(asset => asset.name.endsWith('.tgz'))),
    readAsset(assets.find(asset => asset.name === 'SHA256SUMS')),
  ]);
  return { bytes, sums };
}
async function successfulCI(commit) {
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs: runs } = github(`actions/workflows/check.yml/runs?head_sha=${commit}&status=success&per_page=100&page=${page}`);
    require(Array.isArray(runs), 'ci-runs-unavailable');
    for (const run of runs.filter(item => ['push', 'workflow_dispatch'].includes(item.event))) {
      const jobs = [];
      for (let jobPage = 1; jobPage <= 10; jobPage++) {
        const batch = github(`actions/runs/${run.id}/jobs?per_page=100&page=${jobPage}`).jobs;
        require(Array.isArray(batch), 'ci-jobs-unavailable'); jobs.push(...batch);
        if (batch.length < 100) break;
        require(jobPage < 10, 'ci-job-pagination-truncated');
      }
      checkCI(run, jobs, commit); return run;
    }
    if (runs.length < 100) break;
  }
  throw new Error('no-successful-ci-for-release-commit');
}
async function assertPublicTarball(metadata, bytes) {
  const response = await fetch(metadata.dist.tarball, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
  require(response.status === 200, 'npm-package-not-publicly-downloadable');
  const length = response.headers.get('content-length');
  require(length === null || Number(length) === bytes.length, 'npm-public-size-mismatch');
}
export async function completePublication({ mode, existing, latest, bytes, version, publish, readVersion, verifyPublic, wait = delay }) {
  require(['verify', 'publish'].includes(mode), 'invalid-publish-mode');
  if (existing) {
    checkNpmMetadata(existing, bytes, version); await verifyPublic(existing, bytes);
    return { status: 'already-published-verified', npmWriteAttempted: false };
  }
  checkLatest(latest, version);
  if (mode === 'verify') return { status: 'verified-ready', npmWriteAttempted: false };
  // Query before every attempt; never automatically retry an uncertain write.
  await publish();
  for (let attempt = 0; attempt < 24; attempt++) {
    const metadata = await readVersion();
    if (metadata) {
      checkNpmMetadata(metadata, bytes, version); await verifyPublic(metadata, bytes);
      return { status: 'published-verified', npmWriteAttempted: true };
    }
    await wait(5000);
  }
  throw new Error('npm-publication-not-visible-query-state-before-retry');
}
async function main() {
  const env = process.env, mode = env.PUBLISH_MODE, tag = env.RELEASE_TAG;
  const receipt = { schema: 1, checkedAt: new Date().toISOString(), mode, repository: REPOSITORY, package: PACKAGE, npmWriteAttempted: false };
  let work;
  try {
    const version = versionFromTag(tag); require(['verify', 'publish'].includes(mode), 'invalid-publish-mode');
    Object.assign(receipt, { version, tag });
    require(git('cat-file', '-t', 'refs/tags/' + tag) === 'tag', 'annotated-release-tag-required');
    const commit = git('rev-parse', `refs/tags/${tag}^{commit}`), tagObject = git('rev-parse', 'refs/tags/' + tag);
    const tagIdentity = git('for-each-ref', '--format=%(taggername)%00%(taggeremail)', 'refs/tags/' + tag);
    require(tagIdentity === 'ghang\0<12455956+ghang@users.noreply.github.com>', 'release-tagger-mismatch');
    checkManifest(JSON.parse(git('show', commit + ':package.json')), version);
    const remoteTag = github('git/ref/tags/' + tag);
    require(remoteTag.object.type === 'tag' && remoteTag.object.sha === tagObject, 'remote-tag-mismatch');
    const release = github('releases/tags/' + tag), assets = checkRelease(release, tag);
    const ci = await successfulCI(commit);
    Object.assign(receipt, { sourceCommit: commit, sourceTree: git('rev-parse', commit + '^{tree}'), tagObject, ciRunId: ci.id, releaseUrl: release.html_url, sha256: assets[0].digest.slice(7), bytes: assets[0].size });
    const { bytes, sums } = await readReleaseArtifacts(assets);
    checkChecksums(sums, assets);
    work = await mkdtemp(join(tmpdir(), 'cache-helper-npm-'));
    const archive = join(work, assets[0].name), user = join(work, 'user.npmrc'), global = join(work, 'global.npmrc');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o400 });
    await writeFile(user, '', { flag: 'wx' }); await writeFile(global, '', { flag: 'wx' });
    checkManifest(JSON.parse(command('tar', ['-xOf', archive, 'package/package.json'])), version);
    const npmEnv = cleanNpmEnvironment(env);
    const fixed = [`--registry=${REGISTRY}`, '--userconfig=' + user, '--globalconfig=' + global, '--cache=' + join(work, 'cache'), '--update-notifier=false'];
    const npmVersion = command('npm', ['--version'], { cwd: work, env: npmEnv });
    const [major, minor, patch] = npmVersion.split('.').map(Number);
    require(major > 11 || major === 11 && (minor > 5 || minor === 5 && patch >= 1), 'npm-11.5.1-or-later-required');
    receipt.npmVersion = npmVersion;
    const versionUrl = REGISTRY + PACKAGE + '/' + version;
    const existing = await json(versionUrl, true), latest = existing ? null : await json(REGISTRY + PACKAGE + '/latest', true);
    const result = await completePublication({ mode, existing, latest, bytes, version,
      readVersion: () => json(versionUrl, true), verifyPublic: assertPublicTarball,
      publish: async () => {
        checkPublishContext(env, tag, commit);
        const current = checkRelease(github('releases/tags/' + tag), tag);
        require(JSON.stringify(current) === JSON.stringify(assets) && github('git/ref/tags/' + tag).object.sha === tagObject, 'release-changed-before-publish');
        require(hash(await readFile(archive)) === receipt.sha256, 'local-tarball-changed');
        receipt.npmWriteAttempted = true;
        receipt.authentication = 'github-actions-oidc-with-empty-npm-config';
        console.log('Publishing the verified release tarball with npm OIDC.');
        command('npm', ['publish', archive, '--access=public', '--ignore-scripts', '--tag=' + (release.prerelease ? 'next' : 'latest'), ...fixed], { cwd: work, env: npmEnv, timeout: 300000 });
      },
    });
    Object.assign(receipt, result);
    if (!release.prerelease && result.status !== 'verified-ready') {
      receipt.latestVersion = await waitForStableLatest(() => json(REGISTRY + PACKAGE + '/latest'), version);
    }
  } catch (error) {
    receipt.status = 'refused-or-incomplete';
    // Do not retain raw npm, gh, authentication URLs or environment values.
    receipt.reason = /^[a-z0-9.-]+$/.test(error.message) ? error.message : 'required-input-or-service-unavailable';
    process.exitCode = 1;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    const serialized = JSON.stringify(receipt, null, 2) + '\n';
    if (env.NPM_PUBLISH_RECEIPT) await writeFile(env.NPM_PUBLISH_RECEIPT, serialized, { flag: 'wx' });
    console.log(serialized);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
