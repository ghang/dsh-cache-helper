import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const defaults = { minLostTokens: 50000, minLossRatio: 0.2, dashboardLimit: 50, maxEvents: 200000, maxCachedSessions: 64 };
const receipt = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0,
  outputTokens: 10, promptTokens: 1000, hitRate: 0.9 };
const NOW = Date.parse('2026-10-22T13:00:00Z');
const group = (calls, extra = {}) => ({ calls, knownCacheReadTokens: calls * 900, cacheUnknownCalls: 0, failedAttempts: 0, ...extra });
const warning = { id: 'child-warning', seq: 42, turn: 2, step: 3, at: NOW, lossTokens: 900,
  cacheReadTokens: 1, hitRate: 0.001, missTokens: 999, summary: '合成工具变更异常',
  changes: [{ kind: 'tools', message: '合成工具声明变化', removed: ['synthetic-tool'] }] };
const detail = (id, role = 'main') => ({ sessionId: id, title: id === 'child' ? '合成子会话' : '合成主会话', role,
  latest: receipt, cumulative: receipt, config: defaults, warnings: id === 'child' ? [warning] : [], pending: null,
  calls: [{ seq: id === 'child' ? 42 : 20, turn: 2, step: 3, at: NOW, usage: receipt }], turns: [] });

async function selectTab(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
}

async function selectChildSession(page) {
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: /合成子会话/ }).click();
  await page.getByRole('region', { name: '调用步骤明细', exact: true }).getByRole('heading', { name: '合成子会话', exact: true }).waitFor();
}

