import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadRuntime } from '../scripts/verify-runtime.mjs';
import { createFakeUpstream } from './fake-upstream.mjs';
const testedModule = file => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', file)).href
  : new URL(`../src/${file}`, import.meta.url).href;
const { createCacheHelper } = await import(testedModule('index.mjs'));
const { normalizeRequest, reconstructCalls } = await import(testedModule('history.mjs'));

// Real installed DSH packages, including the production HTTP serializer. This
// suite never reads credentials, binds public interfaces, or calls a paid API.
const modules = await loadRuntime();
const { Context } = modules['@deepseek-ai/cordis'];
const { DeepSeekAdapter, resolveAdapterOptions } = modules['@deepseek-ai/dsh-llm-deepseek'];
const { createUserMessage, isAgentLoopRequest } = modules['@deepseek-ai/dsh-llm'];
const { defineContentToolFixture } = modules['@deepseek-ai/dsh-tools'];
const MODEL = 'deepseek-flash';

function user(text) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
}

async function eventually(read, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(5);
  }
  throw new Error(message);
}

function registerTool(ctx, name, deferLoading = false) {
  return ctx.tools.register(defineContentToolFixture({
    name,
    description: `Synthetic ${name} tool; no external effects.`,
    parameters: { text: { type: 'string' } },
    ...(deferLoading ? { deferLoading: true } : {}),
    async execute(args) { return [{ type: 'text', text: `fixture: ${args.text ?? ''}` }]; },
  }));
}

async function harness(t, { script = [], helper = true, model = MODEL, config = {} } = {}) {
  const upstream = await createFakeUpstream({ script });
  const ctx = new Context();
  let cacheHelper;
  t.after(async () => {
    await cacheHelper?.dispose();
    await ctx.fiber.dispose();
    await upstream.close();
  });
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection']) {
    await ctx.plugin(modules[`@deepseek-ai/${name}`].default);
  }
  await ctx.plugin(modules['@deepseek-ai/dsh-system-prompt'].default, { personaPrefix: 'Stable synthetic cache fixture.' });
  for (const name of ['dsh-tools', 'dsh-agent']) await ctx.plugin(modules[`@deepseek-ai/${name}`].default);
  await ctx.plugin(modules['@deepseek-ai/dsh-agent-loop'].default, { agents: [] });
  ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: upstream.url, retryPolicy: { mode: 'normal', maxRetries: 0 } }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'synthetic-key-only' } }),
    resolveUserId: () => 'cache-helper-synthetic-validation',
    resolveAttachments: () => undefined,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  }));
  if (helper) cacheHelper = await createCacheHelper(ctx, { registerHttp: false, persistState: false, minLostTokens: 1, minLossRatio: 0.01, ...config });
  let serial = 0;
  async function agent(id = `cache-helper-${++serial}`, meta = {}) {
    if (meta.isSeeded) {
      const handle = await ctx.agents.create({
        sessionId: id, agentOptions: { provider: 'deepseek-official', model },
        meta, seed: [], inheritedEventCount: 0,
      });
      return handle.agent;
    }
    return ctx.agentLoop.create(id, { provider: 'deepseek-official', model }, meta);
  }
  return { ctx, upstream, helper: cacheHelper, agent };
}

async function send(agent, text) {
  agent.followup(user(text));
  await agent.whenIdle();
}

async function pending(helper, agent) {
  return eventually(() => helper.gate.pendingFor(agent.session.header.id), 'Expected an explicit cache-risk gate');
}

function decide(helper, view, decision) {
  return helper.gate.decide({ sessionId: view.sessionId, id: view.id, fingerprint: view.fingerprint, decision });
}

async function assertNoExtraRequest(upstream, count) {
  // A bounded dwell catches accidental eager dispatch while the gate is open.
  await delay(50);
  assert.equal(upstream.requests.length, count);
}

