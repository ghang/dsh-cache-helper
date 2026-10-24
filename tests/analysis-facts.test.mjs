import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, usage } from './history-fixtures.mjs';

const testedModule = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const {
  analyzeSession, extractSessionFacts, extractSessionFactsAsync,
  deriveSessionAnalysis, deriveSessionAnalysisAsync, ANALYZER_VERSION, FACTS_SCHEMA_VERSION,
} = await import(testedModule('analysis.mjs'));
const { latestReceiptSeq } = await import(testedModule('history.mjs'));

function scenario() {
  const f = fixture({ text: 'private-prompt-canary '.repeat(4000) });
  f.response(usage(100, 100_000));
  f.next(); f.header([f.tools[0]]); f.user('continue after registry change');
  f.response(usage(101_000, 100));
  f.next(); f.user('ordinary continuation'); f.response(usage(100, 110_000));
  return f;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('an explicit null-usage failure cannot replace the effective live or historical baseline', () => {
  const f = fixture({ text: 'synthetic input' });
  const own = f.response(usage(100, 100_000));
  f.next();
  f.session.append('assistant/attempt', { turn: 1, step: 2, stream: [], usage: null });
  assert.equal(latestReceiptSeq(f.records()), own.seq);
  const facts = extractSessionFacts(f.records());
  assert.equal(facts.baseline.seq, own.seq);
  assert.equal(facts.baseline.kind, 'own');
});

test('neutral facts can derive different warning policy without replay or normalization', () => {
  const f = scenario();
  let normalizations = 0;
  const facts = freeze(extractSessionFacts(f.records(), { onNormalize() { normalizations++; } }));
  assert.equal(facts.schema, FACTS_SCHEMA_VERSION);
  assert.equal(facts.analyzerVersion, ANALYZER_VERSION);
  assert.equal(normalizations, 3);
  const original = JSON.stringify(facts);
  const strict = deriveSessionAnalysis(facts);
  const loose = deriveSessionAnalysis(facts, { minLostTokens: 200_000 });
  assert.equal(strict.warnings.length, 1);
  assert.equal(strict.warnings[0].cause, 'observed-prefix-change');
  assert.equal(strict.warnings[0].recovered, true);
  assert.equal(loose.warnings.length, 0);
  assert.deepEqual(loose.cumulative, strict.cumulative);
  assert.deepEqual(loose.latest, strict.latest);
  assert.equal(normalizations, 3, 'policy-only derivation must not replay old inputs');
  assert.equal(JSON.stringify(facts), original, 'recovery must not mutate reusable neutral facts');
  assert.deepEqual(facts, extractSessionFacts(f.records(), { minLostTokens: 200_000, minLossRatio: 0.9 }));
});

test('facts contain no prompt, response, tool definitions, streams or replay state', () => {
  const f = fixture({ text: 'PRIVATE_PROMPT_CANARY', tools: [{ name: 'tool-name',
    description: 'PRIVATE_TOOL_DEFINITION_CANARY', parameters: { type: 'object',
      properties: { secret: { description: 'PRIVATE_SCHEMA_CANARY', type: 'string' } } } }] });
  f.response(usage(100, 100_000));
  f.next();
  f.session.append('assistant/message', { turn: 1, step: 2, usage: usage(101_000, 100),
    message: { role: 'assistant', id: 'synthetic-response', content: [{ type: 'text', text: 'PRIVATE_RESPONSE_CANARY' }],
      source: { kind: 'model', provider: 'deepseek-test', model: 'deepseek-flash',
        replayState: { privateCanary: 'PRIVATE_REPLAY_CANARY' } } },
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'text', text: 'PRIVATE_STREAM_CANARY' } }],
  }, { surfaceOp: 'append' });
  const facts = extractSessionFacts(f.records());
  const encoded = JSON.stringify(facts);
  for (const secret of ['PRIVATE_PROMPT_CANARY', 'PRIVATE_TOOL_DEFINITION_CANARY', 'PRIVATE_SCHEMA_CANARY',
    'PRIVATE_RESPONSE_CANARY', 'PRIVATE_REPLAY_CANARY', 'PRIVATE_STREAM_CANARY']) {
    assert.equal(encoded.includes(secret), false, `neutral facts retained ${secret}`);
  }
  const forbidden = new Set(['request', 'messages', 'system', 'tools', 'toolHistory', 'stream', 'replayState']);
  function check(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.equal(forbidden.has(key), false, key); check(child); }
  }
  check(facts);
});

