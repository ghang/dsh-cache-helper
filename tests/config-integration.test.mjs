import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { fixture, usage } from './history-fixtures.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const dependency = spec => import(pathToFileURL(require.resolve(spec)).href);
const [{ boot, initProfile, readProfilePatches }, { default: ConfigEditor }, { default: Settings }] = await Promise.all([
  dependency('@deepseek-ai/dsh-app-boot'),
  dependency('@deepseek-ai/dsh-config-editor'),
  dependency('@deepseek-ai/dsh-settings'),
]);
const testedModule = file => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', file)).href
  : new URL(`../src/${file}`, import.meta.url).href;
const { Config, createCacheHelper, apply: applyPlugin } = await import(testedModule('index.mjs'));

/** A real Loader + SettingsForms + ConfigEditor with only synthetic Session data. */
async function configurationHarness(t, { production = false } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cache-helper-config-')));
  const dir = join(home, 'profiles', 'web');
  initProfile(dir, ['cache-helper-config-fixture']);
  const bundle = join(dir, 'node_modules', 'cache-helper-config-fixture');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(home, 'package.json'), '{"name":"cache-helper-config-fixture"}\n');
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'cache-helper-config-fixture', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }));
  // The inherited layer differs from the schema default: unset must restore
  // 60k rather than silently writing the plugin's 50k default into the profile.
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:config-editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'cache-helper', name: 'cordis:cache-helper', config: { minLostTokens: 60_000 } },
  ] }]));
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const profile = {
    name: 'web', startedBundles: ['cache-helper-config-fixture'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  };
  const f = fixture({ text: 'Synthetic configuration history' });
  f.response(usage(100, 100_000));
  f.next();
  f.response(usage(100_100, 0));
  let helper;
  let mounts = 0;
  let disposals = 0;
  const contexts = [];
  const routes = [];
  const Probe = {
    name: 'cache-helper', Config,
    async apply(ctx, config) {
      mounts += 1;
      if (production) {
        await applyPlugin(ctx, { ...config, persistState: false });
        ctx.effect(() => () => { disposals += 1; });
        return;
      }
      // The wrapper exposes the production helper API to assertions. The
      // configuration schema, volatile references and persistence are real;
      // no callback stands in for SettingsForms or ConfigEditor.
      const current = await createCacheHelper(ctx, { ...config, registerHttp: false, persistState: false });
      helper = current;
      ctx.on('loader/volatile-update', () => { current.updateResolvedConfig(config); });
      ctx.effect(() => async () => { disposals += 1; await current.dispose(); });
    },
  };
  const start = async () => {
    const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), ctx => {
      ctx.provide('profileContext', profile);
      ctx.provide('appReady', { onReady: listener => { listener(); return () => {}; } });
      ctx.provide('llm', {});
      ctx.provide('webServer', { register: route => {
        routes.push(route);
        return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); };
      } });
      ctx.provide('connection', {
        admit: () => ({ peer: { id: 'synthetic-browser' } }), browserPeer: { id: 'synthetic-browser' },
      });
      ctx.provide('sessions', {
        get: id => id === f.session.id ? f.session : undefined,
        list: () => [f.session], messageProjections: [],
      });
      Object.assign(ctx.loader.builtins, { 'config-editor': ConfigEditor, settings: Settings, 'cache-helper': Probe });
    });
    contexts.push(ctx);
    return ctx;
  };
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  });
  const ctx = await start();
  return { ctx, start, profile, f,
    get helper() { return helper; },
    get mounts() { return mounts; },
    get disposals() { return disposals; },
    descriptor: context => (context ?? ctx).settings.describe().find(row => row.ns === 'cache-helper'),
    async sessionApi() {
      const route = routes.find(route => route.path === '/dsh-cache-helper/api');
      assert.ok(route, 'Production apply registers the browser API');
      let status;
      let value;
      await route.handler({ method: 'GET', url: `/dsh-cache-helper/api/session?sessionId=${encodeURIComponent(f.session.id)}`, headers: {} }, {
        writeHead: code => { status = code; }, end: body => { value = JSON.parse(body); },
      });
      assert.equal(status, 200);
      return value;
    },
  };
}

