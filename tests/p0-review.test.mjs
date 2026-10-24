import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, usage } from './history-fixtures.mjs';

const testedModule = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { AnalysisService } = await import(testedModule('analysis-service.mjs'));
const { SessionRepository } = await import(testedModule('repository.mjs'));

const settings = extra => ({ minLostTokens: 50_000, minLossRatio: 0.2,
  maxCachedSessions: 2, maxEvents: 1000, dashboardLimit: 50, persistState: false, ...extra });
const context = ({ live = () => undefined, persistence } = {}) => ({
  sessions: { get: live, messageProjections: [] },
  get: name => name === 'sessionPersistence' ? persistence : undefined,
});

test('a cold fixed cut reports appends during analysis without chasing the new events', async () => {
  const f = fixture({ text: 'synthetic small prompt' });
  f.response(usage(10, 100));
  let revision = 1;
  const persistence = {
    stat: async () => ({ header: f.session.header, revision }),
    open: async () => ({ header: f.session.header, inheritedEventCount: 0,
      read: async () => ({ events: f.session.snapshotEvents() }), close: async () => {},
    }),
  };
  let appended = false;
  const repo = new SessionRepository(context({ persistence }), settings({ onNormalize() {
    if (appended) return;
    appended = true;
    f.next(); f.user('new appended input'); f.response(usage(20, 200)); revision++;
  } }));
  try {
    const old = await repo.session(f.session.id);
    assert.equal(old.calls.length, 1);
    assert.equal(old.sourceCut.revision, 1);
    assert.equal(old.hasNewEvents, true);
    const current = await repo.session(f.session.id);
    assert.equal(current.calls.length, 2);
    assert.equal(current.sourceCut.revision, 2);
    assert.equal(current.hasNewEvents, false);
  } finally { await repo.dispose(); }
});

test('a cold source changing between stat and read is rejected with its handle closed', async () => {
  const f = fixture({ text: 'synthetic small prompt' });
  f.response(usage(10, 100));
  let revision = 1;
  let reads = 0;
  let closed = 0;
  const persistence = {
    stat: async () => ({ header: f.session.header, revision }),
    open: async () => ({ header: f.session.header, inheritedEventCount: 0,
      read: async () => {
        if (++reads === 1) {
          f.next(); f.user('source changed during read'); f.response(usage(20, 200)); revision++;
        }
        return { events: f.session.snapshotEvents() };
      },
      close: async () => { closed++; },
    }),
  };
  const repo = new SessionRepository(context({ persistence }), settings());
  try {
    await assert.rejects(repo.session(f.session.id), { code: 'CACHE_HELPER_SOURCE_CHANGED', status: 409 });
    assert.equal(closed, 1);
    assert.equal(repo.analysis.diagnostics().computations, 0, 'an uncertain cut cannot seed the facts cache');
    assert.equal((await repo.session(f.session.id)).calls.length, 2);
    assert.equal(closed, 2);
  } finally { await repo.dispose(); }
});

test('late registration of a lower request order cannot replace a newer source entry', async () => {
  const service = new AnalysisService({ extract: async records => ({ marker: records[0] }),
    derive: async facts => facts });
  const request = (revision, marker, order) => ({ sessionId: 'source-order', sourceCut: { revision }, order,
    load: async () => ({ records: [marker] }) });
  try {
    await service.analyze(request(2, 'new', 2));
    assert.equal((await service.analyze(request(1, 'late-old', 1))).marker, 'late-old');
    const current = await service.analyze(request(2, 'new', 3));
    assert.equal(current.marker, 'new');
    assert.equal(current.cacheStatus, 'memory');
    assert.equal(service.diagnostics().computations, 2);
  } finally { await service.dispose(); }
});

test('recreated live Sessions with the same id and event count never share facts', async () => {
  const a = fixture({ text: 'same input' }); a.response(usage(10, 100));
  const b = fixture({ text: 'same input' }); b.response(usage(20, 200));
  const wrap = f => ({ id: a.session.id, header: a.session.header, surface: a.session.surface,
    snapshotEvents: () => f.session.snapshotEvents() });
  let live = wrap(a);
  const repo = new SessionRepository(context({ live: () => live }), settings());
  try {
    const first = await repo.session(live.id);
    live = wrap(b);
    const second = await repo.session(live.id);
    assert.equal(first.latest.cacheReadTokens, 100);
    assert.equal(second.latest.cacheReadTokens, 200);
    assert.notEqual(first.sourceCut.lifecycle, second.sourceCut.lifecycle);
    assert.equal(repo.analysis.diagnostics().computations, 2);
  } finally { await repo.dispose(); }
});
