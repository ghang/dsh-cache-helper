import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRuntime } from '../scripts/verify-runtime.mjs';
import { createFakeUpstream } from './fake-upstream.mjs';

const testedModule = file => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', file)).href
  : new URL(`../src/${file}`, import.meta.url).href;
const { OperationController } = await import(testedModule('operations.mjs'));
const { GateController } = await import(testedModule('gate.mjs'));
const { analyzeSession } = await import(testedModule('analysis.mjs'));
const { aggregateStatistics } = await import(testedModule('statistics.mjs'));
const modules = await loadRuntime();
const { default: TokenMeter } = await import('@deepseek-ai/dsh-token-meter');
const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
const JsonlSessionPersistence = await import('@deepseek-ai/dsh-session-persistence-jsonl');
const { Context } = modules['@deepseek-ai/cordis'];
const { DeepSeekAdapter, resolveAdapterOptions } = modules['@deepseek-ai/dsh-llm-deepseek'];
const { createUserMessage, isAgentLoopRequest } = modules['@deepseek-ai/dsh-llm'];
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const TERMINAL = new Set(['completed', 'noop', 'partial', 'failed', 'cancelled', 'interrupted']);

async function eventually(read, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await delay(5);
  }
  throw new Error('Synthetic operation did not settle in its test window');
}

async function harness(t, { replies = [], statePath, persistState = false, compaction = true, waitTimeoutMs = 1000,
  durable = true, compactionEngine = BasicCompactionEngine } = {}) {
  const upstream = await createFakeUpstream({ script: [
    { text: 'Synthetic first answer' },
    { text: 'Synthetic second answer' },
    ...replies,
  ] });
  const ctx = new Context();
  const gate = new GateController();
  const sessionRoot = durable ? await mkdtemp(join(tmpdir(), 'cache-helper-durable-sessions-')) : null;
  let operations;
  t.after(async () => {
    await operations?.dispose();
    gate.dispose();
    await ctx.fiber.dispose();
    await upstream.close();
    if (sessionRoot) await rm(sessionRoot, { recursive: true, force: true });
  });
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection']) await ctx.plugin(modules[`@deepseek-ai/${name}`].default);
  await ctx.plugin(modules['@deepseek-ai/dsh-system-prompt'].default, { personaPrefix: 'Synthetic compaction fixture.' });
  for (const name of ['dsh-tools', 'dsh-agent']) await ctx.plugin(modules[`@deepseek-ai/${name}`].default);
  if (sessionRoot) await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' });
  await ctx.plugin(modules['@deepseek-ai/dsh-agent-loop'].default, { agents: [] });
  await ctx.plugin(TokenMeter);
  if (compaction) await ctx.plugin(compactionEngine, { auto: false, compactionRetries: 0, maxTokens: 2048 });
  ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: upstream.url, retryPolicy: { mode: 'normal', maxRetries: 0 } }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'synthetic-key-only' } }),
    resolveUserId: () => 'cache-helper-operations-synthetic',
    resolveAttachments: () => undefined,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  }));
  const source = await ctx.agentLoop.create('operation-source', { provider: 'deepseek-official', model: 'deepseek-flash' });
  source.followup(user('PRIVATE_SYNTHETIC_HISTORY '.repeat(300)));
  await source.whenIdle();
  source.followup(user('Second synthetic user turn.'));
  await source.whenIdle();
  operations = new OperationController(ctx, { gate, persistState, statePath, waitTimeoutMs });
  await operations.init();
  const finished = id => eventually(() => {
    const result = operations.get(id);
    return TERMINAL.has(result.state) ? result : null;
  });
  return { ctx, gate, upstream, source, operations, finished, sessionRoot };
}

