import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeChildHarness as harness, eventually, content, user, selectReceiptBaseline, liveRecords } from './child-runtime-fixture.mjs';

test('native fork first request waits visibly at the parent and confirms only its inherited candidate', async t => {
  const h = await harness(t);
  h.remove();
  const activation = await h.start('fork-child');
  const view = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected inherited child confirmation');
  assert.equal(view.baseline.kind, 'inherited');
  assert.equal(view.identity.directParentId, h.parent.id);
  assert.equal(view.identity.rootSessionId, h.parent.id);
  assert.ok(view.identity.activationGeneration);
  assert.equal(h.helper.pending({ sessionId: h.parent.id }).pending[0].id, view.id);
  assert.equal(h.helper.pending().pending[0].id, view.id);
  assert.equal(h.upstream.requests.length, 1);
  let joined = false;
  const waiting = h.ctx.subagents.waitForChildren(h.parent).then(() => { joined = true; });
  await delay(20);
  assert.equal(joined, false, 'Native parent wait is held by the pending child');
  h.helper.gate.decide({ ...view, decision: 'confirm' });
  await activation.result;
  await waiting;
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(joined, true);
  assert.throws(() => h.helper.gate.decide({ ...view, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
});

test('native fork cancellation settles parent waiting with zero child HTTP dispatch', async t => {
  const h = await harness(t);
  h.remove();
  const activation = await h.start('cancel-child');
  const view = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected child pending');
  const waiting = h.ctx.subagents.waitForChildren(h.parent);
  h.helper.gate.decide({ ...view, decision: 'cancel' });
  await activation.result;
  await waiting;
  assert.equal(h.upstream.requests.length, 1);
});

test('multiple concurrent native forks remain separate and repeated spawn first requests do not gate', async t => {
  const h = await harness(t, { script: [{ text: 'parent' }, { text: 'spawn one' }, { text: 'spawn two' }] });
  h.remove();
  const [a, b] = await Promise.all([h.start('fork-a'), h.start('fork-b')]);
  const pending = await eventually(() => h.helper.pending().pending.length === 2 && h.helper.pending().pending, 'Expected two independent child candidates');
  assert.notEqual(pending[0].identity.activationGeneration, pending[1].identity.activationGeneration);
  h.helper.gate.decide({ ...pending[0], decision: 'cancel' });
  assert.equal(h.helper.pending().pending.length, 1);
  h.helper.gate.decide({ ...pending[1], decision: 'cancel' });
  await Promise.all([a.result, b.result]);
  for (const id of ['spawn-one', 'spawn-two']) {
    const spawned = await h.start(id, 'spawn');
    await spawned.result;
    assert.equal(h.helper.gate.pendingFor(id), null);
    assert.equal(h.helper.children.observations({ sessionId: id })[0].baseline.kind, 'none');
  }
  assert.equal(h.upstream.requests.length, 3);
});

test('native child high risk without a reachable browser refuses rather than hanging parent wait', async t => {
  const h = await harness(t);
  h.remove();
  h.helper.children.reachable({ channelId: 'synthetic-visible-global-ui', seq: 2, reachable: false });
  const activation = await h.start('no-visible-ui');
  await activation.result;
  await h.ctx.subagents.waitForChildren(h.parent);
  assert.equal(h.upstream.requests.length, 1);
  assert.equal(h.helper.gate.pendingFor(activation.childId), null);
  assert.equal(h.helper.children.observations({ sessionId: activation.childId })[0].state, 'unsupported');
});

test('observe mode records inherited risk without pretending child blocking is enabled', async t => {
  const h = await harness(t, { config: { childProtection: 'observe' } });
  h.remove();
  const activation = await h.start('observe-child');
  await activation.result;
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.helper.pending().pending.length, 0);
  const observation = h.helper.children.observations({ sessionId: activation.childId })[0];
  assert.equal(observation.baseline.kind, 'inherited');
  assert.equal(observation.state, 'observed-risk');
});

test('child deadline cancels without automatic approval or retry and reconnect cannot extend it', async t => {
  const h = await harness(t, { config: { childPendingTimeoutMs: 100 } });
  h.remove();
  const activation = await h.start('deadline-child');
  const view = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected deadline child pending');
  h.helper.children.reachable({ channelId: 'replacement-visible-ui', seq: 1, reachable: true });
  assert.equal(h.helper.gate.pendingFor(activation.childId).expiresAt, view.expiresAt);
  await activation.result;
  await h.ctx.subagents.waitForChildren(h.parent);
  assert.equal(h.upstream.requests.length, 1);
  assert.throws(() => h.helper.gate.decide({ ...view, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
});

test('a cancelled first fork request still uses inherited baseline after cold continuation', async t => {
  const h = await harness(t);
  h.remove();
  const activation = await h.start('resumed-child');
  const first = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected initial child pending');
  h.helper.gate.decide({ ...first, decision: 'cancel' });
  await activation.result;
  assert.equal(h.ctx.agents.get(activation.childId), undefined);
  await h.ctx.subagents.sendMessage(h.parent, activation.childId, content('Continue the same cold child'), { signal: new AbortController().signal });
  const second = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected restored child pending');
  assert.equal(second.baseline.kind, 'inherited');
  assert.equal(second.baseline.seq, first.baseline.seq);
  assert.notEqual(second.identity.activationGeneration, first.identity.activationGeneration);
  h.helper.gate.decide({ ...second, decision: 'cancel' });
  await h.ctx.subagents.waitForChildren(h.parent);
  assert.equal(h.upstream.requests.length, 1);
});

test('native targeted stop addresses the direct child and observes quiescence', async t => {
  const h = await harness(t);
  h.remove();
  const activation = await h.start('stop-child');
  const view = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected child pending before stop');
  const stopped = await h.helper.children.stop({ ...view,
    parentSessionId: h.parent.id, activationGeneration: view.identity.activationGeneration });
  assert.equal(stopped.accepted, true);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.descendantsStopped, false);
  await activation.result;
  assert.equal(h.upstream.requests.length, 1);
});

test('a cold native continuation uses its own receipt and does not refork newer parent history', async t => {
  const h = await harness(t, { script: [{ text: 'parent first' }, { text: 'child first' },
    { text: 'parent newer' }, { text: 'child continuation' }, { text: 'native parent settlement' }] });
  const first = await h.start('own-receipt-child');
  await first.result;
  h.parent.followup(user('PARENT_NEW_HISTORY_CANARY'));
  await h.parent.whenIdle();
  await h.ctx.subagents.sendMessage(h.parent, first.childId, content('Normal child tail addition'), { signal: new AbortController().signal });
  await h.ctx.subagents.waitForChildren(h.parent);
  assert.equal(h.upstream.requests.length, 4);
  assert.equal(h.helper.gate.pendingFor(first.childId), null);
  const observation = h.helper.children.observations({ sessionId: first.childId })[0];
  assert.equal(observation.baseline.kind, 'own');
  assert.equal(JSON.stringify(h.upstream.requests.at(-1).body).includes('PARENT_NEW_HISTORY_CANARY'), false);
  h.remove();
  await h.ctx.subagents.sendMessage(h.parent, first.childId, content('Child continuation after tool removal'), { signal: new AbortController().signal });
  const pending = await eventually(() => h.helper.gate.pendingFor(first.childId), 'Expected own-baseline risk on continuation');
  assert.equal(pending.baseline.kind, 'own');
  assert.equal(pending.baseline.receiptSessionId, first.childId);
  h.helper.gate.decide({ ...pending, decision: 'cancel' });
  await h.ctx.subagents.waitForChildren(h.parent);
  await delay(20);
  assert.equal(h.upstream.requests.some(request => JSON.stringify(request.body).includes('Child continuation after tool removal')), false,
    'Native settlement may wake the parent; the cancelled child candidate still cannot reach HTTP');
  const settledRecords = await h.helper.repository.records(first.childId);
  assert.equal(selectReceiptBaseline(settledRecords).seq, pending.baseline.seq);
});

test('a failed spawn without a receipt stays none after cold continuation', async t => {
  const h = await harness(t, { script: [{ text: 'parent first' }, { status: 503 }, { text: 'spawn retry' }] });
  const first = await h.start('failed-spawn-child', 'spawn');
  await first.result;
  assert.equal(h.upstream.requests.length, 2);
  h.remove();
  await h.ctx.subagents.sendMessage(h.parent, first.childId, content('Continue no-receipt spawn'), { signal: new AbortController().signal });
  await h.ctx.subagents.waitForChildren(h.parent);
  assert.equal(h.upstream.requests.length, 3);
  assert.equal(h.helper.gate.pendingFor(first.childId), null);
  assert.equal(h.helper.children.observations({ sessionId: first.childId })[0].baseline.kind, 'none');
});

test('native steer invalidates the old pending without approving the changed candidate', async t => {
  const h = await harness(t);
  h.remove();
  const activation = await h.start('steered-child');
  const first = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected initial steer candidate');
  await h.ctx.subagents.sendMessage(h.parent, activation.childId, content('New child steer input'), { signal: new AbortController().signal });
  assert.throws(() => h.helper.gate.decide({ ...first, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
  const child = await eventually(() => {
    const value = h.ctx.agents.get(activation.childId);
    return value?.status === 'idle' ? value : null;
  }, 'Expected the rejected old request to become idle');
  assert.equal(h.helper.gate.pendingFor(activation.childId), null);
  assert.ok(child.inbox.nextStep.some(message => JSON.stringify(message).includes('New child steer input')),
    'The accepted steer remains parked in the native inbox; the plugin does not invent another send');
  await h.ctx.subagents.waitForChildren(h.parent);
  assert.equal(h.upstream.requests.length, 1);
  await activation.dispose();
  await activation.result;
});

test('stopping a native child leaves its pending grandchild running for separate confirmation', async t => {
  const h = await harness(t);
  h.remove();
  const child = await h.start('tree-child');
  const childView = await eventually(() => h.helper.gate.pendingFor(child.childId), 'Expected child risk');
  const childAgent = h.ctx.agents.get(child.childId);
  assert.equal(selectReceiptBaseline(liveRecords(childAgent.session)).kind, 'inherited');
  const grandchild = await h.start('tree-grandchild', 'fork', childAgent);
  const grandchildView = await eventually(() => h.helper.gate.pendingFor(grandchild.childId), 'Expected grandchild risk');
  assert.equal(grandchildView.identity.directParentId, child.childId);
  assert.equal(grandchildView.identity.rootSessionId, h.parent.id);
  assert.equal(grandchildView.identity.depth, 2);
  const stopped = await h.helper.children.stop({ ...childView, parentSessionId: h.parent.id,
    activationGeneration: childView.identity.activationGeneration });
  assert.equal(stopped.state, 'stopped');
  assert.equal(h.helper.gate.pendingFor(grandchild.childId).id, grandchildView.id);
  assert.equal(h.ctx.agents.get(grandchild.childId).status, 'running');
  assert.equal(h.upstream.requests.length, 1);
  h.helper.gate.decide({ ...grandchildView, decision: 'cancel' });
  await Promise.all([child.result, grandchild.result]);
  await h.ctx.subagents.waitForChildren(h.parent);
});

test('global pending HTTP stays lightweight and browser identity alone may decide or stop a child', async t => {
  const h = await harness(t, { config: { registerHttp: true } });
  h.remove();
  const activation = await h.start('http-visible-child');
  const view = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected HTTP-visible pending');
  const computations = h.helper.repository.analysis.diagnostics().computations;
  assert.equal((await h.request('GET', '/pending', undefined, { unauthorized: true })).status, 401);
  assert.equal((await h.request('GET', '/pending', undefined, { operator: true })).status, 403);
  const global = await h.request('GET', '/pending');
  assert.equal(global.status, 200);
  assert.equal(global.value.pending[0].id, view.id);
  assert.equal(h.helper.repository.analysis.diagnostics().computations, computations);
  const parent = await h.request('GET', `/pending?sessionId=${encodeURIComponent(h.parent.id)}`);
  assert.equal(parent.value.pending[0].id, view.id);
  assert.equal((await h.request('POST', '/decision', { ...view, decision: 'confirm' }, { operator: true })).status, 403);
  assert.equal((await h.request('POST', '/children/stop', { ...view, parentSessionId: h.parent.id,
    activationGeneration: view.identity.activationGeneration }, { operator: true })).status, 403);
  assert.equal((await h.request('POST', '/pending/reachable', { channelId: 'operator-ui', seq: 1, reachable: true }, { operator: true })).status, 403);
  assert.equal(h.upstream.requests.length, 1);
  assert.equal((await h.request('POST', '/children/stop', { ...view, parentSessionId: 'wrong-direct-parent',
    activationGeneration: view.identity.activationGeneration })).status, 409);
  assert.equal(h.helper.gate.pendingFor(activation.childId).id, view.id);
  const cachedParent = (await h.request('GET', `/session?sessionId=${encodeURIComponent(h.parent.id)}&cached=1`)).value;
  assert.equal(cachedParent.coverage.detailsAvailable, false, 'A native retained accounting projection does not invent detailed analysis');
  assert.deepEqual(cachedParent.calls, []);
  assert.equal(h.helper.repository.analysis.diagnostics().computations, computations, 'Cached-only preview must not start analysis');
  assert.equal((await h.request('GET', '/session?sessionId=absent-history&cached=1')).value, null);
  assert.ok(Array.isArray((await h.request('GET', '/analysis/jobs')).value), 'Async job list is awaited before JSON serialization');
  assert.equal((await h.request('POST', '/analysis/cache/clear', { sessionId: 42 })).status, 400);
  const decision = await h.request('POST', '/decision', { ...view, decision: 'confirm' });
  assert.equal(decision.status, 200);
  assert.deepEqual(decision.value, { ok: true });
  await activation.result;
  assert.equal(h.upstream.requests.length, 2);
});
