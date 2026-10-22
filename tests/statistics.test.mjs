import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateStatistics, statisticsDate, statisticsFilters } from '../src/statistics.mjs';

const NOW = Date.parse('2026-10-22T13:00:00.000Z');
const at = value => Date.parse(value);
const usage = (input = 10, read = 90) => ({ inputTokens: input, cacheReadTokens: read,
  cacheWriteTokens: 0, outputTokens: 3, promptTokens: input + read,
  hitRate: read / (input + read), reported: true });
const call = (seq, extra = {}) => ({ seq, at: NOW - 1000, turn: 1, step: seq,
  provider: 'provider', model: 'model', settlement: 'assistant/message',
  usage: usage(), inherited: false, ...extra });
const session = (id, calls, extra = {}) => ({ sessionId: id, role: 'main',
  ownership: { known: true, inheritedEventCount: 0 }, calls, warnings: [],
  auxiliaryCalls: [], auxiliaryCoverage: { complete: false, unrecorded: [] }, ...extra });
const aggregate = (sessions, options = {}) => aggregateStatistics(sessions, { now: NOW, ...options });

test('global accounting groups main/sub/auxiliary and excludes fork-inherited events', () => {
  const shared = call(1, { inherited: true, usage: usage(100, 900) });
  const result = aggregate([
    session('parent', [call(1, { usage: usage(100, 900) })]),
    session('fork', [shared, call(5, { usage: usage(1, 999) })], { ownership: { known: true, inheritedEventCount: 4 } }),
    session('child', [shared, call(7)], { role: 'sub',
      auxiliaryCalls: [call(8, { settlement: 'compaction/summary', purpose: 'compaction', usage: usage(20, 80) })] }),
  ]);
  assert.equal(result.totals.calls, 4);
  assert.equal(result.groups.main.calls, 2);
  assert.equal(result.groups.sub.calls, 1);
  assert.equal(result.groups.auxiliary.calls, 1);
  assert.equal(result.totals.inputTokens, 131);
  assert.equal(result.coverage.inheritedCallsExcluded, 2);
  assert.equal(result.coverage.auxiliaryRecordingComplete, false);
});

test('seeded ownership that is not recorded stays unknown and never duplicates parent usage', () => {
  const original = call(1); delete original.inherited;
  const result = aggregate([session('child', [original], { ownership: { known: false, inheritedEventCount: null } })]);
  assert.equal(result.totals.calls, 0);
  assert.equal(result.coverage.ownershipUnknownCalls, 1);
  assert.equal(result.recommendations.at(-1).id, 'coverage');
});

test('duplicate session DTOs cannot count the same settlement twice', () => {
  const record = session('one', [call(1), call(2)], {
    emptyAttempts: [{ seq: 3, at: NOW, inherited: false }],
    auxiliaryCoverage: { unrecorded: [{ seq: 4, at: NOW, inherited: false }] },
  });
  const result = aggregate([record, record]);
  assert.equal(result.totals.calls, 2);
  assert.equal(result.coverage.duplicateCallsExcluded, 2);
  assert.equal(result.totals.emptyAttempts, 1);
  assert.equal(result.totals.unrecordedAuxiliaryOperations, 1);
});

test('failed nonempty attempts are actual calls; empty attempts remain separate with dispatch unknown', () => {
  const result = aggregate([session('one', [call(1), call(2, { settlement: 'assistant/attempt' })], {
    emptyAttempts: [{ seq: 3, at: NOW, turn: 2, step: 1, inherited: false, dispatch: 'unknown' }],
  })]);
  assert.equal(result.totals.calls, 2);
  assert.equal(result.totals.failedAttempts, 1);
  assert.equal(result.totals.successfulCalls, 1);
  assert.equal(result.totals.emptyAttempts, 1);
  assert.equal(result.coverage.emptyAttemptDispatchKnown, false);
});

test('partial usage does not become zero and known rates use only complete denominators', () => {
  const incomplete = { inputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null,
    outputTokens: 5, promptTokens: null, reported: true };
  const result = aggregate([session('one', [call(1), call(2, { usage: incomplete })])]);
  assert.equal(result.totals.cacheReadTokens, null);
  assert.equal(result.totals.promptTokens, null);
  assert.equal(result.totals.hitRate, null);
  assert.equal(result.totals.knownHitRate, 0.9);
  assert.equal(result.totals.knownCacheReadTokens, 90);
  assert.equal(result.totals.cacheUnknownCalls, 1);
  assert.equal(result.totals.inputTokens, 60);
});

