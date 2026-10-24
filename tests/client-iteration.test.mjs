import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, selectTab, detail, NOW } from './browser-fixture.mjs';

function row(index, extra = {}) {
  return { sessionId: `history-${index}`, title: `历史会话 ${index}`, kind: 'main', role: 'main',
    live: false, persisted: true, analysisStatus: 'none', createdAt: NOW - index * 1000,
    activityAt: NOW, activitySource: 'created-fallback', eventCount: 10, sizeBytes: 1000,
    budgetKnown: true, model: null, warningCount: null, ...extra };
}
function harness(options = {}) {
  const state = { rows: Array.from({ length: 61 }, (_, index) => row(index + 1)),
    jobs: options.jobs || [], pending: options.pending || [], observations: [], stops: [],
    channels: new Map(), cacheEntries: 2, completes: options.completes !== false, ...options.state };
  state.rows[51] = row(52, { kind: 'sub', role: 'sub', directParentId: 'history-51' });
  state.rows[52] = row(53, { kind: 'fork', forkParentId: 'history-51' });
  const api = async ({ url, request, response, body, json }) => {
    const send = (value, status) => { json(response, value, status); return true; };
    const path = url.pathname;
    if (path.endsWith('/sessions')) {
      const offset = Number(url.searchParams.get('cursor') || 0);
      const q = url.searchParams.get('q');
      const rows = q ? state.rows.filter(item => item.title.includes(q) || item.sessionId.includes(q)) : state.rows;
      return send({ snapshotId: 'directory-one', items: rows.slice(offset, offset + 25), total: rows.length,
        nextCursor: offset + 25 < rows.length ? String(offset + 25) : null, generatedAt: NOW,
        coverage: { listed: rows.length, limited: false, budgetUnknown: 0 } });
    }
    if (path.endsWith('/analysis/selection')) {
      const ids = new Set(body.sessionIds);
      if (body.includeChildren) for (const item of state.rows) if (item.kind === 'sub' && ids.has(item.directParentId)) ids.add(item.sessionId);
      return send({ snapshotId: 'directory-one', selectedIds: [...ids], items: state.rows.filter(item => ids.has(item.sessionId)) });
    }
    if (path.endsWith('/analysis/jobs/cancel')) {
      const job = state.jobs.find(item => item.id === body.id);
      job.state = 'cancelled';
      for (const item of job.items) if (!['cached', 'completed'].includes(item.state)) item.state = 'cancelled';
      job.progress = { total: job.items.length, finished: job.items.length, completed: job.items.filter(item => item.state === 'completed').length,
        cached: 0, failed: 0, limited: 0, cancelled: job.items.filter(item => item.state === 'cancelled').length };
      return send(structuredClone(job));
    }
    if (path.endsWith('/analysis/jobs')) {
      if (request.method === 'POST') {
        const job = { id: `analysis-${state.jobs.length + 1}`, state: 'running', mode: body.mode,
          createdAt: NOW + state.jobs.length, updatedAt: NOW + state.jobs.length,
          selectedIds: body.sessionIds, items: body.sessionIds.map((id, index) => ({ sessionId: id, state: index === 0 && !state.completes ? 'completed' : 'running' })),
          progress: { total: body.sessionIds.length, finished: !state.completes ? 1 : 0, completed: !state.completes ? 1 : 0 } };
        state.jobs.push(job); return send(structuredClone(job));
      }
      const id = url.searchParams.get('id');
      if (!id) return send(structuredClone(state.jobs));
      const job = state.jobs.find(item => item.id === id);
      if (state.completes && ['running', 'queued'].includes(job.state)) {
        job.state = 'completed'; job.items.forEach(item => { item.state = job.mode === 'reuse' ? 'cached' : 'completed'; });
        job.progress = { total: job.items.length, finished: job.items.length, cached: job.mode === 'reuse' ? job.items.length : 0,
          completed: job.mode === 'refresh' ? job.items.length : 0, failed: 0, limited: 0, cancelled: 0 };
      }
      return send(structuredClone(job));
    }
    if (path.endsWith('/analysis/cache/clear')) { state.cacheEntries = 0; return send({ cleared: 2 }); }
    if (path.endsWith('/analysis/cache')) return send({ enabled: true, entries: state.cacheEntries, bytes: state.cacheEntries * 1000, budget: { maxBytes: 32 * 1024 * 1024 } });
    if (path.endsWith('/pending/reachable')) {
      const previous = state.channels.get(body.channelId);
      if (!previous || previous.seq < body.seq) state.channels.set(body.channelId, body);
      return send({ reachable: [...state.channels.values()].some(item => item.reachable) });
    }
    if (path.endsWith('/pending')) return send({ pending: state.pending, observations: state.observations, stops: state.stops, childProtection: 'block' });
    if (path.endsWith('/decision')) {
      const current = state.pending.find(item => item.id === body.id && item.sessionId === body.sessionId && item.fingerprint === body.fingerprint);
      if (!current) return send({ error: '此确认已过期' }, 409);
      state.pending = state.pending.filter(item => item.id !== current.id); return send({ ok: true });
    }
    if (path.endsWith('/children/stop')) {
      const current = state.pending.find(item => item.id === body.id);
      assert.equal(body.parentSessionId, 'main'); assert.equal(body.activationGeneration, current.identity.activationGeneration);
      state.pending = state.pending.filter(item => item.id !== current.id);
      const receipt = { ...body, startedAt: NOW, state: 'stopping', quiescent: false, descendantsStopped: false };
      state.stops.push(receipt);
      await new Promise(resolve => setTimeout(resolve, 80));
      receipt.state = 'stop-unconfirmed';
      return send(receipt);
    }
    if (path.endsWith('/session') && url.searchParams.get('sessionId')?.startsWith('history-')) {
      if (url.searchParams.get('cached') === '1') return send(null);
      const id = url.searchParams.get('sessionId');
      return send({ ...detail(id), title: state.rows.find(item => item.sessionId === id)?.title || id,
        sourceCut: { eventCount: 10, lastSeq: 9 }, cacheStatus: 'memory' });
    }
    return false;
  };
  return { state, api };
}

