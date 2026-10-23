import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructCalls, reconstructCall, normalizeRequest, normalizeUsage, sessionAccounting } from '../src/history.mjs';
import { fixture, tool, usage } from './history-fixtures.mjs';

test('reconstruction includes assembled system, user and header after step/start; excludes current output', () => {
  const f = fixture();
  const first = f.response(usage(100_000));
  f.next();
  f.user('next input');
  f.response();
  const calls = reconstructCalls(f.records());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.messages.length, 2);
  assert.equal(calls[0].request.messages[0].role, 'system');
  assert.equal(calls[0].request.messages[1].role, 'user');
  assert.equal(calls[1].request.messages.length, 4);
  assert.deepEqual(reconstructCall(f.records(), first.seq).request, calls[0].request);
  assert.equal(calls[1].request.messages.at(-1).content[0].text, 'next input');
});

test('addition-only tool history preserves declaration order and drops removed definitions', () => {
  const f = fixture();
  f.response();
  f.next();
  const gamma = tool('gamma');
  const added = f.header([...f.tools, gamma]);
  f.update([{ type: 'tool-addition', toolName: 'gamma' }], added.seq);
  f.user('tools added');
  f.response();
  f.next();
  f.header([f.tools[0], gamma]);
  f.update([{ type: 'tool-removal', toolName: 'beta' }]);
  f.user('tools removed');
  f.response();
  f.next();
  const restored = f.header(f.tools);
  f.update([{ type: 'tool-addition', toolName: 'beta' }], restored.seq);
  f.update([{ type: 'tool-removal', toolName: 'gamma' }]);
  f.user('beta restored');
  f.response();
  const inputs = reconstructCalls(f.records()).map(call => normalizeRequest(call.request));
  assert.deepEqual(inputs[1].tools.map(tool => tool.name), ['alpha', 'beta', 'gamma']);
  assert.equal(inputs[1].tools[2].defer_loading, true);
  assert.deepEqual(inputs[2].tools.map(tool => tool.name), ['alpha', 'gamma']);
  assert.deepEqual(inputs[3].tools.map(tool => tool.name), ['alpha', 'beta']);
  assert.ok(inputs[2].messages.every(message => message.content.every(block => block.type !== 'tool_removal')));
});

test('surface replacements are applied at the right historical boundary', () => {
  const f = fixture();
  const original = f.session.snapshotEvents().find(event => event.type === 'system/message');
  f.response();
  f.next();
  f.system('replacement system', { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [original.seq] });
  f.response();
  const calls = reconstructCalls(f.records());
  assert.equal(normalizeRequest(calls[0].request).system, 'first system');
  assert.equal(normalizeRequest(calls[1].request).system, 'replacement system');
});

test('failed attempt reads last compact usage once and does not manufacture output history', () => {
  const f = fixture();
  f.session.append('assistant/attempt', { turn: 1, step: 1, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: usage(1000, 100) } },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage: usage(1200, 200) } },
  ] });
  f.response(usage(20, 1400));
  const calls = reconstructCalls(f.records());
  assert.equal(calls[0].usage.inputTokens, 1200);
  assert.deepEqual(calls[0].request.messages, calls[1].request.messages);
});

test('cache fields that are absent remain unknown and never become a false zero rate', () => {
  const result = normalizeUsage({ inputTokens: 100, outputTokens: 10 });
  assert.equal(result.cacheReadTokens, null);
  assert.equal(result.cacheWriteTokens, null);
  assert.equal(result.hitRate, null);
  assert.equal(normalizeUsage(usage(10, 90)).hitRate, 0.9);
});

test('unsupported multimodal input is explicit and does not claim full coverage', () => {
  const f = fixture();
  f.response();
  const request = reconstructCalls(f.records())[0].request;
  const copy = { ...request, messages: [...request.messages, { role: 'user', id: 'image', source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'synthetic' } }] }] };
  const result = normalizeRequest(copy);
  assert.equal(result.comparable, false);
  assert.match(result.unknown, /image/);
});