test('filters use actual call dates in Shanghai, not creation dates, with seven calendar days by default', () => {
  const result = aggregate([session('old-session', [
    call(1, { at: at('2026-10-15T15:59:59.999Z') }), // Oct 15 in Shanghai: excluded.
    call(2, { at: at('2026-10-15T16:00:00.000Z') }), // Oct 16: included.
    call(3, { at: at('2026-10-21T16:05:00.000Z') }), // Oct 22.
    call(4, { at: NOW + 1 }),
  ], { createdAt: at('2020-01-01T00:00:00Z') })]);
  assert.equal(result.totals.calls, 2);
  assert.deepEqual(result.byDate.map(row => row.date), ['2026-10-22', '2026-10-16']);
  assert.equal(result.coverage.dateFilteredOutCalls, 2);
  assert.equal(statisticsDate(at('2026-10-21T16:05:00.000Z')), '2026-10-22');
});

test('unknown dates are isolated in all-time statistics and excluded from bounded dates', () => {
  const record = session('one', [call(1, { at: null })]);
  const bounded = aggregate([record]);
  assert.equal(bounded.totals.calls, 0);
  assert.equal(bounded.coverage.unknownDateCalls, 1);
  const all = aggregate([record], { period: 'all' });
  assert.equal(all.totals.calls, 1);
  assert.equal(all.byDate[0].date, 'unknown');
});

test('model and date ranges also select failed and auxiliary recorded calls', () => {
  const result = aggregate([session('one', [call(1), call(2, { model: 'other' }),
    call(3, { settlement: 'assistant/attempt' })], { auxiliaryCalls: [call(4, { settlement: 'compaction/summary' })] })],
  { period: '30d', model: 'model', provider: 'provider', fromDate: '2026-10-22', toDate: '2026-10-22' });
  assert.equal(result.totals.calls, 3);
  assert.equal(result.totals.failedAttempts, 1);
  assert.equal(result.totals.auxiliaryCalls, 1);
  assert.equal(result.availableModels.length, 2);
  assert.equal(result.byModel.length, 1);
  assert.equal(result.byModel[0].model, 'model');
});

test('expected rebuild is separate from unexpected loss and never sold as monetary savings', () => {
  const warnings = [
    { seq: 2, lossTokens: 1000, category: 'unexpected-loss', changes: [{ kind: 'tools' }],
      recovered: true, recoveredAt: { seq: 3, at: NOW - 100 } },
    { seq: 4, lossTokens: 900, category: 'expected-rebuild', changes: [{ kind: 'history' }], recovered: false },
  ];
  const result = aggregate([session('one', [call(1, { category: 'cold-start' }), call(2), call(3), call(4)], { warnings })]);
  assert.equal(result.totals.warnings, 1);
  assert.equal(result.totals.recoveredWarnings, 1);
  assert.equal(result.totals.coldStarts, 1);
  assert.equal(result.totals.expectedRebuilds, 1);
  assert.equal(result.totals.estimatedLossTokens, 1000);
  assert.equal(result.totals.expectedRebuildLossTokens, 900);
  assert.equal(result.causes.length, 1);
  assert.deepEqual(result.recommendations[0].evidence[0], { sessionId: 'one', seq: 2, turn: 1, step: 2 });
  assert.equal(result.recommendations[0].action, 'inspect');
  assert.equal(result.coverage.monetarySavings, 'not-estimated');
});

test('future or unknown recovery receipts do not claim recovery at the selected cutoff', () => {
  const result = aggregate([session('one', [call(1), call(2)], { warnings: [
    { seq: 1, lossTokens: 10, recovered: true, recoveredAt: { at: NOW + 1 } },
    { seq: 2, lossTokens: 20, recovered: true, recoveredAt: { seq: 3 } },
  ] })]);
  assert.equal(result.totals.recoveredWarnings, 0);
  assert.equal(result.totals.unrecoveredWarnings, 1);
  assert.equal(result.totals.recoveryUnknownWarnings, 1);
});

test('unrecorded auxiliary operations and read/scan limits remain explicit coverage', () => {
  const result = aggregate([session('one', [], { auxiliaryCoverage: { unrecorded: [
    { seq: 1, at: NOW, inherited: false, purpose: 'compaction', reason: 'compaction-without-summary-receipt' },
  ] } })], { coverage: { scanned: 1, total: 100, limit: 1, errors: [{ sessionId: 'failed' }] } });
  assert.equal(result.totals.calls, 0);
  assert.equal(result.totals.unrecordedAuxiliaryOperations, 1);
  assert.equal(result.coverage.total, 100);
  assert.equal(result.coverage.errors.length, 1);
  assert.match(result.coverage.auxiliaryNote, /不代表零/);
});

test('policy reclassification changes diagnostics only, preserving recorded token counters', () => {
  const calls = [call(1), call(2)];
  const warning = { seq: 2, lossTokens: 10, recovered: false, cause: 'upstream-unknown' };
  const before = aggregate([session('one', calls, { warnings: [warning] })], { policyVersion: 1 });
  const after = aggregate([session('one', calls)], { policyVersion: 2 });
  assert.equal(before.totals.cacheReadTokens, after.totals.cacheReadTokens);
  assert.equal(before.totals.hitRate, after.totals.hitRate);
  assert.equal(before.totals.warnings, 1);
  assert.equal(after.totals.warnings, 0);
  assert.equal(after.policyVersion, 2);
});