test('native fork + BasicCompactionEngine + DeepSeek HTTP preserve source, route and zero automatic continuation', async t => {
  const h = await harness(t, { replies: [{ text: 'A short synthetic checkpoint.' }] });
  const original = h.source.session.snapshotEvents();
  const preview = h.operations.preview(h.source.id);
  assert.equal(preview.available, true);
  assert.equal(h.operations.preview(h.source.id).id, preview.id);
  const job = h.operations.start(preview);
  assert.equal(h.operations.start(preview).id, job.id);
  const result = await h.finished(job.id);
  assert.equal(result.state, 'completed', JSON.stringify(result.error));
  assert.equal(result.branchDurable, true);
  assert.equal(result.resultDurable, true);
  assert.equal(result.manualContinue, true);
  assert.equal(result.observation, 'pending');
  const child = h.ctx.agents.get(result.branchId);
  assert.ok(child);
  assert.equal(child.session.header.parentSession, h.source.id);
  assert.deepEqual(child.options, preview.route);
  assert.deepEqual(h.source.session.snapshotEvents(), original);
  assert.ok(result.compaction.summarySeq > child.session.inheritedEventCount);
  assert.equal(result.summaryCalls.length, 1);
  assert.equal(result.summaryCalls[0].provider, 'deepseek-official');
  assert.equal(result.summaryCalls[0].model, 'deepseek-flash');
  assert.equal(result.summaryCalls[0].usage.cacheReadTokens, 100000);
  assert.equal(result.summaryCalls[0].usageRecorded, true);
  assert.ok(result.summaryCalls[0].durationMs >= 0);
  assert.equal(result.summaryCalls[0].compactionId, result.compaction.id);
  assert.equal(result.summaryCalls[0].atSource, 'llm-stream-start');
  assert.equal(result.summaryCalls[0].llmStreamCall, true);
  assert.ok(result.summaryCalls[0].settledAt >= result.summaryCalls[0].at);
  assert.equal(result.summaryCalls[0].settledAtSource, 'session-summary-settlement');
  assert.equal(child.status, 'idle');
  assert.equal(child.inbox.nextTurn.length + child.inbox.nextStep.length, 0);
  assert.equal(child.session.snapshotEvents().filter(e => e.type === 'turn/start' && e.seq >= child.session.inheritedEventCount).length, 0);
  await delay(50);
  assert.equal(h.upstream.requests.length, 3);
  assert.equal(h.operations.preview(h.source.id).id, result.id, 'the same source cannot accidentally create a second branch');
});

test('real JSONL storage reopens the branch, summary and route after the original runtime is disposed', async t => {
  const h = await harness(t, { replies: [{ text: 'A durable synthetic checkpoint.' }] });
  const original = h.source.session.snapshotEvents();
  const preview = h.operations.preview(h.source.id);
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'completed');
  const child = h.ctx.agents.get(result.branchId);
  const branchEvents = child.session.snapshotEvents();
  const inheritedEventCount = child.session.inheritedEventCount;
  await h.operations.dispose();
  await h.ctx.fiber.dispose();
  const reopened = new Context();
  t.after(() => reopened.fiber.dispose());
  await reopened.plugin(modules['@deepseek-ai/dsh-session'].default);
  await reopened.plugin(JsonlSessionPersistence, { root: h.sessionRoot, compression: 'none' });
  for (const [id, expected] of [[h.source.id, original], [result.branchId, branchEvents]]) {
    const reader = await reopened.sessionPersistence.open(id, 'read');
    try {
      const stored = (await reader.read()).events;
      assert.deepEqual(stored, expected);
      if (id === result.branchId) {
        assert.equal(reader.header.parentSession, h.source.id);
        assert.equal(reader.inheritedEventCount, inheritedEventCount);
        assert.ok(stored.some(event => event.type === 'compaction/summary'
          && event.data.compactionId === result.compaction.id));
        const route = stored.findLast(event => event.type === 'request/header').data.header.config;
        for (const [key, value] of Object.entries(preview.route)) assert.deepEqual(route[key], value);
      }
    } finally { await reader.close(); }
  }
});

