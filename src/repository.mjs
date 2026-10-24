import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { AnalysisService, analysisAborted } from './analysis-service.mjs';
import { FactCache } from './fact-cache.mjs';
import { ACCOUNTING_PROJECTION_KEY, accountingProjectionSchema, installAccountingProjection } from './accounting-projection.mjs';
import { aggregateStatistics } from './statistics.mjs';

export function liveRecords(session) {
  return [{ type: 'session', ...session.header, inheritedEventCount: session.inheritedEventCount ?? 0 }, ...session.snapshotEvents()];
}

export function requestRevision(records) {
  const start = records[0]?.type === 'session' ? 1 : 0;
  for (let index = records.length - 1; index >= start; index--) {
    const event = records[index];
    if (event.surfaceOp !== undefined || event.type === 'request/header' || event.type === 'request/context') return event.seq;
  }


  return -1;
}

function titleOf(records) {
  for (let index = records.length - 1; index > 0; index--) {
    if (records[index].type === 'session/title') return records[index].data?.title ?? records[0].id;
  }
  return records[0].id;
}

const headerDigest = header => header ? createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.keys(header).sort().map(key => [key, header[key]])))).digest('hex') : null;
const limited = () => Object.assign(new Error('会话事件数超过本地分析上限。'), { status: 413 });
const byteLimited = () => Object.assign(new Error('会话字节数超过本地分析预算。'), { status: 413, code: 'CACHE_HELPER_BYTE_LIMIT' });
const changed = () => Object.assign(new Error('分析读取期间会话来源发生变化，请重新分析。'), {
  status: 409, code: 'CACHE_HELPER_SOURCE_CHANGED',
});

