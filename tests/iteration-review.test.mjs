import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import { fixture, usage } from './history-fixtures.mjs';
const tested = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { createCacheHelper } = await import(tested('index.mjs'));
const { FactCache } = await import(tested('fact-cache.mjs'));
const { AnalysisService } = await import(tested('analysis-service.mjs'));
const { SessionRepository } = await import(tested('repository.mjs'));
const { AnalysisJobs } = await import(tested('analysis-jobs.mjs'));
const { SessionCatalog } = await import(tested('session-catalog.mjs'));
const settings = { minLostTokens: 50_000, minLossRatio: 0.2, maxCachedSessions: 2,
  maxEvents: 200_000, dashboardLimit: 50, persistState: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function eventually(read) { for (let tries = 0; tries < 200; tries++) { const value = await read(); if (value) return value; await tick(); } throw new Error('Synthetic task did not settle'); }

test('job cancellation and cache clearing preserve an unrelated foreground consumer and live confirmation', async t => {
  const f = fixture({ text: 'synthetic request' }); f.response(usage(10, 100_000));
  const hooks = new Map();
  const ctx = { on(type, callback) { const listeners = hooks.get(type) ?? new Set(); listeners.add(callback); hooks.set(type, listeners); return () => listeners.delete(callback); },
    get: () => undefined, sessions: { get: id => id === f.session.id ? f.session : undefined,
      list: () => [f.session], messageProjections: [] } };
  const helper = await createCacheHelper(ctx, { ...settings, registerHttp: false });
  const release = deferred(); const entered = deferred();
  t.after(async () => { release.resolve(); await helper.dispose(); });
  const extract = helper.repository.analysis.extract;
  let sharedSignal;
  helper.repository.analysis.extract = async (...args) => {
    sharedSignal = args[2].signal; entered.resolve(); await release.promise;
    sharedSignal.throwIfAborted(); return extract(...args);
  };
  const waiting = helper.gate.wait({ unknown: true }, { sessionId: f.session.id, fingerprint: 'frozen-live-candidate' });
  const settled = waiting.catch(error => error);
  const pending = helper.gate.pendingFor(f.session.id);
  const foreground = helper.getSession(f.session.id);
  await entered.promise;
  const job = await helper.jobs.start({ sessionIds: [f.session.id], idempotencyKey: 'separate-local-analysis' });
  await eventually(() => helper.repository.analysis.diagnostics().sharedHits > 0);
  await helper.repository.analysis.clearCache();
  await helper.jobs.cancel({ id: job.id });
  assert.equal(sharedSignal.aborted, false);
  assert.equal(helper.gate.pendingFor(f.session.id).id, pending.id);
  release.resolve();
  assert.equal((await foreground).latest.cacheReadTokens, 100_000);
  assert.equal(helper.gate.pendingFor(f.session.id).fingerprint, 'frozen-live-candidate');
  helper.gate.cancel(f.session.id);
  assert.equal((await settled).code, 'CACHE_HELPER_CANCELLED');
});

test('cached display checks disk lifecycle and exact inherited cut independently of current memory metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-preview-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new FactCache({ directory: join(directory, 'facts') }); await cache.init();
  const service = new AnalysisService({ factCache: cache }); t.after(() => service.dispose());
  const f = fixture({ text: 'synthetic inherited input' }); f.response(usage(10, 100));
  const records = f.records(); records[0] = { ...records[0], isSeeded: true, inheritedEventCount: 1 };
  await service.analyze({ sessionId: f.session.id, sourceCut: { sessionId: f.session.id, revision: 1 },
    load: async () => ({ records }), config: {} });
  assert.ok(await service.cached(f.session.id, { header: records[0], inheritedEventCount: 1 }));
  assert.equal(await service.cached(f.session.id, { header: { ...records[0], createdAt: records[0].createdAt + 1 }, inheritedEventCount: 1 }), undefined);
  assert.equal(await service.cached(f.session.id, { header: records[0], inheritedEventCount: 0 }), undefined);
});

test('a queued cold Session that outgrows its byte budget is rejected before opening its log', async t => {
  const f = fixture({ text: 'synthetic stored data' }); f.response(usage(10, 100));
  const header = { ...f.session.header, id: 'queued-large' };
  const first = { id: 'first', header: { id: 'first', version: 4, createdAt: 1, isSeeded: false }, seq: 1 };
  let bytes = 100; let opens = 0;
  const backend = { identity: Symbol('review-backend'),
    list: async () => [{ header, sizeBytes: bytes, eventCount: f.session.snapshotEvents().length, revision: bytes }],
    stat: async () => ({ header, sizeBytes: bytes, eventCount: f.session.snapshotEvents().length, revision: bytes }),
    open: async () => { opens++; return { header, inheritedEventCount: 0,
      read: async () => ({ events: f.session.snapshotEvents() }), close: async () => {} }; } };
  const ctx = { sessions: { get: id => id === 'first' ? first : undefined, list: () => [first], messageProjections: [] },
    get: name => name === 'sessionPersistence' ? backend : undefined };
  const repository = new SessionRepository(ctx, settings);
  const catalog = new SessionCatalog(ctx);
  const entered = deferred(); const release = deferred();
  const jobs = new AnalysisJobs({ catalog, persistState: false,
    limits: { maxSessionBytes: 1000, maxBatchBytes: 2000 },
    analyze: async (id, options) => {
      if (id === 'first') { entered.resolve(); await release.promise; return { sourceCut: { sessionId: id, eventCount: 1 }, cacheStatus: 'computed' }; }
      return repository.session(id, options);
    } });
  t.after(async () => { release.resolve(); await jobs.dispose(); await repository.dispose(); });
  const firstJob = await jobs.start({ sessionIds: ['first'], idempotencyKey: 'hold-queue' }); await entered.promise;
  const queued = await jobs.start({ sessionIds: ['queued-large'], idempotencyKey: 'queued-small-then-large' });
  bytes = 5000;
  release.resolve();
  await eventually(async () => (await jobs.get(firstJob.id)).state === 'completed');
  const done = await eventually(async () => { const value = await jobs.get(queued.id); return value.state === 'completed' ? value : null; });
  assert.equal(done.items[0].state, 'limited');
  assert.equal(opens, 0);
});