test('a host without durable session storage cannot offer or dispatch a paid compaction', async t => {
  const h = await harness(t, { durable: false });
  const original = h.source.session.snapshotEvents();
  const preview = h.operations.preview(h.source.id);
  assert.equal(preview.available, false);
  assert.equal(preview.id, null);
  assert.match(preview.reason, /持久化/);
  assert.deepEqual(h.source.session.snapshotEvents(), original);
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(h.upstream.requests.length, 2);
});

test('a false host flush leaves a visible partial branch and prevents the summary request', async t => {
  const h = await harness(t);
  const original = h.source.session.snapshotEvents();
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  h.ctx.sessions.flush = async session => session.header.parentSession === h.source.id ? false : flush(session);
  const preview = h.operations.preview(h.source.id);
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'persistence');
  assert.equal(result.branchCreated, true);
  assert.equal(result.branchDurable, false);
  assert.equal(result.resultDurable, false);
  assert.equal(result.summaryCalls.length, 0);
  assert.equal(h.upstream.requests.length, 2);
  assert.deepEqual(h.source.session.snapshotEvents(), original);
});

test('a final branch flush failure exposes partial rather than completed and preserves the attempted summary', async t => {
  const h = await harness(t, { replies: [{ text: 'A checkpoint whose final flush is refused.' }] });
  const original = h.source.session.snapshotEvents();
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  let refuseFinal = false;
  h.ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === h.source.id && event.type === 'compaction/summary') refuseFinal = true;
  });
  h.ctx.sessions.flush = async session => session.header.parentSession === h.source.id && refuseFinal ? false : flush(session);
  const preview = h.operations.preview(h.source.id);
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'partial');
  assert.equal(result.error.code, 'persistence');
  assert.equal(result.branchCreated, true);
  assert.equal(result.branchDurable, true);
  assert.equal(result.resultDurable, false);
  assert.ok(result.compaction);
  assert.equal(result.summaryCalls.length, 1);
  assert.equal(h.upstream.requests.length, 3);
  assert.deepEqual(h.source.session.snapshotEvents(), original);
});

test('cancellation accepted during the final flush preserves the durable summary without reporting completion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-final-flush-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'operations.json');
  const h = await harness(t, { statePath, persistState: true,
    replies: [{ text: 'A durable summary completed before the user cancelled.' }] });
  const original = h.source.session.snapshotEvents();
  const release = Promise.withResolvers();
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  let summaryFlushes = 0;
  let waitingForFinalFlush = false;
  h.ctx.sessions.flush = async session => {
    if (session.header.parentSession === h.source.id
      && session.snapshotEvents().some(event => event.type === 'compaction/summary')
      && ++summaryFlushes === 2) {
      waitingForFinalFlush = true;
      await release.promise;
    }
    return flush(session);
  };
  try {
    const preview = h.operations.preview(h.source.id);
    const job = h.operations.start(preview);
    await eventually(() => waitingForFinalFlush);
    assert.equal(h.operations.get(job.id).state, 'compacting');
    assert.equal(h.operations.cancel(job).cancelRequested, true);
    release.resolve();
    const result = await h.finished(job.id);
    assert.equal(result.state, 'cancelled');
    assert.equal(result.error.code, 'cancelled');
    assert.equal(result.branchDurable, true);
    assert.equal(result.resultDurable, true);
    assert.ok(result.compaction);
    assert.equal(result.summaryCalls.length, 1);
    assert.equal(result.summaryCalls[0].outcome, 'completed');
    assert.equal(result.summaryCalls[0].usageRecorded, true);
    assert.equal(result.summaryCalls[0].usage.cacheReadTokens, 100000);
    assert.deepEqual(h.source.session.snapshotEvents(), original);
    const child = h.ctx.agents.get(result.branchId);
    const reader = await h.ctx.sessionPersistence.open(result.branchId, 'read');
    try {
      assert.deepEqual((await reader.read()).events, child.session.snapshotEvents());
    } finally { await reader.close(); }
    const receipt = JSON.parse(await readFile(statePath, 'utf8')).jobs.find(item => item.id === job.id);
    assert.equal(receipt.state, 'cancelled');
    assert.equal(receipt.resultDurable, true);
    assert.equal(h.operations.start(preview).state, 'cancelled');
    assert.equal(h.operations.preview(h.source.id).id, job.id);
    assert.equal(h.upstream.requests.length, 3);
  } finally { release.resolve(); }
});

