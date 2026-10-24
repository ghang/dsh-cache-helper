import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const testedModule = process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', 'session-identity.mjs')).href
  : new URL('../src/session-identity.mjs', import.meta.url).href;
const { inheritanceCut, sessionIdentity, selectReceiptBaseline } = await import(testedModule);

const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, ...extra });
const message = seq => ({ type: 'assistant/message', seq, time: seq, data: {} });
const attempt = (seq, extra = {}) => ({ type: 'assistant/attempt', seq, time: seq, data: { stream: [], ...extra } });
const child = (id, extra = {}) => header(id, { origin: 'subagent', delegationDepth: 1, parentSession: 'parent', ...extra });
const parents = (...headers) => new Map(headers.map(value => [value.id, value]));

test('ordinary and manually forked Sessions stay main; fork lineage is not delegation', () => {
  assert.deepEqual(sessionIdentity([header('main')]), {
    targetSessionId: 'main', role: 'main', directParentId: null, rootSessionId: 'main', depth: 0,
    activationGeneration: null, forkParentId: null, relationshipKnown: true, unknownReasons: [],
  });
  const records = [header('manual', { parentSession: 'old', isSeeded: true, inheritedEventCount: 1 }), message(0)];
  const identity = sessionIdentity(records);
  assert.equal(identity.role, 'main');
  assert.equal(identity.directParentId, null);
  assert.equal(identity.rootSessionId, 'manual');
  assert.equal(identity.forkParentId, 'old');
  assert.equal(selectReceiptBaseline(records).kind, 'inherited', 'Main gate still compares the inherited actual receipt');
});

test('spawn has no baseline until its own effective receipt, including after failure or cancellation', () => {
  const records = [child('spawn'), attempt(0), attempt(1, { stream: [
    { type: 'chunk', time: 1, chunk: { type: 'text', text: 'incomplete' } },
  ] })];
  assert.equal(selectReceiptBaseline(records).kind, 'none');
  assert.equal(sessionIdentity(records).role, 'sub');
  assert.equal(sessionIdentity(records).rootSessionId, null);
  assert.equal(sessionIdentity(records).relationshipKnown, false);
  records.push(message(2));
  assert.deepEqual(selectReceiptBaseline(records), { kind: 'own', seq: 2,
    receiptSessionId: 'spawn', inheritedEventCount: 0, ownershipKnown: true });
});

test('fork baseline remains inherited through an empty attempt, cold restore or no-usage failure', () => {
  const records = [child('fork', { isSeeded: true, inheritedEventCount: 1 }), message(0), attempt(1)];
  assert.equal(selectReceiptBaseline(records).kind, 'inherited');
  assert.equal(selectReceiptBaseline(records).receiptSessionId, null, 'Direct parent alone cannot prove receipt ownership');
  assert.equal(selectReceiptBaseline(structuredClone(records)).kind, 'inherited');
  records.push(attempt(2, { stream: [{ type: 'chunk', time: 2, chunk: { type: 'text', text: 'error' } }] }));
  assert.equal(selectReceiptBaseline(records).seq, 0);
  records.push(attempt(3, { usage: { inputTokens: 10 } }));
  assert.equal(selectReceiptBaseline(records).kind, 'own');
  assert.equal(selectReceiptBaseline(records).seq, 3);
});

test('a successful receipt without usage and a failed receipt with compact usage are valid own baselines', () => {
  assert.equal(selectReceiptBaseline([header('one'), message(0)]).kind, 'own');
  const records = [child('two'), attempt(0, { stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 100 } } },
  ] })];
  assert.equal(selectReceiptBaseline(records).kind, 'own');
  assert.equal(selectReceiptBaseline([child('null'), attempt(0, { usage: null })]).kind, 'none');
  assert.equal(selectReceiptBaseline([child('null-stream'), attempt(0, { usage: null, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 100 } } },
  ] })]).kind, 'none', 'Explicit settlement usage follows the accounting precedence');
});

test('missing, out-of-range, inconsistent seed cuts remain unknown instead of fabricating own usage', () => {
  for (const extra of [{ isSeeded: true }, { isSeeded: true, inheritedEventCount: -1 },
    { isSeeded: true, inheritedEventCount: 2 }, { isSeeded: false, inheritedEventCount: 1 },
    { isSeeded: true, inheritedEventCount: 0.5 }]) {
    const records = [child('bad', extra), message(0)];
    assert.equal(inheritanceCut(records).known, false);
    assert.equal(selectReceiptBaseline(records).kind, 'unknown');
    assert.equal(selectReceiptBaseline(records).seq, null);
  }
  assert.equal(selectReceiptBaseline([child('empty-fork', { isSeeded: true, inheritedEventCount: 0 })]).kind, 'none');
});

