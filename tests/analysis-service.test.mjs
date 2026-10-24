import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, usage } from './history-fixtures.mjs';

const testedModule = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { AnalysisService } = await import(testedModule('analysis-service.mjs'));
const { SessionRepository } = await import(testedModule('repository.mjs'));

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const options = (extra = {}) => ({ sessionId: 'synthetic',
  sourceCut: { sessionId: 'synthetic', serviceInstance: 1, lifecycle: 1, revision: 1 },
  load: async () => ({ records: ['synthetic-fact'] }), ...extra });
const service = extra => new AnalysisService({
  extract: async records => ({ value: records[0] }),
  derive: async (facts, policy) => ({ value: facts.value, threshold: policy.minLostTokens }), ...extra,
});

test('four concurrent same-cut consumers share loading, facts and policy derivation', async () => {
  let loads = 0;
  const s = service();
  const request = options({ load: async () => { loads++; await tick(); return { records: ['once'] }; } });
  const values = await Promise.all(Array.from({ length: 4 }, () => s.analyze(request)));
  assert.deepEqual(values.map(value => value.value), ['once', 'once', 'once', 'once']);
  assert.equal(loads, 1);
  assert.equal(s.diagnostics().computations, 1);
  assert.equal(s.diagnostics().derivations, 1);
  assert.equal(s.diagnostics().sharedHits, 3);
  assert.equal((await s.analyze(request)).cacheStatus, 'memory');
  assert.equal(loads, 1);
  await s.dispose();
});

test('the service scopes even incomplete source-cut descriptors to their target Session', async () => {
  const s = service();
  const cut = { revision: 1 };
  const first = await s.analyze(options({ sourceCut: cut }));
  const other = await s.analyze(options({ sessionId: 'other', sourceCut: cut,
    load: async () => ({ records: ['other-result'] }) }));
  assert.notEqual(first.value, other.value);
  assert.equal(s.diagnostics().computations, 2);
  await assert.rejects(s.analyze(options({ sourceCut: { sessionId: 'other' } })), TypeError);
  await s.dispose();
});

test('cancelling one subscription preserves other consumers of the same work', async () => {
  const entered = deferred();
  const release = deferred();
  let sharedSignal;
  const s = service({ extract: async (_records, _config, { signal }) => {
    sharedSignal = signal; entered.resolve(); await release.promise;
    signal.throwIfAborted(); return { value: 'survivor' };
  } });
  const controller = new AbortController();
  const cancelled = s.analyze(options({ signal: controller.signal }));
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  const survivor = s.analyze(options());
  await entered.promise;
  controller.abort();
  await rejection;
  assert.equal(sharedSignal.aborted, false);
  release.resolve();
  assert.equal((await survivor).value, 'survivor');
  assert.equal(s.diagnostics().computations, 1);
  await s.dispose();
});

test('the last cancelled subscriber aborts shared work and cannot publish its late result', async () => {
  const entered = deferred();
  const release = deferred();
  let runs = 0;
  let sharedSignal;
  const s = service({ extract: async (_records, _config, { signal }) => {
    runs++;
    if (runs === 1) {
      sharedSignal = signal; entered.resolve(); await release.promise;
      return { value: 'abandoned' }; // Simulates a backend observing abort late.
    }
    return { value: 'replacement' };
  } });
  const controller = new AbortController();
  const old = s.analyze(options({ signal: controller.signal }));
  const rejection = assert.rejects(old, { code: 'ABORT_ERR' });
  await entered.promise;
  controller.abort();
  await rejection;
  assert.equal(sharedSignal.aborted, true);
  assert.equal((await s.analyze(options())).value, 'replacement');
  release.resolve();
  await tick();
  assert.equal((await s.analyze(options())).value, 'replacement');
  assert.equal(runs, 2);
  await s.dispose();
});

test('cancellation during shared policy derivation does not evict the surviving task', async () => {
  const entered = deferred();
  const release = deferred();
  const s = service({ derive: async facts => { entered.resolve(); await release.promise; return facts; } });
  const controller = new AbortController();
  const first = s.analyze(options({ signal: controller.signal }));
  const rejection = assert.rejects(first, { name: 'AbortError' });
  const second = s.analyze(options());
  await entered.promise;
  await tick();
  controller.abort();
  await rejection;
  const third = s.analyze(options());
  await tick();
  release.resolve();
  await Promise.all([second, third]);
  assert.equal(s.diagnostics().derivations, 1);
  await s.dispose();
});

test('policy versions rederive shared neutral facts without extracting old inputs', async () => {
  const s = service();
  const one = await s.analyze(options({ policyVersion: 1, config: { minLostTokens: 1 } }));
  const two = await s.analyze(options({ policyVersion: 2, config: { minLostTokens: 2 } }));
  assert.equal(one.threshold, 1);
  assert.equal(two.threshold, 2);
  assert.equal(s.diagnostics().computations, 1);
  assert.equal(s.diagnostics().derivations, 2);
  await s.dispose();
});

test('an older source cut finishing last does not replace the newer complete result', async () => {
  const entered = deferred();
  const release = deferred();
  const s = service({ extract: async records => {
    if (records[0] === 'old') { entered.resolve(); await release.promise; }
    return { value: records[0] };
  } });
  const oldRequest = options({ order: 1, load: async () => ({ records: ['old'] }) });
  const newRequest = options({ order: 2, sourceCut: { ...oldRequest.sourceCut, revision: 2 },
    load: async () => ({ records: ['new'] }) });
  const old = s.analyze(oldRequest);
  await entered.promise;
  assert.equal((await s.analyze(newRequest)).value, 'new');
  release.resolve();
  assert.equal((await old).value, 'old');
  assert.equal((await s.analyze({ ...newRequest, order: 3 })).cacheStatus, 'memory');
  assert.equal(s.diagnostics().computations, 2);
  await s.dispose();
});

