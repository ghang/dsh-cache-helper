import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

const TERMINAL = new Set(['completed', 'noop', 'partial', 'failed', 'cancelled', 'interrupted']);
const ACTIVE = new Set(['stopping', 'creating', 'compacting']);
const ROUTE_KEYS = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
const POLICY_KEYS = ['revision', 'version', 'minLostTokens', 'minLossRatio', 'dashboardLimit', 'maxEvents', 'maxCachedSessions'];
const MESSAGES = {
  changed: '来源会话或模型路由已变化，请重新检查；已有分支保留供手动查看。',
  busy: '来源会话尚未空闲或有排队输入，未继续处理。',
  cancelled: '操作已取消；已经创建的分支仍保留，原消息没有自动续发。',
  summary: '摘要未成功生成；已有分支保留，请查看后手动处理。',
  persistence: '操作状态或分支未能保存，请检查当前分支状态后手动处理。',
  unsupported: '宿主未提供受控分支压缩所需的公开接口。',
  interrupted: '上次操作随进程退出而中断；不会自动重试，已有分支可手动打开。',
  failed: '分支压缩未完成；不会自动重试，已有分支可手动打开。',
};

export class OperationError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.failed, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function identifier(value, name = 'sessionId') {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new OperationError('invalid', `${name} 无效。`, 400);
  }
  return value;
}

function routeOf(agent) {
  const header = agent.session.requestHeader()?.config ?? {};
  const source = { ...agent.options, ...header };
  const result = Object.fromEntries(ROUTE_KEYS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (typeof result.provider !== 'string' || !result.provider.length || typeof result.model !== 'string' || !result.model.length) return null;
  return result;
}

function revisionOf(agent) {
  const session = agent.session;
  const governed = session.snapshotEvents().filter(event => event.surfaceOp !== undefined
    || event.type === 'request/header' || event.type === 'request/context');
  return createHash('sha256').update(JSON.stringify({
    generation: session.surface.contentGeneration, route: routeOf(agent), governed,
  })).digest('hex');
}

function inputOf(agent) {
  const events = agent.session.snapshotEvents();
  const lastUser = events.findLast(event => event.type === 'user/message' && event.data?.source?.kind !== 'compact-checkpoint');
  const lastReceipt = events.findLast(event => event.type === 'assistant/message');
  return {
    acceptedInHistory: !!lastUser && (!lastReceipt || lastUser.seq > lastReceipt.seq),
    queued: (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0),
    composerDraft: 'not-copied',
  };
}

function metering(ctx, session) {
  try {
    const meter = ctx.get?.('tokenMeter');
    const value = meter?.measure(session)?.totalTokens;
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch { return null; }
}

function usageOf(value) {
  const result = {};
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    result[key] = Number.isFinite(value?.[key]) && value[key] >= 0 ? value[key] : null;
  }
  return result;
}

async function untilIdle(agent, signal, timeoutMs) {
  signal.throwIfAborted();
  let timer;
  let abort;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new OperationError('busy')), timeoutMs);
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Browser-owned, one-shot fork/compact jobs. No method wakes or queues a turn. */
export class OperationController {
  #jobs = new Map();
  #latest = new Map();
  #closed = false;
  #receiptFailure = false;
  #write = Promise.resolve();

  constructor(ctx, { gate, policy, persistState = true, statePath, maxJobs = 100, maxEvents = 200000, waitTimeoutMs = 10000, previewTtlMs = 300000 } = {}) {
    this.ctx = ctx;
    this.gate = gate;
    this.policy = policy;
    this.persistState = persistState;
    this.statePath = statePath ?? join(resolveDshHome(), 'storages', 'cache-helper', 'operations-state.json');
    this.maxJobs = maxJobs;
    this.maxEvents = maxEvents;
    this.waitTimeoutMs = waitTimeoutMs;
    this.previewTtlMs = previewTtlMs;
  }