test('browser iteration: metadata selection reaches the 51st history and freezes the reviewed child set', async t => {
  const stub = harness();
  const { page, requests, errors } = await fixture(t, { api: stub.api });
  await selectTab(page, '会话明细');
  assert.equal(requests.filter(item => item.path.endsWith('/sessions')).length, 0, 'Opening the tab alone does not enumerate or analyze all history');
  await page.getByRole('button', { name: '选择会话分析', exact: true }).click();
  const region = page.getByRole('region', { name: '选择会话分析', exact: true });
  await region.getByText('历史会话 1', { exact: true }).waitFor();
  await region.getByRole('button', { name: '下一页会话' }).click();
  await region.getByText('历史会话 26', { exact: true }).waitFor();
  await region.getByRole('button', { name: '下一页会话' }).click();
  await region.getByText('历史会话 51', { exact: true }).waitFor();
  assert.equal(requests.filter(item => item.path.endsWith('/analysis/jobs') && item.method === 'POST').length, 0);
  const target = region.locator('.dch-catalog-row').filter({ has: page.getByText('历史会话 51', { exact: true }) });
  await target.getByRole('button', { name: '仅选此会话' }).click();
  await region.getByLabel('包含子 Agent', { exact: true }).check();
  await region.getByRole('button', { name: '预览分析范围' }).click();
  await region.getByText('固定分析范围：2 个会话（已去重）', { exact: true }).waitFor();
  await region.getByRole('button', { name: '分析所选', exact: true }).click();
  await region.getByRole('heading', { name: '分析任务：完成', exact: true }).waitFor();
  const start = requests.find(item => item.path.endsWith('/analysis/jobs') && item.method === 'POST');
  assert.deepEqual(start.body.sessionIds, ['history-51', 'history-52']);
  assert.equal(start.body.includeChildren, false, 'Already reviewed descendants cannot expand again at execution');
  assert.equal(start.body.snapshotId, 'directory-one');
  assert.equal(start.body.mode, 'reuse');
  await region.getByRole('button', { name: '查看分析结果', exact: true }).first().click();
  await page.getByRole('region', { name: '调用步骤明细', exact: true }).getByRole('heading', { name: '历史会话 51', exact: true }).waitFor();
  await region.getByRole('button', { name: '重新分析', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="本地分析进度"] h3')?.textContent === '分析任务：完成');
  const starts = requests.filter(item => item.path.endsWith('/analysis/jobs') && item.method === 'POST');
  assert.equal(starts.length, 2); assert.equal(starts[1].body.mode, 'refresh');
  assert.equal(requests.some(item => /\/operations\/start|\/children\/stop|\/decision$/.test(item.path)), false);
  assert.deepEqual(errors, []);
});

test('browser iteration: cancelled and interrupted analysis retain completed items without controlling agents', async t => {
  const stub = harness({ completes: false, jobs: [{ id: 'interrupted-one', state: 'interrupted', mode: 'reuse', createdAt: NOW, updatedAt: NOW,
    items: [{ sessionId: 'history-61', state: 'cancelled' }], progress: { total: 1, finished: 1, cancelled: 1 } }] });
  const { page, requests, errors } = await fixture(t, { api: stub.api });
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: '选择会话分析', exact: true }).click();
  const region = page.getByRole('region', { name: '选择会话分析', exact: true });
  await region.getByRole('heading', { name: '分析任务：进程中断，未自动续跑', exact: true }).waitFor();
  assert.equal(requests.some(item => item.path.endsWith('/analysis/jobs') && item.method === 'POST'), false);
  await region.getByLabel('选择 历史会话 1', { exact: true }).check();
  await region.getByLabel('选择 历史会话 2', { exact: true }).check();
  await region.getByRole('button', { name: '预览分析范围' }).click();
  await region.getByRole('button', { name: '分析所选', exact: true }).click();
  await region.getByRole('button', { name: '取消分析', exact: true }).click();
  await region.getByRole('heading', { name: '分析任务：已取消', exact: true }).waitFor();
  const job = stub.state.jobs.at(-1);
  assert.equal(job.items[0].state, 'completed'); assert.equal(job.items[1].state, 'cancelled');
  assert.equal(await region.getByRole('button', { name: '查看分析结果' }).count(), 1);
  assert.equal(requests.some(item => /\/decision$|\/children\/stop|\/operations\/cancel/.test(item.path)), false);
  await region.getByRole('button', { name: '收起会话选择' }).click();
  await page.getByRole('button', { name: '选择会话分析', exact: true }).click();
  await region.getByRole('heading', { name: '分析任务：已取消', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

const pending = index => ({ id: `pending-${index}`, sessionId: `child-${index}`, fingerprint: `candidate-${index}`,
  turn: 2, step: 1, lossTokens: 90_000, lossRatio: 0.9, createdAt: Date.now(), expiresAt: Date.now() + 120_000,
  identity: { role: 'sub', directParentId: 'main', rootSessionId: 'main', activationGeneration: `activation-${index}` },
  baseline: { kind: index === 1 ? 'inherited' : 'own' }, changes: [{ kind: 'tools', message: '合成工具前缀变化' }] });

test('browser iteration: parent and collapsed global entry share pending decisions and bounded stop outcomes', async t => {
  const stub = harness({ pending: [pending(1), pending(2)] });
  const { page, requests, errors } = await fixture(t, { api: stub.api, globalPending: true, composerSessionId: 'main' });
  await page.getByText('2 个子任务请求等待缓存确认', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'Child pending requests do not pile automatic modals');
  await page.waitForFunction(() => document.querySelector('.dch-global-confirm')?.textContent.includes('(2)'));
  assert.ok(requests.some(item => item.path.endsWith('/pending/reachable') && item.body?.reachable));
  await page.evaluate(() => window.__setWide(false));
  const entry = page.getByRole('button', { name: '缓存待确认 2 项', exact: true });
  assert.equal(await entry.isVisible(), true);
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '缓存待确认', exact: true });
  await dialog.getByText('继承前缀', { exact: false }).waitFor();
  await dialog.locator('article').filter({ hasText: 'child-1' }).getByRole('button', { name: '继续本次发送' }).click();
  await page.waitForFunction(() => document.querySelector('.dch-global-confirm')?.getAttribute('aria-label') === '缓存待确认 1 项');
  assert.deepEqual(requests.find(item => item.path.endsWith('/decision')).body,
    { sessionId: 'child-1', id: 'pending-1', fingerprint: 'candidate-1', decision: 'confirm' });
  await dialog.locator('article').filter({ hasText: 'child-2' }).getByRole('button', { name: '停止此子任务' }).click();
  await dialog.getByText('停止信号已接纳，尚未确认静止', { exact: true }).waitFor();
  assert.equal(stub.state.stops[0].descendantsStopped, false);
  await dialog.getByRole('button', { name: '关闭缓存确认列表' }).click();
  await page.getByText('停止信号已接纳，尚未确认静止', { exact: true }).waitFor();
  await page.evaluate(() => window.__dispose());
  await page.waitForTimeout(100);
  for (const channel of stub.state.channels.values()) assert.equal(channel.reachable, false, 'Unmount revokes every confirmation reachability lease');
  assert.deepEqual(errors, []);
});

test('browser iteration: stale cache stays labelled through a failed validation and clearing preserves sessions', async t => {
  const stub = harness();
  const api = async args => {
    if (args.url.pathname.endsWith('/session') && args.url.searchParams.get('sessionId') === 'child') {
      if (args.url.searchParams.get('cached') === '1') args.json(args.response, { ...detail('child', 'sub'),
        sourceCut: { validation: 'unverified', lastSeq: 42 }, cacheStatus: 'stale-disk' });
      else args.json(args.response, { error: '合成日志校验失败' }, 503);
      return true;
    }
    return stub.api(args);
  };
  const { page, requests, errors } = await fixture(t, { api });
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: /合成子会话/ }).click();
  await page.getByText('缓存结果，尚未校验当前日志 · 分析至事件 42', { exact: true }).waitFor();
  await page.getByText('合成日志校验失败。显示上次结果。', { exact: true }).waitFor();
  assert.equal(await page.locator('tr[data-cache-evidence-seq="42"]').count(), 1);
  await selectTab(page, '设置');
  const cache = page.getByRole('region', { name: '本地分析缓存', exact: true });
  await cache.getByRole('button', { name: '清理分析缓存' }).click();
  await cache.getByText('分析缓存已清理。现有会话和真实用量保留，下次分析会重新计算。', { exact: true }).waitFor();
  assert.equal(stub.state.cacheEntries, 0);
  assert.equal(requests.some(item => /\/operations\/start|\/decision$|\/analysis\/jobs$/.test(item.path) && item.method === 'POST'), false);
  assert.deepEqual(errors, []);
});