test('disposed services abort consumers and refuse further work', async () => {
  const entered = deferred();
  const s = service({ extract: async (_records, _config, { signal }) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  } });
  const pending = s.analyze(options());
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  await s.dispose();
  await rejection;
  assert.equal(s.diagnostics().cachedSessions, 0);
  await assert.rejects(s.analyze(options()), { code: 'ABORT_ERR' });
});

const settings = extra => ({ minLostTokens: 50_000, minLossRatio: 0.2, dashboardLimit: 50,
  maxEvents: 200_000, maxCachedSessions: 2, persistState: false, ...extra });
function context(live, getPersistence = () => undefined) {
  return { sessions: { get: id => id === live?.id ? live : undefined,
    list: () => live ? [live] : [], messageProjections: [] },
  get: name => name === 'sessionPersistence' ? getPersistence() : undefined };
}
function stored(f, extra = {}) {
  let reads = 0;
  return { identity: Symbol('synthetic-backend'), get reads() { return reads; },
    stat: async () => ({ revision: 'same-token', header: f.session.header, ...extra }),
    list: async () => [{ header: f.session.header }],
    open: async () => ({ header: f.session.header, inheritedEventCount: 0,
      read: async () => { reads++; return { events: f.session.snapshotEvents() }; },
      close: async () => {} }) };
}

test('session and dashboard share real historical analysis and preserve authoritative metrics', async () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  const repo = new SessionRepository(context(f.session), settings());
  const [one, two, three, dashboard] = await Promise.all([
    repo.session(f.session.id), repo.session(f.session.id), repo.session(f.session.id), repo.dashboard({ period: 'all' }),
  ]);
  assert.deepEqual(one.latest, two.latest);
  assert.deepEqual(one.latest, three.latest);
  assert.equal(dashboard.statistics.totals.calls, 1);
  assert.equal(repo.analysis.diagnostics().computations, 1);
  assert.equal(repo.analysis.diagnostics().derivations, 1);
  assert.equal(one.sourceCut.eventCount, f.session.snapshotEvents().length);
  await repo.dispose();
});

test('backend replacement with the same revision never reuses an unrelated result', async () => {
  const a = fixture(); a.response(usage(10, 100));
  const b = fixture(); b.response(usage(20, 200));
  let backend = stored(a);
  const repo = new SessionRepository(context(undefined, () => backend), settings());
  const first = await repo.session(a.session.id);
  backend = stored(b);
  const second = await repo.session(b.session.id);
  assert.equal(first.latest.cacheReadTokens, 100);
  assert.equal(second.latest.cacheReadTokens, 200);
  assert.notEqual(first.sourceCut.serviceInstance, second.sourceCut.serviceInstance);
  assert.equal(repo.analysis.diagnostics().computations, 2);
  await repo.dispose();
});

test('lower event limits apply to cached cold results even without budget metadata', async () => {
  const f = fixture(); f.response(usage(10, 100));
  const backend = stored(f);
  const repo = new SessionRepository(context(undefined, () => backend), settings());
  await repo.session(f.session.id);
  repo.updatePolicy(settings({ maxEvents: 1 }), 2);
  await assert.rejects(repo.session(f.session.id), { status: 413 });
  assert.equal(backend.reads, 1);
  await repo.dispose();
});

test('a fixed live cut reports newer events without chasing or recounting them', async () => {
  const f = fixture(); f.response(usage(10, 100));
  let appended = false;
  const repo = new SessionRepository(context(f.session), settings({ onNormalize: () => {
    if (!appended) { appended = true; f.next(); f.user('new synthetic input'); f.response(usage(20, 200)); }
  } }));
  const old = await repo.session(f.session.id);
  assert.equal(old.calls.length, 1);
  assert.equal(old.hasNewEvents, true);
  const current = await repo.session(f.session.id);
  assert.equal(current.calls.length, 2);
  assert.equal(current.hasNewEvents, false);
  assert.ok(current.sourceCut.eventCount > old.sourceCut.eventCount);
  await repo.dispose();
});

test('cold reads forward abort signals and close the handle on cancellation', async () => {
  const f = fixture();
  const controller = new AbortController();
  let closed = 0;
  const backend = stored(f);
  backend.open = async (_id, access, options) => {
    assert.equal(access, 'read'); assert.ok(options.signal);
    return { header: f.session.header, inheritedEventCount: 0,
      read: async (_offset, _count, readOptions) => {
        assert.equal(readOptions.signal, options.signal);
        controller.abort(); return { events: f.session.snapshotEvents() };
      }, close: async () => { closed++; } };
  };
  const repo = new SessionRepository(context(undefined, () => backend), settings());
  await assert.rejects(repo.session(f.session.id, { signal: controller.signal }), { code: 'ABORT_ERR' });
  await repo.dispose();
  assert.equal(closed, 1);
});

test('projection function replacement invalidates facts even with unchanged event and type lists', async () => {
  const f = fixture(); f.response(usage(10, 100));
  const ctx = context(f.session);
  ctx.sessions.messageProjections = [{ type: 'synthetic/unused', project() { return new Map(); } }];
  const repo = new SessionRepository(ctx, settings());
  await repo.session(f.session.id);
  ctx.sessions.messageProjections[0] = { type: 'synthetic/unused', project() { return new Map(); } };
  await repo.session(f.session.id);
  assert.equal(repo.analysis.diagnostics().computations, 2);
  await repo.dispose();
});
