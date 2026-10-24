import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const testedModule = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { SessionCatalog } = await import(testedModule('session-catalog.mjs'));
const { AnalysisJobs } = await import(testedModule('analysis-jobs.mjs'));
const { AnalysisService } = await import(testedModule('analysis-service.mjs'));

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const row = (id, extra = {}) => ({ header: { id, version: 4, createdAt: 1,
  cwd: '/PRIVATE_CWD_CANARY', isSeeded: false }, eventCount: 10, sizeBytes: 100, ...extra });
function catalogOf(rows, { allows } = {}) {
  return new SessionCatalog({ sessions: { list: () => [] }, get: name => name === 'sessionPersistence'
    ? { list: async () => rows } : name === 'sessionProjectionCache'
      ? { cachedSnapshot: () => ({ values: { title: 'PRIVATE_TITLE_CANARY' } }) } : undefined }, { allows });
}
const result = (id, cacheStatus = 'computed') => ({ sessionId: id, cacheStatus, generatedAt: 100,
  sourceCut: { sessionId: id, eventCount: 10, sizeBytes: 100, lastSeq: 9, serviceInstance: 7, revision: 'PRIVATE_REVISION_CANARY',
    lifecycle: 'PRIVATE_LIFECYCLE_CANARY', headerDigest: 'a'.repeat(64), source: 'persistence' },
  request: 'PRIVATE_REQUEST_CANARY', calls: ['PRIVATE_RESPONSE_CANARY'],
  coverage: { unknownCalls: 1, unknown: true, privateBody: 'PRIVATE_COVERAGE_CANARY' } });
async function finished(jobs, id, options) {
  for (let turn = 0; turn < 400; turn++) {
    const job = await jobs.get(id, options);
    if (!['queued', 'running'].includes(job.state)) return job;
    await delay(2);
  }
  assert.fail('Analysis job did not finish');
}

test('serial jobs report partial success, cache hits and finite result references', async t => {
  let active = 0;
  let maximum = 0;
  const calls = [];
  const jobs = new AnalysisJobs({ catalog: catalogOf(['a', 'b', 'c'].map(id => row(id))), persistState: false,
    analyze: async (id, options) => {
      assert.equal(options.mode, 'reuse'); active++; maximum = Math.max(maximum, active); calls.push(id);
      try { await delay(2); if (id === 'b') throw new Error('PRIVATE_FAILURE_BODY_CANARY'); return result(id, id === 'a' ? 'memory' : 'computed'); }
      finally { active--; }
    } });
  t.after(() => jobs.dispose());
  const started = await jobs.start({ sessionIds: ['a', 'b', 'c'], idempotencyKey: 'one' });
  const done = await finished(jobs, started.id);
  assert.equal(done.state, 'completed'); assert.deepEqual(calls, ['a', 'b', 'c']); assert.equal(maximum, 1);
  assert.deepEqual(done.progress, { total: 3, finished: 3, cached: 1, completed: 1, failed: 1, limited: 0, cancelled: 0 });
  assert.equal(done.items[2].coverage.unknown, true);
  assert.deepEqual(done.items[0].resultReference, { sessionId: 'a', sourceCut: done.items[0].sourceCut, generatedAt: 100 });
  for (const canary of ['PRIVATE_REQUEST_CANARY', 'PRIVATE_RESPONSE_CANARY', 'PRIVATE_COVERAGE_CANARY',
    'PRIVATE_FAILURE_BODY_CANARY', 'PRIVATE_TITLE_CANARY', 'PRIVATE_CWD_CANARY', 'PRIVATE_REVISION_CANARY', 'PRIVATE_LIFECYCLE_CANARY']) {
    assert.equal(JSON.stringify(done).includes(canary), false, canary);
  }
});

test('idempotent retries bind explicit scope and mode without starting duplicate work', async t => {
  let calls = 0;
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a'), row('b')], { allows: () => true }), persistState: false,
    analyze: async (id, options) => { assert.equal(options.mode, 'refresh'); calls++; await delay(2); return result(id); } });
  t.after(() => jobs.dispose());
  const request = { sessionIds: ['b', 'a', 'a'], mode: 'refresh', idempotencyKey: 'retry' };
  const [first, second] = await Promise.all([jobs.start(request), jobs.start({ ...request, sessionIds: ['a', 'b'] })]);
  assert.equal(first.id, second.id); await finished(jobs, first.id); assert.equal(calls, 2);
  await assert.rejects(jobs.start({ ...request, sessionIds: ['a'] }), { status: 409 });
  const other = await jobs.start(request, { owner: 'other-browser' });
  assert.notEqual(other.id, first.id);
  await assert.rejects(jobs.get(other.id), { status: 403 });
  await finished(jobs, other.id, { owner: 'other-browser' });
  assert.equal(calls, 4);
});