async function fixture(t, options = {}) {
  const localRequire = createRequire(new URL('../package.json', import.meta.url));
  const browserRequire = process.env.DSH_BROWSER_TEST_MODULES
    ? createRequire(join(resolve(process.env.DSH_BROWSER_TEST_MODULES), '__dsh_next_test__.cjs')) : localRequire;
  const reactRequire = process.env.DSH_REACT_TEST_MODULES
    ? createRequire(join(resolve(process.env.DSH_REACT_TEST_MODULES), '__dsh_next_test__.cjs')) : localRequire;
  const { chromium } = browserRequire('playwright');
  const clientPath = process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
    ? resolve(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib/client.js') : join(ROOT, 'src/client.js');
  const [client, react, reactDOM, theme] = await Promise.all([
    readFile(clientPath, 'utf8'),
    readFile(join(dirname(reactRequire.resolve('react/package.json')), 'umd/react.development.js'), 'utf8'),
    readFile(join(dirname(reactRequire.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8'),
    readFile(new URL('./fixtures/host-theme.css', import.meta.url), 'utf8'),
  ]);
  const requests = [];
  const sessions = options.sessions ?? { main: detail('main'), child: detail('child', 'sub') };
  const preview = { id: 'operation-one', sessionId: 'main', state: 'prepared', available: true,
    route: { provider: 'synthetic-provider', model: 'synthetic-model' },
    input: { acceptedInHistory: true }, context: { beforeTokens: 100000, afterTokens: null }, summaryCalls: [] };
  const state = { job: structuredClone(preview), startDelay: 100, statisticsReadTokens: options.statisticsReadTokens ?? 2700 };
  const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/dsh-cache-helper/api/')) {
      let body;
      if (request.method === 'POST') { let raw = ''; for await (const chunk of request) raw += chunk; body = JSON.parse(raw); }
      requests.push({ path: url.pathname, search: Object.fromEntries(url.searchParams), method: request.method, body });
      if (url.pathname.endsWith('/dashboard')) return json(response, {
        sessions: Object.values(sessions).map(item => ({ ...item, warningCount: item.sessionId === 'main' ? 2 : 1 })),
        generatedAt: NOW, policyVersion: 3, coverage: { scanned: 2, total: 20, limit: 2, limited: true, errors: [] },
        statistics: { totals: { calls: 3, cacheKnownCalls: 2, knownCacheReadTokens: state.statisticsReadTokens, knownHitRate: 0.9, estimatedLossTokens: 900,
          warnings: 1, recoveredWarnings: 0, expectedRebuilds: 1, cacheUnknownCalls: 1, coldStarts: 1, emptyAttempts: 2,
          unrecordedAuxiliaryOperations: 1 },
          groups: { main: group(1), sub: group(1), auxiliary: group(1, { cacheUnknownCalls: 1 }), unknown: group(0) },
          byDate: options.byDate ?? [{ date: '2026-10-22', calls: 2, warnings: 1 }, { date: 'unknown', calls: 1, warnings: 0 }],
          byModel: options.byModel ?? [{ provider: 'synthetic-provider', model: 'model-a', calls: 2 }, { provider: null, model: null, calls: 1 }],
          availableModels: [{ provider: 'synthetic-provider', model: 'model-a' }],
          recommendations: [{ id: 'tools', title: '检查工具声明变化', message: '合成建议依赖实际异常步骤。',
            evidence: [options.evidence ?? { sessionId: 'child', seq: 42, turn: 2, step: 3 }] }],
          coverage: { ownershipUnknownCalls: 1, unknownDateCalls: 1, auxiliaryRecordingComplete: false } },
      });
      if (url.pathname.endsWith('/session')) return json(response, sessions[url.searchParams.get('sessionId')] ?? detail('main'));
      if (url.pathname.endsWith('/operations/preview') || url.pathname.endsWith('/operations')) return json(response, state.job);
      if (url.pathname.endsWith('/operations/start')) {
        await new Promise(done => setTimeout(done, state.startDelay));
        state.job = { ...state.job, state: 'compacting', branchId: 'synthetic-branch' };
        return json(response, state.job);
      }
      if (url.pathname.endsWith('/operations/cancel')) { state.job = { ...state.job, state: 'cancelled', cancelRequested: true }; return json(response, state.job); }
      return json(response, { error: 'Unexpected fixture API' }, 404);
    }
    const scripts = { '/client.js': client, '/react.js': react, '/react-dom.js': reactDOM };
    if (scripts[url.pathname]) { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(scripts[url.pathname]); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}\nbody{margin:0}#app{max-width:960px;margin:16px auto;padding:12px;box-sizing:border-box}</style><body><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
      window.__registrations=[];window.__cleanups=[];window.__writes=[];window.__openCalls=[];window.__tabCalls=[];window.__nextWriteFailure=false;window.__contextMode='missing';window.__mountedValue=null;
      window.__formListeners=new Set();window.__mountedListeners=new Set();window.__formEnabled=true;
      const defaults=${JSON.stringify(defaults)};
      const base={...defaults,minLostTokens:60000};
      let user={minLostTokens:80000};
      let snapshot={status:'ready',writable:true,value:{...base,...user},base,user,revision:7};
      const publish=next=>{snapshot={...snapshot,...next};__formListeners.forEach(listener=>listener())};
      window.__publishForm=publish;
      window.__form={getSnapshot:()=>snapshot,subscribe(listener){__formListeners.add(listener);return()=>__formListeners.delete(listener)},async mutate(ops,expectedRevision){
        __writes.push({ops,expectedRevision});
        if(__nextWriteFailure){__nextWriteFailure=false;throw new Error('合成保存失败')}
        if(expectedRevision!==snapshot.revision)return false;
        user={...user};for(const op of ops){if(op.op==='unset')delete user[op.path[0]];else user[op.path[0]]=op.value}
        publish({value:{...base,...user},base,user,revision:snapshot.revision+1});return true;
      }};
      const mounted={getSnapshot:()=>__mountedValue,subscribe(listener){__mountedListeners.add(listener);return()=>__mountedListeners.delete(listener)}};
      window.__mount=value=>{__mountedValue=value;__mountedListeners.forEach(listener=>listener())};
      const services={uiWorkspace:{openSession(id){__openCalls.push(id);if(__contextMode==='ready')__mount(id);else if(__contextMode==='delayed')setTimeout(()=>__mount(id),50)}},sidebarRight:{mounted,openTab(id){__tabCalls.push(id)}},sidebarRightTabs:{get(id){return __contextMode==='missing'?undefined:{id}}}};
      window.__ModuleLoader__={load(definition){window.__plugin=definition.factory(name=>name==='react'?React:ReactDOM)}};
    </script><script src="/client.js"></script><script>
      __plugin.apply({slots:{inject(name,callback){return callback()},register(meta,component){__registrations.push({meta,component});return()=>{}}},configForms:{get(id){return __formEnabled?__form:undefined}},get(name){return services[name]},effect(effect){__cleanups.push(effect())}});
      const root=ReactDOM.createRoot(document.getElementById('app'));let generation=0;
      window.__render=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(__registrations.find(item=>item.meta.id==='dsh-cache-helper').component,{key:++generation})));
      window.__dispose=()=>{root.unmount();__cleanups.forEach(cleanup=>cleanup&&cleanup())};__render();
    </script></body></html>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(done => server.close(done)); });
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_BROWSER_CHANNEL ? { channel: process.env.DSH_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('tab', { name: '概览', exact: true }).waitFor();
  await page.getByRole('region', { name: '缓存专项统计' }).waitFor();
  return { page, requests, state, errors };
}

