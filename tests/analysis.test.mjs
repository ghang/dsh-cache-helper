import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSession, compareRequests, inspectNextRequest } from '../src/analysis.mjs';
import { normalizeRequest, reconstructCalls } from '../src/history.mjs';
import { fixture, tool, usage } from './history-fixtures.mjs';

test('normal tail growth, including a large input, has no predicted or actual old-prefix loss', () => {
  const f = fixture();
  f.response(usage(100_000));
  f.next();
  f.user('new '.repeat(300_000));
  f.response(usage(900_000, 100_000));
  const calls = reconstructCalls(f.records());
  const risk = compareRequests(calls[0].request, calls[1].request, { previousPromptTokens: 100_000 });
  assert.equal(risk.lossTokens, 0);
  assert.equal(risk.significant, false);
  assert.deepEqual(risk.changes, []);
  assert.equal(analyzeSession(f.records()).warnings.length, 0);
});

test('tool removal is a large-prefix risk; later recovery retains the warning', () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  f.next(2, 1);
  f.header([f.tools[0]]);
  f.update([{ type: 'tool-removal', toolName: 'beta' }]);
  f.user('next');
  f.response(usage(101_000, 1000));
  const before = f.records();
  const calls = reconstructCalls(before);
  const risk = inspectNextRequest(before.slice(0, -1), calls[1].request);
  assert.ok(risk.lossTokens >= 50_000);
  assert.deepEqual(risk.changes.find(change => change.kind === 'tools').removed, ['beta']);
  f.next(2, 2);
  f.response(usage(1000, 102_000));
  const result = analyzeSession(f.records());
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].turn, 2);
  assert.equal(result.warnings[0].step, 1);
  assert.equal(result.warnings[0].recovered, true);
  assert.equal(result.latest.hitRate, 102_000 / 103_000);
  assert.ok(!JSON.stringify(result).includes('old old old'));
});

test('in-history system append preserves prefix; a replaced head does not', () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  f.next();
  f.system('new in-history prompt');
  f.user('continued');
  f.response();
  const calls = reconstructCalls(f.records());
  assert.equal(compareRequests(calls[0].request, calls[1].request, { previousPromptTokens: 100_100 }).lossTokens, 0);
  const changed = { ...calls[0].request, messages: calls[0].request.messages.map(message => message.role === 'system'
    ? { ...message, content: [{ type: 'text', text: 'changed at head' }] } : message) };
  assert.equal(compareRequests(calls[0].request, changed, { previousPromptTokens: 100_100 }).significant, true);
});

test('an unexplained actual old-prefix miss is described as uncertain upstream behavior', () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  f.next();
  f.response(usage(101_000, 100));
  const result = analyzeSession(f.records());
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].cause, 'upstream-unknown');
  assert.match(result.warnings[0].reason, /可能/);
  assert.equal(result.warnings[0].changes.length, 0);
});

test('route change invalidates the cache domain and requires a large baseline', () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  const request = reconstructCalls(f.records())[0].request;
  const risk = compareRequests(request, { ...request, provider: 'different' }, { previousPromptTokens: 100_100 });
  assert.equal(risk.lossRatio, 1);
  assert.equal(risk.lossTokens, 100_100);
  assert.equal(risk.changes[0].kind, 'route');
  assert.equal(compareRequests(request, { ...request, provider: 'different' }, { previousPromptTokens: 1000 }).significant, false);
});

test('cold start is normal and missing usage remains unknown in latest and cumulative', () => {
  const f = fixture();
  assert.equal(inspectNextRequest(f.records(), { model: 'deepseek-flash', messages: [] }), null);
  f.response({ inputTokens: 100, outputTokens: 10 });
  const result = analyzeSession(f.records());
  assert.equal(result.latest.hitRate, null);
  assert.equal(result.cumulative.hitRate, null);
  assert.equal(result.warnings.length, 0);
});

test('sampling and trace metadata do not affect model input cache comparison', () => {
  const f = fixture();
  f.response();
  const request = reconstructCalls(f.records())[0].request;
  const changed = { ...request, temperature: 0.9, signal: new AbortController().signal, traceId: 'new' };
  assert.equal(compareRequests(request, changed, { previousPromptTokens: 100_000 }).lossTokens, 0);
  assert.equal(normalizeRequest(request).fingerprint, normalizeRequest(changed).fingerprint);
});

test('cumulative rate uses summed token denominators and counts each settlement once', () => {
  const f = fixture();
  f.response(usage(100, 100));
  f.next();
  f.response(usage(100, 900));
  const result = analyzeSession(f.records());
  assert.equal(result.cumulative.inputTokens, 200);
  assert.equal(result.cumulative.cacheReadTokens, 1000);
  assert.equal(result.cumulative.hitRate, 1000 / 1200);
  assert.equal(result.cumulative.calls, 2);
});

test('cancelled unsent attempts do not replace the most recent actual usage', () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  f.next();
  f.session.append('assistant/attempt', { turn: 1, step: 2, stream: [] });
  const result = analyzeSession(f.records());
  assert.equal(result.latest.cacheReadTokens, 100_000);
  assert.equal(result.cumulative.calls, 1);
});