test('native AgentLoop + DeepSeek HTTP: confirmation is required and consumed exactly once', async t => {
  const h = await harness(t, { script: [{ text: 'first' }, { text: 'confirmed' }] });
  const remove = registerTool(h.ctx, 'a_probe');
  registerTool(h.ctx, 'z_probe');
  const agent = await h.agent('gate-confirm');
  await send(agent, 'First synthetic turn');
  assert.equal(h.upstream.requests.length, 1);
  remove();
  agent.followup(user('The tool list now changed'));
  const view = await pending(h.helper, agent);
  assert.equal(view.turn, 2);
  assert.equal(view.step, 1);
  await assertNoExtraRequest(h.upstream, 1);
  assert.throws(() => h.helper.gate.decide({ ...view, sessionId: 'different-session', decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
  assert.throws(() => h.helper.gate.decide({ ...view, fingerprint: 'changed', decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
  assert.deepEqual(decide(h.helper, view, 'confirm'), { ok: true });
  assert.throws(() => decide(h.helper, view, 'confirm'), { code: 'CACHE_HELPER_STALE' });
  await agent.whenIdle();
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.helper.gate.pendingFor(view.sessionId), null);
  assert.equal(h.upstream.requests[1].headers['x-api-key'], 'synthetic-key-only');
  assert.equal(h.upstream.requests[1].path, '/anthropic/v1/messages');
});

test('native AgentLoop + DeepSeek HTTP: a tool change gates the next step inside the same turn', async t => {
  const h = await harness(t, { script: [
    { text: 'first step', toolCalls: [{ id: 'mutate-1', name: 'mutate', input: {} }] },
    { text: 'confirmed second step' },
  ] });
  const remove = registerTool(h.ctx, 'a_probe');
  h.ctx.tools.register(defineContentToolFixture({
    name: 'mutate', description: 'Synthetic test registry mutation', parameters: {},
    async execute() { remove(); return [{ type: 'text', text: 'Synthetic tool removed' }]; },
  }));
  const agent = await h.agent('gate-within-turn');
  agent.followup(user('Run the synthetic mutate tool'));
  const view = await pending(h.helper, agent);
  assert.equal(view.turn, 1);
  assert.equal(view.step, 2);
  await assertNoExtraRequest(h.upstream, 1);
  decide(h.helper, view, 'confirm');
  await agent.whenIdle();
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.upstream.requests[1].body.messages.at(-1).content[0].type, 'tool_result');
});

test('native AgentLoop + DeepSeek HTTP: cancel sends no additional request', async t => {
  const h = await harness(t, { script: [{ text: 'first' }] });
  const remove = registerTool(h.ctx, 'a_probe');
  registerTool(h.ctx, 'z_probe');
  const agent = await h.agent('gate-cancel');
  await send(agent, 'First');
  remove();
  agent.followup(user('Wait for me'));
  const view = await pending(h.helper, agent);
  await assertNoExtraRequest(h.upstream, 1);
  assert.deepEqual(decide(h.helper, view, 'cancel'), { ok: true });
  await agent.whenIdle();
  await assertNoExtraRequest(h.upstream, 1);
  assert.equal(h.helper.gate.pendingFor(view.sessionId), null);
  const metrics = await h.helper.getSession(view.sessionId);
  assert.equal(metrics.latest.cacheReadTokens, 100_000, 'A pre-send cancellation must not erase the latest actual cache receipt');
  assert.equal(metrics.cumulative.calls, 1, 'A candidate cancelled before HTTP dispatch is not a model call');
});

for (const operation of ['abort', 'unload']) {
  test(`native AgentLoop + DeepSeek HTTP: ${operation} releases the waiter without sending`, async t => {
    const h = await harness(t, { script: [{ text: 'first' }] });
    const remove = registerTool(h.ctx, 'a_probe');
    registerTool(h.ctx, 'z_probe');
    const agent = await h.agent(`gate-${operation}`);
    await send(agent, 'First');
    remove();
    agent.followup(user('Pending synthetic request'));
    const view = await pending(h.helper, agent);
    await assertNoExtraRequest(h.upstream, 1);
    if (operation === 'abort') agent.cancel({ kind: 'user' });
    else await h.helper.dispose();
    await agent.whenIdle();
    await assertNoExtraRequest(h.upstream, 1);
    assert.equal(h.helper.gate.pendingFor(view.sessionId), null);
    assert.throws(() => decide(h.helper, view, 'confirm'), { code: 'CACHE_HELPER_STALE' });
  });
}

test('native AgentLoop + DeepSeek HTTP: decisions are isolated between two sessions', async t => {
  const h = await harness(t, { script: [{ text: 'A first' }, { text: 'B first' }, { text: 'A confirmed' }] });
  const remove = registerTool(h.ctx, 'a_probe');
  registerTool(h.ctx, 'z_probe');
  const a = await h.agent('isolated-a');
  const b = await h.agent('isolated-b');
  await send(a, 'A first');
  await send(b, 'B first');
  remove();
  a.followup(user('A changed tools'));
  b.followup(user('B changed tools'));
  const [aView, bView] = await Promise.all([pending(h.helper, a), pending(h.helper, b)]);
  await assertNoExtraRequest(h.upstream, 2);
  assert.throws(() => h.helper.gate.decide({ ...aView, sessionId: bView.sessionId, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
  decide(h.helper, aView, 'confirm');
  await a.whenIdle();
  assert.equal(h.upstream.requests.length, 3);
  assert.equal(h.helper.gate.pendingFor(bView.sessionId)?.id, bView.id);
  decide(h.helper, bView, 'cancel');
  await b.whenIdle();
  await assertNoExtraRequest(h.upstream, 3);
});

test('native AgentLoop + DeepSeek HTTP: a changed Session invalidates pending confirmation', async t => {
  const h = await harness(t, { script: [{ text: 'first' }] });
  const remove = registerTool(h.ctx, 'a_probe');
  registerTool(h.ctx, 'z_probe');
  const agent = await h.agent('gate-session-revision');
  await send(agent, 'First');
  remove();
  agent.followup(user('Pending candidate'));
  const view = await pending(h.helper, agent);
  agent.session.append('user/message', user('Synthetic concurrent surface update'), { surfaceOp: 'append' });
  assert.throws(() => decide(h.helper, view, 'confirm'), { code: 'CACHE_HELPER_STALE' });
  await agent.whenIdle();
  await assertNoExtraRequest(h.upstream, 1);
  assert.equal(h.helper.gate.pendingFor(view.sessionId), null);
});

for (const scope of [
  { name: 'subagent-origin', meta: { origin: 'subagent' }, gated: false },
  { name: 'delegated', meta: { delegationDepth: 1 }, gated: false },
  { name: 'human-fork', meta: { parentSession: 'synthetic-parent', isSeeded: true }, gated: true },
]) {
  test(`scope: ${scope.name} has the expected native gate coverage`, async t => {
    const h = await harness(t, { script: [{ text: 'first' }, { text: 'second' }],
      config: { childProtection: scope.gated ? 'block' : 'observe' } });
    const remove = registerTool(h.ctx, 'a_probe');
    registerTool(h.ctx, 'z_probe');
    const agent = await h.agent(`scope-${scope.name}`, scope.meta);
    await send(agent, 'First');
    remove();
    agent.followup(user('Tools changed'));
    if (scope.gated) {
      const view = await pending(h.helper, agent);
      await assertNoExtraRequest(h.upstream, 1);
      decide(h.helper, view, 'cancel');
      await agent.whenIdle();
      assert.equal(h.upstream.requests.length, 1);
    } else {
      await agent.whenIdle();
      assert.equal(h.upstream.requests.length, 2);
      assert.equal(h.helper.gate.pendingFor(agent.session.header.id), null);
    }
  });
}

for (const meta of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
  test(`default child protection rejects high risk without native activation evidence: ${Object.keys(meta)[0]}`, async t => {
    const h = await harness(t, { script: [{ text: 'first' }, { text: 'must not send' }] });
    const remove = registerTool(h.ctx, 'a_probe'); registerTool(h.ctx, 'z_probe');
    const agent = await h.agent('metadata-without-native-witness', meta);
    await send(agent, 'First recorded input');
    remove(); agent.followup(user('Tools changed without a native activation'));
    await agent.whenIdle();
    await assertNoExtraRequest(h.upstream, 1);
    assert.equal(h.helper.gate.pendingFor(agent.session.id), null, 'Unsupported requests must not hang invisibly');
    const observation = h.helper.children.observations({ sessionId: agent.session.id })[0];
    assert.equal(observation.state, 'unsupported');
    assert.match(observation.reason, /activation/);
  });
}

test('stable appended input is not blocked; actual miss still creates a step warning', async t => {
  const h = await harness(t, { script: [
    { text: 'first', usage: { inputTokens: 100, cacheReadTokens: 100_000, cacheWriteTokens: 20, outputTokens: 8 } },
    { text: 'provider miss', usage: { inputTokens: 100_000, cacheReadTokens: 1_000, cacheWriteTokens: 0, outputTokens: 8 } },
  ] });
  const agent = await h.agent('stable-prefix-miss');
  await send(agent, 'First');
  await send(agent, 'Normal tail addition');
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.helper.gate.pendingFor(agent.session.header.id), null);
  const view = await h.helper.getSession(agent.session.header.id);
  assert.equal(view.latest.cacheReadTokens, 1_000);
  assert.equal(view.latest.hitRate, 1_000 / 101_000);
  assert.ok(view.warnings.some(warning => warning.turn === 2 && warning.step === 1));
  assert.equal(view.warnings.find(warning => warning.turn === 2).cause, 'upstream-unknown');
});

test('a native addition-only deferred tool activates after prior history without a false gate', async t => {
  const h = await harness(t, { script: [{ text: 'first' }, { text: 'deferred addition' }] });
  registerTool(h.ctx, 'a_probe');
  const agent = await h.agent('deferred-tool-append');
  await send(agent, 'First');
  registerTool(h.ctx, 'new_deferred', true);
  agent.followup(user('Tail turn with a deferred tool addition'));
  let timer;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A deferred append was unexpectedly blocked')), 1_000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.helper.gate.pendingFor(agent.session.header.id), null);
  assert.equal(h.upstream.requests[1].body.tools.find(tool => tool.name === 'new_deferred').defer_loading, true);
  assert.ok(h.upstream.requests[1].body.messages.some(message => message.content.some(block => block.type === 'tool_addition')));
});

test('warning recovery, dashboard metrics and dismissal survive helper reload without storing prompts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cache-helper-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'web-state.json');
  const h = await harness(t, { config: { persistState: true, statePath }, script: [
    { text: 'first', usage: { inputTokens: 100, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 8 } },
    { text: 'miss', usage: { inputTokens: 100_000, cacheReadTokens: 1_000, cacheWriteTokens: 0, outputTokens: 8 } },
    { text: 'recovered', usage: { inputTokens: 100, cacheReadTokens: 120_000, cacheWriteTokens: 0, outputTokens: 8 } },
  ] });
  const agent = await h.agent('persisted-warn-fixture');
  await send(agent, 'Private synthetic fixture prompt is never copied to warning state');
  await send(agent, 'Tail addition with server miss');
  await send(agent, 'Tail addition with recovered cache');
  const metrics = await h.helper.getSession(agent.session.header.id);
  assert.equal(metrics.warnings.length, 1);
  assert.equal(metrics.warnings[0].recovered, true);
  assert.equal(metrics.warnings[0].recoveredAt.turn, 3);
  assert.equal(metrics.warnings[0].dismissed, false);
  await h.helper.repository.dismiss({ sessionId: agent.session.header.id, id: metrics.warnings[0].id, dismissed: true });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(state, { version: 1, dismissed: [`${agent.session.header.id}:${metrics.warnings[0].id}`] });
  const dashboard = await h.helper.dashboard();
  assert.equal(dashboard.coverage.included, 1);
  assert.equal(dashboard.sessions[0].latest.cacheReadTokens, 120_000);
  assert.equal(dashboard.sessions[0].warningCount, 1);
  assert.ok(!JSON.stringify(dashboard).includes('Private synthetic fixture prompt'));
  await h.helper.dispose();
  const restored = await createCacheHelper(h.ctx, { registerHttp: false, persistState: true, statePath, minLostTokens: 1, minLossRatio: 0.01 });
  t.after(() => restored.dispose());
  const reloaded = await restored.getSession(agent.session.header.id);
  assert.equal(reloaded.warnings[0].dismissed, true);
  assert.equal(reloaded.warnings[0].recovered, true);
  assert.equal(reloaded.latest.cacheReadTokens, 120_000);
});

for (const model of [MODEL, 'deepseek-v4-pro']) {
  test(`session reconstruction equals actual serialized DeepSeek input (${model})`, async t => {
    const script = [
      { text: 'tool step', toolCalls: [{ id: 'fixture-call-1', name: 'echo', input: { text: 'synthetic' } }] },
      { text: 'tool result received' },
      { text: 'stable append' },
      { text: 'new prompt' },
      { text: 'removed tool' },
      { text: 'added tool' },
      { text: 'after surface replacement' },
    ];
    const h = await harness(t, { helper: false, model, script });
    let prompt = 'Synthetic first system prompt';
    h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
      ...await next(), sections: [{ name: 'test', text: prompt, order: 0 }],
    }));
    registerTool(h.ctx, 'echo');
    const remove = registerTool(h.ctx, 'spare');
    const agent = await h.agent(`reconstruct-${model}`);
    const observed = [];
    h.ctx.on('llm/stream', (options, next) => {
      if (isAgentLoopRequest(options)) observed.push(options);
      return next();
    });
    await send(agent, 'Use the synthetic echo tool');
    await send(agent, 'Append only');
    prompt = 'Synthetic updated system prompt';
    await send(agent, 'System updated');
    remove();
    await send(agent, 'One tool removed');
    registerTool(h.ctx, 'added');
    await send(agent, 'One tool added');
    const nodes = agent.session.surface.nodes;
    assert.ok(nodes.length >= 3);
    agent.session.append('user/message', user('[synthetic history summary]'), {
      surfaceOp: { op: 'replace', startSeq: nodes[1], endSeq: nodes.at(-1) },
      sourceEventSeqs: nodes.slice(1),
    });
    await send(agent, 'Continue after compaction-like surface replacement');
    const originalRequests = h.upstream.requests.map(request => structuredClone(request.body));
    assert.equal(originalRequests.length, 7);
    assert.equal(observed.length, originalRequests.length);
    const records = [{ type: 'session', ...agent.session.header }, ...agent.session.snapshotEvents()];
    const calls = reconstructCalls(records);
    assert.equal(calls.length, originalRequests.length);
    for (const [index, call] of calls.entries()) {
      assert.ok(call.request, `Missing reconstructed request ${index}`);
      assert.equal(call.unknown, undefined, `Uncertain reconstructed request ${index}`);
      const normalized = normalizeRequest(call.request);
      assert.equal(normalized.comparable, true, normalized.unknown);
      assert.deepEqual(
        { tools: normalized.tools, system: normalized.system, messages: normalized.messages },
        { tools: originalRequests[index].tools ?? [], system: originalRequests[index].system ?? '', messages: originalRequests[index].messages },
        `Analysis projection differs from captured wire input at ${call.turn}/${call.step}`,
      );
      h.upstream.enqueue({ text: `replay ${index}` });
      // The reconstructed input takes the same production runtime/serializer
      // path. It is intentionally not marked as a new AgentLoop conversation.
      const replay = { ...call.request, sessionId: `replay-${index}` };
      for await (const _chunk of h.ctx.llm.stream(replay)) { /* consume native SSE */ }
      assert.deepEqual(h.upstream.requests.at(-1).body, originalRequests[index], `Wire input mismatch at ${call.turn}/${call.step}`);
    }
    assert.equal(h.upstream.requests.length, originalRequests.length * 2);
  });
}