  async init() {
    if (!this.persistState) return;
    try {
      const stored = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.jobs)) throw new Error('invalid state');
      for (const view of stored.jobs.slice(-this.maxJobs)) {
        if (!view || typeof view !== 'object') throw new Error('invalid operation receipt');
        identifier(view.id, 'id'); identifier(view.sessionId);
        if (!TERMINAL.has(view.state) && !ACTIVE.has(view.state)) throw new Error('invalid operation state');
        if (view.branchId !== null) identifier(view.branchId, 'branchId');
        if (typeof view.revision !== 'string' || !/^[a-f0-9]{64}$/.test(view.revision)) throw new Error('invalid source revision');
        if (ACTIVE.has(view.state)) {
          view.state = 'interrupted';
          view.error = { code: 'interrupted', message: MESSAGES.interrupted };
        }
        view.available = false;
        this.#jobs.set(view.id, { view });
        this.#latest.set(view.sessionId, view.id);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.#receiptFailure = true;
        this.ctx.logger?.warn?.('cache-helper: operation receipts could not be restored');
      }
    }
  }

  #services() {
    const get = name => this.ctx.get ? this.ctx.get(name) : this.ctx[name];
    return { agents: get('agents'), compaction: get('compaction'), persistence: get('sessionPersistence') };
  }

  #durabilityAvailable(persistence) {
    return typeof persistence?.create === 'function' && typeof persistence?.open === 'function'
      && typeof this.ctx.sessions?.flush === 'function';
  }

  #assertDurability(job) {
    const { persistence } = this.#services();
    if (!this.#durabilityAvailable(persistence)
      || (persistence.identity ?? persistence) !== job.persistenceIdentity) throw new OperationError('persistence');
  }

  async #flushBranch(job, child) {
    try {
      this.#assertDurability(job);
      if (await this.ctx.sessions.flush(child.session) !== true) throw new OperationError('persistence');
      this.#assertDurability(job);
    } catch { throw new OperationError('persistence'); }
  }

  #active(job) {
    return ACTIVE.has(job.view.state) || !!job.task && !job.settled;
  }

  #publicView(job) {
    const view = structuredClone(job.view);
    // A terminal receipt is not public until its final writes settle. Readers
    // must keep polling instead of seeing a success that later becomes partial.
    if (job.task && !job.settled && TERMINAL.has(view.state)) view.state = 'finalizing';
    return view;
  }

  preview(sessionId) {
    identifier(sessionId);
    const { agents, compaction, persistence } = this.#services();
    const agent = agents?.get(sessionId);
    const unavailable = reason => ({ id: null, sessionId, available: false, reason, manualContinue: true });
    if (this.#closed) return unavailable('插件已停用。');
    if (this.#receiptFailure) return unavailable('历史处理记录无法读取；请先核对已有分支，避免重复创建。');
    if (!agent) return unavailable('首版仅支持宿主当前已激活的主会话；当前历史会话未激活，不能执行受控分支处理。');
    const previous = this.#jobs.get(this.#latest.get(sessionId));
    if (previous && this.#active(previous)) return this.#publicView(previous);
    const policy = this.policy?.();
    const maxEvents = policy?.maxEvents ?? this.maxEvents;
    const eventCount = agent.session.snapshotEvents().length;
    const preparedLimit = previous?.view.state === 'prepared' ? previous.maxEvents : undefined;
    const overLimit = () => unavailable('来源会话超过本地分析上限，暂不能安全创建处理分支。');
    if (eventCount > (preparedLimit ?? maxEvents)) return overLimit();
    if (agent.session.header.origin === 'subagent' || agent.session.header.delegationDepth > 0) return unavailable('首版只支持主会话的受控分支处理。');
    if (!compaction?.compactNow || !agents?.create || !agent.runMaintenance || !agent.whenIdle) return unavailable(MESSAGES.unsupported);
    if (!this.#durabilityAvailable(persistence)) return unavailable('宿主未提供可恢复的会话持久化，暂不能创建处理分支或调用摘要。');
    const route = routeOf(agent);
    if (!route) return unavailable('无法确定来源 provider/model，请先检查会话路由。');
    const revision = revisionOf(agent);
    if (previous?.view.branchId && previous.view.revision === revision) return this.#publicView(previous);
    const pending = this.gate?.pendingFor(sessionId);
    const pendingIdentity = pending ? { id: pending.id, fingerprint: pending.fingerprint } : null;
    if (previous?.view.state === 'prepared' && previous.view.revision === revision
      && JSON.stringify(previous.view.pending) === JSON.stringify(pendingIdentity)
      && Date.now() - previous.view.createdAt < this.previewTtlMs) return this.#publicView(previous);
    if (eventCount > maxEvents) return overLimit();
    while (this.#jobs.size >= this.maxJobs) {
      const retired = [...this.#jobs].find(([, job]) => !this.#active(job));
      if (!retired) return unavailable('当前处理任务过多，请等待已有任务完成。');
      this.#jobs.delete(retired[0]);
      if (this.#latest.get(retired[1].view.sessionId) === retired[0]) this.#latest.delete(retired[1].view.sessionId);
    }
    const view = {
      id: randomUUID(), sessionId, state: 'prepared', available: true,
      reason: '将停止本次尝试，保留原会话，创建分支并调用宿主摘要；完成后由你手动继续。',
      revision, route, requiresStop: agent.status === 'running', pending: pendingIdentity,
      previousBranchId: previous?.view.branchId ?? null,
      branchId: null, branchCreated: false, branchDurable: false, resultDurable: false,
      createdAt: Date.now(), updatedAt: Date.now(), manualContinue: true,
      input: inputOf(agent), context: { beforeTokens: metering(this.ctx, agent.session), afterTokens: null, estimated: true },
      summaryCalls: [], observation: 'pending', error: null,
      ...(policy ? { policy: Object.fromEntries(POLICY_KEYS.filter(key => policy[key] !== undefined).map(key => [key, policy[key]])) } : {}),
    };
    this.#jobs.set(view.id, { view, agent, session: agent.session, maxEvents,
      persistenceIdentity: persistence.identity ?? persistence });
    this.#latest.set(sessionId, view.id);
    return structuredClone(view);
  }

  get(id) {
    identifier(id, 'id');
    const job = this.#jobs.get(id);
    if (!job) throw new OperationError('missing', '操作记录不存在或已过期。', 404);
    return this.#publicView(job);
  }

  forSession(sessionId) {
    identifier(sessionId);
    const id = this.#latest.get(sessionId);
    return id ? this.get(id) : null;
  }

  /** Metadata-only receipts also cover failed summary calls absent from Session. */
  list() {
    return [...this.#jobs.values()].filter(job => job.view.state !== 'prepared').map(job => this.#publicView(job));
  }

  start(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperationError('invalid', '需要操作 id 与 sessionId。', 400);
    const { id, sessionId } = input;
    identifier(id, 'id'); identifier(sessionId);
    const job = this.#jobs.get(id);
    if (!job || job.view.sessionId !== sessionId) throw new OperationError('missing', '操作记录不存在或不属于此会话。', 404);
    if (job.view.state !== 'prepared') return this.#publicView(job);
    if (this.#closed) throw new OperationError('cancelled');
    if (Date.now() - job.view.createdAt >= this.previewTtlMs) throw new OperationError('changed', '操作预览已过期，请重新检查。');
    this.#assertSource(job);
    this.#assertDurability(job);
    const current = this.gate?.pendingFor(sessionId);
    if (JSON.stringify(job.view.pending) !== JSON.stringify(current ? { id: current.id, fingerprint: current.fingerprint } : null)) throw new OperationError('changed');
    job.abort = new AbortController();
    job.view.state = 'stopping';
    job.view.available = false;
    job.view.updatedAt = Date.now();
    job.settled = false;
    job.task = this.#execute(job).finally(() => { job.settled = true; });
    return this.#publicView(job);
  }

  cancel(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperationError('invalid', '需要操作 id 与 sessionId。', 400);
    const { id, sessionId } = input;
    identifier(id, 'id'); identifier(sessionId);
    const job = this.#jobs.get(id);
    if (!job || job.view.sessionId !== sessionId) throw new OperationError('missing', '操作记录不存在或不属于此会话。', 404);
    if (TERMINAL.has(job.view.state)) return this.#publicView(job);
    if (job.view.state === 'prepared') {
      job.view.state = 'cancelled';
      job.view.available = false;
      job.view.error = { code: 'cancelled', message: MESSAGES.cancelled };
    } else {
      job.view.cancelRequested = true;
      job.abort.abort(new OperationError('cancelled'));
    }
    return this.#publicView(job);
  }

  #assertSource(job) {
    const { agents } = this.#services();
    if (agents?.get(job.view.sessionId) !== job.agent || job.agent.session !== job.session
      || revisionOf(job.agent) !== job.view.revision) throw new OperationError('changed');
  }

  async #save() {
    if (!this.persistState) return;
    const text = JSON.stringify({ version: 1, jobs: [...this.#jobs.values()].map(job => job.view).filter(view => view.state !== 'prepared') });
    const operation = this.#write.catch(() => {}).then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.#write = operation;
    try { await operation; } catch { throw new OperationError('persistence'); }
  }

  async #execute(job) {
    const started = Date.now();
    const signal = job.abort.signal;
    let child;
    let firstOwnEvent;
    let stopMetering;
    let resultPrepared = false;
    try {
      await this.#save();
      signal.throwIfAborted();
      this.#assertSource(job);
      this.#assertDurability(job);
      this.gate?.cancel(job.view.sessionId, '已选择创建处理分支，取消原候选，未续发原消息。');
      if (job.agent.status !== 'idle') job.agent.cancel({ kind: 'user' }, { keepInbox: true });
      await untilIdle(job.agent, signal, this.waitTimeoutMs);
      signal.throwIfAborted();
      this.#assertSource(job);
      if (inputOf(job.agent).queued) throw new OperationError('busy');
      const { agents, compaction } = this.#services();
      if (!compaction?.compactNow || !agents?.create) throw new OperationError('unsupported');
      child = await job.agent.runMaintenance(async ownerSignal => {
        const combined = AbortSignal.any([signal, ownerSignal]);
        combined.throwIfAborted();
        this.#assertSource(job);
        const events = job.session.snapshotEvents();
        if (events.length > job.maxEvents) throw new OperationError('changed');
        const seed = events.length ? buildForkSeed(events, events.at(-1).seq) : [];
        const branchId = randomUUID();
        job.view.state = 'creating';
        // Persist the intended identity before publication. A crash after the
        // host creates a child can then never lose the only recovery handle.
        job.view.branchId = branchId;
        job.view.updatedAt = Date.now();
        await this.#save();
        combined.throwIfAborted();
        this.#assertSource(job);
        const handle = await agents.create({
          sessionId: branchId,
          meta: { isSeeded: true, parentSession: job.view.sessionId,
            ...(job.session.header.cwd === undefined ? {} : { cwd: job.session.header.cwd }) },
          seed, inheritedEventCount: events.length, agentOptions: { ...job.view.route }, signal: combined,
        });
        child = handle.agent;
        job.view.branchId = child.session.id;
        job.view.branchCreated = true;
        job.view.input = inputOf(job.agent);
        firstOwnEvent = child.session.snapshotEvents().length;
        await this.#save();
        await this.#flushBranch(job, child);
        job.view.branchDurable = true;
        await this.#save();
        combined.throwIfAborted();
        this.#assertSource(job);
        return child;
      });
      signal.throwIfAborted();
      if (JSON.stringify(routeOf(child)) !== JSON.stringify(job.view.route)) throw new OperationError('changed');
      job.view.state = 'compacting';
      job.view.updatedAt = Date.now();
      await this.#save();
      signal.throwIfAborted();
      const summaryCalls = job.view.summaryCalls;
      const saveReceipt = () => this.#save();
      if (this.ctx.on) stopMetering = this.ctx.on('llm/stream', async function* (options, next) {
        if (options.sessionId !== child.session.id || options.purpose !== 'compaction') return yield* next();
        const begin = Date.now();
        const compactionStart = child.session.snapshotEvents().slice(firstOwnEvent)
          .findLast(event => event.type === 'compaction/start');
        const call = { provider: options.provider, model: options.model, purpose: 'compaction',
          usage: usageOf(undefined), at: begin, atSource: 'llm-stream-start',
          ...(compactionStart ? { compactionId: compactionStart.data.compactionId } : {}),
          durationMs: null, outcome: 'started', usageRecorded: false };
        summaryCalls.push(call);
        // Preserve the invocation intent before the adapter can dispatch. A
        // restarted process must report unknown expenditure rather than zero.
        let failed = false;
        try {
          await saveReceipt();
          signal.throwIfAborted();
          for await (const chunk of next()) {
            if (chunk.type === 'usage') { call.usage = usageOf(chunk.usage); call.usageRecorded = true; }
            if (chunk.type === 'finish' && ['error', 'aborted', 'max-tokens'].includes(chunk.reason?.kind)) failed = true;
            yield chunk;
          }
          call.outcome = signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed';
        } catch (error) {
          call.outcome = signal.aborted ? 'cancelled' : 'failed';
          throw error;
        } finally { call.durationMs = Date.now() - begin; }
      });
      const result = await compaction.compactNow(child, signal);
      resultPrepared = true;
      if (result !== null) job.view.compaction = {
        id: result.compactionId, startSeq: result.startSeq, summarySeq: result.summarySeq,
        endSeq: result.endSeq, shadowedNodes: result.shadowedSeqs.length,
        shadowedTokens: result.shadowedTokenCount,
      };
      await this.#flushBranch(job, child);
      job.view.resultDurable = true;
      job.view.state = result === null ? 'noop' : 'completed';
      job.view.context.afterTokens = metering(this.ctx, child.session);
    } catch (error) {
      const code = signal.aborted ? 'cancelled' : Object.hasOwn(MESSAGES, error?.code) ? error.code : 'failed';
      job.view.state = code === 'cancelled' ? 'cancelled'
        : resultPrepared && code === 'persistence' ? 'partial' : 'failed';
      job.view.error = { code, message: MESSAGES[code] };
    } finally {
      if (typeof stopMetering === 'function') stopMetering();
      if (child) {
        const own = child.session.snapshotEvents().slice(firstOwnEvent ?? child.session.inheritedEventCount);
        for (const event of own.filter(event => event.type === 'compaction/summary')) {
          const call = job.view.summaryCalls.findLast(item => item.provider === event.data.provider
            && item.model === event.data.model && item.summarySeq === undefined && item.outcome === 'completed'
            && (item.compactionId === undefined || item.compactionId === event.data.compactionId));
          const details = { provider: event.data.provider, model: event.data.model, usage: usageOf(event.data.usage),
            summarySeq: event.seq, compactionId: event.data.compactionId };
          if (call) Object.assign(call, details);
          else job.view.summaryCalls.push({ ...details, durationMs: null, outcome: 'completed',
            at: event.time, atSource: 'session-summary-settlement',
            usageRecorded: event.data.usage !== undefined, source: 'session-summary' });
        }
        job.view.context.afterTokens = metering(this.ctx, child.session);
      }
      job.view.durationMs = Date.now() - started;
      job.view.updatedAt = Date.now();
      job.view.observation = job.view.state === 'completed' ? 'pending' : 'unknown';
      try { await this.#save(); }
      catch {
        if (['completed', 'noop'].includes(job.view.state)) job.view.state = 'partial';
        job.view.observation = 'unknown';
        job.view.error = { code: 'persistence', message: MESSAGES.persistence };
      }
    }
  }

  async dispose() {
    this.#closed = true;
    for (const job of this.#jobs.values()) if (job.abort && ACTIVE.has(job.view.state)) job.abort.abort(new OperationError('cancelled'));
    await Promise.allSettled([...this.#jobs.values()].map(job => job.task).filter(Boolean));
    await this.#write.catch(() => {});
  }
}
