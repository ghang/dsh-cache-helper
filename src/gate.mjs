import { randomUUID } from 'node:crypto';

export class GateError extends Error {
  constructor(message, code = 'CACHE_HELPER_CANCELLED') {
    super(message);
    this.name = ['CACHE_HELPER_CANCELLED', 'CACHE_HELPER_EXPIRED', 'CACHE_HELPER_CHILD_UNSUPPORTED'].includes(code)
      ? 'AbortError' : 'CacheHelperError';
    this.code = code;
    this.status = code === 'CACHE_HELPER_BAD_DECISION' ? 400 : code === 'CACHE_HELPER_PENDING_LIMIT' ? 429 : 409;
  }
}

/** Each waiter owns one immutable candidate. No remembered allow-list or timeout approval. */
export class GateController {
  #pending = new Map();
  #closed = false;

  constructor({ now = Date.now, maxPending = 128 } = {}) {
    this.now = now;
    this.maxPending = maxPending;
  }

  #prune(sessionId) {
    const items = sessionId === undefined ? [...this.#pending.values()] : [this.#pending.get(sessionId)].filter(Boolean);
    for (const item of items) {
      if (item.view.expiresAt !== undefined && this.now() >= item.view.expiresAt) {
        item.finish(new GateError('缓存风险确认已到期，本次请求未发送。', 'CACHE_HELPER_EXPIRED'));
      } else if (!this.#valid(item, true)) {
        item.finish(new GateError('等待期间会话或候选已变化，本次请求未发送。'));
      }
    }
  }

  #valid(item, observation = false) {
    const validate = observation ? item.observe ?? item.validate : item.validate;
    try { return !validate || Boolean(validate()); }
    catch { return false; }
  }

  pendingFor(sessionId) {
    this.#prune(sessionId);
    const item = this.#pending.get(sessionId);
    return item ? structuredClone(item.view) : null;
  }

  recheck(sessionId) { this.#prune(sessionId); }

  list({ sessionId } = {}) {
    this.#prune();
    return [...this.#pending.values()].map(item => item.view)
      .filter(item => !sessionId || item.sessionId === sessionId
        || item.identity?.directParentId === sessionId || item.identity?.rootSessionId === sessionId)
      .map(item => structuredClone(item));
  }

  wait(risk, { sessionId, fingerprint, turn, step, signal, validate, observe, timeoutMs }) {
    if (this.#closed || signal?.aborted) return Promise.reject(new GateError('缓存检查已取消。'));
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) return Promise.reject(new GateError('无效的确认期限。', 'CACHE_HELPER_BAD_DECISION'));
    this.#prune();
    if (this.#pending.has(sessionId)) {
      return Promise.reject(new GateError('此会话已有一个请求等待缓存风险确认。', 'CACHE_HELPER_CONCURRENT'));
    }
    if (this.#pending.size >= this.maxPending) return Promise.reject(new GateError('待确认请求过多，本次请求未发送。', 'CACHE_HELPER_PENDING_LIMIT'));
    return new Promise((resolve, reject) => {
      const createdAt = this.now();
      const view = {
        ...structuredClone(risk),
        id: randomUUID(), sessionId, fingerprint, turn, step, createdAt,
        ...(timeoutMs === undefined ? {} : { expiresAt: createdAt + timeoutMs }),
        reason: risk.reason ?? risk.summary ?? '检测到旧上下文缓存可能大规模失效，请确认是否发送。',
      };
      let timer;
      const item = { view, validate, observe, finish: (error) => {
        if (this.#pending.get(sessionId) !== item) return;
        this.#pending.delete(sessionId);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      } };
      const abort = () => item.finish(new GateError('已停止等待，未发送模型请求。'));
      this.#pending.set(sessionId, item);
      signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => item.finish(new GateError('缓存风险确认已到期，本次请求未发送。', 'CACHE_HELPER_EXPIRED')), Math.max(0, timeoutMs));
        timer.unref?.();
      }
      if (signal?.aborted) abort();
    });
  }

  decide({ sessionId, id, fingerprint, decision }) {
    if (decision !== 'confirm' && decision !== 'cancel') {
      throw new GateError('无效的确认操作。', 'CACHE_HELPER_BAD_DECISION');
    }
    this.#prune(sessionId);
    const item = this.#pending.get(sessionId);
    if (!item || item.view.id !== id || item.view.fingerprint !== fingerprint) {
      throw new GateError('此确认已过期，或不属于当前请求。', 'CACHE_HELPER_STALE');
    }
    if (decision === 'cancel') item.finish(new GateError('用户取消了本次模型请求。'));
    else {
      if (!this.#valid(item)) {
        item.finish(new GateError('等待期间会话已变化，请重新发送并检查。'));
        throw new GateError('会话已变化，此确认已失效。', 'CACHE_HELPER_STALE');
      }
      item.finish();
    }
    return { ok: true };
  }

  cancel(sessionId, reason = '会话已关闭，未发送模型请求。') {
    this.#pending.get(sessionId)?.finish(new GateError(reason));
  }

  dispose() {
    this.#closed = true;
    for (const item of [...this.#pending.values()]) item.finish(new GateError('插件已卸载，未发送模型请求。'));
  }
}