test('the first public terminal state is partial when a delayed final receipt rename fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-final-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'operations.json');
  const h = await harness(t, { statePath, persistState: true,
    replies: [{ text: 'A summary awaiting its final durable receipt.' }] });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === statePath) {
      const stored = JSON.parse(await readFile(from, 'utf8'));
      if (stored.jobs.some(job => job.state === 'completed')) {
        entered.resolve();
        await release.promise;
        throw Object.assign(new Error('Synthetic final receipt rename failure'), { code: 'EIO' });
      }
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const preview = h.operations.preview(h.source.id);
    const job = h.operations.start(preview);
    await entered.promise;
    assert.equal(h.operations.get(job.id).state, 'finalizing');
    assert.equal(h.operations.forSession(h.source.id).state, 'finalizing');
    assert.equal(h.operations.list()[0].state, 'finalizing');
    assert.equal(h.operations.preview(h.source.id).state, 'finalizing');
    assert.equal(h.operations.start(job).state, 'finalizing');
    assert.equal(h.operations.cancel(job).state, 'finalizing');
    release.resolve();
    const terminal = await h.finished(job.id);
    assert.equal(terminal.state, 'partial');
    assert.equal(terminal.error.code, 'persistence');
    assert.equal(terminal.branchDurable, true);
    assert.equal(terminal.resultDurable, true);
    assert.equal(h.upstream.requests.length, 3);
  } finally {
    release.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('summary settlement fallback records its actual event time without inventing an invocation time', async t => {
  class LocalSummaryEngine extends BasicCompactionEngine {
    async summarize() {
      return { summary: [{ type: 'text', text: 'A locally supplied synthetic checkpoint.' }],
        provider: 'synthetic-summary-provider', model: 'synthetic-summary-model' };
    }
  }
  const h = await harness(t, { compactionEngine: LocalSummaryEngine });
  const result = await h.finished(h.operations.start(h.operations.preview(h.source.id)).id);
  assert.equal(result.state, 'completed', JSON.stringify(result.error));
  const child = h.ctx.agents.get(result.branchId);
  const summary = child.session.snapshotEvents().findLast(event => event.type === 'compaction/summary');
  assert.equal(result.summaryCalls.length, 1);
  assert.equal(result.summaryCalls[0].at, summary.time);
  assert.equal(result.summaryCalls[0].settledAt, summary.time);
  assert.equal(result.summaryCalls[0].atSource, 'session-summary-settlement');
  assert.equal(result.summaryCalls[0].compactionId, summary.data.compactionId);
  assert.equal(result.summaryCalls[0].llmStreamCall, false);
  assert.equal(result.summaryCalls[0].usageRecorded, false);
  const metrics = analyzeSession([{ type: 'session', ...child.session.header,
    inheritedEventCount: child.session.inheritedEventCount }, ...child.session.snapshotEvents()]);
  assert.equal(metrics.auxiliaryCalls.length, 0);
  const statistics = aggregateStatistics([metrics], { period: 'all', operations: [result] });
  assert.equal(statistics.groups.auxiliary.calls, 0, 'A template summary does not prove a model call');
  assert.equal(statistics.totals.unrecordedAuxiliaryOperations, 1, 'Unconfirmed usage must remain a coverage gap');
  assert.equal(statistics.coverage.operationSummaryRecordsUnconfirmed, 1);
  assert.equal(h.upstream.requests.length, 2);
});

test('operation previews freeze all five policy fields and their event limit until explicitly refreshed', async t => {
  const h = await harness(t, { replies: [{ text: 'A checkpoint using the approved policy snapshot.' }] });
  let current = { version: 1, minLostTokens: 50000, minLossRatio: 0.2, dashboardLimit: 50,
    maxEvents: 200000, maxCachedSessions: 64 };
  const operations = new OperationController(h.ctx, { gate: h.gate, persistState: false, policy: () => current });
  t.after(() => operations.dispose());
  const prepared = operations.preview(h.source.id);
  assert.deepEqual(prepared.policy, current);
  current = { ...current, version: 2, maxEvents: 1 };
  assert.deepEqual(operations.preview(h.source.id), prepared);
  operations.start(prepared);
  const result = await eventually(() => {
    const value = operations.get(prepared.id);
    return TERMINAL.has(value.state) && value;
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.policy.maxEvents, 200000);
  assert.equal(result.policy.version, 1);
  const fresh = new OperationController(h.ctx, { gate: h.gate, persistState: false, policy: () => current });
  t.after(() => fresh.dispose());
  assert.equal(fresh.preview(h.source.id).available, false, 'new previews use the saved lower event limit');
});

test('native pending candidate is cancelled, accepted input is inherited exactly once and never sent automatically', async t => {
  const h = await harness(t, { replies: [{ text: 'A checkpoint of the earlier turns.' }] });
  h.ctx.on('llm/stream', async function* (options, next) {
    if (isAgentLoopRequest(options) && !options.purpose && options.sessionId === h.source.id) {
      await h.gate.wait({ lossTokens: 100000 }, { sessionId: h.source.id, fingerprint: 'synthetic-pending', signal: options.signal });
    }
    yield* next();
  });
  h.source.followup(user('UNSENT_SYNTHETIC_INPUT'));
  await eventually(() => h.gate.pendingFor(h.source.id));
  const surface = h.source.session.deriveMessages();
  const preview = h.operations.preview(h.source.id);
  assert.equal(preview.input.acceptedInHistory, true);
  assert.equal(preview.requiresStop, true);
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'completed', JSON.stringify(result.error));
  assert.equal(h.gate.pendingFor(h.source.id), null);
  assert.deepEqual(h.source.session.deriveMessages(), surface);
  const child = h.ctx.agents.get(result.branchId);
  assert.equal(JSON.stringify(child.session.deriveMessages()).split('UNSENT_SYNTHETIC_INPUT').length - 1, 1);
  assert.equal(h.upstream.requests.length, 3, 'two original turns and one summary, no resumed main request');
});

test('changed preview and queued input refuse a fork without discarding either input', async t => {
  const h = await harness(t);
  const preview = h.operations.preview(h.source.id);
  h.source.session.append('user/message', user('A concurrent surface edit'), { surfaceOp: 'append' });
  assert.throws(() => h.operations.start(preview), { code: 'changed', status: 409 });
  const next = h.operations.preview(h.source.id);
  h.source.inbox.append('next-turn', user('A parked input'));
  const result = await h.finished(h.operations.start(next).id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'busy');
  assert.equal(result.branchId, null);
  assert.equal(h.source.inbox.nextTurn.length, 1);
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(h.upstream.requests.length, 2);
});

test('native failed summary keeps the created branch and records its attempted call without retrying the job', async t => {
  const h = await harness(t, { replies: [{ status: 500 }] });
  const preview = h.operations.preview(h.source.id);
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'summary');
  assert.ok(result.branchId);
  assert.ok(h.ctx.agents.get(result.branchId));
  assert.equal(result.summaryCalls.length, 1);
  assert.equal(result.summaryCalls[0].outcome, 'failed');
  const childStart = h.ctx.agents.get(result.branchId).session.snapshotEvents()
    .findLast(event => event.type === 'compaction/start');
  assert.equal(result.summaryCalls[0].compactionId, childStart.data.compactionId);
  assert.equal(result.summaryCalls[0].usageRecorded, false);
  assert.equal(result.summaryCalls[0].usage.inputTokens, null);
  assert.equal(h.operations.start(preview).branchId, result.branchId);
  assert.equal(h.operations.preview(h.source.id).branchId, result.branchId);
  await delay(30);
  assert.equal(h.upstream.requests.length, 3);
});

