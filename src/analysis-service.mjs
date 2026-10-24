import { ANALYZER_VERSION, extractSessionFactsAsync, deriveSessionAnalysisAsync } from './analysis.mjs';

export function analysisAborted() {
  return Object.assign(new Error('本地分析已取消。'), { name: 'AbortError', code: 'ABORT_ERR', status: 499 });
}

/** One process-local owner for shared computations and disposable facts. */
export class AnalysisService {
  #cache = new Map();
  #inflight = new Map();
  #tasks = new Set();
  #latest = new Map();
  #references = new WeakMap();
  #symbols = new Map();
  #sequence = 0;
  #disposed = false;
  #stats = { computations: 0, sharedHits: 0, cacheHits: 0, derivations: 0, cancelled: 0 };

  constructor({ maxCachedSessions = 64, extract = extractSessionFactsAsync,
    derive = deriveSessionAnalysisAsync, scheduling = {} } = {}) {
    this.maxCachedSessions = maxCachedSessions;
    this.extract = extract;
    this.derive = derive;
    this.scheduling = scheduling;
  }

  /** Never compare these IDs or backend revisions across service lifetimes. */
  reference(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol') return value;
    const store = typeof value === 'symbol' ? this.#symbols : this.#references;
    if (!store.has(value)) store.set(value, ++this.#sequence);
    const id = store.get(value);
    // Eviction can cause a conservative miss, never a false hit.
    while (this.#symbols.size > 32) this.#symbols.delete(this.#symbols.keys().next().value);
    return id;
  }

  diagnostics() { return { ...this.#stats, cachedSessions: this.#cache.size, inflight: this.#tasks.size }; }

  resize(limit) {
    this.maxCachedSessions = limit;
    this.#trim();
  }

  #trim() {
    while (this.#cache.size > this.maxCachedSessions) {
      const id = this.#cache.keys().next().value;
      this.#cache.delete(id);
      this.#forget(id);
    }
  }

  #forget(id) {
    if (!this.#cache.has(id) && ![...this.#inflight.values()].some(task => task.sessionId === id)) this.#latest.delete(id);
  }

  #task(run, onEmpty) {
    const task = { controller: new AbortController(), consumers: new Set(), settled: false };
    this.#tasks.add(task);
    task.promise = Promise.resolve().then(() => {
      task.controller.signal.throwIfAborted();
      return run(task.controller.signal);
    }).catch(error => { task.failed = true; throw error; }).finally(() => {
      task.settled = true;
      this.#tasks.delete(task);
      onEmpty?.(task);
    });
    // A cancelled consumer need not wait for a backend that observes abort late.
    task.promise.catch(() => {});
    task.onEmpty = onEmpty;
    return task;
  }

  #subscribe(task, signal) {
    if (signal?.aborted || task.controller.signal.aborted || this.#disposed) return Promise.reject(analysisAborted());
    return new Promise((resolve, reject) => {
      const token = Symbol();
      task.consumers.add(token);
      const cleanup = () => {
        signal?.removeEventListener('abort', cancel);
        task.controller.signal.removeEventListener('abort', stopped);
        task.consumers.delete(token);
      };
      const stopped = () => { cleanup(); reject(analysisAborted()); };
      const cancel = () => {
        cleanup();
        this.#stats.cancelled++;
        reject(analysisAborted());
        if (!task.settled && task.consumers.size === 0) {
          task.controller.abort(analysisAborted());
          task.onEmpty?.(task);
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      task.controller.signal.addEventListener('abort', stopped, { once: true });
      task.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  /** load captures an immutable prefix; policy never enters the facts key. */
  async analyze({ sessionId, sourceCut, dependencyKey = '', load, config = {}, policyVersion = 1,
    signal, order = ++this.#sequence }) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    if (sourceCut?.sessionId !== undefined && sourceCut.sessionId !== sessionId) throw new TypeError('Analysis source cut belongs to another Session');
    const key = JSON.stringify([sessionId, sourceCut, dependencyKey, ANALYZER_VERSION]);
    const latest = this.#latest.get(sessionId);
    if (!latest || order >= latest.order) this.#latest.set(sessionId, { key, order });
    let entry = this.#cache.get(sessionId);
    let cacheStatus;
    if (entry?.key === key) {
      this.#stats.cacheHits++;
      cacheStatus = 'memory';
      this.#cache.delete(sessionId);
      this.#cache.set(sessionId, entry);
    } else {
      let task = this.#inflight.get(key);
      cacheStatus = task ? 'shared' : 'computed';
      if (task) this.#stats.sharedHits++;
      else {
        task = this.#task(async sharedSignal => {
          const snapshot = await load(sharedSignal);
          sharedSignal.throwIfAborted();
          this.#stats.computations++;
          const facts = await this.extract(snapshot.records, config, { ...this.scheduling, signal: sharedSignal });
          sharedSignal.throwIfAborted();
          const completed = { key, facts, sourceCut: Object.freeze({ ...sourceCut, ...snapshot.sourceCut }),
            metadata: snapshot.metadata ?? {}, generatedAt: Date.now(), derived: new Map() };
          if (!this.#disposed && this.#latest.get(sessionId)?.key === key) {
            this.#cache.delete(sessionId);
            this.#cache.set(sessionId, completed);
            this.#trim();
          }
          return completed;
        }, current => {
          if (this.#inflight.get(key) === current) this.#inflight.delete(key);
          this.#forget(sessionId);
        });
        task.sessionId = sessionId;
        this.#inflight.set(key, task);
      }
      entry = await this.#subscribe(task, signal);
    }
    if (signal?.aborted || this.#disposed) throw analysisAborted();
    const policyKey = JSON.stringify([policyVersion, config.minLostTokens ?? 50_000, config.minLossRatio ?? 0.2]);
    let derived = entry.derived.get(policyKey);
    if (!derived) {
      derived = this.#task(async sharedSignal => {
        this.#stats.derivations++;
        return this.derive(entry.facts, config, { ...this.scheduling, signal: sharedSignal });
      }, current => {
        if (current.controller.signal.aborted && entry.derived.get(policyKey) === current) entry.derived.delete(policyKey);
      });
      entry.derived.set(policyKey, derived);
      // Old policies are reproducible from facts; do not retain all revisions.
      while (entry.derived.size > 2) entry.derived.delete(entry.derived.keys().next().value);
    }
    let metrics;
    try { metrics = await this.#subscribe(derived, signal); }
    catch (error) {
      if ((derived.failed || derived.controller.signal.aborted) && entry.derived.get(policyKey) === derived) entry.derived.delete(policyKey);
      throw error;
    }
    return { ...metrics, ...entry.metadata, sourceCut: entry.sourceCut, generatedAt: entry.generatedAt,
      analyzerVersion: ANALYZER_VERSION, policyVersion, cacheStatus };
  }

  async dispose() {
    this.#disposed = true;
    for (const task of this.#tasks) task.controller.abort(analysisAborted());
    await Promise.allSettled([...this.#tasks].map(task => task.promise));
    this.#cache.clear();
    this.#inflight.clear();
    this.#latest.clear();
    this.#symbols.clear();
  }
}
