import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { SessionRepository } from '../src/repository.mjs';
import { requestRevision } from '../src/repository.mjs';
import { createCacheHelper } from '../src/index.mjs';
import { fixture, usage } from './history-fixtures.mjs';

function warnedSession(id) {
  const f = fixture();
  f.response(usage(100, 100_000));
  f.next(2, 1);
  f.header([f.tools[0]]);
  f.update([{ type: 'tool-removal', toolName: 'beta' }]);
  f.user('a short new prompt');
  f.response(usage(100_000, 100));
  return { id, header: { ...f.session.header, id }, surface: f.session.surface,
    snapshotEvents: () => f.session.snapshotEvents() };
}

function context(sessions, persistence, projections = []) {
  const lookup = new Map(sessions.map(session => [session.id, session]));
  let analyses = 0;
  return {
    get analyses() { return analyses; },
    sessions: { get: id => lookup.get(id), list: () => [...lookup.values()],
      get messageProjections() { analyses++; return projections; } },
    get: name => name === 'sessionPersistence' ? persistence : undefined,
    logger: { warn() {} },
  };
}

const settings = extra => ({
  minLostTokens: 50_000, minLossRatio: 0.2, dashboardLimit: 50,
  maxEvents: 200_000, maxCachedSessions: 2, persistState: false, ...extra,
});

test('session DTO contains derived metrics without raw request or response content', async () => {
  const ctx = context([warnedSession('first')]);
  const repo = new SessionRepository(ctx, settings());
  const data = await repo.session('first');
  assert.equal(data.warnings.length, 1);
  assert.equal(data.latest.cacheReadTokens, 100);
  assert.equal(data.warnings[0].dismissed, false);
  assert.ok(data.calls.every(call => !Object.hasOwn(call, 'request')));
  assert.ok(!JSON.stringify(data).includes('old old old'));
  await repo.dispose();
});

test('dismissal is bound to its session and restores from metadata-only state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cache-helper-state-'));
  const statePath = join(directory, 'state.json');
  try {
    const ctx = context([warnedSession('first'), warnedSession('second')]);
    const config = settings({ persistState: true, statePath });
    const repo = new SessionRepository(ctx, config);
    await repo.init();
    const first = await repo.session('first');
    const second = await repo.session('second');
    await assert.rejects(repo.dismiss({ sessionId: 'second', id: first.warnings[0].id, dismissed: true }), { status: 404 });
    await repo.dismiss({ sessionId: 'first', id: first.warnings[0].id, dismissed: true });
    assert.equal((await repo.session('first')).warnings[0].dismissed, true);
    assert.equal((await repo.session('second')).warnings[0].dismissed, false);
    const raw = await readFile(statePath, 'utf8');
    const state = JSON.parse(raw);
    assert.deepEqual(Object.keys(state).sort(), ['dismissed', 'version']);
    assert.equal(state.dismissed.length, 1);
    assert.ok(!raw.includes('old old old'));
    await repo.dispose();
    const restored = new SessionRepository(ctx, config);
    await restored.init();
    assert.equal((await restored.session('first')).warnings[0].dismissed, true);
    await restored.dismiss({ sessionId: 'first', id: first.warnings[0].id, dismissed: false });
    assert.equal((await restored.session('first')).warnings[0].dismissed, false);
    assert.equal(second.warnings[0].dismissed, false);
    await restored.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('maxEvents rejects oversized live histories as well as persisted histories', async () => {
  const liveRepo = new SessionRepository(context([warnedSession('live')]), settings({ maxEvents: 1 }));
  await assert.rejects(liveRepo.session('live'), { status: 413 });
  let closed = false;
  const persistence = {
    stat: async () => ({ revision: 1 }),
    open: async () => ({
      header: { id: 'saved' },
      read: async (_start, count) => ({ events: Array.from({ length: count }, (_, seq) => ({ seq })) }),
      close: async () => { closed = true; },
    }),
  };
  const savedRepo = new SessionRepository(context([], persistence), settings({ maxEvents: 1 }));
  await assert.rejects(savedRepo.session('saved'), { status: 413 });
  assert.equal(closed, true);
});

test('cache eviction respects recent reads so a dashboard scan does not evict a hot session', async () => {
  const ctx = context(['a', 'b', 'c'].map(warnedSession));
  const repo = new SessionRepository(ctx, settings({ maxCachedSessions: 2 }));
  await repo.session('a');
  await repo.session('b');
  await repo.session('a');
  await repo.session('c');
  await repo.session('a');
  assert.equal(ctx.analyses, 3);
  await repo.dispose();
});

test('an analysis limit cannot hide an existing confirmation from the session API', async () => {
  const ctx = context([warnedSession('limited')]);
  ctx.on = () => () => {};
  const helper = await createCacheHelper(ctx, settings({ maxEvents: 1, registerHttp: false }));
  const waiting = helper.gate.wait({ unknown: true }, {
    sessionId: 'limited', fingerprint: 'one-candidate', turn: 2, step: 1,
  });
  const settled = waiting.catch(error => error);
  try {
    const data = await helper.getSession('limited');
    assert.equal(data.pending.sessionId, 'limited');
    assert.equal(data.pending.fingerprint, 'one-candidate');
    assert.ok(data.error || data.coverage?.errors?.length);
    helper.gate.decide({ ...data.pending, decision: 'cancel' });
    assert.equal((await settled).code, 'CACHE_HELPER_CANCELLED');
  } finally { await helper.dispose(); }
});

test('a settled upstream failure with unknown usage invalidates cached usage metrics', async () => {
  const f = fixture();
  f.response(usage(100, 100_000));
  const repo = new SessionRepository(context([f.session]), settings());
  assert.equal((await repo.session(f.session.id)).cumulative.calls, 1);
  f.next();
  f.session.append('assistant/attempt', { turn: 1, step: 2, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'finish', reason: 'error' } },
  ] });
  const data = await repo.session(f.session.id);
  assert.equal(data.cumulative.calls, 2);
  assert.equal(data.latest.hitRate, null);
  await repo.dispose();
});