test('P1 disk reuse and zero-normalization shared hits count as cached while append work remains completed', async t => {
  const variants = { disk: ['validated-disk', 'hit', 0], append: ['incremental-memory', 'hit', 2],
    sharedHit: ['shared', 'hit', 0], sharedComputed: ['shared', 'miss', 1] };
  const jobs = new AnalysisJobs({ catalog: catalogOf(Object.keys(variants).map(id => row(id))), persistState: false,
    analyze: async id => { const [cacheStatus, status, normalizedCalls] = variants[id];
      return { ...result(id, cacheStatus), cacheDetails: { status, normalizedCalls } }; } });
  t.after(() => jobs.dispose());
  const started = await jobs.start({ sessionIds: Object.keys(variants), idempotencyKey: 'p1-cache-status' });
  const done = await finished(jobs, started.id);
  assert.deepEqual(done.items.map(item => item.state), ['cached', 'completed', 'cached', 'completed']);
  assert.equal(done.progress.cached, 2); assert.equal(done.progress.completed, 2);
});

test('a retry returns the original expanded set when new children arrive', async t => {
  const rows = [row('parent'), row('child', { header: { ...row('child').header,
    origin: 'subagent', delegationDepth: 1, parentSession: 'parent' } })];
  const jobs = new AnalysisJobs({ catalog: catalogOf(rows), persistState: false, analyze: async id => result(id) });
  t.after(() => jobs.dispose());
  const request = { sessionIds: ['parent'], includeChildren: true, idempotencyKey: 'fixed-selection' };
  const first = await jobs.start(request);
  assert.deepEqual(first.selectedIds, ['parent', 'child']);
  rows.push(row('later-child', { header: { ...row('later-child').header,
    origin: 'subagent', delegationDepth: 1, parentSession: 'parent' } }));
  const retried = await jobs.start(request);
  assert.equal(retried.id, first.id); assert.deepEqual(retried.selectedIds, first.selectedIds);
});

test('cancellation preserves completed items and only aborts this job subscription', async t => {
  const entered = deferred(); let signal; const calls = [];
  const jobs = new AnalysisJobs({ catalog: catalogOf(['a', 'b', 'c'].map(id => row(id))), persistState: false,
    analyze: async (id, options) => {
      calls.push(id); if (id !== 'b') return result(id);
      signal = options.signal; entered.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
    } });
  t.after(() => jobs.dispose());
  const first = await jobs.start({ sessionIds: ['a', 'b', 'c'], idempotencyKey: 'cancel' });
  await entered.promise;
  const cancelled = await jobs.cancel({ id: first.id });
  assert.equal(cancelled.state, 'cancelled'); assert.equal(signal.aborted, true);
  assert.deepEqual(cancelled.items.map(item => item.state), ['completed', 'cancelled', 'cancelled']);
  assert.ok(cancelled.items[0].resultReference); assert.deepEqual(calls, ['a', 'b']);
  assert.equal((await jobs.cancel({ id: first.id })).state, 'cancelled');
});

test('a queued cancellation never starts that job or stops the running job', async t => {
  const entered = deferred(); const release = deferred(); const calls = [];
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a'), row('b')]), persistState: false,
    analyze: async id => { calls.push(id); entered.resolve(); await release.promise; return result(id); } });
  t.after(() => jobs.dispose());
  const running = await jobs.start({ sessionIds: ['a'], idempotencyKey: 'running' }); await entered.promise;
  const queued = await jobs.start({ sessionIds: ['b'], idempotencyKey: 'queued' });
  assert.equal((await jobs.cancel({ id: queued.id })).state, 'cancelled');
  release.resolve(); await finished(jobs, running.id);
  assert.deepEqual(calls, ['a']);
});

test('preflight budgets limit one item, reject unsafe batches and bound unknown metadata', async t => {
  let calls = 0;
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('large', { eventCount: 200 }), row('small')]), persistState: false,
    limits: { maxSessionEvents: 100 }, analyze: async id => { calls++; return result(id); } });
  t.after(() => jobs.dispose());
  const started = await jobs.start({ sessionIds: ['large', 'small'], idempotencyKey: 'limits' });
  const done = await finished(jobs, started.id);
  assert.deepEqual(done.items.map(item => item.state), ['limited', 'completed']); assert.equal(calls, 1);
  const batch = new AnalysisJobs({ catalog: catalogOf([row('a', { sizeBytes: 70 }), row('b', { sizeBytes: 70 })]), persistState: false,
    limits: { maxBatchBytes: 100 }, analyze: async () => assert.fail('Unsafe batch must not analyze') });
  t.after(() => batch.dispose());
  await assert.rejects(batch.start({ sessionIds: ['a', 'b'], idempotencyKey: 'batch' }), { status: 413 });
  const unknown = new AnalysisJobs({ catalog: catalogOf(Array.from({ length: 6 }, (_, index) => row(`unknown-${index}`, { eventCount: undefined, sizeBytes: undefined }))),
    persistState: false, analyze: async () => assert.fail('Unknown batch must remain bounded') });
  t.after(() => unknown.dispose());
  await assert.rejects(unknown.start({ sessionIds: Array.from({ length: 6 }, (_, index) => `unknown-${index}`), idempotencyKey: 'unknown' }), { status: 413 });
});