test('synchronous and sliced execution preserve usage, ownership, warnings, unknowns and auxiliary facts', async () => {
  const f = scenario();
  f.session.append('assistant/attempt', { turn: 1, step: 4, stream: [] });
  f.session.append('compaction/start', { compactionId: 'local-failure', turn: 1 });
  f.session.append('compaction/end', { compactionId: 'local-failure', turn: 1, error: 'synthetic' });
  f.next(2, 1); f.response({ inputTokens: 50, outputTokens: 5 });
  const records = f.records();
  records[0] = { ...records[0], origin: 'subagent', isSeeded: true,
    inheritedEventCount: records.find(record => record.type === 'assistant/message').seq + 1 };
  let slices = 0;
  const options = { sliceEvents: 2, scheduler: async () => { slices++; await immediate(); } };
  const facts = await extractSessionFactsAsync(records, {}, options);
  assert.deepEqual(facts, extractSessionFacts(records));
  const result = await deriveSessionAnalysisAsync(facts, {}, options);
  assert.deepEqual(result, analyzeSession(records));
  assert.equal(result.role, 'sub');
  assert.equal(result.calls[0].inherited, true);
  assert.equal(result.calls[1].inherited, false);
  assert.equal(result.latest.cacheReadTokens, null);
  assert.equal(result.cumulative.cacheReadTokens, null);
  assert.equal(result.auxiliaryCoverage.unrecorded.length, 1);
  assert.equal(result.emptyAttempts.length, 1);
  assert.ok(slices > 10);
});

test('long logs with no receipts yield to the event loop and cancel before normalization', async () => {
  const f = fixture({ text: 'small' });
  for (let index = 0; index < 10_000; index++) f.session.append('synthetic/trace', { index });
  const controller = new AbortController();
  let normalized = 0;
  let turnRan = false;
  const work = extractSessionFactsAsync(f.records(), { onNormalize() { normalized++; } }, {
    signal: controller.signal, sliceEvents: 16,
  });
  setImmediate(() => { turnRan = true; controller.abort(); });
  await assert.rejects(work, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(turnRan, true);
  assert.equal(normalized, 0);
});

test('cancellation interrupts sliced request analysis after work has started', async () => {
  const f = fixture({ text: 'start '.repeat(1000) });
  for (let index = 0; index < 80; index++) {
    if (index) { f.next(); f.user('append '.repeat(100)); }
    f.response(usage(100, 100_000 + index));
  }
  const controller = new AbortController();
  let normalized = 0;
  let observed = 0;
  const work = extractSessionFactsAsync(f.records(), {
    onNormalize() { normalized++; if (normalized === 2) setImmediate(() => controller.abort()); },
  }, { signal: controller.signal, sliceEvents: 8,
    scheduler: async () => { observed++; await immediate(); } });
  await assert.rejects(work, { name: 'AbortError' });
  assert.ok(normalized >= 2 && normalized < 80, String(normalized));
  assert.ok(observed > 0);
});

test('already aborted work does not run normalization, and policy derivation is cancellable', async () => {
  const f = scenario();
  const controller = new AbortController();
  controller.abort();
  let normalized = 0;
  await assert.rejects(extractSessionFactsAsync(f.records(), { onNormalize() { normalized++; } }, {
    signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(normalized, 0);
  const facts = extractSessionFacts(f.records());
  const derivedAbort = new AbortController();
  let slices = 0;
  await assert.rejects(deriveSessionAnalysisAsync(facts, {}, { sliceEvents: 1,
    signal: derivedAbort.signal, scheduler: async () => { slices++; derivedAbort.abort(); } }),
  { name: 'AbortError' });
  assert.equal(slices, 1);
  assert.deepEqual(deriveSessionAnalysis(facts), analyzeSession(f.records()));
});

test('unknown projection errors do not retain arbitrary private exception content', () => {
  const projection = { type: 'image/offload', project() { throw new Error('PRIVATE_EXCEPTION_PROMPT_CANARY'); } };
  const f = fixture({ text: 'small' });
  f.response(usage(100, 100_000));
  const records = f.records();
  const last = records.pop();
  records.push({ type: 'image/offload', seq: last.seq, time: last.time, data: {} },
    { ...last, seq: last.seq + 1 });
  const facts = extractSessionFacts(records, { messageProjections: [projection] });
  assert.equal(facts.calls.length, 1);
  assert.equal(JSON.stringify(facts).includes('PRIVATE_EXCEPTION_PROMPT_CANARY'), false);
  assert.ok(facts.calls[0].unknown);
});
