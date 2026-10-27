import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve locked package devDependencies by default. These optional overrides
// remain useful for a workspace that already provides equivalent runtimes.
const browserModules = process.env.DSH_BROWSER_TEST_MODULES;
const reactModules = process.env.DSH_REACT_TEST_MODULES;
const ONLY_WARNINGS_KEY = 'dsh-cache-helper.only-warnings.v1';

test('browser: per-turn native footer placement, explicit decisions, isolation and dashboard', async () => {
  const requirePackage = createRequire(new URL('../package.json', import.meta.url));
  const requireBrowser = browserModules ? createRequire(join(resolve(browserModules), '__dsh_test__.cjs')) : requirePackage;
  const requireReact = reactModules ? createRequire(join(resolve(reactModules), '__dsh_test__.cjs')) : requirePackage;
  const { chromium } = requireBrowser('playwright');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const clientPath = process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
    ? resolve(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib/client.js')
    : join(root, 'src/client.js');
  const source = await readFile(clientPath, 'utf8');
  const react = await readFile(join(dirname(requireReact.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
  const reactDOM = await readFile(join(dirname(requireReact.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
  // Test-only, pinned host CSS snapshots; no Lab checkout or running DSH needed.
  const theme = await readFile(new URL('./fixtures/host-theme.css', import.meta.url), 'utf8');
  const footerCss = await readFile(new URL('./fixtures/host-footer.css', import.meta.url), 'utf8');
  const composerCss = await readFile(new URL('./fixtures/host-composer.css', import.meta.url), 'utf8');
  const settingsCss = await readFile(new URL('./fixtures/host-settings.css', import.meta.url), 'utf8');
  const good = { inputTokens: 1000, cacheReadTokens: 99000, cacheWriteTokens: 0, outputTokens: 400, hitRate: 0.99, turn: 14, step: 2, seq: 20 };
  const bad = { inputTokens: 528472, cacheReadTokens: 2048, cacheWriteTokens: 0, outputTokens: 100, hitRate: 2048 / 530520, turn: 15, step: 1, seq: 21 };
  const unknown = { inputTokens: 1000, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 20, hitRate: null, turn: 1, step: 1, seq: 1 };
  const earlyMulti = { ...bad, turn: 16, step: 1, seq: 22 };
  const finalMulti = { inputTokens: 1979, cacheReadTokens: 636400, cacheWriteTokens: 0, promptTokens: 638379, outputTokens: 100, hitRate: 636400 / 638379, turn: 16, step: 3, seq: 24 };
  const earlyUnknown = { ...good, turn: 17, step: 1, seq: 25 };
  const finalUnknown = { ...unknown, turn: 17, step: 2, seq: 26 };
  const delayedFooter = { ...good, turn: 18, step: 1, seq: 27, cacheReadTokens: 88000, inputTokens: 12000, hitRate: 0.88 };
  const betaKnown = { ...good, turn: 14, step: 1, seq: 2, cacheReadTokens: 4321, inputTokens: 5679, hitRate: 0.4321 };
  const alphaCalls = [good, bad, earlyMulti, finalMulti, earlyUnknown, finalUnknown, delayedFooter];
  const turn = latest => ({ turn: latest.turn, latest, seq: latest.seq, step: latest.step });
  const warning = { id: 'warn-21', turn: 15, step: 1, seq: 21, at: '2026-10-21T12:00:00Z', hitRate: bad.hitRate, missTokens: bad.inputTokens, cacheReadTokens: bad.cacheReadTokens, lossTokens: 500000, changes: [{ kind: 'tools', message: '工具定义发生变化', removed: ['demo_lookup', 'demo_search'] }], summary: '缓存大规模失效，需要分析原因', dismissed: false, recovered: true };
  const sessions = {
    alpha: { sessionId: 'alpha', title: '演示会话：工具清单变更', latest: delayedFooter, cumulative: { ...good, inputTokens: 529472, cacheReadTokens: 101048, hitRate: 101048 / 630520 }, calls: alphaCalls, turns: [good, bad, finalMulti, finalUnknown, delayedFooter].map(turn), warnings: [warning], pending: null, config: {} },
    beta: { sessionId: 'beta', title: '演示会话：缓存用量未知', latest: betaKnown, cumulative: unknown, calls: [unknown, betaKnown], turns: [unknown, betaKnown].map(turn), warnings: [], pending: null, config: {} },
    late: { sessionId: 'late', title: '演示会话：延迟响应隔离', latest: { ...bad, turn: 14, cacheReadTokens: 12345678 }, cumulative: bad, calls: [bad], turns: [turn({ ...bad, turn: 14, cacheReadTokens: 12345678 })], warnings: [], pending: null, config: {} },
  };
  const decisions = [];
  const reads = new Map();
  let failDecision = false;
  let failSession = false;
  let failDashboard = false;
  let emptyDashboard = false;
  let failDetailId = null;
  const pending = id => ({ id, sessionId: 'alpha', fingerprint: `fingerprint-${id}`, turn: 16, step: 1, reason: '工具列表变化，原有长前缀可能无法复用', lossTokens: 500000, lossRatio: 0.95, changes: [{ kind: 'tools', message: '工具列表发生变化', added: ['demo_lookup'] }], createdAt: Date.now() });
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (['/react.js', '/react-dom.js', '/client.js', '/theme.css', '/footer.css', '/composer.css', '/settings.css'].includes(url.pathname)) {
      response.writeHead(200, { 'Content-Type': url.pathname.endsWith('css') ? 'text/css' : 'application/javascript' });
      response.end(url.pathname === '/react.js' ? react : url.pathname === '/react-dom.js' ? reactDOM : url.pathname === '/theme.css' ? theme : url.pathname === '/footer.css' ? footerCss : url.pathname === '/composer.css' ? composerCss : url.pathname === '/settings.css' ? settingsCss : source);
      return;
    }
    if (url.pathname === '/dsh-cache-helper/api/session') {
      const id = url.searchParams.get('sessionId');
      reads.set(id, (reads.get(id) || 0) + 1);
      if (id === 'late') await new Promise(resolveDelay => setTimeout(resolveDelay, 1800));
      json(response, sessions[id], failSession && id === 'alpha' || failDetailId === id ? 503 : 200);
      return;
    }
    if (url.pathname === '/dsh-cache-helper/api/pending') {
      json(response, { pending: Object.values(sessions).map(item => item.pending).filter(Boolean),
        stops: [], observations: [], childProtection: 'block' }, failSession ? 503 : 200);
      return;
    }
    if (url.pathname === '/dsh-cache-helper/api/dashboard') {
      json(response, { sessions: emptyDashboard ? [] : Object.values(sessions).filter(item => item.sessionId !== 'late').map(item => ({ sessionId: item.sessionId, title: item.title, cumulative: item.cumulative, latest: item.latest, warningCount: item.warnings.length })), generatedAt: Date.now(), coverage: { scanned: emptyDashboard ? 0 : 2, limit: 100, errors: [] } }, failDashboard ? 503 : 200);
      return;
    }
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      if (url.pathname.endsWith('/decision')) {
        decisions.push(payload);
        if (failDecision) { failDecision = false; json(response, { error: 'unavailable' }, 503); return; }
        assert.equal(payload.fingerprint, sessions[payload.sessionId].pending.fingerprint);
        sessions[payload.sessionId].pending = null;
      } else if (url.pathname.endsWith('/warnings/dismiss')) {
        sessions[payload.sessionId].warnings.find(item => item.id === payload.id).dismissed = payload.dismissed;
      }
      json(response, { ok: true });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/footer.css"><link rel="stylesheet" href="/composer.css"><link rel="stylesheet" href="/settings.css"><style>.fixture-tail{margin-bottom:22px}.fixture-tail>p{margin:0 0 5px}.native-usage-dialog{position:fixed;inset:30% 20%;z-index:2000;background:var(--dsw-alias-bg-layer-1);border:1px solid #777;padding:20px}.timeEnd{white-space:nowrap}.fixture-composer-stack{gap:6px}.fixture-input-card{min-height:70px;border:1px solid #aaa}</style></head><body><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
      window.__registrations=[];window.__cleanups=[];window.__disposedRegistrations=[];window.__settingsCloseCount=0;
      window.__detachedObservations=[];window.__activeObservers=new Map();
      const NativeMutationObserver=window.MutationObserver;
      window.MutationObserver=class extends NativeMutationObserver{observe(target,options){__activeObservers.set(this,target);return super.observe(target,options)}disconnect(){__activeObservers.delete(this);return super.disconnect()}};
      window.__ModuleLoader__={load(definition){window.__plugin=definition.factory(name=>name==='react'?React:ReactDOM)}};
    </script><script src="/client.js"></script><script>
      __plugin.apply({slots:{inject(name,callback){return callback()},register(meta,component){__registrations.push({meta,component});return()=>{__disposedRegistrations.push(meta.id)}}},effect(effect){__cleanups.push(effect())}});
      const root=ReactDOM.createRoot(document.getElementById('app'));
      const h=React.createElement;
      function FixtureIcon({kind}){
        const paths=kind==='copy'?h(React.Fragment,null,h('rect',{x:5,y:5,width:8,height:9,rx:1.5}),h('path',{d:'M3 10H2V2h8v1'})):kind==='branch'?h(React.Fragment,null,h('path',{d:'M4 4v8M4 7h4a4 4 0 0 0 4-4'}),h('circle',{cx:4,cy:3,r:1.5}),h('circle',{cx:4,cy:13,r:1.5}),h('circle',{cx:12,cy:2,r:1.5})):h(React.Fragment,null,h('ellipse',{cx:8,cy:4,rx:5,ry:2}),h('path',{d:'M3 4v8c0 3 10 3 10 0V4M3 8c0 3 10 3 10 0'}));
        return h('svg',{viewBox:'0 0 16 16',fill:'none',stroke:'currentColor',strokeWidth:1.2,'aria-hidden':true},paths);
      }
      function AttachAfterPassive({host,seat,turn}){
        React.useEffect(()=>{
          const marker=host.querySelector('.dch-turn-cache-anchor');
          __detachedObservations.push({turn,connected:marker.isConnected,tail:marker.closest('[data-turn-tail]')?.getAttribute('data-turn-tail')||null,phase:marker.dataset.cachePhase});
          const timer=setTimeout(()=>{if(seat.isConnected)seat.before(host)},60);
          return()=>clearTimeout(timer);
        },[host,seat,turn]);
        return null;
      }
      function DetachedTailSlot({id,turn,seq}){
        const seat=React.useRef(null);
        const turnNumber=typeof turn==='number'?turn:turn?.turn;
        React.useEffect(()=>{
          const host=document.createElement('div');host.style.display='contents';
          const slotRoot=ReactDOM.createRoot(host);
          slotRoot.render(h(React.StrictMode,null,h(__registrations[2].component,{sessionId:id,turn,seq}),h(AttachAfterPassive,{host,seat:seat.current,turn:turnNumber})));
          return()=>{host.remove();queueMicrotask(()=>slotRoot.unmount())};
        },[id,turn,seq]);
        return h('span',{ref:seat,hidden:true,'data-fixture-detached-seat':turnNumber});
      }
      function NativeTurn({id,turn,options}){
        const [open,setOpen]=React.useState(false);
        const location=React.useMemo(()=>({turn,status:'closed',steps:[],start:{seq:turn*2-1},end:{seq:turn*2},data:{fixture:true}}),[turn]);
        const ownerTurn=options.missingOwner&&turn===16?undefined:options.primitiveOwner?turn:location;
        const ownerSeq=options.missingOwner&&turn===16?undefined:turn*2;
        return h('section',{'data-turn-tail':turn,className:'fixture-tail'},h('p',null,'第 '+turn+' 轮回答'),
          options.helper===false?null:options.detachedSlot?h(DetachedTailSlot,{id,turn:ownerTurn,seq:ownerSeq}):h(__registrations[2].component,{sessionId:id,turn:ownerTurn,seq:ownerSeq}),
          turn===18&&!options.lateFooter?null:h('div',{'data-clock':'end',className:'actions',key:options.footerVersion||0},
            h('button',{className:'action','aria-label':'复制第'+turn+'轮'},h(FixtureIcon,{kind:'copy'})),h('button',{className:'action','aria-label':'分支第'+turn+'轮'},h(FixtureIcon,{kind:'branch'})),
            h('span',{className:'endInfo'},
              options.compact?null:h('span',{className:'root','data-native-usage':turn},h('button',{className:'trigger','aria-haspopup':'dialog',onClick:()=>setOpen(!open),'aria-label':'第'+turn+'轮用量'},h(FixtureIcon,{kind:'usage'}),h('span',{className:'label'},'用量 '+turn+'K tok'))),
              options.noClock?null:h('span',{className:'timeEnd','data-native-clock':turn},'10:'+String(turn).padStart(2,'0')),
              options.changedFooter?h('a',{href:'#unknown'},'宿主结构已变化'):null)),
          open?ReactDOM.createPortal(h('div',{role:'dialog','aria-label':'原生第'+turn+'轮用量详情',className:'native-usage-dialog'},h('p',null,'原生用量详情'),h('button',{onClick:()=>setOpen(false)},'关闭原生用量详情')),document.body):null);
      }
      function Fixture({id,options}){
        const turns=id==='alpha'?[14,15,16,17,18,19]:id==='beta'?[1,14]:[14];
        return h('main',{style:{maxWidth:'960px',margin:'20px auto',padding:'12px'}},
        h('p',{style:{fontSize:'12px',color:'#777'}},'合成演示数据 · 不连接模型服务'),
        ...turns.map(turn=>h(NativeTurn,{id,turn,options,key:turn})),
        h('div',{className:'fixture-composer-stack'+(options.embedded?' fixture-composer-stack-embedded':''),style:{'--dsh-conversation-column-width':'1440px'}},
          options.helper===false?null:h(__registrations[1].component,{sessionId:id}),
          h('div',{className:'fixture-input-root'},h('div',{id:'fixture-input-card',className:'fixture-input-card'},'模拟输入框'),
            h('div',{'data-composer-dock':true,className:'fixture-input-dock'},h('span',{id:'native-usage'},'用量 100K tok'),options.helper===false?null:h(__registrations[0].component,{sessionId:id})))));
      }
      function SettingsFixture(){
        const [open,setOpen]=React.useState(true);
        const [active,setActive]=React.useState('general');
        const close=()=>{__settingsCloseCount+=1;setOpen(false)};
        React.useEffect(()=>{
          if(!open)return;
          const onKey=event=>{if(event.key==='Escape'){event.preventDefault();close()}};
          document.addEventListener('keydown',onKey);
          return()=>document.removeEventListener('keydown',onKey);
        },[open]);
        const rows=[{id:'general',order:0,label:'通用'},{id:'archived-sessions',order:45,label:'归档会话'},{id:'another-plugin',order:100,label:'其他插件'},__registrations[3].meta].sort((a,b)=>a.order-b.order);
        return open?ReactDOM.createPortal(h('div',{className:'fixture-settings-overlay'},h('div',{role:'dialog','aria-label':'原生设置','data-shortcut-modal':'settings',className:'fixture-settings-panel'},
          h('nav',{className:'fixture-settings-nav'},h('div',{className:'fixture-settings-navTitle'},'设置'),h('div',{className:'fixture-settings-navList'},...rows.map(row=>h('button',{key:row.id,type:'button',className:'fixture-settings-navCell'+(active===row.id?' fixture-settings-active':''),'aria-current':active===row.id?'true':undefined,onClick:()=>setActive(row.id)},row.label)))),
          h('div',{className:'fixture-settings-content'},h('header',{className:'fixture-settings-header'},h('div',{className:'fixture-settings-actions'}),h('button',{type:'button',className:'fixture-settings-close',onClick:close,'aria-label':'关闭原生设置'},'×')),h('div',{className:'fixture-settings-options'},active==='dsh-cache-helper'?h(__registrations[3].component,{close}):h('p',null,'原生设置内容'))))),document.body):h('p',null,'设置已关闭');
      }
      const globalPending=()=>h(__registrations.find(item=>item.meta.name==='sidebar.footer.action').component,{key:'global-pending'});
      window.__render=(id,options={})=>root.render(h(React.StrictMode,null,globalPending(),h(Fixture,{id,options})));
      let settingsGeneration=0;
      window.__renderSettings=(options={})=>root.render(h(React.StrictMode,null,globalPending(),options.withConversation?h(Fixture,{id:'alpha',options:{lateFooter:true}}):null,h(SettingsFixture,{key:++settingsGeneration})));
      window.__cleanup=()=>{root.unmount();__cleanups.forEach(cleanup=>cleanup&&cleanup())};__render('alpha');
    </script></body></html>`);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const browser = await chromium.launch({ headless: true, ...(process.env.DSH_BROWSER_CHANNEL ? { channel: process.env.DSH_BROWSER_CHANNEL } : {}) }).catch(async error => {
    await new Promise(resolveClose => server.close(resolveClose));
    throw new Error('Browser launch failed. Install the pinned Playwright Chromium, or explicitly set DSH_BROWSER_CHANNEL to an installed browser.', { cause: error });
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(key => {
    if (!sessionStorage.getItem('dch-fixture-initialized')) {
      localStorage.setItem(key, 'false');
      sessionStorage.setItem('dch-fixture-initialized', 'true');
    }
  }, ONLY_WARNINGS_KEY);
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.message); });
  const assertChecked = async (locator, value, message) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (await locator.isChecked() === value) return;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    assert.equal(await locator.isChecked(), value, message);
  };
  const showSessionTab = async dashboard => {
    const tab = dashboard.getByRole('tab', { name: '会话明细', exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
  };
  const capture = async outputPath => {
    if (!outputPath) return;
    const requested = process.env.DSH_CLIENT_TEST_SCREENSHOT_VIEWPORT;
    const match = requested?.match(/^(\d+)x(\d+)$/);
    if (requested && !match) throw new Error('DSH_CLIENT_TEST_SCREENSHOT_VIEWPORT must be WIDTHxHEIGHT.');
    const original = page.viewportSize();
    if (match) await page.setViewportSize({ width: Number(match[1]), height: Number(match[2]) });
    try {
      await mkdir(dirname(resolve(outputPath)), { recursive: true });
      await page.mouse.move(0, 0);
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
      await page.screenshot({ path: outputPath, fullPage: true });
    } finally {
      if (match) await page.setViewportSize(original);
    }
  };
  try {
    const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
    await page.goto(fixtureUrl);
    await page.getByText('末次缓存 99K tok · 99%', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => __registrations.map(item => ({ name: item.meta.name, order: item.meta.order }))), [
      { name: 'conversation.composer.dock', order: 1.5 }, { name: 'conversation.input.dock', order: 10 }, { name: 'conversation.chat.turnTail', order: 100 }, { name: 'settings.section', order: 200 },
      { name: 'sidebar.footer.action', order: 150 },
    ]);
    assert.deepEqual(await page.evaluate(() => ({ id: __registrations[3].meta.id, label: __registrations[3].meta.label })), { id: 'dsh-cache-helper', label: '缓存看板' });
    const tail = turnNumber => page.locator(`[data-turn-tail="${turnNumber}"]`);
    const assertComposerAlignment = async label => {
      const card = await page.locator('#fixture-input-card').boundingBox();
      const warn = await page.locator('[data-dsh-cache-helper="warnings"]').boundingBox();
      assert.ok(Math.abs(card.x - warn.x) < 0.5, `${label}: WARN left edge matches input card`);
      assert.ok(Math.abs(card.x + card.width - warn.x - warn.width) < 0.5, `${label}: WARN right edge matches input card`);
      assert.ok(warn.y + warn.height <= card.y, `${label}: WARN is above input card`);
      assert.equal(await page.locator('[data-composer-dock] [data-dsh-cache-helper="warnings"]').count(), 0, `${label}: WARN is outside composer statistics dock`);
    };
    await assertComposerAlignment('main wide');
    assert.equal(await tail(14).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 99K tok · 99%');
    assert.equal(await tail(15).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 2,048 tok · 0.39%');
    assert.equal(await tail(16).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 636.4K tok · 99.69%');
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-turn'), '16');
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-turn-type'), 'number');
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-raw-owner-type'), 'object', 'fixture passes the real TurnLocation owner shape');
    assert.equal(await tail(17).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 未知 tok · 未知', 'unknown final call must not use an earlier known step');
    assert.equal(await tail(19).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 未知', 'turn without usage cannot borrow another turn');
    assert.equal(await page.locator('[data-composer-dock] [data-dsh-cache-helper="turn-reading"]').count(), 0, 'composer has no cache reading');
    assert.equal(await page.locator('[data-composer-dock] .dch-dashboard-trigger').count(), 0, 'composer has no duplicate dashboard entry');
    assert.equal(await page.getByRole('button', { name: '缓存看板', exact: true }).count(), await page.locator('[data-dsh-cache-helper-portal]').count(), 'each mounted turn has exactly one dashboard entry');
    assert.equal(await tail(16).locator('[data-dsh-cache-helper="turn-reading"]').evaluate(element => element.nextElementSibling?.matches('button.dch-dashboard-trigger')), true, 'dashboard follows this turn cache ratio directly');
    const turnTooltip = await tail(16).locator('[data-dsh-cache-helper="turn-reading"]').getAttribute('title');
    assert.match(turnTooltip, /第 16 轮 · 步骤 3/);
    assert.match(turnTooltip, /636,400 tok \/ 全部输入 638,379 tok/);
    assert.doesNotMatch(turnTooltip, /累计|99,000/);
    assert.deepEqual(await tail(16).locator('.endInfo').evaluate(element => Array.from(element.children).map(child => child.hasAttribute('data-native-usage') ? 'usage' : child.hasAttribute('data-native-clock') ? 'clock' : child.hasAttribute('data-dsh-cache-helper-portal') ? 'cache' : 'other')), ['usage', 'cache', 'clock']);
    await page.evaluate(() => {
      window.__nativeUsage=document.querySelector('[data-native-usage="16"]');
      window.__nativeClock=document.querySelector('[data-native-clock="16"]');
    });
    await page.getByRole('button', { name: '第16轮用量', exact: true }).click();
    await page.getByRole('dialog', { name: '原生第16轮用量详情' }).waitFor();
    await page.getByRole('button', { name: '关闭原生用量详情' }).click();
    assert.equal(await page.evaluate(() => __nativeUsage===document.querySelector('[data-native-usage="16"]')&&__nativeClock===document.querySelector('[data-native-clock="16"]')), true, 'native nodes remain owned and seated by host');
    await page.evaluate(() => __render('alpha', { lateFooter: true, footerVersion: 1 }));
    await tail(18).getByText('末次缓存 88K tok · 88%', { exact: true }).waitFor();
    await tail(16).getByText('末次缓存 636.4K tok · 99.69%', { exact: true }).waitFor();
    assert.equal(await tail(16).locator('[data-dsh-cache-helper-portal]').count(), 1, 'native footer recreation does not duplicate portal');
    await page.evaluate(() => {
      window.__nativeUsage=document.querySelector('[data-native-usage="16"]');
      window.__nativeClock=document.querySelector('[data-native-clock="16"]');
      __render('alpha', { helper: false, lateFooter: true, footerVersion: 1 });
    });
    await page.waitForFunction(() => document.querySelector('[data-dsh-cache-helper-portal]') === null);
    assert.equal(await page.evaluate(() => __nativeUsage===document.querySelector('[data-native-usage="16"]')&&__nativeClock===document.querySelector('[data-native-clock="16"]')), true, 'helper removal preserves native usage and clock nodes');
    await page.evaluate(() => __render('alpha', { lateFooter: true, footerVersion: 1 }));
    await tail(16).getByText('末次缓存 636.4K tok · 99.69%', { exact: true }).waitFor();
    await page.evaluate(() => __render('alpha', { primitiveOwner: true, lateFooter: true, footerVersion: 1 }));
    await tail(16).locator('.dch-turn-cache-anchor[data-cache-raw-owner-type="number"]').waitFor({ state: 'attached' });
    assert.equal(await tail(16).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 636.4K tok · 99.69%', 'legacy primitive owners remain compatible');
    await page.evaluate(() => __render('alpha', { lateFooter: true, footerVersion: 1 }));
    assert.equal(await tail(16).locator('[data-dsh-cache-helper-portal]').count(), 1, 'StrictMode remount has one portal per turn');
    assert.equal(await tail(16).evaluate(element => getComputedStyle(element.querySelector('[data-dsh-cache-helper="turn-reading"]')).fontSize === getComputedStyle(element.querySelector('[data-native-clock]')).fontSize), true, 'cache reading inherits the native metadata text size');
    await page.evaluate(() => __render('alpha', { detachedSlot: true, lateFooter: true, footerVersion: 1 }));
    await page.waitForFunction(() => __detachedObservations.some(item => item.turn===16));
    assert.equal(await page.evaluate(() => __detachedObservations.some(item => item.turn===16&&!item.connected&&item.tail===null&&item.phase==='waiting-tail')), true, 'fixture actually commits helper passive effects before slot container attachment');
    await tail(16).locator('.dch-turn-cache-anchor[data-cache-phase="attached"]').waitFor({ state: 'attached' });
    await tail(16).getByText('末次缓存 636.4K tok · 99.69%', { exact: true }).waitFor();
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-observer'), 'tail');
    assert.equal(await page.evaluate(() => [...__activeObservers.values()].filter(target => target===document.documentElement).length), 0, 'attachment observers stop immediately after tails are found');
    assert.equal(await tail(16).locator('[data-dsh-cache-helper-portal]').count(), 1, 'detached StrictMode attachment has no duplicate portal');
    await page.evaluate(() => __render('alpha', { missingOwner: true, lateFooter: true, footerVersion: 1 }));
    await tail(16).locator('.dch-turn-cache-anchor[data-cache-phase="owner-missing"]').waitFor({ state: 'attached' });
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-turn'), 'undefined');
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-turn-type'), 'undefined');
    assert.equal(await tail(16).locator('.dch-turn-cache-anchor').getAttribute('data-cache-observer'), 'none');
    assert.equal(await tail(16).locator('[data-dsh-cache-helper-portal]').count(), 0, 'missing owner cannot borrow turn or session data');
    await page.evaluate(() => __render('alpha', { lateFooter: true, footerVersion: 1 }));
    await tail(16).getByText('末次缓存 636.4K tok · 99.69%', { exact: true }).waitFor();
    await page.evaluate(() => __render('alpha', { compact: true, lateFooter: true, footerVersion: 1 }));
    await page.waitForFunction(() => {
      const info = document.querySelector('[data-turn-tail="16"] .endInfo');
      return info.children.length === 2 && info.children[0].hasAttribute('data-dsh-cache-helper-portal') && info.children[1].hasAttribute('data-native-clock');
    });
    await page.evaluate(() => __render('alpha', { noClock: true, lateFooter: true, footerVersion: 1 }));
    await page.waitForFunction(() => {
      const info = document.querySelector('[data-turn-tail="16"] .endInfo');
      return info.children.length === 2 && info.children[0].hasAttribute('data-native-usage') && info.children[1].hasAttribute('data-dsh-cache-helper-portal');
    });
    await page.evaluate(() => __render('alpha', { changedFooter: true, lateFooter: true, footerVersion: 1 }));
    await page.waitForFunction(() => document.querySelector('[data-dsh-cache-helper-portal]') === null);
    assert.equal(await tail(16).locator('[data-native-usage]').count(), 1, 'unknown structure retains host usage and adds no fallback reading');
    assert.equal(await tail(16).locator('[data-native-clock]').count(), 1);
    await page.evaluate(() => __render('alpha', { lateFooter: true, footerVersion: 1 }));
    await tail(16).getByText('末次缓存 636.4K tok · 99.69%', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'narrow native answer footers do not overflow');
    for (const turnNumber of [14, 15, 16, 17, 18, 19]) {
      const cacheBounds = await tail(turnNumber).locator('[data-dsh-cache-helper="turn-reading"]').boundingBox();
      assert.ok(cacheBounds.x >= 0 && cacheBounds.x + cacheBounds.width <= 390, `turn ${turnNumber} cache reading stays in narrow viewport`);
      const buttonBounds = await tail(turnNumber).getByRole('button', { name: '缓存看板', exact: true }).boundingBox();
      assert.ok(buttonBounds.x >= 0 && buttonBounds.x + buttonBounds.width <= 390, `turn ${turnNumber} dashboard entry stays in narrow viewport`);
    }
    await assertComposerAlignment('main narrow');
    await capture(process.env.DSH_CLIENT_TEST_FOOTER_SCREENSHOT);
    await page.evaluate(() => __render('alpha', { embedded: true, lateFooter: true, footerVersion: 1 }));
    await page.locator('.fixture-composer-stack-embedded').waitFor({ state: 'attached' });
    await assertComposerAlignment('embedded narrow');
    await page.setViewportSize({ width: 1280, height: 900 });
    await assertComposerAlignment('embedded wide');
    await page.evaluate(() => __render('alpha', { lateFooter: true, footerVersion: 1 }));
    await page.locator('.fixture-composer-stack-embedded').waitFor({ state: 'detached' });
    await assertComposerAlignment('main restored');
    const before = reads.get('alpha');
    await page.waitForTimeout(1650);
    assert.equal(reads.get('alpha') - before, 1, 'all per-turn and composer slot components share one poll');

    sessions.alpha.pending = pending('escape');
    await page.getByRole('alertdialog').waitFor();
    assert.equal(decisions.length, 0, 'merely displaying a gate cannot approve');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '取消本次发送');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.equal(decisions.at(-1).decision, 'cancel');

    sessions.alpha.pending = pending('failure');
    await page.getByRole('alertdialog').waitFor();
    failDecision = true;
    await page.getByRole('button', { name: '稍后处理', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.equal(sessions.alpha.pending.id, 'failure', 'Deferring preserves the frozen candidate');
    assert.equal(decisions.length, 1, 'Deferring does not send a decision');
    await page.getByRole('button', { name: '缓存失效待确认 1 项', exact: true }).click();
    await page.getByRole('button', { name: '确认并发送', exact: true }).click();
    await page.getByRole('alert').getByText(/请求仍未获准发送/).waitFor();
    assert.equal(sessions.alpha.pending.id, 'failure');
    await page.getByRole('button', { name: '取消发送并关闭警告' }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.equal(decisions.at(-1).decision, 'cancel');

    sessions.alpha.pending = pending('confirm');
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name: '确认并发送', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.deepEqual(decisions.at(-1), { sessionId: 'alpha', id: 'confirm', fingerprint: 'fingerprint-confirm', decision: 'confirm' });

    sessions.alpha.pending = pending('offline');
    await page.getByRole('alertdialog').waitFor();
    failSession = true;
    await page.getByText('与宿主连接中断。请求保持等待，连接恢复前无法确认。').waitFor();
    await tail(16).locator('[data-dsh-cache-helper="turn-reading"].dch-stale').waitFor();
    assert.match(await tail(16).locator('[data-dsh-cache-helper="turn-reading"]').getAttribute('title'), /更新失败，显示上次读取结果/);
    assert.equal(await page.getByRole('button', { name: '确认并发送', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    failSession = false;

    await page.getByRole('button', { name: /WARN · 1 次缓存大规模失效/ }).click();
    await page.getByText('工具定义发生变化').waitFor();
    await page.getByRole('button', { name: '收起此条', exact: true }).click();
    await page.getByRole('button', { name: /1 条缓存异常已收起/ }).waitFor();
    assert.equal(warning.dismissed, true);
    await page.getByLabel('显示 1 条已收起记录').check();
    await page.getByRole('button', { name: '恢复提示', exact: true }).click();
    await page.getByRole('button', { name: /WARN · 1 次缓存大规模失效/ }).waitFor();

    await tail(16).getByRole('button', { name: '缓存看板', exact: true }).click();
    await page.getByRole('dialog', { name: '缓存有效率看板' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '会话明细', exact: true }).getAttribute('aria-selected'), 'true',
      'A turn shortcut opens directly to its session instead of the overview');
    await page.getByRole('cell', { name: '0.4%', exact: true }).first().waitFor();
    await page.getByRole('button', { name: /演示会话：缓存用量未知/ }).click();
    await page.getByRole('cell', { name: '未知', exact: true }).waitFor();
    await page.getByRole('button', { name: /演示会话：工具清单变更/ }).click();
    await page.getByLabel('只看异常').check();
    await page.getByText('1 个调用步骤', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 1);
    assert.equal(await page.getByRole('tabpanel', { name: '会话明细', exact: true }).getByLabel('只看异常').count(), 1,
      'The shared anomaly filter is visible in the session page');
    await page.getByRole('button', { name: /演示会话：缓存用量未知/ }).click();
    await page.getByText('没有异常步骤', { exact: true }).waitFor();
    await assertChecked(page.getByLabel('只看异常'), true, 'changing selected session keeps the global anomaly filter');
    await page.getByRole('button', { name: /演示会话：工具清单变更/ }).click();
    await page.getByText('1 个调用步骤', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByText('1 个调用步骤', { exact: true }).waitFor();
    await assertChecked(page.getByLabel('只看异常'), true, 'refreshing dashboard data keeps the global anomaly filter');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    const box = await page.getByRole('dialog').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'narrow dashboard stays within viewport');
    assert.ok(box.y >= 0 && box.y + box.height <= 844, 'narrow dashboard stays within viewport height');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await capture(process.env.DSH_CLIENT_TEST_SCREENSHOT);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });

    await tail(14).getByRole('button', { name: '缓存看板', exact: true }).click();
    await page.getByRole('dialog', { name: '缓存有效率看板' }).waitFor();
    await assertChecked(page.getByLabel('只看异常'), true, 'closing and reopening a different turn popup keeps the filter');
    await page.evaluate(() => __render('beta'));
    await tail(14).getByText('末次缓存 4,321 tok · 43.21%', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '缓存有效率看板' }).count(), 0, 'switching session hides the old per-turn dashboard');
    await page.evaluate(() => __render('alpha'));
    await tail(14).getByText('末次缓存 99K tok · 99%', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '缓存有效率看板' }).count(), 0, 'returning to a reused turn does not revive an old dashboard');

    await page.evaluate(() => __render('late'));
    await page.waitForTimeout(100);
    await page.evaluate(() => __render('beta'));
    await tail(1).getByText('末次缓存 未知 tok · 未知', { exact: true }).waitFor();
    await tail(14).getByText('末次缓存 4,321 tok · 43.21%', { exact: true }).waitFor();
    await page.waitForTimeout(1900);
    assert.equal(await page.getByText(/12\.35M/).count(), 0, 'late response cannot overwrite another session');
    assert.equal(await tail(14).locator('[data-dsh-cache-helper="turn-reading"]').textContent(), '末次缓存 4,321 tok · 43.21%', 'same numbered turn is scoped to the current session');
    assert.equal(await tail(14).locator('[data-dsh-cache-helper-portal]').count(), 1, 'session switches do not duplicate portal containers');
    assert.equal(await page.locator('[data-dsh-cache-helper="warnings"]').count(), 0, 'another session does not inherit warnings');
    assert.equal(await page.getByRole('alertdialog').count(), 0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => __renderSettings());
    const nativeSettings = page.getByRole('dialog', { name: '原生设置', exact: true });
    await nativeSettings.waitFor();
    assert.deepEqual(await nativeSettings.locator('nav button').allTextContents(), ['通用', '归档会话', '其他插件', '缓存看板'], 'settings section is after archived and existing third-party sections');
    await nativeSettings.getByRole('button', { name: '缓存看板', exact: true }).click();
    const inline = nativeSettings.locator('.dch-settings-dashboard');
    await inline.getByRole('tab', { name: '概览', exact: true }).waitFor();
    assert.equal(await inline.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true',
      'The root settings page starts with a compact overview');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), '缓存看板', 'opening an inline dashboard does not steal native settings focus');
    await showSessionTab(inline);
    await inline.locator('.dch-detail-heading h3').getByText('演示会话：工具清单变更', { exact: true }).waitFor();
    await assertChecked(inline.getByLabel('只看异常'), true, 'settings shares the value selected in a turn popup');
    assert.equal(await page.locator('[data-turn-tail]').count(), 0, 'settings dashboard works without an active conversation');
    assert.equal(await page.getByRole('dialog').count(), 1, 'settings renders content inline without a second dialog');
    assert.equal(await page.locator('.dch-overlay').count(), 0, 'inline settings adds no body overlay');
    assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'inline settings does not acquire an independent scroll lock');
    await inline.getByRole('searchbox', { name: '搜索会话' }).fill('缓存用量未知');
    assert.equal(await inline.locator('.dch-session-list button').count(), 1);
    failDetailId = 'beta';
    await inline.getByRole('button', { name: /演示会话：缓存用量未知/ }).click();
    await inline.getByRole('alert').getByText(/HTTP 503/).waitFor();
    failDetailId = null;
    await inline.getByRole('searchbox', { name: '搜索会话' }).fill('');
    await inline.getByRole('button', { name: /演示会话：工具清单变更/ }).click();
    await inline.getByLabel('只看异常').check();
    await inline.getByText('1 个调用步骤', { exact: true }).waitFor();
    assert.equal(await inline.locator('tbody tr').count(), 1);
    const assertSettingsWidth = async label => {
      const bounds = await inline.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= (await page.viewportSize()).width, `${label}: settings dashboard stays within viewport`);
      assert.equal(await nativeSettings.locator('.fixture-settings-options').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${label}: table scroll is contained inside settings content`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: page does not overflow`);
    };
    await assertSettingsWidth('wide');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertSettingsWidth('narrow');
    await capture(process.env.DSH_CLIENT_TEST_SETTINGS_SCREENSHOT);
    const beforeNativeClose = await page.evaluate(() => __settingsCloseCount);
    await page.keyboard.press('Escape');
    await nativeSettings.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => __settingsCloseCount), beforeNativeClose + 1, 'native settings owns Escape close semantics');

    failDashboard = true;
    await page.evaluate(() => __renderSettings());
    await nativeSettings.getByRole('button', { name: '缓存看板', exact: true }).click();
    await inline.getByRole('alert').getByText(/HTTP 503/).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'inline error recovery does not create a dialog');
    failDashboard = false;
    await inline.getByRole('button', { name: '刷新', exact: true }).click();
    await showSessionTab(inline);
    await inline.locator('.dch-detail-heading h3').getByText('演示会话：工具清单变更', { exact: true }).waitFor();
    await nativeSettings.getByRole('button', { name: '关闭原生设置', exact: true }).click();
    await nativeSettings.waitFor({ state: 'detached' });

    emptyDashboard = true;
    await page.evaluate(() => __renderSettings());
    await nativeSettings.getByRole('button', { name: '缓存看板', exact: true }).click();
    await showSessionTab(inline);
    await inline.getByText('没有匹配的会话', { exact: true }).waitFor();
    await inline.getByText('选择一个会话查看步骤', { exact: true }).waitFor();
    assert.equal(await inline.locator('tbody tr').count(), 0, 'empty dashboard does not invent a session');
    emptyDashboard = false;
    await inline.getByRole('button', { name: '刷新', exact: true }).click();
    await inline.locator('.dch-detail-heading h3').getByText('演示会话：工具清单变更', { exact: true }).waitFor();
    await nativeSettings.getByRole('button', { name: '关闭原生设置', exact: true }).click();
    await nativeSettings.waitFor({ state: 'detached' });

    assert.equal(await page.evaluate(key => localStorage.getItem(key), ONLY_WARNINGS_KEY), 'true');
    await page.reload();
    await tail(16).getByRole('button', { name: '缓存看板', exact: true }).click();
    const popup = page.getByRole('dialog', { name: '缓存有效率看板', exact: true });
    await popup.waitFor();
    await assertChecked(popup.getByLabel('只看异常'), true, 'page reload remembers true');
    await popup.getByText('1 个调用步骤', { exact: true }).waitFor();
    await popup.getByLabel('只看异常').uncheck();
    await popup.getByText(`${alphaCalls.length} 个调用步骤`, { exact: true }).waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), ONLY_WARNINGS_KEY), 'false');
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });
    await page.reload();
    await tail(14).getByRole('button', { name: '缓存看板', exact: true }).click();
    await popup.waitFor();
    await assertChecked(popup.getByLabel('只看异常'), false, 'page reload remembers false');
    await popup.getByText(`${alphaCalls.length} 个调用步骤`, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });

    sessions.alpha.calls = [...alphaCalls, ...Array.from({ length: 45 }, (_, index) => ({ ...good, turn: index + 100, step: 1, seq: index + 1000 }))];
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => __renderSettings({ withConversation: true }));
    await nativeSettings.getByRole('button', { name: '缓存看板', exact: true }).click();
    await showSessionTab(inline);
    await inline.getByText(`${sessions.alpha.calls.length} 个调用步骤`, { exact: true }).waitFor();
    await inline.getByRole('button', { name: '下一页', exact: true }).click();
    await inline.getByText('2 / 2', { exact: true }).waitFor();
    // Both instances are mounted, like settings above an existing conversation.
    await tail(16).getByRole('button', { name: '缓存看板', exact: true }).evaluate(button => button.click());
    await popup.waitFor();
    await popup.getByText(`${sessions.alpha.calls.length} 个调用步骤`, { exact: true }).waitFor();
    await popup.getByRole('button', { name: '下一页', exact: true }).click();
    await popup.getByText('2 / 2', { exact: true }).waitFor();
    await popup.getByLabel('只看异常').check();
    await assertChecked(inline.getByLabel('只看异常'), true, 'mounted settings synchronizes immediately with popup');
    await inline.getByText('1 个调用步骤', { exact: true }).waitFor();
    await popup.getByText('1 个调用步骤', { exact: true }).waitFor();
    assert.equal(await inline.locator('.dch-pagination').count(), 0);
    assert.equal(await popup.locator('.dch-pagination').count(), 0);
    await popup.getByLabel('只看异常').uncheck();
    await assertChecked(inline.getByLabel('只看异常'), false, 'unchecking synchronizes all mounted dashboard instances');
    await inline.getByText('1 / 2', { exact: true }).waitFor();
    await popup.getByText('1 / 2', { exact: true }).waitFor();

    const peer = await page.context().newPage();
    peer.on('pageerror', error => { pageErrors.push(`peer: ${error.message}`); });
    await peer.goto(fixtureUrl);
    await peer.locator('[data-turn-tail="16"]').getByRole('button', { name: '缓存看板', exact: true }).click();
    const peerPopup = peer.getByRole('dialog', { name: '缓存有效率看板', exact: true });
    await peerPopup.waitFor();
    await assertChecked(peerPopup.getByLabel('只看异常'), false, 'a new tab loads the stored global value');
    await popup.getByLabel('只看异常').check();
    await assertChecked(peerPopup.getByLabel('只看异常'), true, 'storage event synchronizes true into another tab');
    await peerPopup.getByLabel('只看异常').uncheck();
    await assertChecked(popup.getByLabel('只看异常'), false, 'storage event synchronizes false back to the popup');
    await assertChecked(inline.getByLabel('只看异常'), false, 'storage event also synchronizes the settings instance');
    await popup.getByLabel('只看异常').check();
    await assertChecked(peerPopup.getByLabel('只看异常'), true, 'tabs synchronize again before storage reset');
    await peer.evaluate(() => localStorage.clear());
    await assertChecked(popup.getByLabel('只看异常'), false, 'storage clear event restores the default across tabs');
    await assertChecked(inline.getByLabel('只看异常'), false, 'storage clear also updates mounted settings');
    await peerPopup.getByLabel('只看异常').uncheck();
    await peer.close();
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'detached' });
    await nativeSettings.getByRole('button', { name: '关闭原生设置', exact: true }).click();
    await nativeSettings.waitFor({ state: 'detached' });
    sessions.alpha.calls = alphaCalls;

    const blockedContext = await browser.newContext();
    const blocked = await blockedContext.newPage();
    blocked.on('pageerror', error => { pageErrors.push(`blocked storage: ${error.message}`); });
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage blocked by fixture', 'SecurityError'); } }));
    await blocked.goto(fixtureUrl);
    await blocked.locator('[data-turn-tail="16"]').getByRole('button', { name: '缓存看板', exact: true }).click();
    const blockedPopup = blocked.getByRole('dialog', { name: '缓存有效率看板', exact: true });
    await blockedPopup.waitFor();
    await assertChecked(blockedPopup.getByLabel('只看异常'), false, 'unavailable storage starts with an in-memory default');
    await blockedPopup.getByLabel('只看异常').check();
    await blockedPopup.getByText('1 个调用步骤', { exact: true }).waitFor();
    await blocked.keyboard.press('Escape');
    await blockedPopup.waitFor({ state: 'detached' });
    await blocked.locator('[data-turn-tail="14"]').getByRole('button', { name: '缓存看板', exact: true }).click();
    await blockedPopup.waitFor();
    await assertChecked(blockedPopup.getByLabel('只看异常'), true, 'unavailable storage still shares the in-memory value across popup lifetimes');
    await blockedContext.close();

    await page.evaluate(() => __cleanup());
    assert.equal(await page.locator('style[data-dsh-cache-helper]').count(), 0, 'plugin cleanup removes styles');
    assert.equal(await page.evaluate(() => __disposedRegistrations.includes('dsh-cache-helper')), true, 'plugin cleanup unregisters its settings section');
    // Browser automation can have its own Document observer. The helper only
    // observes documentElement while attaching and individual turn tails.
    const remainingObservers = await page.evaluate(() => [...__activeObservers.values()]
      .filter(target => target===document.documentElement || target.matches?.('[data-turn-tail]'))
      .map(target => ({ tag: target.tagName, turn: target.getAttribute('data-turn-tail') })));
    assert.deepEqual(remainingObservers, [], `helper cleanup disconnects both local and attachment observers: ${JSON.stringify(remainingObservers)}`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
