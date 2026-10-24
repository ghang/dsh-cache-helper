import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { analysisReferenceCut, catalogId } from './session-catalog.mjs';

const ACTIVE = new Set(['queued', 'running']);
const TERMINAL_ITEMS = new Set(['cached', 'completed', 'failed', 'limited', 'cancelled']);
const STATES = new Set(['queued', 'running', 'completed', 'cancelled', 'interrupted']);
const ITEM_STATES = new Set(['queued', 'running', ...TERMINAL_ITEMS]);
const digest = value => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const finite = value => Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const limitsOf = supplied => ({ maxSelection: 100, maxQueuedJobs: 4, maxRetainedJobs: 50,
  maxSessionEvents: 200_000, maxSessionBytes: 32 * 1024 * 1024,
  maxBatchEvents: 400_000, maxBatchBytes: 64 * 1024 * 1024, maxUnknownSessions: 5,
  maxItemMs: 30_000, maxJobMs: 120_000, retentionMs: 7 * 86400_000,
  maxStateBytes: 1024 * 1024, ...supplied });

export class AnalysisJobError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'AnalysisJobError'; this.code = code; this.status = status; }
}

const failure = (code, message) => ({ code, message });
const cancelled = () => new AnalysisJobError('ABORT_ERR', '本地分析已取消。', 499);
const interrupted = () => failure('interrupted', '上次分析随进程退出而中断；请手动重试未完成项。');
const sourceError = error => error?.status === 413
  ? failure('analysis-limit', '此会话超过本地分析上限。')
  : error?.code === 'CACHE_HELPER_SOURCE_CHANGED'
    ? failure('source-changed', '分析期间会话来源发生变化，请重新分析。')
    : error?.status === 403 ? failure('not-visible', '此会话已不在当前可见范围内。')
      : error?.status === 404 ? failure('not-found', '此会话已被删除或无法找到。')
        : failure('analysis-failed', '此会话无法完整分析；其他所选会话继续处理。');

function ownerKey(options = {}) {
  const owner = options.owner ?? 'browser';
  if (typeof owner !== 'string' || !owner.length || owner.length > 200 || /[\x00-\x1f\x7f]/.test(owner)) throw new AnalysisJobError('CACHE_HELPER_JOB_INVALID', '分析任务访问者无效。');
  return digest(owner);
}

function progress(items) {
  const result = { total: items.length, finished: 0, cached: 0, completed: 0, failed: 0, limited: 0, cancelled: 0 };
  for (const item of items) if (TERMINAL_ITEMS.has(item.state)) { result.finished++; result[item.state]++; }
  return result;
}

function coverageOf(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['unknown', 'partial', 'limited', 'unknownCalls', 'ownershipUnknownCalls', 'missingUsageCalls']) {
    if (typeof value[key] === 'boolean' || finite(value[key])) result[key] = value[key];
  }
  return result;
}

async function abortable(run, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? cancelled());
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(run), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Local-only serial jobs. Cancellation never controls a Session or a gate. */
export class AnalysisJobs {
  #jobs = new Map();
  #keys = new Map();
  #controllers = new Map();
  #scopes = new Map();
  #write = Promise.resolve();
  #pump;
  #disposed = false;
  #persistenceAvailable = true;
  #persistenceError = null;