test('native cancellation during summarization leaves the branch, closes compaction and dispatches no continuation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-operations-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  const h = await harness(t, { replies: [{ text: 'A slow synthetic checkpoint.', delayMs: 80 }], persistState: true, statePath });
  const preview = h.operations.preview(h.source.id);
  const job = h.operations.start(preview);
  await h.upstream.waitForRequests(3);
  const receipt = JSON.parse(await readFile(statePath, 'utf8')).jobs[0];
  assert.equal(receipt.summaryCalls.length, 1);
  assert.equal(receipt.summaryCalls[0].outcome, 'started');
  h.operations.cancel(job);
  const result = await h.finished(job.id);
  assert.equal(result.state, 'cancelled');
  assert.ok(result.branchId);
  const child = h.ctx.agents.get(result.branchId);
  assert.ok(child.session.snapshotEvents().some(e => e.type === 'compaction/end' && e.data.error));
  assert.equal(result.summaryCalls[0].outcome, 'cancelled');
  await delay(30);
  assert.equal(h.upstream.requests.length, 3);
});

test('operation receipts omit history and restart converts incomplete work to interrupted without creating another branch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-operations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'operations.json');
  const h = await harness(t, { replies: [{ text: 'A short synthetic checkpoint.' }], persistState: true, statePath });
  const preview = h.operations.preview(h.source.id);
  const result = await h.finished(h.operations.start(preview).id);
  await h.operations.dispose();
  const text = await readFile(statePath, 'utf8');
  assert.equal(text.includes('PRIVATE_SYNTHETIC_HISTORY'), false);
  assert.equal(h.operations.list().length, 1);
  assert.equal(h.operations.list()[0].branchId, result.branchId);
  const stored = JSON.parse(text);
  stored.jobs[0].state = 'compacting';
  await writeFile(statePath, JSON.stringify(stored));
  const restored = new OperationController(h.ctx, { gate: h.gate, persistState: true, statePath });
  t.after(() => restored.dispose());
  await restored.init();
  const interrupted = restored.get(result.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.branchId, result.branchId);
  assert.equal(restored.start(interrupted).branchId, result.branchId);
  assert.equal(restored.preview(h.source.id).branchId, result.branchId);
  assert.equal(h.ctx.sessions.list().length, 2);
  assert.equal(h.upstream.requests.length, 3);
});