test('operation summary receipts deduplicate durable events and include failed/cancelled known usage', () => {
  const operations = [{ id: 'job-one', sessionId: 'source', branchId: 'branch', state: 'failed', summaryCalls: [
    { summarySeq: 5, provider: 'provider', model: 'model', at: NOW, usage: usage(), outcome: 'completed' },
    { provider: 'provider', model: 'model', at: NOW, usage: usage(20, 80), usageRecorded: true, outcome: 'failed' },
    { provider: 'provider', model: 'model', at: NOW, usage: usage(30, 70), usageRecorded: true, outcome: 'cancelled' },
    { provider: 'provider', model: 'model', at: NOW, usage: { inputTokens: null, cacheReadTokens: null,
      cacheWriteTokens: null, outputTokens: null }, usageRecorded: false, outcome: 'failed' },
  ] }];
  const result = aggregate([session('source', []), session('branch', [], {
    auxiliaryCalls: [call(5, { settlement: 'compaction/summary' })],
  })], { operations });
  assert.equal(result.groups.auxiliary.calls, 4);
  assert.equal(result.groups.auxiliary.successfulCalls, 1);
  assert.equal(result.totals.knownCacheReadTokens, 240);
  assert.equal(result.totals.cacheReadTokens, null);
  assert.equal(result.totals.missingUsageCalls, 1);
  assert.equal(result.groups.auxiliary.failedAttempts, 2);
  assert.equal(result.groups.auxiliary.cancelledAuxiliaryCalls, 1);
  assert.equal(result.coverage.operationReceiptsDuplicateExcluded, 1);
  assert.equal(result.coverage.operationReceiptCalls, 3);
});

test('operation receipts stay inside the scan and an active incomplete call is not settled accounting', () => {
  const result = aggregate([session('source', [])], { operations: [
    { id: 'outside', sessionId: 'other', branchId: 'other-branch', state: 'completed',
      summaryCalls: [{ at: NOW, usage: usage(), outcome: 'completed' }] },
    { id: 'pending', sessionId: 'source', branchId: 'branch', state: 'compacting',
      summaryCalls: [{ at: NOW, usage: usage(), outcome: 'started' }] },
  ] });
  assert.equal(result.totals.calls, 0);
  assert.equal(result.coverage.operationsOutsideScanExcluded, 1);
  assert.equal(result.coverage.pendingAuxiliaryCalls, 1);
});

test('operation-scoped compaction receipts resolve Session gaps only for the exact branch and compaction', () => {
  const unrecorded = [{ seq: 5, at: NOW, inherited: false, purpose: 'compaction',
    compactionId: 'compact-one', reason: 'compaction-without-summary-receipt' }];
  const known = { id: 'job-one', sessionId: 'source', branchId: 'branch', state: 'failed', summaryCalls: [
    { compactionId: 'compact-one', provider: 'provider', model: 'model', at: NOW,
      usage: usage(), usageRecorded: true, outcome: 'failed' },
  ] };
  const records = [session('source', []), session('branch', [], { auxiliaryCoverage: { unrecorded } })];
  const result = aggregate(records, { operations: [known] });
  assert.equal(result.totals.calls, 1);
  assert.equal(result.totals.cacheUnknownCalls, 0);
  assert.equal(result.totals.unrecordedAuxiliaryOperations, 0);
  assert.equal(result.coverage.sessionAuxiliaryReceiptGaps, 1);
  assert.equal(result.coverage.unrecordedAuxiliaryOperations, 0);
  const mismatched = aggregate(records, { operations: [{ ...known, branchId: 'different-branch' }] });
  assert.equal(mismatched.totals.unrecordedAuxiliaryOperations, 1);
  const unknown = aggregate(records, { operations: [{ ...known, summaryCalls: [{
    ...known.summaryCalls[0], usage: undefined, usageRecorded: false,
  }] }] });
  assert.equal(unknown.totals.cacheUnknownCalls, 1, 'A recorded call without usage is still unknown');
  assert.equal(unknown.totals.missingUsageCalls, 1);
  assert.equal(unknown.totals.unrecordedAuxiliaryOperations, 0, 'Unknown usage and missing call records are separate gaps');
});

test('invalid date/model/range inputs fail explicitly', () => {
  for (const options of [{ period: '365d' }, { fromDate: '2026-02-31' }, { model: [] },
    { fromDate: '2026-10-23', toDate: '2026-10-21' }, { now: NaN }, { now: 1e20 }]) {
    assert.throws(() => statisticsFilters({ now: NOW, ...options }), { status: 400 });
  }
  assert.equal(statisticsDate(1e20), null);
});