  constructor({ catalog, analyze, statePath, persistState = true, limits = {}, now = Date.now } = {}) {
    if (!catalog?.select || !catalog?.assertVisible || typeof analyze !== 'function') throw new TypeError('Analysis jobs require a catalog and analyze callback');
    this.catalog = catalog; this.analyze = analyze; this.persistState = persistState;
    this.statePath = statePath ?? join(resolveDshHome(), 'storages', 'cache-helper', 'analysis-jobs.json');
    this.limits = limitsOf(limits); this.now = now;
    for (const [name, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid analysis job ${name}`);
  }

  async init() {
    if (!this.persistState) return;
    let handle;
    try {
      handle = await open(this.statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.limits.maxStateBytes) throw new Error('invalid-state-size');
      await handle.chmod(0o600);
      const state = JSON.parse(await handle.readFile('utf8'));
      if (state?.schema !== 1 || !Array.isArray(state.jobs) || state.jobs.length > this.limits.maxRetainedJobs + this.limits.maxQueuedJobs) throw new Error('invalid-state');
      const restored = state.jobs.map(value => this.#restore(value));
      if (new Set(restored.map(job => job.id)).size !== restored.length) throw new Error('duplicate-state');
      for (const job of restored) {
        this.#jobs.set(job.id, job);
        this.#keys.set(`${job.ownerKey}:${job.idempotencyHash}`, job.id);
      }
      this.#trim();
      await this.#persist();
    } catch (error) {
      if (error.code !== 'ENOENT') { this.#persistenceAvailable = false; this.#persistenceError = 'state-unavailable'; }
    } finally { await handle?.close(); }
  }

  #restore(value) {
    if (!value || typeof value !== 'object' || !STATES.has(value.state)
      || !['reuse', 'refresh'].includes(value.mode) || !HASH.test(value.ownerKey)
      || !HASH.test(value.idempotencyHash) || !HASH.test(value.requestHash)
      || typeof value.includeChildren !== 'boolean' || !finite(value.createdAt) || !finite(value.updatedAt)
      || !Array.isArray(value.selectedIds) || !value.selectedIds.length || value.selectedIds.length > this.limits.maxSelection
      || !Array.isArray(value.items) || value.items.length !== value.selectedIds.length) throw new Error('invalid-job');
    catalogId(value.id);
    const selectedIds = value.selectedIds.map(catalogId);
    if (new Set(selectedIds).size !== selectedIds.length) throw new Error('duplicate-job-items');
    const wasActive = ACTIVE.has(value.state);
    const items = value.items.map((item, index) => {
      if (item?.sessionId !== selectedIds[index] || !ITEM_STATES.has(item.state)) throw new Error('invalid-job-item');
      const pending = !TERMINAL_ITEMS.has(item.state);
      return { sessionId: item.sessionId, state: pending ? 'cancelled' : item.state,
        ...(item.cacheStatus && typeof item.cacheStatus === 'string' && item.cacheStatus.length <= 100 ? { cacheStatus: item.cacheStatus } : {}),
        ...(item.sourceCut ? { sourceCut: analysisReferenceCut(item.sourceCut) } : {}),
        ...(item.resultReference ? { resultReference: { sessionId: item.sessionId,
          sourceCut: analysisReferenceCut(item.resultReference.sourceCut),
          generatedAt: finite(item.resultReference.generatedAt) ? item.resultReference.generatedAt : null } } : {}),
        ...(pending ? { error: interrupted() } : item.error ? { error: sourceError({}) } : {}),
        coverage: coverageOf(item.coverage), hasNewEvents: item.hasNewEvents === true,
        budget: { eventCount: integer(item.budget?.eventCount) ? item.budget.eventCount : null,
          sizeBytes: integer(item.budget?.sizeBytes) ? item.budget.sizeBytes : null,
          known: integer(item.budget?.eventCount) && integer(item.budget?.sizeBytes) } };
    });
    return { id: value.id, ownerKey: value.ownerKey, idempotencyHash: value.idempotencyHash, requestHash: value.requestHash,
      state: wasActive ? 'interrupted' : value.state, mode: value.mode, includeChildren: value.includeChildren,
      createdAt: value.createdAt, updatedAt: wasActive ? this.now() : value.updatedAt,
      finishedAt: wasActive ? this.now() : finite(value.finishedAt) ? value.finishedAt : null,
      selectedIds, items, budget: this.#budget(items), snapshotId: null };
  }

  #budget(items) {
    return { maxSessionEvents: this.limits.maxSessionEvents, maxSessionBytes: this.limits.maxSessionBytes,
      maxBatchEvents: this.limits.maxBatchEvents, maxBatchBytes: this.limits.maxBatchBytes,
      knownEvents: items.reduce((sum, item) => sum + (item.budget.eventCount ?? 0), 0),
      knownBytes: items.reduce((sum, item) => sum + (item.budget.sizeBytes ?? 0), 0),
      unknownItems: items.filter(item => !item.budget.known).length,
      coverage: items.some(item => !item.budget.known) ? 'partial' : 'known' };
  }

  #dto(job) {
    const { ownerKey, idempotencyHash, requestHash, ...publicJob } = job;
    return structuredClone({ ...publicJob, progress: progress(job.items),
      persistence: { enabled: this.persistState, available: this.#persistenceAvailable,
        ...(this.#persistenceError ? { error: this.#persistenceError } : {}) } });
  }

  #owned(id, options) {
    this.#trim();
    const job = this.#jobs.get(catalogId(id));
    if (!job) throw new AnalysisJobError('CACHE_HELPER_JOB_NOT_FOUND', '分析任务不存在或已过保留期。', 404);
    if (job.ownerKey !== ownerKey(options)) throw new AnalysisJobError('CACHE_HELPER_JOB_FORBIDDEN', '分析任务不属于当前访问者。', 403);
    return job;
  }

  async get(id, options = {}) {
    const job = this.#owned(id, options);
    await this.catalog.assertVisible(job.selectedIds, options);
    return this.#dto(job);
  }

  async list(options = {}) {
    this.#trim();
    const result = [];
    for (const job of [...this.#jobs.values()].reverse().sort((a, b) => b.createdAt - a.createdAt)) {
      if (job.ownerKey !== ownerKey(options)) continue;
      try { await this.catalog.assertVisible(job.selectedIds, options); result.push(this.#dto(job)); }
      catch (error) { if (error.status !== 403) throw error; }
    }
    return result;
  }

  async start(request, options = {}) {
    if (this.#disposed) throw new AnalysisJobError('CACHE_HELPER_JOBS_DISPOSED', '分析服务已卸载。', 409);
    this.#trim();
    options.signal?.throwIfAborted();
    if (!request || !Array.isArray(request.sessionIds) || !request.sessionIds.length
      || request.sessionIds.length > this.limits.maxSelection || typeof request.idempotencyKey !== 'string'
      || !request.idempotencyKey.length || request.idempotencyKey.length > 200 || /[\x00-\x1f\x7f]/.test(request.idempotencyKey)
      || (request.includeChildren !== undefined && typeof request.includeChildren !== 'boolean')
      || !['reuse', 'refresh'].includes(request.mode ?? 'reuse')) throw new AnalysisJobError('CACHE_HELPER_JOB_INVALID', '分析任务参数无效。');
    const ids = [...new Set(request.sessionIds.map(catalogId))];
    const owner = ownerKey(options);
    const idempotencyHash = digest(request.idempotencyKey);
    const key = `${owner}:${idempotencyHash}`;
    const requestHash = digest(JSON.stringify({ ids: [...ids].sort(), includeChildren: request.includeChildren ?? false, mode: request.mode ?? 'reuse' }));
    const existing = () => {
      const prior = this.#jobs.get(this.#keys.get(key));
      if (!prior) return null;
      if (prior.requestHash !== requestHash) throw new AnalysisJobError('CACHE_HELPER_JOB_CONFLICT', '同一幂等键已用于不同的分析范围。', 409);
      return prior;
    };
    let prior = existing();
    if (prior) return this.get(prior.id, options);
    const selection = await this.catalog.select(ids, { ...options, includeChildren: request.includeChildren ?? false, snapshotId: request.snapshotId });
    options.signal?.throwIfAborted();
    if (this.#disposed) throw cancelled();
    prior = existing();
    if (prior) return this.get(prior.id, options);
    if (selection.selectedIds.length > this.limits.maxSelection) throw new AnalysisJobError('CACHE_HELPER_JOB_LIMIT', '包含子任务后的会话数超过本次分析上限。', 413);
    if ([...this.#jobs.values()].filter(job => ACTIVE.has(job.state)).length >= this.limits.maxQueuedJobs) throw new AnalysisJobError('CACHE_HELPER_JOB_QUEUE_FULL', '本地分析队列已满，请等待或取消已有任务。', 429);
    const items = selection.items.map(row => {
      const eventCount = integer(row.eventCount) ? row.eventCount : null;
      const sizeBytes = integer(row.sizeBytes) ? row.sizeBytes : null;
      const limited = eventCount > this.limits.maxSessionEvents || sizeBytes > this.limits.maxSessionBytes;
      return { sessionId: row.sessionId, state: limited ? 'limited' : 'queued',
        budget: { eventCount, sizeBytes, known: eventCount !== null && sizeBytes !== null },
        ...(limited ? { error: failure('session-budget', '此会话的事件数或字节数超过本次分析预算。') } : {}) };
    });
    const budget = this.#budget(items);
    if (budget.knownBytes > this.limits.maxBatchBytes || budget.knownEvents > this.limits.maxBatchEvents
      || budget.unknownItems > this.limits.maxUnknownSessions) throw new AnalysisJobError('CACHE_HELPER_JOB_LIMIT',
      budget.unknownItems > this.limits.maxUnknownSessions ? '部分会话缺少预算元数据，请缩小本次分析集合。' : '所选集合超过本地分析批次预算。', 413);
    const job = { id: randomUUID(), ownerKey: owner, idempotencyHash, requestHash, state: 'queued',
      mode: request.mode ?? 'reuse', includeChildren: request.includeChildren ?? false,
      snapshotId: selection.snapshotId, selectedIds: [...selection.selectedIds], items, budget,
      createdAt: this.now(), updatedAt: this.now(), finishedAt: null };
    this.#jobs.set(job.id, job); this.#keys.set(key, job.id); this.#trim();
    this.#scopes.set(job.id, { owner: options.owner ?? 'browser',
      ...(options.visibleIds ? { visibleIds: new Set(options.visibleIds) } : {}) });
    await this.#persist();
    this.#schedule();
    return this.#dto(job);
  }

  async cancel({ id }, options = {}) {
    const job = this.#owned(id, options);
    await this.catalog.assertVisible(job.selectedIds, options);
    if (!ACTIVE.has(job.state)) return this.#dto(job);
    job.state = 'cancelled'; job.updatedAt = this.now(); job.finishedAt = this.now();
    for (const item of job.items) if (!TERMINAL_ITEMS.has(item.state)) {
      item.state = 'cancelled'; item.error = failure('cancelled', '用户取消了本地分析；会话运行不受影响。');
    }
    this.#controllers.get(job.id)?.abort(cancelled());
    await this.#persist();
    return this.#dto(job);
  }

  #schedule() {
    if (this.#pump || this.#disposed) return;
    this.#pump = Promise.resolve().then(async () => {
      while (!this.#disposed) {
        const job = [...this.#jobs.values()].find(value => value.state === 'queued');
        if (!job) break;
        await this.#run(job);
      }
    }).finally(() => { this.#pump = undefined; if (!this.#disposed && [...this.#jobs.values()].some(job => job.state === 'queued')) this.#schedule(); });
    this.#pump.catch(() => {});
  }

  async #run(job) {
    job.state = 'running'; job.updatedAt = this.now();
    const controller = new AbortController(); this.#controllers.set(job.id, controller);
    let jobTimeout = false;
    let reservedEvents = 0;
    let reservedBytes = 0;
    let knownEvents = 0;
    let knownBytes = 0;
    const timer = setTimeout(() => { jobTimeout = true; controller.abort(cancelled()); }, this.limits.maxJobMs);
    try {
      await this.#persist();
      for (const item of job.items) {
        if (this.#disposed || job.state === 'cancelled') break;
        if (TERMINAL_ITEMS.has(item.state)) continue;
        if (jobTimeout) { item.state = 'limited'; item.error = failure('job-time-limit', '本次分析已达到运行时间预算。'); continue; }
        const maxEvents = Math.min(this.limits.maxSessionEvents, this.limits.maxBatchEvents - reservedEvents);
        const maxBytes = Math.min(this.limits.maxSessionBytes, this.limits.maxBatchBytes - reservedBytes);
        if (maxEvents <= 0 || maxBytes <= 0) {
          item.state = 'limited'; item.error = failure('batch-budget', '本批次已达到分析预算；未知读取按单项上限保守预留。'); continue;
        }
        item.state = 'running'; job.updatedAt = this.now();
        const itemController = new AbortController();
        const propagate = () => itemController.abort(controller.signal.reason ?? cancelled());
        controller.signal.addEventListener('abort', propagate, { once: true });
        if (controller.signal.aborted) propagate();
        let itemTimeout = false;
        const itemTimer = setTimeout(() => { itemTimeout = true; itemController.abort(cancelled()); }, this.limits.maxItemMs);
        try {
          await this.catalog.assertVisible([item.sessionId], { ...this.#scopes.get(job.id), signal: itemController.signal });
          // The source may grow while queued. The repository must apply these
          // limits to its CURRENT stat before opening/decoding, not the old
          // directory snapshot. Reserve a full item until measured metadata is
          // returned; unknown/failing reads do not silently cost zero.
          reservedEvents += maxEvents; reservedBytes += maxBytes;
          const result = await abortable(() => this.analyze(item.sessionId, { signal: itemController.signal,
            mode: job.mode, maxEvents, maxBytes }), itemController.signal);
          itemController.signal.throwIfAborted();
          if (this.#disposed || job.state === 'cancelled') break;
          if (integer(result?.sourceCut?.eventCount)) {
            knownEvents += result.sourceCut.eventCount;
            reservedEvents -= maxEvents - Math.min(maxEvents, result.sourceCut.eventCount);
          }
          if (integer(result?.sourceCut?.sizeBytes)) {
            knownBytes += result.sourceCut.sizeBytes;
            reservedBytes -= maxBytes - Math.min(maxBytes, result.sourceCut.sizeBytes);
          }
          Object.assign(job.budget, { measuredKnownEvents: knownEvents, measuredKnownBytes: knownBytes,
            reservedEvents, reservedBytes, actualBytesComplete: reservedBytes === knownBytes });
          if (integer(result?.sourceCut?.eventCount) && result.sourceCut.eventCount > maxEvents
            || integer(result?.sourceCut?.sizeBytes) && result.sourceCut.sizeBytes > maxBytes) {
            item.state = 'limited'; item.error = failure('session-budget', '此会话实际事件数超过本次分析预算。');
          } else {
            const cacheStatus = typeof result?.cacheStatus === 'string' ? result.cacheStatus.slice(0, 100) : 'computed';
            const factHit = result?.cacheDetails?.status === 'hit' && result.cacheDetails.normalizedCalls === 0;
            item.state = factHit || ['memory', 'disk', 'cached', 'disk-validated', 'validated-disk', 'persisted'].includes(cacheStatus) ? 'cached' : 'completed';
            item.cacheStatus = cacheStatus; item.sourceCut = analysisReferenceCut(result?.sourceCut);
            item.resultReference = { sessionId: item.sessionId, sourceCut: item.sourceCut,
              generatedAt: finite(result?.generatedAt) ? result.generatedAt : null };
            item.coverage = coverageOf(result?.coverage); item.hasNewEvents = result?.hasNewEvents === true;
          }
        } catch (error) {
          if (this.#disposed || job.state === 'cancelled') break;
          if (jobTimeout || itemTimeout) {
            item.state = 'limited'; item.error = failure(jobTimeout ? 'job-time-limit' : 'item-time-limit', '本地分析已达到运行时间预算。');
          } else { item.state = error?.status === 413 ? 'limited' : 'failed'; item.error = sourceError(error); }
        } finally {
          clearTimeout(itemTimer); controller.signal.removeEventListener('abort', propagate);
          Object.assign(job.budget, { measuredKnownEvents: knownEvents, measuredKnownBytes: knownBytes,
            reservedEvents, reservedBytes, actualBytesComplete: reservedBytes === knownBytes });
        }
        job.updatedAt = this.now();
        await this.#persist();
      }
      if (!this.#disposed && job.state !== 'cancelled') { job.state = 'completed'; job.finishedAt = this.now(); job.updatedAt = this.now(); }
      this.#trim(); await this.#persist();
    } finally { clearTimeout(timer); this.#controllers.delete(job.id); }
  }

  #trim() {
    const finished = [...this.#jobs.values()].reverse().filter(job => !ACTIVE.has(job.state)).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const [index, job] of finished.entries()) if (index >= this.limits.maxRetainedJobs || this.now() - job.updatedAt > this.limits.retentionMs) {
      this.#jobs.delete(job.id); this.#keys.delete(`${job.ownerKey}:${job.idempotencyHash}`);
      this.#scopes.delete(job.id);
    }
  }

  async #persist() {
    if (!this.persistState) return;
    this.#trim();
    let jobs = [...this.#jobs.values()];
    let state = JSON.stringify({ schema: 1, jobs });
    while (Buffer.byteLength(state) > this.limits.maxStateBytes) {
      const oldest = jobs.filter(job => !ACTIVE.has(job.state)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) { this.#persistenceAvailable = false; this.#persistenceError = 'state-budget'; return; }
      this.#jobs.delete(oldest.id); this.#keys.delete(`${oldest.ownerKey}:${oldest.idempotencyHash}`);
      this.#scopes.delete(oldest.id);
      jobs = [...this.#jobs.values()]; state = JSON.stringify({ schema: 1, jobs });
    }
    const write = this.#write.catch(() => {}).then(async () => {
      const directory = dirname(this.statePath);
      let temporary;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const parent = await lstat(directory);
        if (parent.isSymbolicLink() || !parent.isDirectory() || parent.mode & 0o022) throw new Error('unsafe-state-directory');
        // mkdir creates a private directory when absent. Never chmod an
        // arbitrary pre-existing parent supplied by the caller.
        temporary = `${this.statePath}.${randomUUID()}.tmp`;
        await writeFile(temporary, state, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.statePath);
        this.#persistenceAvailable = true; this.#persistenceError = null;
      } catch { this.#persistenceAvailable = false; this.#persistenceError = 'state-unavailable'; }
      finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.#write = write; await write;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of this.#jobs.values()) if (ACTIVE.has(job.state)) {
      job.state = 'interrupted'; job.updatedAt = this.now(); job.finishedAt = this.now();
      for (const item of job.items) if (!TERMINAL_ITEMS.has(item.state)) { item.state = 'cancelled'; item.error = interrupted(); }
      this.#controllers.get(job.id)?.abort(cancelled());
    }
    await this.#pump;
    await this.#persist();
    await this.#write.catch(() => {});
  }
}
