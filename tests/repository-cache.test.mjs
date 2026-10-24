import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, usage } from './history-fixtures.mjs';

const tested = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { SessionRepository, requestRevision } = await import(tested('repository.mjs'));
const { accountingProjectionDefinition: definition } = await import(tested('accounting-projection.mjs'));
const settings = { minLostTokens: 50_000, minLossRatio: 0.2, dashboardLimit: 50,
  maxEvents: 1000, maxCachedSessions: 2, persistState: false };

test('cold analysis preserves a bounded accounting checkpoint after detailed facts are cleared', async () => {
  const f = fixture({ text: 'PRIVATE_REPOSITORY_SUMMARY_CANARY' });
  f.response(usage(100, 100_000));
  f.next(); f.user('continue'); f.response({ inputTokens: 20, outputTokens: 2 });
  const header = { ...f.session.header, id: 'cold-summary' };
  const events = f.session.snapshotEvents();
  const original = JSON.stringify(events);
  let opens = 0;
  let checkpoints = 0;
  let saved;
  const persistence = { identity: Symbol('summary-backend'),
    stat: async () => ({ header, revision: 1, eventCount: events.length, sizeBytes: 2000 }),
    open: async () => { opens++; return { header, inheritedEventCount: 0,
      read: async () => ({ events }), close: async () => {} }; } };
  const projectionCache = {
    coldSnapshot(meta, cut, records) {
      checkpoints++; assert.deepEqual(meta, header); assert.equal(cut, 0); assert.deepEqual(records, events);
      const state = records.reduce((value, event) => definition.apply(value, event), definition.init(meta, cut));
      saved = { asOfSeq: records.at(-1).seq, values: { [definition.key]: definition.stateSchema.parse(state) } };
      return saved;
    },
    cachedSnapshot(meta) { assert.deepEqual(meta, header); return saved; },
  };
  const ctx = { sessions: { get: () => undefined, list: () => [], messageProjections: [] },
    get: name => ({ sessionPersistence: persistence, sessionProjectionCache: projectionCache }[name]) };
  const repo = new SessionRepository(ctx, settings);
  await repo.init();
  const full = await repo.session(header.id);
  assert.equal(full.calls.length, 2); assert.equal(checkpoints, 1);
  await repo.analysis.clearCache();
  const summary = await repo.cachedSession(header.id);
  assert.equal(opens, 1, 'Reading a retained summary must not reopen or decode its Session');
  assert.equal(summary.coverage.partial, true); assert.equal(summary.coverage.detailsAvailable, false);
  assert.equal(summary.accountingSummary.own.calls, 2);
  assert.equal(summary.accountingSummary.own.knownCacheReadTokens, 100_000);
  assert.equal(summary.accountingSummary.own.unknownUsageCalls, 1);
  assert.equal(summary.latest, null, 'An effective receipt is not proof of the last actual call');
  assert.equal(summary.cumulative, null, 'Known sums must not fabricate a complete rate');
  assert.deepEqual(summary.calls, []); assert.deepEqual(summary.warnings, []);
  assert.equal(summary.sourceCut.validation, 'unverified');
  assert.equal(JSON.stringify(summary).includes('PRIVATE_REPOSITORY_SUMMARY_CANARY'), false);
  assert.equal(repo.analysisStatus(header, { revision: 1 }).state, 'stale');
  assert.equal(JSON.stringify(events), original, 'Checkpointing never changes the Session source');
  await repo.dispose();
});

test('directory cache status checks live lifecycle and projection semantics without reading events', async () => {
  const f = fixture({ text: 'synthetic status source' }); f.response(usage(10, 100));
  let readingAllowed = true;
  const wrap = () => ({ id: f.session.id, header: f.session.header, seq: f.session.seq,
    inheritedEventCount: 0, surface: f.session.surface,
    snapshotEvents() { assert.ok(readingAllowed, 'A directory status must not read live events'); return f.session.snapshotEvents(); } });
  let live = wrap();
  const ctx = { sessions: { get: () => live, list: () => [live], messageProjections: [] }, get: () => undefined };
  const repo = new SessionRepository(ctx, settings);
  await repo.session(live.id);
  readingAllowed = false;
  assert.equal(repo.analysisStatus(live.header, { live: true, eventCount: live.seq }).state, 'cached');
  live = wrap();
  assert.equal(repo.analysisStatus(live.header, { live: true, eventCount: live.seq }).state, 'stale', 'Identical id/header/length cannot identify a recreated Session');
  readingAllowed = true;
  await repo.session(live.id);
  readingAllowed = false;
  ctx.sessions.messageProjections = [{ type: 'unused/synthetic', project() { return new Map(); } }];
  assert.equal(repo.analysisStatus(live.header, { live: true, eventCount: live.seq }).state, 'stale');
  await repo.dispose();
});

test('request observations treat event zero consistently with and without a storage header', () => {
  const event = { type: 'user/message', seq: 0, surfaceOp: 'append' };
  assert.equal(requestRevision([event]), 0);
  assert.equal(requestRevision([{ type: 'session', id: 'zero' }, event]), 0);
});
