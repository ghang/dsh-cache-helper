import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const defaults = { minLostTokens: 50000, minLossRatio: 0.2, dashboardLimit: 50, maxEvents: 200000, maxCachedSessions: 64 };
export const receipt = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0,
  outputTokens: 10, promptTokens: 1000, hitRate: 0.9 };
export const NOW = Date.parse('2026-10-22T13:00:00Z');
const group = (calls, extra = {}) => ({ calls, knownCacheReadTokens: calls * 900, cacheUnknownCalls: 0, failedAttempts: 0, ...extra });
export const warning = { id: 'child-warning', seq: 42, turn: 2, step: 3, at: NOW, lossTokens: 900,
  cacheReadTokens: 1, hitRate: 0.001, missTokens: 999, summary: '合成工具变更异常',
  changes: [{ kind: 'tools', message: '合成工具声明变化', removed: ['synthetic-tool'] }] };
export const detail = (id, role = 'main') => ({ sessionId: id, title: id === 'child' ? '合成子会话' : '合成主会话', role,
  latest: receipt, cumulative: receipt, config: defaults, warnings: id === 'child' ? [warning] : [], pending: null,
  calls: [{ seq: id === 'child' ? 42 : 20, turn: 2, step: 3, at: NOW, usage: receipt }], turns: [] });

export async function selectTab(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
}

export async function selectChildSession(page) {
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: /合成子会话/ }).click();
  await page.getByRole('region', { name: '调用步骤明细', exact: true }).getByRole('heading', { name: '合成子会话', exact: true }).waitFor();
}

export async function fixture(t, options = {}) {
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
      if (options.api && await options.api({ request, response, url, body, state, sessions, json, requests })) return;
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
      window.__wide=true;window.__registrations=[];window.__cleanups=[];window.__writes=[];window.__openCalls=[];window.__tabCalls=[];window.__nextWriteFailure=false;window.__contextMode='missing';window.__mountedValue=null;
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
      const draw=()=>root.render(React.createElement(React.StrictMode,null,
        ${options.globalPending ? "React.createElement(__registrations.find(item=>item.meta.id==='dsh-cache-helper-pending').component,{wide:window.__wide,key:'pending'})," : ''}
        ${options.composerSessionId ? "React.createElement(__registrations.find(item=>item.meta.id==='dsh-cache-helper-gate').component,{sessionId:"+JSON.stringify(options.composerSessionId)+",key:'composer'})," : ''}
        React.createElement(__registrations.find(item=>item.meta.id==='dsh-cache-helper').component,{key:generation})));
      window.__render=()=>{generation++;draw()};window.__setWide=value=>{window.__wide=value;draw()};
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