test('queue and runtime budgets settle rather than waiting indefinitely', async t => {
  const entered = deferred(); let signal;
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a'), row('b')]), persistState: false,
    limits: { maxQueuedJobs: 1, maxItemMs: 10, maxJobMs: 100 },
    analyze: async (_id, options) => { signal = options.signal; entered.resolve(); return new Promise(() => {}); } });
  t.after(() => jobs.dispose());
  const first = await jobs.start({ sessionIds: ['a'], idempotencyKey: 'timeout' }); await entered.promise;
  await assert.rejects(jobs.start({ sessionIds: ['b'], idempotencyKey: 'queue-full' }), { status: 429 });
  const done = await finished(jobs, first.id);
  assert.equal(done.state, 'completed'); assert.equal(done.items[0].state, 'limited');
  assert.equal(done.items[0].error.code, 'item-time-limit'); assert.equal(signal.aborted, true);
});

test('queued sources receive current read budgets and measured bytes reduce the next item allowance', async t => {
  const allowances = [];
  let decoded = 0;
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a', { sizeBytes: 10 }), row('b', { sizeBytes: 10 })]), persistState: false,
    limits: { maxBatchBytes: 100 }, analyze: async (id, options) => {
      allowances.push(options.maxBytes); assert.ok(options.maxEvents > 0);
      // Both files grew after directory capture. This models the repository's
      // current stat check before opening a full log.
      const currentBytes = 70;
      if (currentBytes > options.maxBytes) throw Object.assign(new Error('current read budget'), { status: 413 });
      decoded++; return { ...result(id), sourceCut: { ...result(id).sourceCut, sizeBytes: currentBytes } };
    } });
  t.after(() => jobs.dispose());
  const job = await jobs.start({ sessionIds: ['a', 'b'], idempotencyKey: 'growing-sources' });
  const done = await finished(jobs, job.id);
  assert.deepEqual(allowances, [100, 30]); assert.equal(decoded, 1);
  assert.deepEqual(done.items.map(item => item.state), ['completed', 'limited']);
  assert.equal(done.budget.measuredKnownBytes, 70);
});

test('cancelling a job leaves an unrelated consumer of shared AnalysisService work alive', async t => {
  const entered = deferred(); const release = deferred(); let underlyingSignal;
  const service = new AnalysisService({ extract: async (_records, _config, { signal }) => {
    underlyingSignal = signal; entered.resolve(); await release.promise; signal.throwIfAborted(); return { value: 'shared' };
  }, derive: async facts => facts });
  const request = signal => ({ sessionId: 'a', sourceCut: { sessionId: 'a', revision: 1 }, signal,
    load: async () => ({ records: ['shared'] }) });
  const foreground = service.analyze(request()); await entered.promise;
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a')]), persistState: false,
    analyze: (_id, options) => service.analyze(request(options.signal)) });
  t.after(async () => { await jobs.dispose(); await service.dispose(); });
  const job = await jobs.start({ sessionIds: ['a'], idempotencyKey: 'shared' });
  for (let count = 0; service.diagnostics().sharedHits === 0 && count < 100; count++) await delay(1);
  await jobs.cancel({ id: job.id });
  assert.equal(underlyingSignal.aborted, false); release.resolve();
  assert.equal((await foreground).value, 'shared'); assert.equal(service.diagnostics().computations, 1);
});

