import { setTimeout as delay } from 'node:timers/promises';
import { GateError } from './gate.mjs';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const fail = (message, code = 'CACHE_HELPER_CHILD_UNSUPPORTED', status = 409) => Object.assign(new GateError(message, code), { status });

/** Native lifecycle edges witness an activation; durable Session IDs do not. */
export class ChildControl {
  #activations = new Map();
  #ended = new Map();
  #observations = new Map();
  #channels = new Map();
  #inboxVersions = new WeakMap();
  #stops = new Map();
  #stopViews = new Map();
  #disposers = [];
  #disposed = false;

  constructor(ctx, { gate, now = Date.now, heartbeatTtlMs = 15_000,
    stopTimeoutMs = 3_000, pollMs = 25, maxObservations = 200 } = {}) {
    if (!Number.isSafeInteger(heartbeatTtlMs) || heartbeatTtlMs < 1 || heartbeatTtlMs > 60_000
      || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 3_000
      || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000
      || !Number.isSafeInteger(maxObservations) || maxObservations < 1 || maxObservations > 1_000)
      throw new TypeError('Invalid bounded child-control limits');
    this.ctx = ctx;
    this.gate = gate;
    this.now = now;
    this.heartbeatTtlMs = heartbeatTtlMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.pollMs = pollMs;
    this.maxObservations = maxObservations;
    this.#disposers.push(ctx.on('subagent/start', info => this.#started(info)));
    this.#disposers.push(ctx.on('subagent/end', info => this.#settled(info)));
    this.#disposers.push(ctx.on('agent/inbox/inserted', ({ agent }) => {
      if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return;
      this.#inboxVersions.set(agent, (this.#inboxVersions.get(agent) ?? 0) + 1);
      this.gate.cancel(agent.session?.id ?? agent.id, '子任务收到新输入，旧缓存确认已失效。');
    }));
    this.#disposers.push(ctx.on('session/disposed', session => {
      const active = this.#activations.get(session.id);
      // Native end is published after the handle/Session closes. Retain the
      // bounded epoch record until that edge so stop observation can distinguish
      // its own teardown from a later activation replacing the same ID.
      if (active?.session === session) active.retired = true;
      this.gate.cancel(session.id);
    }));
    this.#disposers.push(ctx.on('session/event', session => this.gate.recheck(session.id)));
  }

  #agents() { return this.ctx.get?.('agents') ?? this.ctx.agents; }

  #started(info) {
    if (this.#disposed || !validId(info?.id) || !validId(info?.runId)) return;
    this.gate.cancel(info.id, '子任务 activation 已变化，旧确认已失效。');
    this.#activations.delete(info.id);
    if (info.local !== true) return;
    const agent = this.#agents()?.get(info.id);
    const session = this.ctx.sessions.get(info.id);
    if (!agent || agent.session !== session || !validId(session?.header?.parentSession)
      || !(session.header.origin === 'subagent' || session.header.delegationDepth > 0)) return;
    this.#activations.set(info.id, { runId: info.runId, provider: info.provider,
      agent, session, parentSessionId: session.header.parentSession, startedAt: this.now() });
    while (this.#activations.size > 256) this.#activations.delete(this.#activations.keys().next().value);
  }

  #settled(info) {
    const active = this.#activations.get(info?.id);
    if (!active || active.runId !== info.runId) return;
    this.#ended.set(active.runId, { at: this.now(), sessionId: info.id });
    while (this.#ended.size > 200) this.#ended.delete(this.#ended.keys().next().value);
    this.#activations.delete(info.id);
    this.gate.cancel(info.id, '子任务 activation 已结束，未发送等待中的请求。');
  }

  #active(sessionId) {
    const active = this.#activations.get(sessionId);
    return active && this.#agents()?.get(sessionId) === active.agent
      && this.ctx.sessions.get(sessionId) === active.session ? active : undefined;
  }

  snapshot(sessionId) {
    const active = this.#active(sessionId);
    if (!active) return null;
    return { local: true, targetSessionId: sessionId, directParentId: active.parentSessionId,
      depth: active.session.header.delegationDepth ?? null, activationGeneration: active.runId,
      provider: active.provider ?? null };
  }

  matches(sessionId, generation, session) {
    const active = this.#active(sessionId);
    return Boolean(active && active.runId === generation && (!session || active.session === session));
  }

  reachable({ channelId, seq, reachable }) {
    if (!validId(channelId) || typeof reachable !== 'boolean'
      || !Number.isSafeInteger(seq) || seq < 0) throw fail('无效的确认通道。', 'CACHE_HELPER_BAD_DECISION', 400);
    if (this.#disposed) throw fail('插件已卸载。');
    const previous = this.#channels.get(channelId);
    if (previous && seq <= previous.seq) return { ...this.reachability(), accepted: false };
    // Keep recent inactive/expired sequence tombstones so a late true cannot
    // undo the later hidden/unmount false. No heartbeat affects a gate deadline.
    this.#channels.delete(channelId);
    this.#channels.set(channelId, { seq, reachable, expiresAt: this.now() + this.heartbeatTtlMs });
    while (this.#channels.size > 256) this.#channels.delete(this.#channels.keys().next().value);
    return { ...this.reachability(), accepted: true };
  }

  reachability() {
    const active = [...this.#channels.values()].filter(item => item.reachable && item.expiresAt > this.now());
    return { reachable: active.length > 0, channels: active.length, heartbeatTtlMs: this.heartbeatTtlMs };
  }

  observe(sessionId, data) {
    this.#observations.delete(sessionId);
    this.#observations.set(sessionId, { sessionId, ...structuredClone(data), observedAt: this.now() });
    while (this.#observations.size > this.maxObservations) this.#observations.delete(this.#observations.keys().next().value);
  }

  observations({ sessionId } = {}) {
    return [...this.#observations.values()].filter(item => !sessionId || item.sessionId === sessionId
      || item.identity?.directParentId === sessionId || item.identity?.rootSessionId === sessionId).map(item => structuredClone(item));
  }

  stops({ sessionId } = {}) {
    return [...this.#stopViews.values()].filter(item => !sessionId || item.sessionId === sessionId
      || item.parentSessionId === sessionId || item.rootSessionId === sessionId).map(item => structuredClone(item));
  }

  async stop({ sessionId, parentSessionId, activationGeneration, id, fingerprint }) {
    if (this.#disposed) throw fail('插件已卸载。');
    if (![sessionId, parentSessionId, activationGeneration, id, fingerprint].every(validId)) throw fail('缺少子任务或确认候选标识。', 'CACHE_HELPER_BAD_DECISION', 400);
    const key = JSON.stringify([sessionId, parentSessionId, activationGeneration, id, fingerprint]);
    const existing = this.#stops.get(key);
    if (existing) return existing;
    const active = this.#active(sessionId);
    const pending = this.gate.pendingFor(sessionId);
    if (!active || active.runId !== activationGeneration || active.parentSessionId !== parentSessionId
      || !pending || pending.id !== id || pending.fingerprint !== fingerprint
      || pending.identity?.activationGeneration !== activationGeneration
      || pending.identity?.directParentId !== parentSessionId) throw fail('子任务或待确认候选已变化，请刷新后重试。', 'CACHE_HELPER_STALE');
    const runtime = this.ctx.get?.('subagents') ?? this.ctx.subagents;
    if (typeof runtime?.interrupt !== 'function') throw fail('当前宿主未提供原生子任务中断接口。');
    const startedAt = this.now();
    const inboxVersion = this.#inboxVersions.get(active.agent) ?? 0;
    // The native primitive checks direct-parent ownership synchronously. Never
    // use dispose/drain here: those APIs may stop a descendant forest.
    runtime.interrupt(sessionId, { kind: 'user', parentSessionId });
    this.gate.cancel(sessionId, '用户停止此子任务，等待中的请求未发送。');
    const view = { id, accepted: true, state: 'stopping', sessionId, parentSessionId,
      rootSessionId: pending.identity?.rootSessionId ?? null, activationGeneration,
      startedAt, updatedAt: startedAt, quiescent: false, descendantsStopped: false };
    this.#stopViews.set(key, view);
    while (this.#stopViews.size > 100) this.#stopViews.delete(this.#stopViews.keys().next().value);
    const observe = (async () => {
      const deadline = startedAt + this.stopTimeoutMs;
      while (!this.#disposed) {
        if ((this.#inboxVersions.get(active.agent) ?? 0) !== inboxVersion) return { ...view, state: 'superseded', quiescent: false };
        const currentAgent = this.#agents()?.get(sessionId);
        const currentSession = this.ctx.sessions.get(sessionId);
        if ((currentAgent && currentAgent !== active.agent) || (currentSession && currentSession !== active.session))
          return { ...view, state: 'superseded', quiescent: false };
        if (this.now() >= deadline) return { ...view, state: 'stop-unconfirmed', quiescent: false };
        if (this.#ended.has(active.runId)) return { ...view, state: 'stopped', quiescent: true };
        if (!this.matches(sessionId, active.runId, active.session)
          && !(this.#activations.get(sessionId) === active && active.retired)) return { ...view, state: 'superseded', quiescent: false };
        if (active.agent.status === 'idle') return { ...view, state: 'stopped', quiescent: true };
        await delay(Math.min(this.pollMs, Math.max(1, deadline - this.now())));
      }
      return { ...view, state: 'stop-unconfirmed', quiescent: false };
    })();
    const work = observe.then(result => {
      const completed = { ...result, updatedAt: this.now() };
      if (!this.#disposed && this.#stopViews.has(key)) this.#stopViews.set(key, structuredClone(completed));
      return completed;
    });
    this.#stops.set(key, work);
    while (this.#stops.size > 100) this.#stops.delete(this.#stops.keys().next().value);
    return work;
  }

  async dispose() {
    this.#disposed = true;
    for (const dispose of this.#disposers.reverse()) dispose?.();
    this.#channels.clear();
    this.#activations.clear();
    this.#observations.clear();
    await Promise.allSettled(this.#stops.values());
    this.#stops.clear();
    this.#stopViews.clear();
  }
}
