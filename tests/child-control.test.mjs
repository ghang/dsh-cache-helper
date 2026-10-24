import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const testedModule = file => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', file)).href
  : new URL(`../src/${file}`, import.meta.url).href;
const { GateController } = await import(testedModule('gate.mjs'));
const { ChildControl } = await import(testedModule('child-control.mjs'));

function harness(t, options = {}) {
  const hooks = new Map();
  const sessions = new Map();
  const agents = new Map();
  const interrupts = [];
  const runtime = { interrupt(id, authority) { interrupts.push({ id, authority }); } };
  const ctx = { on(type, callback) { hooks.set(type, callback); return () => hooks.delete(type); },
    sessions: { get: id => sessions.get(id) },
    get: name => name === 'agents' ? { get: id => agents.get(id) } : name === 'subagents' ? runtime : undefined };
  const gate = new GateController(options);
  const control = new ChildControl(ctx, { gate, stopTimeoutMs: 30, pollMs: 2, ...options });
  t.after(async () => { gate.dispose(); await control.dispose(); });
  const agent = { id: 'child', session: { id: 'child', header: {
    id: 'child', origin: 'subagent', delegationDepth: 1, parentSession: 'parent' } }, status: 'running' };
  agents.set(agent.id, agent); sessions.set(agent.id, agent.session);
  const emit = (type, value) => hooks.get(type)?.(value);
  const start = (runId = 'run-1') => emit('subagent/start', { id: agent.id, runId, provider: 'fork', local: true });
  const pending = () => {
    const identity = control.snapshot(agent.id);
    const waiting = gate.wait({ identity, baseline: { kind: 'inherited', seq: 4 } }, {
      sessionId: agent.id, fingerprint: 'one-candidate', timeoutMs: 1000,
    });
    const settled = waiting.catch(error => error);
    return { view: gate.pendingFor(agent.id), settled };
  };
  return { ctx, hooks, sessions, agents, interrupts, runtime, gate, control, agent, emit, start, pending };
}

test('native start/end witnesses bind exact local activation and ignore stale terminal edges', async t => {
  const h = harness(t);
  assert.equal(h.control.snapshot('child'), null, 'A live child alone is not an activation witness');
  h.start();
  assert.equal(h.control.snapshot('child').activationGeneration, 'run-1');
  h.start('run-2');
  h.emit('subagent/end', { id: 'child', runId: 'run-1', local: true });
  assert.equal(h.control.snapshot('child').activationGeneration, 'run-2');
  const { settled } = h.pending();
  h.emit('subagent/end', { id: 'child', runId: 'run-2', local: true });
  assert.equal((await settled).code, 'CACHE_HELPER_CANCELLED');
  assert.equal(h.control.snapshot('child'), null);
  h.emit('subagent/start', { id: 'child', runId: 'external', local: false });
  assert.equal(h.control.snapshot('child'), null);
});

test('child stop and heartbeat limits cannot become unbounded', t => {
  const h = harness(t);
  assert.throws(() => new ChildControl(h.ctx, { gate: h.gate, stopTimeoutMs: Infinity }), TypeError);
  assert.throws(() => new ChildControl(h.ctx, { gate: h.gate, stopTimeoutMs: 3001 }), TypeError);
  assert.throws(() => new ChildControl(h.ctx, { gate: h.gate, heartbeatTtlMs: Infinity }), TypeError);
});

test('reachability has monotone heartbeats and does not revive on late true after hidden/unmount false', t => {
  let now = 1;
  const h = harness(t, { now: () => now, heartbeatTtlMs: 20 });
  h.control.reachable({ channelId: 'page-1', seq: 1, reachable: true });
  assert.equal(h.control.reachability().reachable, true);
  h.control.reachable({ channelId: 'page-1', seq: 3, reachable: false });
  assert.equal(h.control.reachable({ channelId: 'page-1', seq: 2, reachable: true }).accepted, false);
  assert.equal(h.control.reachability().reachable, false);
  h.control.reachable({ channelId: 'page-1', seq: 4, reachable: true });
  now = 22;
  assert.equal(h.control.reachability().reachable, false);
  assert.equal(h.control.reachable({ channelId: 'page-1', seq: 3, reachable: true }).accepted, false);
  assert.throws(() => h.control.reachable({ channelId: 'page', seq: -1, reachable: true }), { status: 400 });
});