test('restart marks unfinished work interrupted and retains only owner-only recovery metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'private-state', 'analysis-jobs.json');
  const catalog = catalogOf(['a', 'b', 'c'].map(id => row(id)));
  const entered = deferred();
  const first = new AnalysisJobs({ catalog, statePath, analyze: async (id, { signal }) => {
    if (id !== 'b') return result(id);
    entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  } });
  await first.init();
  const request = { sessionIds: ['a', 'b', 'c'], idempotencyKey: 'restart' };
  const started = await first.start(request); await entered.promise; await first.dispose();
  const raw = await readFile(statePath, 'utf8');
  for (const secret of ['PRIVATE_TITLE_CANARY', 'PRIVATE_CWD_CANARY', 'PRIVATE_REQUEST_CANARY', 'PRIVATE_RESPONSE_CANARY',
    'PRIVATE_REVISION_CANARY', 'PRIVATE_LIFECYCLE_CANARY']) assert.equal(raw.includes(secret), false, secret);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'private-state'))).mode & 0o777, 0o700);
  let resumed = 0;
  const restored = new AnalysisJobs({ catalog, statePath, analyze: async id => { resumed++; return result(id); } });
  t.after(() => restored.dispose()); await restored.init();
  const interrupted = await restored.get(started.id);
  assert.equal(interrupted.state, 'interrupted'); assert.equal(resumed, 0);
  assert.deepEqual(interrupted.items.map(item => item.state), ['completed', 'cancelled', 'cancelled']);
  assert.equal((await restored.start(request)).id, started.id); assert.equal(resumed, 0);
  const retry = await restored.start({ sessionIds: ['b', 'c'], idempotencyKey: 'manual-retry' });
  await finished(restored, retry.id); assert.equal(resumed, 2);
});

test('corrupt state and failed writes degrade to local analysis without exposing exception content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-job-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parentFile = join(directory, 'not-a-directory'); await writeFile(parentFile, 'synthetic');
  const failed = new AnalysisJobs({ catalog: catalogOf([row('a')]), statePath: join(parentFile, 'state.json'), analyze: async id => result(id) });
  t.after(() => failed.dispose()); await failed.init();
  const first = await failed.start({ sessionIds: ['a'], idempotencyKey: 'write-failed' });
  const done = await finished(failed, first.id);
  assert.equal(done.items[0].state, 'completed'); assert.equal(done.persistence.available, false);
  const corruptPath = join(directory, 'corrupt.json'); await writeFile(corruptPath, '{PRIVATE_CORRUPT_CANARY');
  const corrupt = new AnalysisJobs({ catalog: catalogOf([row('a')]), statePath: corruptPath, analyze: async id => result(id) });
  t.after(() => corrupt.dispose()); await corrupt.init();
  const second = await corrupt.start({ sessionIds: ['a'], idempotencyKey: 'corrupt' });
  assert.equal((await finished(corrupt, second.id)).items[0].state, 'completed');
  assert.equal((await readFile(corruptPath, 'utf8')).includes('PRIVATE_CORRUPT_CANARY'), false);
});

test('terminal retention is bounded even when several jobs share a timestamp', async t => {
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a')]), persistState: false, now: () => 1,
    limits: { maxRetainedJobs: 2 }, analyze: async id => result(id) });
  t.after(() => jobs.dispose());
  const ids = [];
  for (let index = 0; index < 3; index++) {
    const job = await jobs.start({ sessionIds: ['a'], idempotencyKey: `retained-${index}` }); ids.push(job.id);
    await finished(jobs, job.id);
  }
  await assert.rejects(jobs.get(ids[0]), { status: 404 });
  assert.equal((await jobs.list()).length, 2); assert.equal((await jobs.get(ids[2])).state, 'completed');
});

test('idle terminal jobs expire on reads without requiring another analysis to run', async t => {
  let now = 1;
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a')]), persistState: false, now: () => now,
    limits: { retentionMs: 10 }, analyze: async id => result(id) });
  t.after(() => jobs.dispose());
  const job = await jobs.start({ sessionIds: ['a'], idempotencyKey: 'idle-expiry' });
  await finished(jobs, job.id);
  now = 20;
  await assert.rejects(jobs.get(job.id), { status: 404 });
  assert.equal((await jobs.list()).length, 0);
});

test('a current visibility revocation prevents queued analysis and access to its job', async t => {
  const allowed = new Set(['a', 'b']); const entered = deferred(); const release = deferred(); const calls = [];
  const jobs = new AnalysisJobs({ catalog: catalogOf([row('a'), row('b')], { allows: id => allowed.has(id) }), persistState: false,
    analyze: async id => { calls.push(id); if (id === 'a') { entered.resolve(); await release.promise; } return result(id); } });
  t.after(() => jobs.dispose());
  const first = await jobs.start({ sessionIds: ['a'], idempotencyKey: 'scope-a' }); await entered.promise;
  const second = await jobs.start({ sessionIds: ['b'], idempotencyKey: 'scope-b' });
  allowed.delete('b'); release.resolve(); await finished(jobs, first.id); await delay(5);
  await assert.rejects(jobs.get(second.id), { status: 403 }); assert.deepEqual(calls, ['a']);
});