test('missing optional compaction and invalid identifiers have explicit non-mutating outcomes', async t => {
  const h = await harness(t, { compaction: false });
  assert.equal(h.operations.preview(h.source.id).available, false);
  const cold = h.operations.preview('synthetic-cold-session');
  assert.equal(cold.available, false);
  assert.match(cold.reason, /已激活/);
  assert.throws(() => h.operations.preview(''), { status: 400 });
  assert.throws(() => h.operations.preview('x\u0000y'), { status: 400 });
  assert.throws(() => h.operations.get('x'.repeat(201)), { status: 400 });
  assert.throws(() => h.operations.start({ id: 'unknown', sessionId: h.source.id }), { status: 404 });
  assert.throws(() => h.operations.start(null), { status: 400 });
  assert.throws(() => h.operations.cancel([]), { status: 400 });
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(h.upstream.requests.length, 2);
});

test('a source mutation during real fork publication preserves the partial branch and sends no summary', async t => {
  const h = await harness(t);
  const preview = h.operations.preview(h.source.id);
  h.ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession === h.source.id) {
      h.source.session.append('user/message', user('A writer changed the original during fork publication'), { surfaceOp: 'append' });
    }
  });
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'changed');
  assert.equal(result.branchCreated, true);
  assert.ok(h.ctx.agents.get(result.branchId));
  assert.equal(result.summaryCalls.length, 0);
  assert.equal(h.upstream.requests.length, 2);
});