test('auxiliary accounting uses recorded summary usage and keeps lifecycle duration distinct from model time', () => {
  const records = [{ type: 'session', id: 'aux', isSeeded: false },
    { type: 'compaction/start', seq: 0, time: 100, data: { compactionId: 'one', turn: null } },
    { type: 'compaction/summary', seq: 1, time: 150, data: { compactionId: 'one',
      provider: 'summary-provider', model: 'summary-model', llmStreamCall: true,
      usage: usage(10, 90), summary: [{ type: 'text', text: 'private summary text' }],
      rawOutput: [{ type: 'text', text: 'private raw output' }] } },
    { type: 'compaction/end', seq: 2, time: 200, data: { compactionId: 'one', turn: null } },
  ];
  const result = sessionAccounting(records);
  assert.equal(result.auxiliaryCalls.length, 1);
  assert.equal(result.auxiliaryCalls[0].usage.cacheReadTokens, 90);
  assert.equal(result.auxiliaryCalls[0].model, 'summary-model');
  assert.equal(result.auxiliaryCalls[0].at, 150);
  assert.equal(result.auxiliaryCalls[0].atSource, 'session-summary-settlement');
  assert.equal(result.auxiliaryCalls[0].operationElapsedMs, 100);
  assert.equal(result.auxiliaryCalls[0].modelDurationMs, null);
  assert.equal(result.auxiliaryCalls[0].durationSource, 'compaction-lifecycle');
  assert.equal(result.auxiliaryCalls[0].outcome, 'completed');
  assert.equal(result.auxiliaryCalls[0].operationOutcome, 'completed');
  assert.ok(!JSON.stringify(result).includes('private summary'));
  assert.ok(!JSON.stringify(result).includes('private raw'));
});

test('unmarked template summaries and failed summaries never manufacture a zero-cost model receipt', () => {
  const records = [{ type: 'session', id: 'aux', isSeeded: false },
    { type: 'compaction/start', seq: 0, time: 100, data: { compactionId: 'template', turn: null } },
    { type: 'compaction/summary', seq: 1, time: 150, data: { compactionId: 'template', provider: 'template', model: 'none' } },
    { type: 'compaction/end', seq: 2, time: 200, data: { compactionId: 'template', turn: null } },
    { type: 'compaction/start', seq: 3, time: 300, data: { compactionId: 'failed', turn: null } },
    { type: 'compaction/end', seq: 4, time: 400, data: { compactionId: 'failed', turn: null, error: 'failed' } },
    { type: 'compaction/summary', seq: 5, time: 450, data: { compactionId: 'known-call', provider: 'one', model: 'two', llmStreamCall: true } },
  ];
  const result = sessionAccounting(records);
  assert.equal(result.auxiliaryCalls.length, 1);
  assert.equal(result.auxiliaryCalls[0].usage.reported, false);
  assert.equal(result.auxiliaryCalls[0].usage.cacheReadTokens, null);
  assert.equal(result.auxiliaryCoverage.unrecorded.length, 2);
  assert.equal(result.auxiliaryCoverage.complete, false);
});

test('seeded sessions require their exact inherited cutoff and empty attempts retain dispatch uncertainty', () => {
  const records = [{ type: 'session', id: 'child', isSeeded: true, origin: 'subagent' },
    { type: 'assistant/attempt', seq: 0, time: 1, data: { turn: 1, step: 1, stream: [] } },
  ];
  const unknown = sessionAccounting(records);
  assert.equal(unknown.role, 'sub');
  assert.equal(unknown.ownership.known, false);
  assert.equal(unknown.emptyAttempts[0].inherited, null);
  assert.equal(unknown.emptyAttempts[0].dispatch, 'unknown');
  const inherited = sessionAccounting([{ ...records[0], inheritedEventCount: 1 }, records[1]]);
  assert.equal(inherited.emptyAttempts[0].inherited, true);
  for (const cutoff of [-1, 99]) {
    assert.equal(sessionAccounting([{ ...records[0], inheritedEventCount: cutoff }, records[1]]).ownership.known, false);
  }
});
