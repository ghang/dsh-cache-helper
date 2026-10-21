import { randomUUID } from 'node:crypto';

export class GateError extends Error {
  constructor(message, code = 'CACHE_HELPER_CANCELLED') {
    super(message);
    this.name = code === 'CACHE_HELPER_CANCELLED' ? 'AbortError' : 'CacheHelperError';
    this.code = code;
  }
}

/** Each waiter owns one immutable candidate. No remembered allow-list or timeout approval. */
export class GateController {
  #pending = new Map();
  #closed = false;

  pendingFor(sessionId) {
    const item = this.#pending.get(sessionId);
    return item ? structuredClone(item.view) : null;
  }

  wait(risk, { sessionId, fingerprint, turn, step, signal, validate }) {
    if (this.#closed || signal?.aborted) return Promise.reject(new GateError('缓存检查已取消。'));
    if (this.#pending.has(sessionId)) {
      return Promise.reject(new GateError('此会话已有一个请求等待缓存风险确认。', 'CACHE_HELPER_CONCURRENT'));
    }
    return new Promise((resolve, reject) => {
      const view = {
        ...risk,
        id: randomUUID(), sessionId, fingerprint, turn, step, createdAt: Date.now(),
        reason: risk.reason ?? risk.summary ?? '检测到旧上下文缓存可能大规模失效，请确认是否发送。',
      };
      const item = { view, validate, finish: (error) => {
        if (this.#pending.get(sessionId) !== item) return;
        this.#pending.delete(sessionId);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      } };
      const abort = () => item.finish(new GateError('已停止等待，未发送模型请求。'));
      this.#pending.set(sessionId, item);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  decide({ sessionId, id, fingerprint, decision }) {
    if (decision !== 'confirm' && decision !== 'cancel') {
      throw new GateError('无效的确认操作。', 'CACHE_HELPER_BAD_DECISION');
    }
    const item = this.#pending.get(sessionId);
    if (!item || item.view.id !== id || item.view.fingerprint !== fingerprint) {
      throw new GateError('此确认已过期，或不属于当前请求。', 'CACHE_HELPER_STALE');
    }
    if (decision === 'cancel') item.finish(new GateError('用户取消了本次模型请求。'));
    else {
      if (item.validate && !item.validate()) {
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