test('nested child distinguishes direct parent, root and ancestor-owned inherited receipts', () => {
  const root = header('root');
  const parent = child('parent', { parentSession: 'root', isSeeded: true, inheritedEventCount: 2 });
  const config = { parentHeaders: parents(root, parent) };
  const records = [child('nested', { parentSession: 'parent', delegationDepth: 2,
    isSeeded: true, inheritedEventCount: 3 }), message(0), message(1), message(2)];
  const identity = sessionIdentity(records, config);
  assert.equal(identity.directParentId, 'parent');
  assert.equal(identity.rootSessionId, 'root');
  assert.equal(identity.depth, 2);
  assert.equal(identity.relationshipKnown, true);
  assert.equal(selectReceiptBaseline(records, config).receiptSessionId, 'parent');
  const ancestorOnly = [records[0], message(0), { type: 'turn/end', seq: 1 }, { type: 'turn/end', seq: 2 }];
  assert.equal(selectReceiptBaseline(ancestorOnly, config).receiptSessionId, 'root');
  assert.equal(selectReceiptBaseline(ancestorOnly, { parentHeaders: parents(parent) }).receiptSessionId, null);
});

test('parent chains missing metadata, cycling or contradicting depth keep the root unknown', () => {
  const records = [child('leaf', { parentSession: 'p', delegationDepth: 2 })];
  for (const parentHeaders of [parents(), parents(child('p', { parentSession: 'leaf' })),
    parents(header('p')), parents(child('p', { parentSession: 'lost' }))]) {
    const identity = sessionIdentity(records, { parentHeaders });
    assert.equal(identity.role, 'sub');
    assert.equal(identity.directParentId, 'p');
    assert.equal(identity.rootSessionId, null);
    assert.equal(identity.relationshipKnown, false);
  }
});

test('activation generation is explicit and target-bound; cold history has none', () => {
  const records = [child('live')];
  const config = { parentHeaders: parents(header('parent')), runtimeIdentity: {
    local: true, targetSessionId: 'live', directParentId: 'parent', depth: 1, activationGeneration: 'run-2',
  } };
  assert.equal(sessionIdentity(records, config).activationGeneration, 'run-2');
  assert.equal(sessionIdentity(records).activationGeneration, null);
  assert.equal(sessionIdentity(records, { ...config,
    runtimeIdentity: { ...config.runtimeIdentity, targetSessionId: 'other' } }).activationGeneration, null);
  const external = sessionIdentity(records, { ...config,
    runtimeIdentity: { ...config.runtimeIdentity, local: false } });
  assert.equal(external.activationGeneration, null);
  assert.equal(external.relationshipKnown, false);
  const conflict = sessionIdentity(records, { ...config,
    runtimeIdentity: { ...config.runtimeIdentity, directParentId: 'wrong' } });
  assert.equal(conflict.directParentId, null);
  assert.equal(conflict.rootSessionId, null);
  assert.ok(conflict.unknownReasons.includes('parent-conflict'));
});

test('precollected ordered receipt seqs choose identical baselines without scanning the log', () => {
  const records = [child('cached', { isSeeded: true, inheritedEventCount: 1 }), message(0), attempt(1), message(2)];
  assert.deepEqual(selectReceiptBaseline(records, { receiptSeqs: [0, 2] }), selectReceiptBaseline(records));
  assert.equal(selectReceiptBaseline(records, { receiptSeqs: [] }).kind, 'none');
  assert.equal(selectReceiptBaseline(records, { receiptSeqs: 'bad' }).kind, 'unknown');
  assert.equal(selectReceiptBaseline(records, { receiptSeqs: [-1] }).kind, 'unknown');
  assert.equal(selectReceiptBaseline(records, { receiptSeqs: [null] }).kind, 'unknown');
});

test('independent concurrent children and later cold continuations do not share baselines or generations', () => {
  const first = [child('first'), message(0)];
  const second = [child('second')];
  const firstIdentity = sessionIdentity(first, { runtimeIdentity: {
    local: true, targetSessionId: 'first', activationGeneration: 'first-run', depth: 1,
  } });
  assert.equal(firstIdentity.activationGeneration, 'first-run');
  assert.equal(sessionIdentity(second).activationGeneration, null);
  assert.equal(selectReceiptBaseline(first).receiptSessionId, 'first');
  assert.equal(selectReceiptBaseline(second).kind, 'none');
  assert.equal(selectReceiptBaseline(structuredClone(first)).receiptSessionId, 'first');
  assert.equal(sessionIdentity(structuredClone(first)).activationGeneration, null);
  assert.equal(sessionIdentity([], { runtimeIdentity: {
    local: true, targetSessionId: null, activationGeneration: 'invalid',
  } }).activationGeneration, null);
});
