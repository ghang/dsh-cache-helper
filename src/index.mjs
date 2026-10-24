import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { GateController, GateError } from './gate.mjs';
import { SessionRepository, liveRecords, requestRevision } from './repository.mjs';
import { inspectNextRequest } from './analysis.mjs';
import { latestReceiptSeq } from './history.mjs';
import { PolicyStore } from './policy.mjs';
import { OperationController } from './operations.mjs';
import { sessionIdentity, selectReceiptBaseline } from './session-identity.mjs';
import { ChildControl } from './child-control.mjs';
import { SessionCatalog } from './session-catalog.mjs';
import { AnalysisJobs } from './analysis-jobs.mjs';

export const name = 'cache-helper';
export const inject = ['llm', 'sessions', 'webServer', 'connection'];
export const Config = z.object({
  minLostTokens: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(50000).volatile().description('旧前缀预计损失 Token 下限'),
  minLossRatio: z.number().min(0).max(1).default(0.2).volatile().description('旧前缀预计损失比例下限'),
  dashboardLimit: z.natural().min(1).max(200).default(50).volatile().description('最近活跃会话扫描上限'),
  maxEvents: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(200000).volatile().description('单会话事件读取上限'),
  maxCachedSessions: z.natural().min(1).max(200).default(64).volatile().description('派生指标内存缓存会话数'),
  childProtection: z.union(['observe', 'block']).default('block').volatile().description('子 Agent 缓存风险：观察或等待浏览器确认'),
});

function configOf(config) {
  const childProtection = config.childProtection?.get?.() ?? config.childProtection ?? 'block';
  if (!['observe', 'block'].includes(childProtection)) throw new GateError('无效的子 Agent 保护模式。', 'CACHE_HELPER_BAD_DECISION');
  const childPendingTimeoutMs = config.childPendingTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(childPendingTimeoutMs) || childPendingTimeoutMs < 1 || childPendingTimeoutMs > 120_000)
    throw new GateError('子 Agent 待确认期限必须在 1ms 到 120s 以内。', 'CACHE_HELPER_BAD_DECISION');
  return {
    minLostTokens: 50000, minLossRatio: 0.2, dashboardLimit: 50,
    maxEvents: 200000, maxCachedSessions: 64, ...config, childProtection, childPendingTimeoutMs,
    ...(config.minLossTokens === undefined ? {} : { minLostTokens: config.minLossTokens }),
  };
}

function fingerprint(options, revision) {
  return createHash('sha256').update(JSON.stringify({
    revision, provider: options.provider, model: options.model,
    messages: options.messages, system: options.system, tools: options.tools,
    toolHistory: options.toolHistory, reasoningEffort: options.reasoningEffort,
    temperature: options.temperature, maxTokens: options.maxTokens, stop: options.stop,
  })).digest('hex');
}

// Live diagnostics also remain finite and body-free when a custom projection
// throws an exception containing private input. The actual request stays with
// the Host; a browser confirmation needs risk scales and change categories.
function riskView(risk) {
  if (!risk) return null;
  const result = {};
  for (const key of ['lossTokens', 'lossRatio', 'previousPromptTokens', 'commonPrefixChars', 'previousChars']) {
    if (risk[key] === null || Number.isFinite(risk[key])) result[key] = risk[key];
  }
  for (const key of ['unknown', 'estimated', 'significant']) if (typeof risk[key] === 'boolean') result[key] = risk[key];
  for (const key of ['previousFingerprint', 'fingerprint']) if (typeof risk[key] === 'string' && /^[a-f0-9]{64}$/.test(risk[key])) result[key] = risk[key];
  const messages = { route: '提供方或模型发生变化。', tools: '模型实际工具声明发生变化，可能破坏旧请求前缀。',
    system: '头部 system 内容发生变化。', history: '既有消息前缀被替换、截断或重新投影。', unknown: '历史输入重建或适配器比较不完整。' };
  result.changes = (risk.changes ?? []).slice(0, 32).map(change => {
    const kind = Object.hasOwn(messages, change.kind) ? change.kind : 'unknown';
    return { kind, message: messages[kind],
      ...Object.fromEntries(['reordered', 'preservesPrefix'].filter(key => typeof change[key] === 'boolean').map(key => [key, change[key]])),
      ...Object.fromEntries(['added', 'removed', 'changed'].filter(key => Array.isArray(change[key]))
        .map(key => [key, change[key].slice(0, 128).map(name => String(name).slice(0, 256))])) };
  });
  if (risk.unknown) {
    result.message = messages.unknown;
    result.reason = '无法完成可靠的上下文缓存检查，需要确认后发送。';
  }
  return result;
}

