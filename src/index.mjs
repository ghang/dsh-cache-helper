import { createHash } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { GateController, GateError } from './gate.mjs';
import { SessionRepository, liveRecords, requestRevision } from './repository.mjs';
import { inspectNextRequest } from './analysis.mjs';
import { latestReceiptSeq } from './history.mjs';
import { PolicyStore } from './policy.mjs';
import { OperationController } from './operations.mjs';

export const name = 'cache-helper';
export const inject = ['llm', 'sessions', 'webServer', 'connection'];
export const Config = z.object({
  minLostTokens: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(50000).volatile().description('旧前缀预计损失 Token 下限'),
  minLossRatio: z.number().min(0).max(1).default(0.2).volatile().description('旧前缀预计损失比例下限'),
  dashboardLimit: z.natural().min(1).max(200).default(50).volatile().description('最近活跃会话扫描上限'),
  maxEvents: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(200000).volatile().description('单会话事件读取上限'),
  maxCachedSessions: z.natural().min(1).max(200).default(64).volatile().description('派生指标内存缓存会话数'),
});

function configOf(config) {
  return {
    minLostTokens: 50000, minLossRatio: 0.2, dashboardLimit: 50,
    maxEvents: 200000, maxCachedSessions: 64, ...config,
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

async function bodyOf(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw Object.assign(new Error('需要 application/json。'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('请求体过大。'), { status: 413 });
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
    gate, repository, policy, operations,
    updateResolvedConfig: next => {
      const snapshot = policy.updateResolvedConfig(configOf(next));
      config = { ...config, ...snapshot.values };
      repository.updatePolicy(config, snapshot.version);
      return snapshot;
    },
    getSession: async sessionId => {
      try { return { ...await repository.session(sessionId), pending: gate.pendingFor(sessionId), operation: operations.forSession(sessionId) }; }
      catch (error) {
        const pending = gate.pendingFor(sessionId);
        if (!pending) throw error;
        // A failed analysis must not hide the very confirmation waiting on it.
        return {
          sessionId, title: sessionId, latest: null, cumulative: null,
          calls: [], turns: [], warnings: [], pending,
          config: { minLostTokens: config.minLostTokens, minLossRatio: config.minLossRatio },
          coverage: { unknown: true, errors: [{ message: '当前会话的用量分析不可用；发送前检查仍在等待确认。' }] },
        };
      }
    },
    dashboard: query => repository.dashboard(query),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      gate.dispose();
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
      if (session.header.origin !== 'subagent' && !(session.header.delegationDepth > 0)) {
        const records = liveRecords(session);
        const revision = requestRevision(records);
        const contentGeneration = session.surface.contentGeneration;
        let risk;
        try {
          if (records.length - 1 > requestConfig.maxEvents) throw new Error('Session exceeds the cache analysis event limit');
          const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
          risk = await inspectNextRequest(records, options, {
            ...requestConfig, toolUpdate: info.toolUpdate, systemPromptUpdate: info.systemPromptUpdate,
            messageProjections: ctx.sessions.messageProjections ?? [],
          });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (latestReceiptSeq(records) !== null) {
            risk = { unknown: true, reason: '无法完成上下文缓存检查，需要确认后才能发送。',
              changes: [{ kind: 'unknown', message: '历史重建或模型输入投影失败，请检查插件兼容性。' }] };
          }
        }
        if (risk) {
          let turn, step;
          for (let index = records.length - 1; index > 0; index--) {
            if (records[index].type === 'step/start') {
              ({ turn, step } = records[index].data); break;
            }
          }
          await gate.wait({ ...risk, policy: strategy }, {
            sessionId: session.id, fingerprint: fingerprint(options, revision), turn, step, signal: options.signal,
            validate: () => ctx.sessions.get(session.id) === session
              && session.surface.contentGeneration === contentGeneration
              && requestRevision(liveRecords(session)) === revision,
          });
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
      try {
        const admission = ctx.connection.admit(req);
        if ('rejection' in admission) return json(res, admission.rejection, { error: '需要 DSH 浏览器登录。' });
        // Model/API operators cannot answer the user's cost confirmation.
        if (admission.peer.id !== ctx.connection.browserPeer.id) return json(res, 403, { error: '仅浏览器用户可访问缓存确认界面。' });
        const url = new URL(req.url, 'http://local');
        const path = url.pathname;
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/session') {
          const id = url.searchParams.get('sessionId');
          if (!id || id.length > 200) return json(res, 400, { error: '缺少有效 sessionId。' });
          return json(res, 200, await api.getSession(id));
        }
        if (req.method === 'GET' && path === '/dsh-cache-helper/api/dashboard') return json(res, 200, await api.dashboard({
          period: url.searchParams.get('period') ?? '7d',
          model: url.searchParams.get('model') || undefined,
          provider: url.searchParams.get('provider') || undefined,
        }));
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
        json(res, status, { error: status === 500 ? '缓存分析暂不可用，请检查宿主日志。' : error.message });
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