test('browser next: horizontal dashboard tabs expose one page and support keyboard navigation', async t => {
  const { page, errors } = await fixture(t);
  const tabs = page.getByRole('tablist');
  assert.deepEqual(await tabs.getByRole('tab').allTextContents(), ['概览', '日期与模型', '会话明细', '设置']);
  assert.equal(await tabs.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tabpanel').count(), 1, 'Inactive pages must not stack below the active page');
  assert.equal(await page.getByRole('form', { name: '缓存策略配置' }).isVisible(), false);
  assert.equal(await page.getByRole('region', { name: '调用步骤明细', exact: true }).isVisible(), false);
  await tabs.getByRole('tab', { name: '概览', exact: true }).focus();
  const assertKeyboardTab = async (key, label) => {
    await page.keyboard.press(key);
    await page.waitForFunction(expected => document.activeElement?.getAttribute('role') === 'tab'
      && document.activeElement?.getAttribute('aria-selected') === 'true'
      && document.activeElement?.textContent === expected, label);
    const selected = tabs.getByRole('tab', { name: label, exact: true });
    assert.equal(await selected.getAttribute('tabindex'), '0');
    const panel = page.getByRole('tabpanel');
    assert.equal(await panel.count(), 1);
    assert.equal(await panel.getAttribute('id'), await selected.getAttribute('aria-controls'));
  };
  await assertKeyboardTab('ArrowRight', '日期与模型');
  await page.getByRole('img', { name: '每日调用次数', exact: true }).waitFor();
  await page.getByRole('img', { name: '模型调用分布', exact: true }).waitFor();
  await assertKeyboardTab('End', '设置');
  await page.getByRole('form', { name: '缓存策略配置' }).waitFor();
  await assertKeyboardTab('ArrowRight', '概览');
  await assertKeyboardTab('ArrowLeft', '设置');
  await assertKeyboardTab('Home', '概览');
  assert.equal(await page.getByText('分析建议', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('browser next: date and model charts use uppercase units and retain unknown buckets', async t => {
  const { page, errors } = await fixture(t, {
    statisticsReadTokens: 1_200_000,
    byDate: [{ date: '2026-10-22', calls: 20000, warnings: 1000 }, { date: 'unknown', calls: 1, warnings: 0 }],
    byModel: [{ provider: 'synthetic-provider', model: 'model-a', calls: 20000 }, { provider: null, model: null, calls: 1 }],
  });
  assert.match(await page.getByRole('region', { name: '缓存专项统计' }).innerText(), /1\.20?M tok/);
  await selectTab(page, '日期与模型');
  const charts = page.getByRole('region', { name: '日期与模型分布', exact: true });
  await charts.getByRole('img', { name: '每日调用次数', exact: true }).waitFor();
  await charts.getByRole('img', { name: '模型调用分布', exact: true }).waitFor();
  const text = await charts.textContent();
  assert.match(text, /日期未知|未知日期/);
  assert.match(text, /未知模型/);
  assert.match(text, /20(?:\.0)?K/);
  assert.doesNotMatch(text, /NaN|Infinity|\d(?:\.\d+)?[km]\b/);
  assert.equal(await page.getByRole('region', { name: '调用步骤明细', exact: true }).isVisible(), false);
  await page.setViewportSize({ width: 360, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
    'Chart and tab scrolling must stay inside the dashboard');
  assert.deepEqual(errors, []);
});

test('browser next: daily chart values appear immediately on hover and focus without native title delay', async t => {
  const { page, errors } = await fixture(t, {
    byDate: [{ date: '2026-10-22', calls: 20000, warnings: 1000 }, { date: 'unknown', calls: 0, warnings: null }],
  });
  await selectTab(page, '日期与模型');
  const column = page.getByRole('img', { name: '2026-10-22：20,000 次调用，1,000 次异常', exact: true });
  const tooltip = page.getByRole('tooltip');
  await column.hover();
  await tooltip.waitFor({ state: 'visible', timeout: 300 });
  assert.match(await tooltip.innerText(), /2026-10-22\s+调用 20,000 次\s+异常 1,000 次/);
  assert.equal(await page.locator('.dch-chart-scroll title').count(), 0, 'Native delayed tooltips must not overlay the immediate values');
  await page.getByRole('heading', { name: '每日调用次数', exact: true }).hover();
  await tooltip.waitFor({ state: 'detached', timeout: 300 });
  await column.focus();
  await tooltip.waitFor({ state: 'visible', timeout: 300 });
  await column.press('Escape');
  await tooltip.waitFor({ state: 'detached', timeout: 300 });
  const unknown = page.getByRole('img', { name: '日期未知：0 次调用，未知 次异常', exact: true });
  await unknown.focus();
  await tooltip.waitFor({ state: 'visible', timeout: 300 });
  assert.match(await tooltip.innerText(), /日期未知\s+调用 0 次\s+异常 未知 次/);
  await page.setViewportSize({ width: 360, height: 900 });
  await column.focus();
  await unknown.focus();
  await tooltip.waitFor({ state: 'visible', timeout: 300 });
  const bounds = await tooltip.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y >= 0 && bounds.y + bounds.height <= 900, 'Tooltip stays inside a narrow viewport');
  await selectTab(page, '概览');
  assert.equal(await tooltip.count(), 0, 'Tooltip must not leak into another tab');
  assert.deepEqual(errors, []);
});

test('browser next: empty distributions show an explicit empty state instead of fabricated charts', async t => {
  const { page, errors } = await fixture(t, { byDate: [], byModel: [] });
  await selectTab(page, '日期与模型');
  await page.getByText('所选范围暂无日期记录', { exact: true }).waitFor();
  await page.getByText('所选范围暂无模型记录', { exact: true }).waitFor();
  const charts = page.getByRole('region', { name: '日期与模型分布', exact: true });
  assert.doesNotMatch(await charts.textContent(), /NaN|Infinity|100%/);
  assert.deepEqual(errors, []);
});

test('browser next: model bar widths show their share of all calls instead of their ratio to the largest model', async t => {
  const { page, errors } = await fixture(t, {
    byDate: [{ date: '2026-10-22', calls: 150, warnings: 0 }],
    byModel: [
      { provider: 'synthetic-provider', model: 'model-100', calls: 100 },
      { provider: 'synthetic-provider', model: 'model-50', calls: 50 },
    ],
  });
  await selectTab(page, '日期与模型');
  const chart = page.getByRole('img', { name: '模型调用分布', exact: true });
  await chart.waitFor();
  for (const [model, expected, label] of [['model-100', 100 / 150 * 100, '66.7%'], ['model-50', 50 / 150 * 100, '33.3%']]) {
    const row = chart.locator('.dch-model-row').filter({ hasText: model });
    const track = await row.locator('.dch-model-track').boundingBox();
    const fill = await row.locator('.dch-model-fill').boundingBox();
    assert.ok(track && fill && track.width > 0, 'The call-share bar must have a rendered track');
    const renderedPercent = fill.width / track.width * 100;
    assert.ok(Math.abs(renderedPercent - expected) < 0.3,
      `${model} occupies ${expected.toFixed(1)}% of its track, observed ${renderedPercent.toFixed(1)}%`);
    assert.match(await row.innerText(), new RegExp(label.replace('.', '\\.')));
  }
  assert.deepEqual(errors, []);
});

test('browser next: policy drafts save atomically and survive transport failure and revision conflict', async t => {
  const { page, errors } = await fixture(t);
  await selectTab(page, '设置');
  const editor = page.getByRole('form', { name: '缓存策略配置' });
  const minimum = editor.getByLabel('最小损失 Token', { exact: true });
  await minimum.fill('90000');
  assert.equal(await page.evaluate(() => __writes.length), 0, 'Typing must not persist a partial policy');
  await selectTab(page, '概览');
  assert.equal(await editor.isVisible(), false, 'The settings page must not remain stacked under the overview');
  await selectTab(page, '设置');
  assert.equal(await minimum.inputValue(), '90000', 'Switching tabs must preserve an unsaved policy draft');
  assert.equal(await page.evaluate(() => __writes.length), 0, 'Tab navigation must not save or discard a draft');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存并热生效；已有待确认请求仍需人工决定。').waitFor();
  let writes = await page.evaluate(() => __writes);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ops.length, 5);
  assert.ok(writes[0].ops.every(op => op.op === 'set' && typeof op.value === 'number'));
  assert.equal(writes[0].expectedRevision, 7);
  await page.evaluate(() => { __nextWriteFailure = true; });
  await minimum.fill('91000');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('合成保存失败。草稿已保留。').waitFor();
  assert.equal(await minimum.inputValue(), '91000');
  assert.equal(await page.evaluate(() => __writes.length), 2, 'A failed mutation must not automatically retry');
  await page.evaluate(() => { __publishForm({ value: { ...__form.getSnapshot().value, minLostTokens: 120000 }, revision: 9 }); });
  assert.equal(await minimum.inputValue(), '91000', 'A remote update must not overwrite a dirty draft');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('保存被拒绝，配置可能已变更。草稿已保留；请重新读取后再保存。').waitFor();
  assert.equal(await minimum.inputValue(), '91000');
  await editor.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="最小损失 Token"]').value === '120000');
  await editor.getByRole('button', { name: '恢复继承默认', exact: true }).click();
  assert.equal(await minimum.inputValue(), '60000', 'Unset preview must use the actual composition base');
  assert.equal(await page.evaluate(() => __writes.length), 3, 'Resetting the draft must wait for explicit save');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存并热生效；已有待确认请求仍需人工决定。').waitFor();
  writes = await page.evaluate(() => __writes);
  assert.ok(writes.at(-1).ops.every(op => op.op === 'unset' && !Object.hasOwn(op, 'value')));
  assert.equal(writes.at(-1).expectedRevision, 9);
  assert.equal(await minimum.inputValue(), '60000');
  await editor.getByLabel('扫描会话数', { exact: true }).fill('201');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  assert.equal(await page.evaluate(() => __writes.length), 4, 'Out-of-range form input must not mutate settings');
  await editor.getByLabel('扫描会话数', { exact: true }).fill('50');
  await page.evaluate(() => { __publishForm({ writable: false }); });
  await page.waitForFunction(() => document.querySelector('input[aria-label="最小损失 Token"]').disabled || document.querySelector('input[aria-label="最小损失 Token"]').closest('fieldset').disabled);
  assert.equal(await minimum.isDisabled(), true);
  await page.evaluate(() => { __formEnabled = false; __render(); });
  await selectTab(page, '设置');
  await page.getByText('当前宿主未提供可编辑配置；缓存看板仍可使用。').waitFor();
  await selectTab(page, '概览');
  await page.getByRole('region', { name: '缓存专项统计' }).waitFor();
  await page.evaluate(() => __dispose());
  assert.equal(await page.evaluate(() => __formListeners.size), 0);
  assert.deepEqual(errors, []);
});

test('browser next: statistics filters, unknown coverage and direct call evidence remain usable in narrow layouts', async t => {
  const { page, requests, errors } = await fixture(t);
  await page.getByLabel('统计时间', { exact: true }).selectOption('30d');
  await page.waitForFunction(() => document.querySelector('select[aria-label="统计时间"]').value === '30d');
  await page.getByLabel('统计模型', { exact: true }).selectOption('model-a');
  await page.getByRole('region', { name: '缓存专项统计' }).getByText('辅助调用', { exact: true }).waitFor();
  await page.getByRole('region', { name: '缓存专项统计' }).getByText('数据覆盖与未知项', { exact: true }).click();
  const texts = await page.getByRole('region', { name: '缓存专项统计' }).innerText();
  assert.match(texts, /主会话/); assert.match(texts, /子会话/); assert.match(texts, /角色未知/);
  assert.match(texts, /1 次缓存用量未知/); assert.match(texts, /发送状态未知/); assert.match(texts, /未记录不代表零开销/);
  assert.match(texts, /未记录辅助操作 1 次/);
  assert.equal(await page.getByRole('region', { name: '缓存分析建议', exact: true }).count(), 0);
  assert.equal(await page.getByText('分析建议', { exact: true }).count(), 0);
  assert.ok(requests.some(item => item.search.period === '30d' && item.search.model === 'model-a'));
  await selectChildSession(page);
  await page.getByRole('checkbox', { name: '只看异常', exact: true }).check();
  await page.locator('[data-cache-evidence-seq="42"]').waitFor();
  assert.equal(await page.getByRole('region', { name: '调用步骤明细', exact: true }).getByRole('row').filter({ hasText: '第 2 轮 · 步骤 3' }).count(), 1);
  await page.setViewportSize({ width: 360, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.deepEqual(errors, []);
});

test('browser next: retry warnings match the exact settlement while legacy records retain their step fallback', async t => {
  const retry = detail('child', 'sub');
  retry.calls = [
    { seq: 41, turn: 2, step: 3, at: NOW, settlement: 'assistant/attempt', usage: receipt },
    { seq: 42, turn: 2, step: 3, at: NOW, settlement: 'assistant/message', usage: receipt },
    { turn: 4, step: 1, at: NOW, settlement: 'assistant/message', usage: receipt },
  ];
  retry.warnings = [
    { ...warning, seq: 41 },
    { ...warning, id: 'legacy-warning', seq: undefined, turn: 4, step: 1 },
  ];
  const { page, errors } = await fixture(t, { sessions: { main: detail('main'), child: retry } });
  await selectChildSession(page);
  await page.getByRole('checkbox', { name: '只看异常', exact: true }).check();
  const panel = page.getByRole('region', { name: '调用步骤明细', exact: true });
  await panel.locator('.dch-call-warning[data-cache-evidence-seq="41"]').waitFor();
  assert.equal(await panel.locator('[data-cache-evidence-seq="42"]').count(), 0,
    'Only-warning mode must not include a later success that reused the failed attempt\'s turn and step');
  const legacyRow = panel.getByRole('row').filter({ hasText: '第 4 轮 · 步骤 1' });
  assert.equal(await legacyRow.count(), 1, 'A legacy record without a reliable sequence still matches its warning');
  assert.match(await legacyRow.getAttribute('class'), /dch-call-warning/);
  await page.getByRole('checkbox', { name: '只看异常', exact: true }).uncheck();
  const recovered = panel.locator('[data-cache-evidence-seq="42"]');
  await recovered.waitFor();
  assert.doesNotMatch(await recovered.getAttribute('class'), /dch-call-warning/,
    'Conflicting event sequences must never fall back to a shared turn and step');
  assert.equal(await recovered.getByText('无异常记录', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
});

test('browser next: compaction is started once, survives closing, and waits for manual branch continuation', async t => {
  const { page, requests, state, errors } = await fixture(t);
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: '生成精简副本', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '生成精简副本', exact: true });
  await dialog.getByRole('button', { name: '创建副本并生成摘要', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '关闭精简副本结果', exact: true }).count(), 1);
  const explanation = await dialog.innerText();
  assert.match(explanation, /原会话/);
  assert.match(explanation, /摘要/);
  assert.match(explanation, /用量|费用/);
  assert.match(explanation, /手动继续|先检查摘要，再决定是否继续/);
  assert.equal(requests.filter(item => item.method === 'POST').length, 0, 'Reviewing the purpose and preview must not start a paid summary');
  await dialog.getByRole('button', { name: '创建副本并生成摘要', exact: true }).evaluate(button => { button.click(); button.click(); });
  await dialog.getByText('正在生成摘要', { exact: true }).waitFor();
  assert.equal(requests.filter(item => item.path.endsWith('/operations/start')).length, 1);
  await dialog.getByRole('button', { name: '关闭并保留状态', exact: true }).click();
  assert.equal(await dialog.count(), 0);
  const polls = requests.filter(item => item.path.endsWith('/operations')).length;
  await page.waitForTimeout(650);
  assert.equal(requests.filter(item => item.path.endsWith('/operations')).length, polls, 'Closed UI must stop polling without cancelling the operation');
  assert.equal(requests.filter(item => item.path.endsWith('/operations/cancel')).length, 0);
  await page.getByRole('button', { name: '生成精简副本', exact: true }).click();
  await dialog.getByText('正在生成摘要', { exact: true }).waitFor();
  assert.equal(requests.filter(item => item.path.endsWith('/operations/start')).length, 1, 'Reopening an active operation must not start it again');
  const completedStatistics = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dashboard'));
  state.statisticsReadTokens = 3600;
  state.job = { ...state.job, state: 'completed', context: { beforeTokens: 100000, afterTokens: 2000 },
    summaryCalls: [
      { provider: 'synthetic-provider', model: 'summary-model', usage: receipt, durationMs: 123,
        source: 'llm-stream', llmStreamCall: true },
      { provider: 'synthetic-provider', model: 'template-model', source: 'session-summary', llmStreamCall: false,
        usageRecorded: false, usage: { inputTokens: null, cacheReadTokens: null }, durationMs: null },
    ] };
  await dialog.getByText('精简副本已就绪', { exact: true }).waitFor();
  await dialog.getByText(/^摘要记录（模型调用未确认）：synthetic-provider \/ template-model/).waitFor();
  assert.equal(await dialog.getByText(/^摘要调用：synthetic-provider \/ summary-model/).count(), 1);
  await completedStatistics;
  await page.getByRole('button', { name: '生成精简副本', exact: true }).waitFor();
  assert.equal(await dialog.getByText('精简副本已就绪', { exact: true }).isVisible(), true, 'Refreshing statistics and detail must preserve the result dialog');
  assert.deepEqual(await page.evaluate(() => __openCalls), [], 'Completion must not navigate or continue by itself');
  assert.equal(requests.filter(item => item.method === 'POST').length, 1, 'Only the explicit start is allowed');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await dialog.count(), 0);
  await selectTab(page, '概览');
  await page.getByRole('region', { name: '缓存专项统计' }).getByText('3,600 tok', { exact: true }).waitFor();
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: '生成精简副本', exact: true }).click();
  await dialog.getByText('精简副本已就绪', { exact: true }).waitFor();
  assert.equal(requests.filter(item => item.path.endsWith('/operations/start')).length, 1, 'Reopening a completed operation must only read its result');
  await dialog.getByRole('button', { name: '打开副本，手动继续', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => __openCalls), ['synthetic-branch']);
  assert.equal(requests.filter(item => item.method === 'POST').length, 1, 'Opening the result must not send a prompt');
  state.job = { ...state.job, id: 'operation-two', state: 'prepared', branchId: null, summaryCalls: [] };
  await page.getByRole('button', { name: '生成精简副本', exact: true }).click();
  await dialog.getByRole('button', { name: '创建副本并生成摘要', exact: true }).click();
  const cancelledStatistics = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dashboard'));
  await dialog.getByRole('button', { name: '取消生成', exact: true }).click();
  await dialog.getByText('操作已取消', { exact: true }).waitFor();
  await cancelledStatistics;
  await page.getByRole('button', { name: '生成精简副本', exact: true }).waitFor();
  assert.equal(await dialog.getByText('操作已取消', { exact: true }).isVisible(), true, 'Refreshing statistics after cancellation must preserve the cancelled result');
  assert.equal(requests.filter(item => item.path.endsWith('/operations/cancel')).length, 1);
  assert.equal(requests.filter(item => item.path.endsWith('/operations/start')).length, 2);
  assert.deepEqual(errors, []);
});

test('browser next: Context navigation handles absent panels, delayed mount, timeout and unmount cleanup', async t => {
  const { page, errors } = await fixture(t);
  await selectTab(page, '会话明细');
  const button = () => page.getByRole('button', { name: '在 Context 中查看会话', exact: true });
  await button().click();
  await page.getByText(/Context 右栏不可用/).waitFor();
  assert.deepEqual(await page.evaluate(() => __openCalls), []);
  await page.evaluate(() => { __contextMode = 'delayed'; });
  await button().click();
  await page.getByText('已打开会话级 Context；具体异常步骤请按本页证据定位。').waitFor();
  assert.deepEqual(await page.evaluate(() => __tabCalls), ['dsh-context']);
  assert.equal(await page.evaluate(() => __mountedListeners.size), 0);
  await page.evaluate(() => { __contextMode = 'timeout'; __mountedValue = null; });
  await button().click();
  await page.waitForFunction(() => __mountedListeners.size === 1);
  await page.evaluate(() => { __contextMode = 'missing'; __mount('main'); });
  await page.getByText('Context 目标面板已不可用，请手动查看会话；没有跳转到其他步骤。').waitFor();
  assert.equal(await page.evaluate(() => __tabCalls.length), 1, 'A panel hidden during navigation must remain closed');
  await page.evaluate(() => { __contextMode = 'timeout'; __mountedValue = null; });
  await button().click();
  await page.getByText('目标会话面板尚未就绪，请手动打开后重试。').waitFor();
  assert.equal(await page.evaluate(() => __mountedListeners.size), 0);
  assert.equal(await page.evaluate(() => __tabCalls.length), 1, 'Timeout must not open a neighboring panel');
  await button().click();
  await page.waitForFunction(() => __mountedListeners.size === 1);
  await page.evaluate(() => __dispose());
  assert.equal(await page.evaluate(() => __mountedListeners.size), 0);
  assert.equal(await page.evaluate(() => __formListeners.size), 0);
  assert.deepEqual(errors, []);
});
