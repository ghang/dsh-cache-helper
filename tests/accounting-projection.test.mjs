import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SessionPlugin from '@deepseek-ai/dsh-session';
import ProjectionPlugin from '@deepseek-ai/dsh-session-projection';
import { fixture, usage } from './history-fixtures.mjs';
const tested = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { accountingProjectionDefinition: definition, ACCOUNTING_PROJECTION_KEY: key,
  installAccountingProjection } = await import(tested('accounting-projection.mjs'));

test('real host registry accepts, checkpoints and restores the bounded accounting fold', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionPlugin); await ctx.plugin(ProjectionPlugin);
  const dispose = await installAccountingProjection(ctx);
  const f = fixture({ text: 'PRIVATE_ACCOUNTING_PROMPT_CANARY' });
  f.response(usage(100, 100_000));
  const session = ctx.sessions.create('projection-accounting', { seed: f.session.snapshotEvents() });
  const snapshot = ctx.sessionProjections.snapshot(session, [key]);
  assert.equal(snapshot.values[key].own.calls, 1);
  assert.equal(snapshot.values[key].own.knownCacheReadTokens, 100_000);
  const checkpoint = ctx.sessionProjections.checkpoint(session);
  assert.equal(checkpoint[key].ver, definition.stateVersion);
  f.next(2, 1);
  const response = f.response({ inputTokens: 10, outputTokens: 5 });
  session.append('assistant/message', response.data, { surfaceOp: 'append' });
  const current = ctx.sessionProjections.snapshot(session, [key]).values[key];
  assert.equal(current.own.calls, 2);
  assert.equal(current.own.unknownUsageCalls, 1, 'Partial sums cannot imply complete accounting');
  assert.equal(current.lastReceipt.usage.cacheReadTokens, null);
  const start = checkpoint[key].seq + 1;
  const restored = ctx.sessionProjections.restore(checkpoint, session.snapshotEvents().slice(start), start, session.header, 0);
  assert.deepEqual(restored.snapshot.values[key], current);
  assert.equal(JSON.stringify(restored.checkpoint).includes('PRIVATE_ACCOUNTING_PROMPT_CANARY'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(current)) < 2000, 'Projection has no growing call list');
  await dispose();
  assert.equal(ctx.sessionProjections.snapshot(session, [key]).values[key], undefined);
});

test('optional projection registration follows a registry that arrives after the helper', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionPlugin);
  const dispose = await installAccountingProjection(ctx);
  const registry = await ctx.plugin(ProjectionPlugin);
  const session = ctx.sessions.create('late-projection');
  assert.equal(ctx.sessionProjections.snapshot(session, [key]).values[key].own.calls, 0);
  await registry.dispose();
  await ctx.plugin(ProjectionPlugin);
  assert.equal(ctx.sessionProjections.snapshot(session, [key]).values[key].own.calls, 0);
  await dispose();
  assert.equal(ctx.sessionProjections.snapshot(session, [key]).values[key], undefined);
});

test('inheritance totals, unknowns and receipt semantics remain explicit and unrelated events reuse state', () => {
  const header = { id: 'child', origin: 'subagent', isSeeded: true, delegationDepth: 1 };
  let state = definition.init(header, 2);
  assert.equal(definition.apply(state, { type: 'user/message', seq: 0 }), state);
  state = definition.apply(state, { type: 'assistant/message', seq: 1, time: 1, data: { usage: usage(10, 100), turn: 1, step: 1 } });
  assert.equal(state.inherited.calls, 1); assert.equal(state.own.calls, 0);
  state = definition.apply(state, { type: 'assistant/attempt', seq: 2, data: { stream: [] } });
  assert.equal(state.emptyAttempts, 1); assert.equal(state.lastReceipt.seq, 1);
  state = definition.apply(state, { type: 'assistant/attempt', seq: 3, data: { stream: [], usage: null } });
  assert.equal(state.own.calls, 1); assert.equal(state.own.unknownUsageCalls, 1);
  assert.equal(state.lastReceipt.seq, 1, 'Null failure does not replace effective receipt');
  let unknown = definition.init(header, undefined);
  unknown = definition.apply(unknown, { type: 'assistant/message', seq: 0, data: { usage: usage(1, 99) } });
  assert.equal(unknown.unknown.calls, 1);
  assert.equal(unknown.own.calls + unknown.inherited.calls, 0);
  const beforeBytes = Buffer.byteLength(JSON.stringify(unknown));
  for (let seq = 1; seq <= 2000; seq++) unknown = definition.apply(unknown,
    { type: 'assistant/message', seq, data: { usage: usage(1, 99) } });
  assert.ok(Buffer.byteLength(JSON.stringify(unknown)) < beforeBytes + 80, 'Accounting state must not grow with history length');
});

test('projection version and schema mismatch cannot restore arbitrary or raw context', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionPlugin); await ctx.plugin(ProjectionPlugin);
  await installAccountingProjection(ctx);
  const f = fixture({ text: 'synthetic input' }); f.response(usage(1, 99));
  const session = ctx.sessions.create('version-check', { seed: f.session.snapshotEvents() });
  const checkpoint = ctx.sessionProjections.checkpoint(session);
  checkpoint[key].ver++;
  const restored = ctx.sessionProjections.restore(checkpoint, session.snapshotEvents(), 0, session.header, 0);
  assert.equal(restored.snapshot.values[key].own.calls, 1);
  assert.equal(definition.stateSchema.safeParse({ ...restored.snapshot.values[key], prompt: 'PRIVATE_CANARY' }).success, false);
});