/** Read through the host backend; cache only derived metrics, never another request body. */
export class SessionRepository {
  #dismissed = new Set();
  #write = Promise.resolve();
  #dashboard;
  #dashboardAt = 0;
  #order = 0;
  #disposed = false;
  #projectionDispose;
  #lastObserved = new Map();
  policyVersion = 1;

  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.statePath = config.statePath ?? join(resolveDshHome(), 'storages', 'cache-helper', 'web-state.json');
    this.factCache = config.persistState === false || config.persistAnalysisCache === false ? undefined : new FactCache({
      directory: config.analysisCachePath ?? join(dirname(this.statePath), 'analysis-cache-v1'),
    });
    this.analysis = new AnalysisService({ maxCachedSessions: config.maxCachedSessions, factCache: this.factCache });
  }

  #dependencies(header, config = this.config) {
    const projections = [...(this.ctx.sessions.messageProjections ?? [])];
    const parentHeaders = new Map();
    let parentId = header?.parentSession;
    for (let hops = 0; parentId && !parentHeaders.has(parentId) && hops < 128; hops++) {
      const parent = this.ctx.sessions.get(parentId);
      if (!parent) break;
      parentHeaders.set(parentId, { ...parent.header,
        inheritedEventCount: parent.inheritedEventCount ?? (parent.header?.isSeeded ? null : 0) });
      parentId = parent.header?.parentSession;
    }
    const historical = config.historicalCapabilities;
    return { analysisConfig: { ...config, messageProjections: projections, parentHeaders },
      dependencyKey: JSON.stringify({ projections: projections.map(item => [item.type, this.analysis.reference(item.project)]),
        historical: typeof historical === 'function' ? this.analysis.reference(historical) : historical,
        lineage: [...parentHeaders].map(([id, value]) => [id, headerDigest(value)]) }) };
  }

  #summary(header, live) {
    try {
      const snapshot = live
        ? this.ctx.get?.('sessionProjections')?.cachedSnapshot(live, [ACCOUNTING_PROJECTION_KEY])
        : this.ctx.get?.('sessionProjectionCache')?.cachedSnapshot(header, [ACCOUNTING_PROJECTION_KEY]);
      const parsed = accountingProjectionSchema.safeParse(snapshot?.values?.[ACCOUNTING_PROJECTION_KEY]);
      if (!parsed.success || parsed.data.sessionId !== header.id || !Number.isSafeInteger(snapshot.asOfSeq)
        || snapshot.asOfSeq < -1 || live && parsed.data.inheritedEventCount !== live.inheritedEventCount) return null;
      return { ...parsed.data, asOfSeq: snapshot.asOfSeq };
    } catch { return null; }
  }

  updatePolicy(config, version) {
    if (this.policyVersion === version) return;
    this.config = config;
    this.policyVersion = version;
    this.analysis.resize(config.maxCachedSessions);
    this.#dashboard = undefined;
  }

  async init() {
    await this.factCache?.init();
    this.#projectionDispose = await installAccountingProjection(this.ctx);
    if (this.config.persistState === false) return;
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (state.version === 1 && Array.isArray(state.dismissed)) {
        for (const id of state.dismissed) if (typeof id === 'string') this.#dismissed.add(id);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.ctx.logger?.warn?.('cache-helper: cannot read dismissal state; Session metrics remain available');
    }
  }

  /** Listing hints use metadata only; unvalidated disk results stay stale. */
  analysisStatus(header, metadata = {}) {
    const id = typeof header === 'string' ? header : header.id;
    const state = this.analysis.analysisStatus(id, typeof header === 'string' ? undefined : header);
    const observed = this.#lastObserved.get(id);
    const live = this.ctx.sessions.get(id);
    const currentHeader = typeof header === 'string' ? live?.header : header;
    if (state.state === 'none') {
      const summary = currentHeader && this.#summary(currentHeader, live);
      return observed || summary ? { ...state, state: 'stale', reason: 'details-not-retained',
        generatedAt: observed?.generatedAt, lastSeq: observed?.lastSeq ?? summary?.asOfSeq,
        summaryAvailable: Boolean(summary) } : state;
    }
    const eventCount = metadata.eventCount ?? live?.seq;
    let current = false;
    const dependencyMatches = observed?.dependencyKey === this.#dependencies(currentHeader).dependencyKey;
    if (live && Number.isSafeInteger(eventCount)) current = state.memory === true && state.eventCount === eventCount
      && live.seq === eventCount && observed?.source === 'live' && observed.lifecycle === this.analysis.reference(live)
      && observed.contentGeneration === live.surface?.contentGeneration && dependencyMatches;
    else if (!live && observed && metadata.revision !== undefined) {
      const persistence = this.ctx.get?.('sessionPersistence');
      current = state.memory === true && observed.source === 'persistence' && observed.revision === metadata.revision && dependencyMatches
        && observed.serviceInstance === this.analysis.reference(persistence?.identity ?? persistence);
    }
    return { ...state, state: current ? 'cached' : 'stale', reason: current ? 'observed-current-cut' : state.reason ?? 'source-not-validated' };
  }

  async cachedSession(sessionId, { signal } = {}) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    const live = this.ctx.sessions.get(sessionId);
    const snapshot = live ? undefined : await this.ctx.get?.('sessionPersistence')?.stat(sessionId, { signal });
    signal?.throwIfAborted();
    const header = live?.header ?? snapshot?.header;
    if (!header) return null;
    const status = this.analysis.analysisStatus(sessionId, header);
    if (status.reason === 'lifecycle-changed') return null;
    const data = status.eventCount > this.config.maxEvents ? undefined : await this.analysis.cached(sessionId, {
      header, ...(live ? { inheritedEventCount: live.inheritedEventCount } : {}), config: this.config,
      policyVersion: this.policyVersion, signal });
    if (!data) {
      const summary = this.#summary(header, live);
      if (!summary) return null;
      return { sessionId, title: sessionId, role: summary.role,
        ownership: { known: summary.inheritedEventCount !== null, inheritedEventCount: summary.inheritedEventCount },
        latest: null, cumulative: null, calls: [], turns: [], warnings: [], accountingSummary: summary,
        sourceCut: { sessionId, source: 'accounting-projection', validation: 'unverified',
          lastSeq: summary.asOfSeq < 0 ? null : summary.asOfSeq, eventCount: summary.asOfSeq + 1 },
        cacheStatus: 'stale-summary', stale: true, policyVersion: this.policyVersion,
        coverage: { cached: true, validated: false, partial: true, detailsAvailable: false, reason: 'details-not-retained' } };
    }
    return { ...data, title: sessionId, cwd: live?.header?.cwd, stale: true,
      config: { minLostTokens: this.config.minLostTokens, minLossRatio: this.config.minLossRatio },
      warnings: (data.warnings ?? []).map(warning => ({ ...warning,
        dismissed: this.#dismissed.has(`${sessionId}:${warning.id}`) })) };
  }

  async records(sessionId, config = this.config, { signal } = {}) {
    signal?.throwIfAborted();
    const live = this.ctx.sessions.get(sessionId);
    if (live) {
      if (live.snapshotEvents().length > config.maxEvents) throw limited();
      return liveRecords(live);
    }
    const persistence = this.ctx.get?.('sessionPersistence');
    if (!persistence) throw Object.assign(new Error('会话不在内存中，宿主也未提供持久化读取接口。'), { status: 404 });
    const handle = await persistence.open(sessionId, 'read', { signal });
    try {
      signal?.throwIfAborted();
      const { events } = await handle.read(0, config.maxEvents + 1, { signal });
      signal?.throwIfAborted();
      if (events.length > config.maxEvents) throw limited();
      return [{ type: 'session', ...handle.header, inheritedEventCount: handle.inheritedEventCount }, ...events];
    } finally {
      await handle.close();
    }
  }

  async session(sessionId, { signal, mode = 'reuse', maxEvents, maxBytes = 32 * 1024 * 1024 } = {}) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    if (maxEvents !== undefined && (!Number.isSafeInteger(maxEvents) || maxEvents < 0)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Object.assign(new Error('分析预算无效。'), { status: 400 });
    const order = ++this.#order;
    const config = { ...this.config, maxEvents: maxEvents === undefined ? this.config.maxEvents : Math.min(this.config.maxEvents, maxEvents) };
    const policyVersion = this.policyVersion;
    const live = this.ctx.sessions.get(sessionId);
    const persistence = this.ctx.get?.('sessionPersistence');
    if (!live && !persistence) throw Object.assign(new Error('会话不在内存中，宿主也未提供持久化读取接口。'), { status: 404 });
    // Borrow the host's immutable event snapshot once. Appends after this point
    // are reported as newer events rather than chased by this computation.
    const events = live?.snapshotEvents();
    const snapshot = live ? undefined : await persistence.stat(sessionId, { signal });
    signal?.throwIfAborted();
    const eventCount = events?.length ?? snapshot?.eventCount;
    const sizeBytes = Number.isSafeInteger(snapshot?.sizeBytes) && snapshot.sizeBytes >= 0 ? snapshot.sizeBytes : null;
    if (eventCount > config.maxEvents) throw limited();
    if (sizeBytes !== null && sizeBytes > maxBytes) throw byteLimited();
    // Use only already-live parent metadata here. Missing cold ancestry stays
    // unknown; analysis never activates an Agent to fill a relationship gap.
    const { analysisConfig, dependencyKey } = this.#dependencies(live?.header ?? snapshot?.header, config);
    const sourceCut = Object.freeze({
      sessionId, source: live ? 'live' : 'persistence',
      serviceInstance: this.analysis.reference(live ? this.ctx.sessions : persistence.identity ?? persistence),
      lifecycle: live ? this.analysis.reference(live) : headerDigest(snapshot?.header),
      headerDigest: headerDigest(live?.header ?? snapshot?.header),
      revision: live ? events.length : snapshot?.revision ?? `unverified-${++this.#order}`,
      eventCount: eventCount ?? null,
      sizeBytes: live ? null : sizeBytes,
      lastSeq: events ? events.at(-1)?.seq ?? null : null,
      inheritedEventCount: live ? live.inheritedEventCount ?? (live.header?.isSeeded ? null : 0) : null,
      contentGeneration: live?.surface?.contentGeneration ?? null,
    });
    const value = await this.analysis.analyze({ sessionId, sourceCut, dependencyKey, config: analysisConfig,
      policyVersion, signal, order, mode,
      load: async sharedSignal => {
        let records;
        if (live) records = [{ type: 'session', ...live.header,
          inheritedEventCount: sourceCut.inheritedEventCount }, ...events];
        else {
          // Read from the same captured service instance as the stat token.
          const handle = await persistence.open(sessionId, 'read', { signal: sharedSignal });
          try {
            sharedSignal.throwIfAborted();
            const read = await handle.read(0, config.maxEvents + 1, { signal: sharedSignal });
            sharedSignal.throwIfAborted();
            if (read.events.length > config.maxEvents) throw limited();
            records = [{ type: 'session', ...handle.header,
              inheritedEventCount: handle.inheritedEventCount }, ...read.events];
          } finally { await handle.close(); }
          const after = await persistence.stat(sessionId, { signal: sharedSignal });
          sharedSignal.throwIfAborted();
          if (snapshot?.revision !== undefined && (after?.revision !== snapshot.revision
            || (snapshot.header && headerDigest(records[0]) !== headerDigest({ type: 'session', ...snapshot.header,
              inheritedEventCount: records[0].inheritedEventCount })))) throw changed();
        }
        sharedSignal.throwIfAborted();
        try {
          if (live) this.ctx.get?.('sessionProjections')?.snapshot(live, [ACCOUNTING_PROJECTION_KEY]);
          else if (Number.isSafeInteger(records[0].inheritedEventCount)) {
            const { type, inheritedEventCount, ...meta } = records[0];
            this.ctx.get?.('sessionProjectionCache')?.coldSnapshot(meta, inheritedEventCount, records.slice(1));
          }
        } catch { /* Projection persistence is optional, bounded and fail-soft. */ }
        sharedSignal.throwIfAborted();
        return { records, metadata: { sessionId, title: titleOf(records), cwd: records[0].cwd },
          sourceCut: { eventCount: records.length - 1, lastSeq: records.at(-1)?.seq ?? null,
            inheritedEventCount: records[0].inheritedEventCount ?? (records[0].isSeeded ? null : 0) } };
      },
    });
    if (value.sourceCut.eventCount > config.maxEvents) throw limited();
    if (policyVersion !== this.policyVersion) return this.session(sessionId, { signal, mode, maxEvents, maxBytes });
    const previousObservation = this.#lastObserved.get(sessionId);
    if (!previousObservation || order >= previousObservation.observationOrder) {
      this.#lastObserved.delete(sessionId);
      this.#lastObserved.set(sessionId, { ...value.sourceCut, observationOrder: order, dependencyKey, generatedAt: value.generatedAt });
    }
    while (this.#lastObserved.size > this.config.maxCachedSessions) this.#lastObserved.delete(this.#lastObserved.keys().next().value);
    const currentLive = this.ctx.sessions.get(sessionId);
    const currentPersistence = this.ctx.get?.('sessionPersistence');
    let hasNewEvents = live ? currentLive !== live || live.snapshotEvents().length !== sourceCut.eventCount
      : this.analysis.reference(currentPersistence?.identity ?? currentPersistence) !== sourceCut.serviceInstance;
    if (!live && !hasNewEvents && snapshot?.revision !== undefined) {
      const afterAnalysis = await currentPersistence.stat(sessionId, { signal });
      hasNewEvents = afterAnalysis?.revision !== snapshot.revision;
    }
    return {
      ...value, hasNewEvents, coverage: { ...value.coverage, byteBudgetKnown: Number.isSafeInteger(sourceCut.sizeBytes) },
      config: { minLostTokens: config.minLostTokens, minLossRatio: config.minLossRatio },
      warnings: (value.warnings ?? []).map(warning => ({
        ...warning, dismissed: this.#dismissed.has(`${sessionId}:${warning.id}`),
      })),
    };
  }

  async dismiss({ sessionId, id, dismissed }) {
    if (typeof dismissed !== 'boolean') throw Object.assign(new Error('dismissed 必须是布尔值。'), { status: 400 });
    const data = await this.session(sessionId);
    if (!data.warnings.some(warning => warning.id === id)) throw Object.assign(new Error('告警不存在。'), { status: 404 });
    const key = `${sessionId}:${id}`;
    dismissed ? this.#dismissed.add(key) : this.#dismissed.delete(key);
    if (this.config.persistState !== false) {
      const state = JSON.stringify({ version: 1, dismissed: [...this.#dismissed].slice(-10000) });
      const write = this.#write.catch(() => {}).then(async () => {
        await mkdir(dirname(this.statePath), { recursive: true });
        const temp = `${this.statePath}.${randomUUID()}.tmp`;
        await writeFile(temp, state, { mode: 0o600 });
        await rename(temp, this.statePath);
      });
      this.#write = write;
      await write;
    }
    return { ok: true };
  }

  async dashboard(query = {}, { signal } = {}) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    const filters = { period: query.period ?? '7d', model: query.model, provider: query.provider };
    if (!['7d', '30d', 'all'].includes(filters.period)
      || [filters.model, filters.provider].some(value => value !== undefined && (typeof value !== 'string' || value.length > 200))) {
      throw Object.assign(new Error('无效的统计筛选条件。'), { status: 400 });
    }
    // A cancellable scan owns only its subscriptions; other dashboard/session
    // consumers continue sharing the underlying AnalysisService computations.
    if (signal) return this.#scanDashboard(filters, { signal });
    const operationRevision = (this.operations?.() ?? []).map(item => [item.id, item.state, item.updatedAt, item.summaryCalls?.length]);
    const key = JSON.stringify({ ...filters, version: this.policyVersion, operationRevision });
    if (this.#dashboard?.key === key && Date.now() - this.#dashboardAt < 10000) return this.#dashboard.promise;
    const promise = this.#scanDashboard(filters);
    this.#dashboard = { key, promise };
    this.#dashboardAt = Date.now();
    try { return await promise; }
    catch (error) { if (this.#dashboard?.promise === promise) this.#dashboard = undefined; throw error; }
  }

  async #scanDashboard(filters, { signal } = {}) {
    if (this.#disposed || signal?.aborted) throw analysisAborted();
    const config = this.config;
    const policyVersion = this.policyVersion;
    const liveSessions = new Map(this.ctx.sessions.list().map(session => [session.id, session]));
    const rows = new Map([...liveSessions.values()].map(session => [session.id, session.header]));
    const errors = [];
    try {
      const snapshots = await this.ctx.get?.('sessionPersistence')?.list({ signal });
      for (const snapshot of snapshots ?? []) rows.set(snapshot.header.id, snapshot.header);
    } catch (error) {
      if (this.#disposed || signal?.aborted || error.name === 'AbortError') throw analysisAborted();
      errors.push({ stage: 'list', message: '部分持久化会话无法枚举。' });
    }
    let activityUnknown = 0;
    const candidates = [...rows.values()].map(header => {
      let projection;
      try {
        const live = liveSessions.get(header.id);
        projection = live
          ? this.ctx.get?.('sessionProjections')?.cachedSnapshot(live)
          : this.ctx.get?.('sessionProjectionCache')?.cachedSnapshot(header);
      } catch { /* Missing or stale projections remain explicit coverage. */ }
      const lastPromptAt = projection?.values?.sessionListMetadata?.lastPromptAt;
      if (!Number.isFinite(lastPromptAt)) activityUnknown++;
      return { header, activityAt: Math.max(header.createdAt || 0, Number.isFinite(lastPromptAt) ? lastPromptAt : 0) };
    });
    const selected = candidates.sort((a, b) => b.activityAt - a.activityAt).slice(0, config.dashboardLimit);
    const sessions = [];
    const details = [];
    // Bounded serial scan avoids retaining several large histories at once.
    for (const { header, activityAt } of selected) {
      if (this.#disposed || signal?.aborted) throw analysisAborted();
      try {
        const data = await this.session(header.id, { signal });
        details.push(data);
        sessions.push({
          sessionId: data.sessionId, title: data.title, cwd: data.cwd,
          latest: data.latest, cumulative: data.cumulative,
          warningCount: data.warnings.length, lastWarningAt: data.warnings.at(-1)?.at ?? null,
          role: data.role, activityAt,
          identity: data.identity, baseline: data.baseline, sourceCut: data.sourceCut,
          analyzerVersion: data.analyzerVersion, cacheStatus: data.cacheStatus, hasNewEvents: data.hasNewEvents,
        });
      } catch (error) {
        if (this.#disposed || signal?.aborted || error.name === 'AbortError') throw analysisAborted();
        errors.push({ sessionId: header.id,
        code: error.status === 413 ? 'event-limit' : 'read-failed',
        message: error.status === 413 ? '此会话事件数超过分析上限，未计入统计。' : '此会话无法完整重建，未计入统计。' }); }
    }
    if (policyVersion !== this.policyVersion) return this.#scanDashboard(filters, { signal });
    const coverage = {
      scanned: selected.length, included: sessions.length, total: rows.size,
      limit: config.dashboardLimit, errors, activityUnknown,
      activityOrder: activityUnknown ? 'cached-projection-with-created-time-fallback' : 'cached-last-prompt',
      limited: selected.length < rows.size,
    };
    return { sessions, generatedAt: Date.now(), policyVersion,
      statistics: aggregateStatistics(details, { ...filters, now: Date.now(), coverage, policyVersion,
        operations: this.operations?.() ?? [] }), coverage };
  }

  async dispose() {
    this.#disposed = true;
    await this.analysis.dispose();
    await this.#projectionDispose?.();
    this.#lastObserved.clear();
    await this.#write.catch(() => {});
    this.#dashboard = undefined;
  }
}
