import { ANALYZER_VERSION, extractSessionFactsAsync, deriveSessionAnalysisAsync } from './analysis.mjs';
import { ADAPTER_VERSION, FACT_CACHE_SCHEMA, sourceProof, stableDependencySignature, lifecycleHash } from './fact-cache.mjs';
import { createHash } from 'node:crypto';

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
  #cacheEpoch = 0;
  #stats = { computations: 0, sharedHits: 0, cacheHits: 0, derivations: 0, cancelled: 0 };

  constructor({ maxCachedSessions = 64, extract = extractSessionFactsAsync,
    derive = deriveSessionAnalysisAsync, scheduling = {}, factCache } = {}) {
    this.maxCachedSessions = maxCachedSessions;
    this.extract = extract;
    this.derive = derive;
    this.scheduling = scheduling;
    this.factCache = factCache;
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

  analysisStatus(sessionId, header) {
    if (sessionId && typeof sessionId === 'object') { header = sessionId; sessionId = header.id; }
    const entry = this.#cache.get(sessionId);
    if (entry?.envelope && (!header || lifecycleHash(header) === entry.envelope.lifecycle.headerHash)) return {
      state: 'cached', reason: 'memory-source-not-validated', generatedAt: entry.generatedAt,
      eventCount: entry.envelope.source.eventCount, lastSeq: entry.envelope.source.lastSeq, memory: true,
    };
    return this.factCache?.status(sessionId, header) ?? { state: 'none', reason: 'not-cached' };
  }

  cacheSummary() { return { enabled: Boolean(this.factCache), memoryEntries: this.#cache.size,
    analyzerVersion: ANALYZER_VERSION, ...(this.factCache?.summary() ?? {}) }; }

  async clearCache(sessionId) {
    this.#cacheEpoch++;
    if (sessionId === undefined) this.#cache.clear(); else this.#cache.delete(sessionId);
    return this.factCache ? this.factCache.clear(sessionId) : { cleared: 0, enabled: false };
  }

  /** Unvalidated prior results are display hints and never enter the send gate. */
  async cached(sessionId, { config = {}, policyVersion = 1, signal, header, inheritedEventCount } = {}) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    const envelope = (await this.factCache?.get(sessionId))?.envelope;
    if (!envelope || envelope.analyzerVersion !== ANALYZER_VERSION) return undefined;
    if (header && lifecycleHash(header) !== envelope.lifecycle.headerHash) return undefined;
    if (inheritedEventCount !== undefined && inheritedEventCount !== envelope.lifecycle.inheritedEventCount) return undefined;
    const metrics = await this.derive(envelope.facts, config, { ...this.scheduling, signal });
    return { ...metrics, sessionId, generatedAt: envelope.generatedAt, analyzerVersion: ANALYZER_VERSION, policyVersion,
      sourceCut: { source: 'disk-cache', validation: 'unverified', sessionId, headerDigest: envelope.lifecycle.headerHash,
        inheritedEventCount: envelope.lifecycle.inheritedEventCount, ...envelope.source },
      cacheStatus: 'stale-disk', cacheDetails: { status: 'stale', reason: 'source-not-validated' },
      coverage: { ...metrics.coverage, cached: true, validated: false } };
  }

  resize(limit) {
    this.maxCachedSessions = limit;
    this.#trim();
  }

  #trim() {
    const bytes = () => [...this.#cache.values()].reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    while (this.#cache.size > this.maxCachedSessions || bytes() > (this.factCache?.budget.maxBytes ?? 32 * 1024 * 1024)) {
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
    signal, order = ++this.#sequence, mode = 'reuse' }) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    if (!['reuse', 'refresh'].includes(mode)) throw new TypeError('Invalid analysis cache mode');
    if (sourceCut?.sessionId !== undefined && sourceCut.sessionId !== sessionId) throw new TypeError('Analysis source cut belongs to another Session');
    const key = JSON.stringify([sessionId, sourceCut, dependencyKey, ANALYZER_VERSION, mode]);
    const latest = this.#latest.get(sessionId);
    if (!latest || order >= latest.order) this.#latest.set(sessionId, { key, order });
    let entry = this.#cache.get(sessionId);
    let cacheStatus;
    if (mode === 'reuse' && entry?.key === key) {
      this.#stats.cacheHits++;
      cacheStatus = 'memory';
      this.#cache.delete(sessionId);
      this.#cache.set(sessionId, entry);
    } else {
      let task = this.#inflight.get(key);
      cacheStatus = task ? 'shared' : 'computed';
      if (task) this.#stats.sharedHits++;
      else {
        const previousEntry = entry;
        const cacheEpoch = this.#cacheEpoch;
        task = this.#task(async sharedSignal => {
          const snapshot = await load(sharedSignal);
          sharedSignal.throwIfAborted();
          const dependencySignature = stableDependencySignature(config);
          const disk = mode === 'reuse' && !previousEntry?.envelope ? await this.factCache?.get(sessionId) : undefined;
          let candidate = mode === 'reuse' ? previousEntry?.envelope ?? disk?.envelope : undefined;
          const proof = await sourceProof(snapshot.records, { ...this.scheduling, signal: sharedSignal,
            prefixCount: candidate?.source.eventCount });
          let reason = mode === 'refresh' ? 'refresh-requested' : disk?.reason ?? 'not-cached';
          if (candidate) {
            if (candidate.analyzerVersion !== ANALYZER_VERSION) reason = 'analyzer-changed';
            else if (candidate.adapterVersion !== ADAPTER_VERSION) reason = 'adapter-changed';
            else if (candidate.lifecycle.headerHash !== proof.lifecycle.headerHash
              || candidate.lifecycle.inheritedEventCount !== proof.lifecycle.inheritedEventCount) reason = 'lifecycle-changed';
            else if (proof.source.eventCount < candidate.source.eventCount) reason = 'log-shortened';
            else if (proof.candidatePrefixSha256 !== candidate.source.prefixSha256) reason = 'source-prefix-changed';
            else if (previousEntry?.envelope === candidate ? previousEntry.dependencyKey !== dependencyKey
              : dependencySignature === null) reason = dependencySignature === null ? 'unknown-dependency' : 'dependency-changed';
            else if (candidate.dependencySignature !== dependencySignature) reason = 'dependency-changed';
            else reason = proof.source.eventCount === candidate.source.eventCount ? 'validated-cut' : 'validated-append';
            if (!['validated-cut', 'validated-append'].includes(reason)) candidate = undefined;
          }
          let normalizedCalls = 0;
          let reusedCalls = 0;
          const rebuildReasons = new Set();
          this.#stats.computations++;
          const facts = await this.extract(snapshot.records, { ...config, ...(candidate ? { reuseFacts: candidate.facts } : {}),
            onNormalize: event => { normalizedCalls++; config.onNormalize?.(event); },
            onReuseCall: event => { reusedCalls++; config.onReuseCall?.(event); },
            onCacheMiss: event => { rebuildReasons.add(event.reason); config.onCacheMiss?.(event); },
          }, { ...this.scheduling, signal: sharedSignal });
          sharedSignal.throwIfAborted();
          const generatedAt = Date.now();
          const envelope = { schema: FACT_CACHE_SCHEMA, analyzerVersion: ANALYZER_VERSION,
            adapterVersion: ADAPTER_VERSION, sessionId, lifecycle: proof.lifecycle, source: proof.source,
            dependencySignature, generatedAt, facts,
            factsSha256: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
          const cacheDetails = { status: candidate ? 'hit' : 'miss', reason, reusedCalls, normalizedCalls,
            rebuildReasons: [...rebuildReasons], sourceValidated: true };
          const completed = { key, facts, sourceCut: Object.freeze({ ...sourceCut, ...snapshot.sourceCut }),
            metadata: snapshot.metadata ?? {}, generatedAt, derived: new Map(), envelope, dependencyKey, cacheDetails,
            bytes: Buffer.byteLength(JSON.stringify(envelope)),
            baseCacheStatus: candidate ? previousEntry?.envelope === candidate ? 'incremental-memory' : 'validated-disk' : 'computed' };
          if (!this.#disposed && this.#cacheEpoch === cacheEpoch && this.#latest.get(sessionId)?.key === key) {
            if (completed.bytes <= (this.factCache?.budget.maxEntryBytes ?? 4 * 1024 * 1024)) {
              this.#cache.delete(sessionId);
              this.#cache.set(sessionId, completed);
              this.#trim();
            } else cacheDetails.retention = { retained: false, reason: 'memory-entry-limit' };
            if (this.factCache) cacheDetails.storage = await this.factCache.put(envelope);
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
      if (cacheStatus === 'computed') cacheStatus = entry.baseCacheStatus;
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
    const cacheDetails = cacheStatus === 'memory' ? { ...entry.cacheDetails, status: 'hit', reason: 'memory-cut',
      normalizedCalls: 0, reusedCalls: entry.facts.calls?.length ?? 0, rebuildReasons: [] } : entry.cacheDetails;
    return { ...metrics, ...entry.metadata, sourceCut: entry.sourceCut, generatedAt: entry.generatedAt,
      analyzerVersion: ANALYZER_VERSION, policyVersion, cacheStatus, cacheDetails };
  }

  async dispose() {
    this.#disposed = true;
    for (const task of this.#tasks) task.controller.abort(analysisAborted());
    await Promise.allSettled([...this.#tasks].map(task => task.promise));
    this.#cache.clear();
    this.#inflight.clear();
    this.#latest.clear();
    this.#symbols.clear();
    await this.factCache?.dispose();
  }
}