async function bodyOf(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw Object.assign(new Error('需要 application/json。'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('请求体过大。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('无效的 JSON。'), { status: 400 }); }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export async function createCacheHelper(ctx, userConfig = {}) {
  let config = configOf(userConfig);
  const policy = new PolicyStore(config);
  config = { ...config, ...policy.snapshot().values };
  const gate = new GateController();
  const repository = new SessionRepository(ctx, config);
  await repository.init();
  const children = new ChildControl(ctx, { gate,
    ...(config.childStopTimeoutMs ? { stopTimeoutMs: config.childStopTimeoutMs } : {}),
  });
  const catalog = new SessionCatalog(ctx, { analysisStatus: (header, metadata) => repository.analysisStatus?.(header, metadata) ?? { status: 'none' } });
  const jobs = new AnalysisJobs({ catalog, analyze: (id, options) => repository.session(id, options),
    statePath: config.jobStatePath ?? join(dirname(repository.statePath), 'analysis-jobs.json'),
    persistState: config.persistState !== false,
  });
  await jobs.init();
  const operations = new OperationController(ctx, {
    gate, persistState: config.persistState,
    policy: () => ({ version: policy.snapshot().version, ...policy.snapshot().values }),
    ...(config.operationStatePath ? { statePath: config.operationStatePath } : {}),
  });
  await operations.init();
  repository.operations = () => operations.list();
  const disposers = [];
  let disposed = false;
  const api = {
    gate, repository, policy, operations, children, catalog, jobs,
    updateResolvedConfig: next => {
      const resolved = configOf(next);
      const snapshot = policy.updateResolvedConfig(resolved);
      config = { ...config, ...resolved, ...snapshot.values };
      repository.updatePolicy(config, snapshot.version);
      return snapshot;
    },
    getSession: async (sessionId, options = {}) => {
      try {
        const metrics = options.cached ? await repository.cachedSession?.(sessionId, options) : await repository.session(sessionId, options);
        if (options.cached && !metrics) return null;
        return { ...metrics, sessionId, pending: gate.pendingFor(sessionId), childrenPending: gate.list({ sessionId }).filter(item => item.sessionId !== sessionId),
          childObservation: children.observations({ sessionId }), operation: operations.forSession(sessionId) };
      }
      catch (error) {
        const pending = gate.pendingFor(sessionId);
        const childrenPending = gate.list({ sessionId }).filter(item => item.sessionId !== sessionId);
        if (!pending && !childrenPending.length) throw error;
        // A failed analysis must not hide the very confirmation waiting on it.
        return {
          sessionId, title: sessionId, latest: null, cumulative: null,
          calls: [], turns: [], warnings: [], pending, childrenPending,
          config: { minLostTokens: config.minLostTokens, minLossRatio: config.minLossRatio },
          coverage: { unknown: true, errors: [{ message: '当前会话的用量分析不可用；发送前检查仍在等待确认。' }] },
        };
      }
    },
    dashboard: (query, options) => repository.dashboard(query, options),
    pending: options => {
      const pending = gate.list(options);
      return { pending, count: pending.length, observations: children.observations(options),
        stops: children.stops(options), reachability: children.reachability(), childProtection: config.childProtection };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      gate.dispose();
      await children.dispose();
      await jobs.dispose();
      await operations.dispose();
      for (const dispose of disposers.reverse()) await dispose();
      await repository.dispose();
    },
  };

  disposers.push(ctx.on('llm/stream', async function* (options, next) {
    if (disposed) throw new GateError('缓存插件已卸载，请重新发送。');
    const strategy = policy.snapshot();
    const requestConfig = { ...config, ...strategy.values };
    if (isAgentLoopRequest(options) && !options.purpose) {
      const session = ctx.sessions.get(options.sessionId);
      if (!session) throw new GateError('缓存检查无法读取当前会话，已阻止发送。', 'CACHE_HELPER_SESSION_UNAVAILABLE');
      {
        const records = liveRecords(session);
        const parentHeaders = new Map();
        let parentId = session.header.parentSession;
        for (let hops = 0; parentId && !parentHeaders.has(parentId) && hops < 128; hops++) {
          const parent = ctx.sessions.get(parentId);
          if (!parent) break;
          parentHeaders.set(parentId, { ...parent.header, inheritedEventCount: parent.inheritedEventCount });
          parentId = parent.header.parentSession;
        }
        const runtimeIdentity = children.snapshot(session.id);
        const identity = sessionIdentity(records, { parentHeaders, ...(runtimeIdentity ? { runtimeIdentity } : {}) });
        const baseline = selectReceiptBaseline(records, { parentHeaders });
        const child = identity.role === 'sub';
        const revision = requestRevision(records);
        const contentGeneration = session.surface.contentGeneration;
        const sourceCut = { eventCount: records.length - 1, lastSeq: records.at(-1)?.seq ?? null,
          requestRevision: revision, contentGeneration, inheritedEventCount: baseline.inheritedEventCount };
        let risk;
        try {
          if (records.length - 1 > requestConfig.maxEvents) throw new Error('Session exceeds the cache analysis event limit');
          const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
          risk = await inspectNextRequest(records, options, {
            ...requestConfig, toolUpdate: info.toolUpdate, systemPromptUpdate: info.systemPromptUpdate,
            messageProjections: ctx.sessions.messageProjections ?? [],
            baseline,
          });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (baseline.kind !== 'none' || latestReceiptSeq(records) !== null) {
            risk = { unknown: true, reason: '无法完成上下文缓存检查，需要确认后才能发送。',
              changes: [{ kind: 'unknown', message: '历史重建或模型输入投影失败，请检查插件兼容性。' }] };
          }
        }
        risk = riskView(risk);
        if (child) children.observe(session.id, { identity, baseline, sourceCut,
          state: risk ? config.childProtection === 'block' ? 'risk' : 'observed-risk' : baseline.kind === 'none' ? 'first-request' : 'checked',
          ...(risk ? { risk } : {}) });
        if (child && config.childProtection !== 'block') risk = null;
        if (risk) {
          if (child && (!runtimeIdentity || !children.reachability().reachable)) {
            children.observe(session.id, { identity, baseline, sourceCut, state: 'unsupported',
              reason: runtimeIdentity ? '确认通道不可达，本次高风险子请求已拒绝。' : '缺少原生 activation 证据，本次高风险子请求已拒绝。' });
            throw new GateError(runtimeIdentity ? '子任务缓存风险确认通道不可达，已拒绝本次发送。'
              : '无法确认原生子任务 activation，已拒绝本次高风险发送。', 'CACHE_HELPER_CHILD_UNSUPPORTED');
          }
          let turn, step;
          for (let index = records.length - 1; index > 0; index--) {
            if (records[index].type === 'step/start') {
              ({ turn, step } = records[index].data); break;
            }
          }
          const candidateFingerprint = fingerprint(options, revision);
          const observed = () => ctx.sessions.get(session.id) === session
            && session.surface.contentGeneration === contentGeneration
            && requestRevision(session.snapshotEvents()) === revision
            && (!child || children.matches(session.id, runtimeIdentity.activationGeneration, session));
          const valid = () => {
            if (!observed() || fingerprint(options, revision) !== candidateFingerprint) return false;
            const current = liveRecords(session);
            const nextBaseline = selectReceiptBaseline(current, { parentHeaders });
            return requestRevision(current) === revision
              && nextBaseline.kind === baseline.kind && nextBaseline.seq === baseline.seq
              && nextBaseline.inheritedEventCount === baseline.inheritedEventCount
              && (!child || children.matches(session.id, runtimeIdentity.activationGeneration, session));
          };
          await gate.wait({ ...risk, policy: strategy, identity, baseline, sourceCut,
            ...(child && baseline.kind === 'inherited' ? { reason: '继承前缀复用风险：请确认此子任务的本次发送。' } : {}) }, {
            sessionId: session.id, fingerprint: candidateFingerprint, turn, step, signal: options.signal,
            validate: valid, observe: observed,
            ...(child ? { timeoutMs: config.childPendingTimeoutMs } : {}),
          });
          if (!valid()) throw new GateError('确认后候选已变化，本次请求未发送。', 'CACHE_HELPER_STALE');
        }
      }
    }
    options.signal?.throwIfAborted();
    if (disposed) throw new GateError('缓存插件已卸载，请重新发送。');
    yield* next();
  }));
  disposers.push(ctx.on('session/disposed', session => gate.cancel(session.id)));

  if (config.registerHttp !== false) {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/dsh-cache-helper/api', handler: async (req, res) => {
      const controller = new AbortController();
      const aborted = () => controller.abort();
      const closed = () => { if (!res.writableEnded) controller.abort(); };
      req.once?.('aborted', aborted);
      res.once?.('close', closed);
      try {
        const admission = ctx.connection.admit(req);
        if ('rejection' in admission) return json(res, admission.rejection, { error: '需要 DSH 浏览器登录。' });
        // Model/API operators cannot answer the user's cost confirmation.
        if (admission.peer.id !== ctx.connection.browserPeer.id) return json(res, 403, { error: '仅浏览器用户可访问缓存确认界面。' });
        const url = new URL(req.url, 'http://local');
        const path = url.pathname;
        const access = { owner: 'browser', signal: controller.signal };
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/pending') {
          return json(res, 200, api.pending({ sessionId: url.searchParams.get('sessionId') || undefined }));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/pending/reachable') {
          return json(res, 200, children.reachable(await bodyOf(req)));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/children/stop') {
          return json(res, 200, await children.stop(await bodyOf(req)));
        }
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/sessions') {
          const query = Object.fromEntries(url.searchParams);
          for (const key of ['limit', 'createdFrom', 'createdTo', 'activityFrom', 'activityTo']) {
            if (query[key] !== undefined) query[key] = Number(query[key]);
          }
          return json(res, 200, await catalog.list(query, access));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/analysis/selection') {
          const data = await bodyOf(req);
          return json(res, 200, await catalog.select(data.sessionIds, { ...access,
            includeChildren: data.includeChildren, snapshotId: data.snapshotId }));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/analysis/jobs') return json(res, 200, await jobs.start(await bodyOf(req), access));
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/analysis/jobs') return json(res, 200,
          url.searchParams.has('id') ? await jobs.get(url.searchParams.get('id'), access) : await jobs.list(access));
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/analysis/jobs/cancel') return json(res, 200, await jobs.cancel(await bodyOf(req), access));
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/analysis/cache') return json(res, 200, await repository.analysis.cacheSummary());
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/analysis/cache/clear') {
          const data = await bodyOf(req);
          if (!data || typeof data !== 'object' || Array.isArray(data)
            || (data.sessionId !== undefined && (typeof data.sessionId !== 'string' || !data.sessionId.length || data.sessionId.length > 200)))
            return json(res, 400, { error: '无效的缓存清理范围。' });
          return json(res, 200, await repository.analysis.clearCache(data.sessionId));
        }
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/session') {
          const id = url.searchParams.get('sessionId');
          if (!id || id.length > 200) return json(res, 400, { error: '缺少有效 sessionId。' });
          await catalog.assertVisible([id], access);
          return json(res, 200, await api.getSession(id, { signal: controller.signal, cached: url.searchParams.get('cached') === '1' }));
        }
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/dashboard') return json(res, 200, await api.dashboard({
          period: url.searchParams.get('period') ?? '7d',
          model: url.searchParams.get('model') || undefined,
          provider: url.searchParams.get('provider') || undefined,
        }, { signal: controller.signal }));
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/operations/preview') {
          return json(res, 200, await operations.preview(url.searchParams.get('sessionId')));
        }
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/operations') {
          return json(res, 200, url.searchParams.has('id')
            ? operations.get(url.searchParams.get('id')) : operations.forSession(url.searchParams.get('sessionId')));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/operations/start') {
          return json(res, 200, await operations.start(await bodyOf(req)));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/operations/cancel') {
          return json(res, 200, await operations.cancel(await bodyOf(req)));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/decision') {
          const data = await bodyOf(req);
          return json(res, 200, gate.decide(data));
        }
        if (req.method === 'POST' && path === '/dsh-cache-helper/api/warnings/dismiss') {
          return json(res, 200, await repository.dismiss(await bodyOf(req)));
        }
        return json(res, 404, { error: '接口不存在。' });
      } catch (error) {
        const status = error.code === 'CACHE_HELPER_STALE' ? 409
          : error.code === 'CACHE_HELPER_BAD_DECISION' ? 400 : error.status ?? 500;
        json(res, status, { error: status === 500 ? '缓存分析暂不可用，请检查宿主日志。' : error.message,
          ...(error.code ? { code: error.code } : {}) });
      } finally {
        req.off?.('aborted', aborted);
        res.off?.('close', closed);
      }
    } }));
  }
  return api;
}

export async function apply(ctx, config) {
  const helper = await createCacheHelper(ctx, config);
  ctx.on('loader/volatile-update', () => { helper.updateResolvedConfig(config); });
  ctx.effect(() => () => helper.dispose(), 'cache-helper: cancel pending requests on unload');
}

export default { name, inject, Config, apply };