test('browser iteration: child policy uses the Host form and remains usable in a narrow viewport', async t => {
  const stub = harness();
  const { page, errors } = await fixture(t, { api: stub.api });
  await page.setViewportSize({ width: 390, height: 850 });
  await selectTab(page, '设置');
  await page.getByLabel('子任务保护模式', { exact: true }).selectOption('block');
  await page.getByRole('button', { name: '保存子任务策略', exact: true }).click();
  await page.getByText('子任务保护模式已保存；已有待确认请求仍需明确决定。', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__writes.at(-1).ops), [{ op: 'set', path: ['childProtection'], value: 'block' }]);
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: '选择会话分析', exact: true }).click();
  await page.getByText('历史会话 1', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
});

test('browser iteration: an evicted detail keeps known accounting separate from unknown steps and rates', async t => {
  const stub = harness();
  const api = async args => {
    if (args.url.pathname.endsWith('/session') && args.url.searchParams.get('sessionId') === 'child') {
      if (args.url.searchParams.get('cached') === '1') args.json(args.response, {
        ...detail('child', 'sub'), latest: null, cumulative: null, calls: [], warnings: [], turns: [],
        accountingSummary: { own: { calls: 2, knownCacheReadTokens: 100_000, unknownUsageCalls: 1 }, inherited: { calls: 3 } },
        sourceCut: { validation: 'unverified', lastSeq: 42 }, cacheStatus: 'summary-only',
        coverage: { partial: true, detailsAvailable: false, reason: 'details-not-retained' },
      });
      else args.json(args.response, { error: '合成明细重建受限' }, 503);
      return true;
    }
    return stub.api(args);
  };
  const { page, errors } = await fixture(t, { api });
  await selectTab(page, '会话明细');
  await page.getByRole('button', { name: /合成子会话/ }).click();
  const region = page.getByRole('region', { name: '调用步骤明细', exact: true });
  await region.getByText('仅保留用量汇总，调用步骤未覆盖', { exact: true }).waitFor();
  await region.getByText('合成明细重建受限。显示上次结果。', { exact: true }).waitFor();
  assert.match(await region.textContent(), /自身 2 次调用，已知缓存读取 100K tok/);
  assert.match(await region.textContent(), /未知用量 1 次；继承 3 次单列/);
  assert.match(await region.textContent(), /空步骤不表示无异常/);
  assert.equal(await region.locator('tbody tr').count(), 0);
  assert.equal(await region.getByText('没有异常步骤', { exact: true }).count(), 0);
  assert.equal(await region.getByText(/累计命中 0(?:\.0)?%/).count(), 0);
  assert.deepEqual(errors, []);
});
