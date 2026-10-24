import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeChildHarness, eventually } from './child-runtime-fixture.mjs';

async function browserHarness(t, options = {}) {
  const h = await nativeChildHarness(t, { ...options, config: { ...options.config, registerHttp: true } });
  h.helper.children.reachable({ channelId: 'synthetic-visible-global-ui', seq: 2, reachable: false });
  const localRequire = createRequire(new URL('../package.json', import.meta.url));
  const browserRequire = process.env.DSH_BROWSER_TEST_MODULES
    ? createRequire(join(resolve(process.env.DSH_BROWSER_TEST_MODULES), '__child_ui__.cjs')) : localRequire;
  const reactRequire = process.env.DSH_REACT_TEST_MODULES
    ? createRequire(join(resolve(process.env.DSH_REACT_TEST_MODULES), '__child_ui__.cjs')) : localRequire;
  const { chromium } = browserRequire('playwright');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const clientPath = process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
    ? resolve(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib/client.js') : join(root, 'src/client.js');
  const [client, react, reactDOM, theme] = await Promise.all([
    readFile(clientPath, 'utf8'),
    readFile(join(dirname(reactRequire.resolve('react/package.json')), 'umd/react.development.js'), 'utf8'),
    readFile(join(dirname(reactRequire.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8'),
    readFile(new URL('./fixtures/host-theme.css', import.meta.url), 'utf8'),
  ]);
  const requests = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/dsh-cache-helper/api/')) {
        requests.push({ method: req.method, path: url.pathname });
        return h.httpHandler(req, res); // No API response or decision is stubbed.
      }
      const assets = { '/react.js': react, '/react-dom.js': reactDOM, '/client.js': client, '/theme.css': theme };
      if (Object.hasOwn(assets, url.pathname)) {
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
        return res.end(assets[url.pathname]);
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'cache-helper-fixture-browser=1; Path=/; HttpOnly; SameSite=Strict' });
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/theme.css"><style>
        body{margin:0;font-family:system-ui;color:#20222a;background:#f7f8fb}#app{min-height:100vh;display:flex}aside{padding:12px;flex:none;border-right:1px solid #ccd0da;box-sizing:border-box}main{flex:1;min-width:0;padding:24px}textarea{width:100%;height:90px;box-sizing:border-box}.native-slot{display:flex;flex-direction:column;gap:8px}button{font:inherit}
      </style></head><body><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
        window.__registrations=[];window.__cleanups=[];window.__ModuleLoader__={load(definition){window.__plugin=definition.factory(name=>name==='react'?React:ReactDOM)}};
      </script><script src="/client.js"></script><script>
        __plugin.apply({slots:{inject(name,callback){return callback()},register(meta,component){const entry={meta,component};__registrations.push(entry);return()=>{__registrations.splice(__registrations.indexOf(entry),1)}}},effect(effect){__cleanups.push(effect())}});
        const h=React.createElement,root=ReactDOM.createRoot(document.getElementById('app'));
        function NativeFixture(){const[wide,setWide]=React.useState(true);const Global=__registrations.find(item=>item.meta.name==='sidebar.footer.action').component;const Composer=__registrations.find(item=>item.meta.name==='conversation.composer.dock').component;
          return h(React.Fragment,null,h('aside',{style:{width:wide?230:64},'aria-label':'原生侧栏槽位夹具'},h('button',{onClick:()=>setWide(value=>!value),'aria-label':wide?'折叠侧栏':'展开侧栏'},wide?'折叠':'展开'),h('div',{className:'native-slot'},h(Global,{wide}))),h('main',null,h('h1',null,'原生父会话'),h('section',{'aria-label':'父会话输入框'},h(Composer,{sessionId:${JSON.stringify(h.parent.id)}}),h('textarea',{'aria-label':'合成父会话草稿'}))));}
        root.render(h(React.StrictMode,null,h(NativeFixture)));window.__dispose=()=>{root.unmount();__cleanups.forEach(cleanup=>typeof cleanup==='function'&&cleanup())};
      </script></body></html>`);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end('Synthetic fixture failure'); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeIdleConnections?.();
    await new Promise(done => server.close(done));
  });
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_BROWSER_CHANNEL ? { channel: process.env.DSH_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '缓存待确认 0 项' }).waitFor();
  await eventually(() => h.helper.children.reachability().reachable, 'The visible browser slot must register its own channel');
  return { ...h, page, context, errors, requests };
}

test('native child → real HTTP → actual parent/global UI confirms once and cancels a separate child', async t => {
  const h = await browserHarness(t);
  h.remove();
  const confirmed = await h.start('browser-confirm-child');
  const first = await eventually(() => h.helper.gate.pendingFor(confirmed.childId), 'Expected native child pending');
  let joined = false;
  const parentWaiting = h.ctx.subagents.waitForChildren(h.parent).then(() => { joined = true; });
  const parentComposer = h.page.getByRole('region', { name: '父会话输入框' });
  const row = parentComposer.getByRole('article', { name: `子任务 ${confirmed.childId} 等待缓存确认` });
  await row.waitFor();
  assert.equal(h.upstream.requests.length, 1);
  assert.equal(joined, false);
  assert.match(await row.textContent(), /继承前缀/);
  await row.getByRole('button', { name: '继续本次发送', exact: true }).click();
  await confirmed.result;
  await parentWaiting;
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.helper.gate.pendingFor(confirmed.childId), null);
  assert.throws(() => h.helper.gate.decide({ ...first, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
  const cancelled = await h.start('browser-cancel-child');
  const second = await eventually(() => h.helper.gate.pendingFor(cancelled.childId), 'Expected second native child pending');
  await h.page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  const globalButton = h.page.getByRole('button', { name: '缓存待确认 1 项' });
  await globalButton.waitFor();
  await globalButton.click();
  const queue = h.page.getByRole('dialog', { name: '缓存待确认', exact: true });
  const globalRow = queue.getByRole('article', { name: `子任务 ${cancelled.childId} 等待缓存确认` });
  await globalRow.waitFor();
  assert.equal(h.helper.pending().pending[0].id, second.id);
  await globalRow.getByRole('button', { name: '取消本次发送', exact: true }).click();
  await cancelled.result;
  assert.equal(h.upstream.requests.length, 2);
  assert.equal(h.helper.pending().count, 0);
  assert.equal(h.requests.filter(request => request.path.endsWith('/decision')).length, 2);
  assert.ok(h.requests.some(request => request.path.endsWith('/pending/reachable')));
  assert.deepEqual(h.errors, []);
});

test('native slow cancellation cleanup keeps stop-unconfirmed visible after the pending row is removed', async t => {
  const h = await browserHarness(t, { config: { childStopTimeoutMs: 50 } });
  // A public request middleware may need time to release resources after an
  // abort. Keep the real Agent running during that bounded cleanup; neither
  // pending discovery, decisions nor the native interrupt are replaced.
  h.ctx.on('llm/stream', async function* (options, next) {
    try { yield* next(); }
    catch (error) {
      if (options.sessionId === 'browser-slow-stop-child' && options.signal?.aborted) await delay(1600);
      throw error;
    }
  }, { prepend: true });
  h.remove();
  const activation = await h.start('browser-slow-stop-child');
  const composer = h.page.getByRole('region', { name: '父会话输入框' });
  const row = composer.getByRole('article', { name: `子任务 ${activation.childId} 等待缓存确认` });
  await row.waitFor();
  await row.getByRole('button', { name: '停止此子任务', exact: true }).click();
  const outcomes = composer.getByRole('region', { name: '子任务停止记录', exact: true });
  await outcomes.getByText('停止信号已接纳，尚未确认静止', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(h.helper.gate.pendingFor(activation.childId), null);
  assert.equal(h.helper.children.stops()[0].state, 'stop-unconfirmed');
  await activation.result;
  assert.equal(h.upstream.requests.length, 1);
  assert.equal(await outcomes.isVisible(), true);
  assert.deepEqual(h.errors, []);
});

test('real browser disconnect and reload cannot renew a native child pending deadline', async t => {
  const h = await browserHarness(t, { config: { childPendingTimeoutMs: 10_000 } });
  h.remove();
  const activation = await h.start('browser-deadline-child');
  const first = await eventually(() => h.helper.gate.pendingFor(activation.childId), 'Expected expiring native child pending');
  await h.page.getByRole('article', { name: `子任务 ${activation.childId} 等待缓存确认` }).waitFor();
  await h.context.setOffline(true);
  await delay(250);
  await h.context.setOffline(false);
  await h.page.reload();
  await h.page.getByRole('article', { name: `子任务 ${activation.childId} 等待缓存确认` }).waitFor();
  const reconnected = h.helper.gate.pendingFor(activation.childId);
  assert.equal(reconnected.id, first.id);
  assert.equal(reconnected.expiresAt, first.expiresAt);
  await activation.result;
  assert.equal(h.upstream.requests.length, 1);
  assert.throws(() => h.helper.gate.decide({ ...first, decision: 'confirm' }), { code: 'CACHE_HELPER_STALE' });
  assert.deepEqual(h.errors, []);
});