test('real Host settings persist a volatile policy without replacing a frozen pending request', async t => {
  const h = await configurationHarness(t);
  const initial = h.helper.policy.snapshot();
  const before = await h.helper.getSession(h.f.session.id);
  assert.equal(before.policyVersion, 1);
  assert.equal(before.warnings.length, 1);
  const entry = [...h.ctx.loader.entries()].find(row => row.options.id === 'cache-helper');
  const fiber = entry.fiber;
  let settled = false;
  const wait = h.helper.gate.wait({ lossTokens: 100_000, policy: initial }, {
    sessionId: h.f.session.id, fingerprint: 'synthetic-config-candidate', turn: 2, step: 1,
  });
  void wait.then(() => { settled = true; }, () => { settled = true; });
  const pending = h.helper.gate.pendingFor(h.f.session.id);
  t.after(async () => { h.helper.gate.cancel(h.f.session.id); await wait.catch(() => {}); });
  const read = h.descriptor();
  await h.ctx.settings.mutate('cache-helper', [{ op: 'set', path: ['minLostTokens'], value: 200_000 }], read.revision);
  assert.match(await readFile(h.profile.patchPath, 'utf8'), /minLostTokens: 200000/);
  assert.equal(entry.fiber, fiber, 'Volatile saves keep the live plugin fiber');
  assert.equal(h.mounts, 1);
  assert.equal(h.disposals, 0);
  assert.equal(h.helper.policy.snapshot().version, 2);
  assert.equal(h.helper.policy.snapshot().values.minLostTokens, 200_000);
  const after = await h.helper.getSession(h.f.session.id);
  assert.equal(after.policyVersion, 2);
  assert.equal(after.warnings.length, 0, 'Accepted strategy invalidates derived results without a new Session event');
  assert.equal(settled, false);
  assert.deepEqual(h.helper.gate.pendingFor(h.f.session.id), pending);
  assert.equal(pending.policy.values.minLostTokens, 60_000);
  const current = h.descriptor();
  await h.ctx.settings.mutate('cache-helper', [{ op: 'unset', path: ['minLostTokens'] }], current.revision);
  assert.equal(h.helper.policy.snapshot().values.minLostTokens, 60_000);
  assert.equal(h.descriptor().user.minLostTokens, undefined);
  assert.doesNotMatch(await readFile(h.profile.patchPath, 'utf8'), /minLostTokens/);
  assert.equal((await h.helper.getSession(h.f.session.id)).warnings.length, 1);
  assert.deepEqual(h.helper.gate.pendingFor(h.f.session.id), pending);
});

test('real Host validation and unreadable profile refuse saves without changing the accepted policy', async t => {
  const h = await configurationHarness(t);
  const initial = h.helper.policy.snapshot();
  const descriptor = h.descriptor();
  const before = await readFile(h.profile.patchPath, 'utf8');
  await assert.rejects(h.ctx.settings.mutate('cache-helper', [{ op: 'set', path: ['minLossRatio'], value: 2 }], descriptor.revision));
  for (const field of ['minLostTokens', 'maxEvents']) {
    await assert.rejects(h.ctx.settings.mutate('cache-helper', [
      { op: 'set', path: [field], value: Number.MAX_SAFE_INTEGER + 1 },
    ], descriptor.revision));
  }
  assert.equal(await readFile(h.profile.patchPath, 'utf8'), before);
  assert.equal(h.helper.policy.snapshot(), initial);
  await writeFile(h.profile.patchPath, 'broken: [\n');
  await assert.rejects(h.ctx.settings.mutate('cache-helper', [{ op: 'set', path: ['dashboardLimit'], value: 20 }], descriptor.revision));
  assert.equal(h.helper.policy.snapshot(), initial);
  assert.equal(h.mounts, 1);
  await writeFile(h.profile.patchPath, before);
});

test('real Host concurrent writers share one revision fence and persisted values survive reopening', async t => {
  const h = await configurationHarness(t);
  const read = h.descriptor();
  const outcomes = await Promise.allSettled([20, 30].map(value => h.ctx.settings.mutate('cache-helper', [
    { op: 'set', path: ['dashboardLimit'], value },
  ], read.revision)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const refused = outcomes.find(result => result.status === 'rejected');
  assert.equal(refused.reason.code, 'SETTINGS_CONFLICT');
  const accepted = h.helper.policy.snapshot().values.dashboardLimit;
  assert.ok([20, 30].includes(accepted));
  assert.equal(h.mounts, 1);
  await h.ctx.fiber.dispose();
  const reopened = await h.start();
  assert.equal(h.helper.policy.snapshot().values.dashboardLimit, accepted);
  assert.equal(h.descriptor(reopened).value.dashboardLimit, accepted);
});

test('production apply wires Host volatile events to the browser metrics API', async t => {
  const h = await configurationHarness(t, { production: true });
  const before = await h.sessionApi();
  assert.equal(before.policyVersion, 1);
  assert.equal(before.warnings.length, 1);
  const read = h.descriptor();
  await h.ctx.settings.mutate('cache-helper', [
    { op: 'set', path: ['minLostTokens'], value: 200_000 },
  ], read.revision);
  const after = await h.sessionApi();
  assert.equal(after.policyVersion, 2);
  assert.equal(after.config.minLostTokens, 200_000);
  assert.equal(after.warnings.length, 0);
  assert.equal(h.mounts, 1);
  assert.equal(h.disposals, 0);
});