test('directed stop requires the exact pending, native generation and direct parent', async t => {
  const h = harness(t);
  h.start();
  const { view, settled } = h.pending();
  const request = { ...view, parentSessionId: 'parent', activationGeneration: 'run-1' };
  await assert.rejects(h.control.stop({ ...request, parentSessionId: 'root' }), { code: 'CACHE_HELPER_STALE' });
  await assert.rejects(h.control.stop({ ...request, activationGeneration: 'old' }), { code: 'CACHE_HELPER_STALE' });
  await assert.rejects(h.control.stop({ ...request, id: 'old-pending' }), { code: 'CACHE_HELPER_STALE' });
  assert.equal(h.interrupts.length, 0);
  h.runtime.interrupt = (id, authority) => { h.interrupts.push({ id, authority }); h.agent.status = 'idle'; };
  const result = await h.control.stop(request);
  assert.equal(result.state, 'stopped');
  assert.equal(result.quiescent, true);
  assert.equal(result.descendantsStopped, false);
  assert.deepEqual(h.interrupts, [{ id: 'child', authority: { kind: 'user', parentSessionId: 'parent' } }]);
  assert.equal((await settled).code, 'CACHE_HELPER_CANCELLED');
  assert.deepEqual(await h.control.stop(request), result, 'Identical candidate retries cannot interrupt twice');
});

test('accepted interrupt times out rather than claiming the target is stopped', async t => {
  const h = harness(t, { stopTimeoutMs: 15 });
  h.start(); const { view, settled } = h.pending();
  const stopping = h.control.stop({ ...view, parentSessionId: 'parent', activationGeneration: 'run-1' });
  assert.equal(h.gate.pendingFor('child'), null);
  assert.equal(h.control.stops({ sessionId: 'parent' })[0].state, 'stopping');
  const result = await stopping;
  assert.equal(result.accepted, true);
  assert.equal(result.state, 'stop-unconfirmed');
  assert.equal(result.quiescent, false);
  assert.equal(h.agent.status, 'running');
  assert.equal(h.control.stops({ sessionId: 'child' })[0].state, 'stop-unconfirmed');
  assert.equal(h.control.stops({ sessionId: 'unrelated' }).length, 0);
  await settled;
});

test('new work during bounded observation is not mistaken for the stopped attempt', async t => {
  const h = harness(t);
  h.start(); const { view, settled } = h.pending();
  const stopping = h.control.stop({ ...view, parentSessionId: 'parent', activationGeneration: 'run-1' });
  h.emit('agent/inbox/inserted', { agent: h.agent, message: { id: 'later-input' } });
  assert.equal((await stopping).state, 'superseded');
  await settled;
});

test('parent release does not clear a still-valid child pending, but target release does', async t => {
  const h = harness(t);
  h.start(); const { view, settled } = h.pending();
  h.emit('session/disposed', { id: 'parent' });
  assert.equal(h.gate.pendingFor('child').id, view.id);
  h.emit('session/disposed', h.agent.session);
  assert.equal(h.gate.pendingFor('child'), null);
  assert.equal((await settled).code, 'CACHE_HELPER_CANCELLED');
});

test('a child confirmation keeps its original deadline across heartbeat and reconnect', async t => {
  let now = 10;
  const h = harness(t, { now: () => now });
  h.start(); const { view, settled } = h.pending();
  h.control.reachable({ channelId: 'first-page', seq: 1, reachable: true });
  now = view.expiresAt - 1;
  h.control.reachable({ channelId: 'second-page', seq: 1, reachable: true });
  assert.equal(h.gate.pendingFor('child').expiresAt, view.expiresAt);
  now++;
  assert.equal(h.gate.pendingFor('child'), null);
  assert.equal((await settled).code, 'CACHE_HELPER_EXPIRED');
});

test('pending discovery validates cheap source observations without rerunning full fingerprint checks', async t => {
  const h = harness(t);
  let strict = 0;
  let observed = true;
  const waiting = h.gate.wait({}, { sessionId: 'main', fingerprint: 'candidate',
    validate: () => { strict++; return true; }, observe: () => observed });
  const settled = waiting.catch(error => error);
  const view = h.gate.pendingFor('main');
  h.gate.list(); h.gate.list();
  assert.equal(strict, 0);
  observed = false;
  h.emit('session/event', { id: 'main' });
  assert.equal(h.gate.pendingFor('main'), null);
  assert.equal((await settled).code, 'CACHE_HELPER_CANCELLED');
  assert.throws(() => h.gate.decide({ ...view, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
});
