import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { loadRuntime } from '../scripts/verify-runtime.mjs';
import { createFakeUpstream } from './fake-upstream.mjs';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionQueryEngine from '@deepseek-ai/dsh-session-query';

const testedModule = file => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', file)).href
  : new URL(`../src/${file}`, import.meta.url).href;
const { createCacheHelper } = await import(testedModule('index.mjs'));
export const { selectReceiptBaseline } = await import(testedModule('session-identity.mjs'));
export const { liveRecords } = await import(testedModule('repository.mjs'));
const modules = await loadRuntime();
const { Context } = modules['@deepseek-ai/cordis'];
const { DeepSeekAdapter, resolveAdapterOptions } = modules['@deepseek-ai/dsh-llm-deepseek'];
const { createUserMessage } = modules['@deepseek-ai/dsh-llm'];
const { defineContentToolFixture } = modules['@deepseek-ai/dsh-tools'];
export const content = text => [{ type: 'text', text }];
export const user = text => createUserMessage({ source: { kind: 'user' }, content: content(text) });
class FixtureSessionQuery extends SessionQueryEngine {
  async searchSessions() { throw new Error('Fixture does not run text search'); }
  async searchEvents() { throw new Error('Fixture does not run text search'); }
}

export async function eventually(read, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(4);
  }
  throw new Error(message);
}

export async function nativeChildHarness(t, { config = {}, script = [{ text: 'parent' }, { text: 'child' }] } = {}) {
  const upstream = await createFakeUpstream({ script });
  const root = await mkdtemp(join(tmpdir(), 'cache-helper-native-children-'));
  const ctx = new Context();
  let helper;
  t.after(async () => {
    await helper?.dispose();
    await ctx.fiber.dispose();
    await upstream.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection']) await ctx.plugin(modules[`@deepseek-ai/${name}`].default);
  await ctx.plugin(modules['@deepseek-ai/dsh-system-prompt'].default, { personaPrefix: 'Synthetic native child fixture.' });
  for (const name of ['dsh-tools', 'dsh-agent']) await ctx.plugin(modules[`@deepseek-ai/${name}`].default);
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' });
  await ctx.plugin(FixtureSessionQuery);
  await ctx.plugin(modules['@deepseek-ai/dsh-agent-loop'].default, { agents: [] });
  // The working-directory owner is real; its synthetic filesystem face only
  // witnesses the fixture directory and cannot read the user's filesystem.
  ctx.provide('fs', { resolve: async (path, options = {}) => resolve(options.cwd ?? '/synthetic', path),
    stat: async () => ({ type: 'directory' }), processPath: value => value });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: '/synthetic' });
  await ctx.plugin(Subagents, { maxDepth: 3, maxActiveSubagents: 8 });
  await ctx.plugin(Fork);
  await ctx.plugin(Spawn);
  ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: upstream.url, retryPolicy: { mode: 'normal', maxRetries: 0 } }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'synthetic-key-only' } }),
    resolveUserId: () => 'cache-helper-native-child-validation',
    resolveAttachments: () => undefined, prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  }));
  let route;
  ctx.provide('webServer', { register(value) { route = value; return () => { route = undefined; }; } });
  ctx.provide('connection', { browserPeer: { id: 'synthetic-browser' },
    admit: req => req.unauthorized || !req.headers?.cookie?.includes('cache-helper-fixture-browser=1')
      ? { rejection: 401 } : { peer: { id: req.operator ? 'synthetic-operator' : 'synthetic-browser' } } });
  helper = await createCacheHelper(ctx, { registerHttp: false, persistState: false,
    minLostTokens: 1, minLossRatio: 0.01, childProtection: 'block', ...config });
  helper.children.reachable({ channelId: 'synthetic-visible-global-ui', seq: 1, reachable: true });
  const remove = ctx.tools.register(defineContentToolFixture({ name: 'old_prefix_tool',
    description: 'Synthetic removed declaration.', parameters: {}, execute: async () => content('unused') }));
  ctx.tools.register(defineContentToolFixture({ name: 'stable_tool', description: 'Stable synthetic declaration.',
    parameters: {}, execute: async () => content('unused') }));
  const parent = await ctx.agentLoop.create('native-parent', { provider: 'deepseek-official', model: 'deepseek-flash' }, { cwd: '/synthetic' });
  parent.followup(user('First synthetic parent turn'));
  await parent.whenIdle();
  const start = (id, provider = 'fork', owner = parent) => ctx.subagents.startActivation({ provider,
    label: id, childId: id, request: { parent: owner, prompt: content(`Synthetic child ${id}`) },
    signal: new AbortController().signal, delivery: 'caller' });
  async function request(method, path, body, authentication = {}) {
    assert.ok(route, 'HTTP registration is enabled for this fixture');
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: `/dsh-cache-helper/api${path}`, headers: { 'content-type': 'application/json', cookie: 'cache-helper-fixture-browser=1' }, ...authentication });
    const res = new EventEmitter();
    const answer = {};
    res.writeHead = status => { answer.status = status; };
    res.end = value => { answer.value = JSON.parse(value); res.writableEnded = true; res.emit('close'); };
    await route.handler(req, res);
    return answer;
  }
  return { ctx, helper, upstream, parent, remove, start, request,
    httpHandler: (req, res) => { assert.ok(route); return route.handler(req, res); } };
}