test('cancel before dispatch and persistence failure cannot create a child or stop an unrelated request', async t => {
  const h = await harness(t);
  const preview = h.operations.preview(h.source.id);
  const job = h.operations.start(preview);
  h.operations.cancel(job);
  assert.equal((await h.finished(job.id)).state, 'cancelled');
  assert.equal(h.ctx.sessions.list().length, 1);
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-receipt-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'synthetic blocker');
  const broken = new OperationController(h.ctx, { gate: h.gate, persistState: true, statePath: join(file, 'state.json') });
  t.after(() => broken.dispose());
  const next = broken.preview(h.source.id);
  broken.start(next);
  const failed = await eventually(() => { const value = broken.get(next.id); return value.state === 'failed' && value; });
  assert.equal(failed.error.code, 'persistence');
  assert.equal(failed.branchId, null);
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(h.upstream.requests.length, 2);
});

test('unreadable durable receipts refuse new operations instead of overwriting uncertain history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-receipt-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, '{broken synthetic JSON');
  const h = await harness(t, { statePath, persistState: true });
  assert.equal(h.operations.preview(h.source.id).available, false);
  assert.equal(await readFile(statePath, 'utf8'), '{broken synthetic JSON');
  assert.equal(h.ctx.sessions.list().length, 1);
});

test('a native maintenance task that has not quiesced times out without a fork', async t => {
  const h = await harness(t, { waitTimeoutMs: 20 });
  let release;
  const held = h.source.runMaintenance(async () => new Promise(resolve => { release = resolve; }));
  try {
    const preview = h.operations.preview(h.source.id);
    const result = await h.finished(h.operations.start(preview).id);
    assert.equal(result.state, 'failed');
    assert.equal(result.error.code, 'busy');
    assert.equal(result.branchId, null);
    assert.equal(h.ctx.sessions.list().length, 1);
    assert.equal(h.upstream.requests.length, 2);
  } finally { release(); await held; }
});

test('expired previews cannot stop work, and cancelling a preview consumes it without sending', async t => {
  const h = await harness(t);
  const immediate = new OperationController(h.ctx, { gate: h.gate, persistState: false, previewTtlMs: 0 });
  t.after(() => immediate.dispose());
  const expired = immediate.preview(h.source.id);
  assert.throws(() => immediate.start(expired), { code: 'changed' });
  const preview = h.operations.preview(h.source.id);
  assert.equal(h.operations.cancel(preview).state, 'cancelled');
  assert.equal(h.operations.start(preview).state, 'cancelled');
  assert.equal(h.ctx.sessions.list().length, 1);
  assert.equal(h.upstream.requests.length, 2);
});

test('native no-op compaction is reported separately from success and makes no summary request', async t => {
  const h = await harness(t);
  const empty = await h.ctx.agentLoop.create('empty-source', { provider: 'deepseek-official', model: 'deepseek-flash' });
  const preview = h.operations.preview(empty.id);
  const result = await h.finished(h.operations.start(preview).id);
  assert.equal(result.state, 'noop');
  assert.equal(result.compaction, undefined);
  assert.equal(result.summaryCalls.length, 0);
  assert.equal(result.observation, 'unknown');
  assert.ok(result.branchCreated);
  assert.equal(h.upstream.requests.length, 2);
});

test('operation preview refuses histories over its explicit local scan limit', async t => {
  const h = await harness(t);
  const bounded = new OperationController(h.ctx, { gate: h.gate, persistState: false, maxEvents: 1 });
  t.after(() => bounded.dispose());
  const preview = bounded.preview(h.source.id);
  assert.equal(preview.available, false);
  assert.match(preview.reason, /上限/);
  assert.deepEqual(bounded.list(), []);
  assert.equal(h.ctx.sessions.list().length, 1);
});