test('a message projection without surfaceOp invalidates the exact pending candidate', async () => {
  const projection = { type: 'plugin:cache-helper-fixture/project', project(_event, history) {
    const seq = history.nodes.find(seq => history.events[seq].type === 'system/message');
    const message = history.events[seq].data.message;
    return new Map([[seq, { ...message, content: [{ type: 'text', text: 'Projected system input' }] }]]);
  } };
  const f = fixture({ projections: [projection] });
  f.response(usage(100, 100_000));
  f.next(2, 1);
  f.header([f.tools[0]]);
  f.update([{ type: 'tool-removal', toolName: 'beta' }]);
  f.user('the changed request');
  const hooks = new Map();
  const ctx = context([f.session], undefined, [projection]);
  ctx.on = (type, hook) => { hooks.set(type, hook); return () => hooks.delete(type); };
  ctx.llm = { resolveModelInfo: async () => ({ toolUpdate: 'addition-only', systemPromptUpdate: 'in-history' }) };
  const helper = await createCacheHelper(ctx, settings({ registerHttp: false }));
  const header = f.session.requestHeader();
  const options = markAgentLoopRequest({ ...header.config,
    messages: f.session.deriveMessages(), tools: header.tools,
    toolHistory: f.session.toolHistory(), sessionId: f.session.id,
  });
  let sent = 0;
  const streaming = hooks.get('llm/stream')(options, async function* () { sent++; });
  const progress = streaming.next().catch(error => error);
  try {
    let pending;
    for (let index = 0; index < 100 && !pending; index++) {
      pending = helper.gate.pendingFor(f.session.id);
      if (!pending) await delay(1);
    }
    assert.ok(pending);
    const beforeRevision = requestRevision(f.records());
    const beforeGeneration = f.session.surface.contentGeneration;
    const event = f.session.append(projection.type, { synthetic: true });
    assert.equal(event.surfaceOp, undefined);
    assert.equal(requestRevision(f.records()), beforeRevision);
    assert.ok(f.session.surface.contentGeneration > beforeGeneration);
    assert.throws(() => helper.gate.decide({ ...pending, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
    assert.equal((await progress).code, 'CACHE_HELPER_CANCELLED');
    assert.equal(sent, 0);
  } finally { await helper.dispose(); }
});