test('unknown cache counters do not appear as zero cumulative cache tokens', () => {
  const f = fixture();
  f.response({ inputTokens: 100, outputTokens: 10 });
  const result = analyzeSession(f.records());
  assert.equal(result.cumulative.cacheReadTokens, null);
  assert.equal(result.cumulative.cacheWriteTokens, null);
});

test('new deferred tool activates after old history without predicting a broken prefix', () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  f.next();
  const event = f.header([...f.tools, tool('new-late-tool')]);
  f.update([{ type: 'tool-addition', toolName: 'new-late-tool' }], event.seq);
  f.user('continue with a new tool');
  f.response(usage(1000, 100_100));
  const calls = reconstructCalls(f.records());
  const risk = compareRequests(calls[0].request, calls[1].request, { previousPromptTokens: 100_100 });
  assert.equal(risk.lossTokens, 0);
  assert.equal(risk.significant, false);
  assert.equal(risk.changes.find(change => change.kind === 'tools').preservesPrefix, true);
  assert.equal(analyzeSession(f.records()).warnings.length, 0);
});

test('unreconstructable receipt with no trustworthy size stays fail-closed as unknown', () => {
  const f = fixture({ text: 'small' });
  const event = f.response({ inputTokens: 100, outputTokens: 10 });
  const corrupted = f.records().filter(record => record.type !== 'request/header');
  // Removing a record also breaks seq continuity: no reconstructed input or
  // complete prompt count exists, so the check must never silently pass.
  const risk = inspectNextRequest(corrupted, { provider: 'deepseek-test', model: 'deepseek-flash', messages: [] });
  assert.equal(risk.unknown, true);
  assert.equal(risk.baselineSeq, event.seq);
});

test('unknown projection with a measured small prompt may stay below the gate threshold', () => {
  const f = fixture({ text: 'small' });
  f.response(usage(100, 10));
  const corrupted = f.records().filter(record => record.type !== 'request/header');
  assert.equal(inspectNextRequest(corrupted, { provider: 'deepseek-test', model: 'deepseek-flash', messages: [] }), null);
});

test('turn footers use only that turn last actual call, never step or session sums', () => {
  const f = fixture({ text: 'small' });
  f.response(usage(100, 100));
  f.next(1, 2);
  f.response(usage(30, 970));
  f.next(2, 1);
  f.response(usage(980, 20));
  f.next(2, 2);
  f.response(usage(800, 200));
  f.next(3, 1);
  f.response(usage(1, 999));
  const result = analyzeSession(f.records());
  assert.deepEqual(result.turns.map(entry => ({ turn: entry.turn, step: entry.step,
    read: entry.latest.cacheReadTokens, rate: entry.latest.hitRate })), [
    { turn: 1, step: 2, read: 970, rate: 0.97 },
    { turn: 2, step: 2, read: 200, rate: 0.2 },
    { turn: 3, step: 1, read: 999, rate: 0.999 },
  ]);
  assert.equal(result.turns[0].latest, result.calls[1].usage);
  assert.equal(result.turns[1].latest, result.calls[3].usage);
  assert.equal(result.turns[2].latest, result.latest);
  assert.notEqual(result.turns[0].latest.cacheReadTokens, result.cumulative.cacheReadTokens);
  assert.ok(result.turns.every(entry => !Object.hasOwn(entry, 'request')));
});

test('unknown last usage stays unknown in its turn instead of borrowing an earlier step or turn', () => {
  const f = fixture({ text: 'small' });
  f.response(usage(100, 900));
  f.next(2, 1);
  f.response(usage(1, 999));
  f.next(2, 2);
  const last = f.response({ inputTokens: 90, outputTokens: 10 });
  const result = analyzeSession(f.records());
  assert.equal(result.turns[0].latest.hitRate, 0.9);
  assert.equal(result.turns[1].seq, last.seq);
  assert.equal(result.turns[1].step, 2);
  assert.equal(result.turns[1].latest.inputTokens, 90);
  assert.equal(result.turns[1].latest.cacheReadTokens, null);
  assert.equal(result.turns[1].latest.hitRate, null);
});

test('empty unsent attempts do not override turn usage or borrow the previous turn', () => {
  const f = fixture({ text: 'small' });
  const actual = f.response(usage(100, 900));
  f.next(1, 2);
  f.session.append('assistant/attempt', { turn: 1, step: 2, stream: [] });
  f.next(2, 1);
  f.session.append('assistant/attempt', { turn: 2, step: 1, stream: [] });
  const result = analyzeSession(f.records());
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].seq, actual.seq);
  assert.equal(result.turns[0].latest.hitRate, 0.9);
  assert.equal(result.turns.find(entry => entry.turn === 2), undefined);
});

test('nonempty failed final attempt with missing usage leaves its turn unknown', () => {
  const f = fixture({ text: 'small' });
  f.response(usage(100, 900));
  f.next(1, 2);
  const last = f.session.append('assistant/attempt', { turn: 1, step: 2, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'finish', reason: 'error' } },
  ] });
  const result = analyzeSession(f.records());
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].seq, last.seq);
  assert.equal(result.turns[0].latest.reported, false);
  assert.equal(result.turns[0].latest.cacheReadTokens, null);
  assert.equal(result.turns[0].latest.hitRate, null);
});
