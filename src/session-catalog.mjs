import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

export class CatalogError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'CatalogError'; this.code = code; this.status = status; }
}

const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, limit = 4096) => typeof value === 'string' && value.length ? value.slice(0, limit) : null;
const child = header => header?.origin === 'subagent' || header?.delegationDepth > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerOf = options => text(options?.owner ?? 'browser', 200);
const invalid = message => new CatalogError('CACHE_HELPER_CATALOG_INVALID', message);
const optionsOf = options => {
  if (options.visibleIds === undefined) return options;
  if (!Array.isArray(options.visibleIds) && !(options.visibleIds instanceof Set)) throw invalid('会话可见范围无效。');
  return { ...options, visibleIds: new Set([...options.visibleIds].map(catalogId)) };
};

export function catalogId(value) {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw invalid('会话标识无效。');
  return value;
}

/** Retain only source metadata; arbitrary provider fields never enter job state. */
export function analysisReferenceCut(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  if (typeof value.sessionId === 'string' && value.sessionId.length <= 200 && !/[\x00-\x1f\x7f]/.test(value.sessionId)) result.sessionId = value.sessionId;
  if (['live', 'persistence', 'disk-cache', 'unknown'].includes(value.source)) result.source = value.source;
  for (const key of ['eventCount', 'sizeBytes', 'lastSeq', 'inheritedEventCount', 'formatVersion', 'policyVersion']) {
    if (value[key] === null || count(value[key]) !== null) result[key] = value[key];
  }
  for (const key of ['headerDigest', 'prefixHash', 'prefixSha256', 'dependencySignature']) if (/^[a-f0-9]{64}$/i.test(value[key])) result[key] = value[key];
  if (['unverified', 'verified', 'validated'].includes(value.validation)) result.validation = value.validation;
  if (typeof value.analyzerVersion === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,99}$/i.test(value.analyzerVersion)) result.analyzerVersion = value.analyzerVersion;
  return result;
}

function filtersOf(query) {
  const result = { q: query.q ?? '', role: query.role ?? 'all', availability: query.availability ?? 'all', analysis: query.analysis ?? 'all' };
  if (typeof result.q !== 'string' || result.q.length > 500
    || !['all', 'main', 'sub', 'fork'].includes(result.role)
    || !['all', 'live', 'history'].includes(result.availability)
    || !['all', 'cached', 'stale', 'none'].includes(result.analysis)) throw invalid('目录筛选条件无效。');
  result.q = result.q.trim().toLocaleLowerCase();
  for (const key of ['createdFrom', 'createdTo', 'activityFrom', 'activityTo']) {
    if (query[key] !== undefined && query[key] !== null && query[key] !== '') {
      const value = typeof query[key] === 'string' ? Number(query[key]) : query[key];
      if (number(value) === null) throw invalid('目录日期范围无效。');
      result[key] = value;
    }
  }
  if ((result.createdFrom ?? 0) > (result.createdTo ?? Infinity)
    || (result.activityFrom ?? 0) > (result.activityTo ?? Infinity)) throw invalid('目录日期范围无效。');
  return result;
}

function matches(row, filters) {
  if (filters.q && ![row.title, row.sessionId, row.cwd].some(value => value?.toLocaleLowerCase().includes(filters.q))) return false;
  if (filters.role !== 'all' && row.kind !== filters.role) return false;
  if (filters.availability === 'live' && !row.live || filters.availability === 'history' && row.live) return false;
  if (filters.analysis !== 'all' && row.analysisStatus !== filters.analysis) return false;
  for (const [field, from, to] of [['createdAt', 'createdFrom', 'createdTo'], ['activityAt', 'activityFrom', 'activityTo']]) {
    if (filters[from] !== undefined && (row[field] === null || row[field] < filters[from])) return false;
    if (filters[to] !== undefined && (row[field] === null || row[field] > filters[to])) return false;
  }
  return true;
}

function analysisOf(raw) {
  const supplied = raw?.status ?? raw?.state;
  const status = supplied === 'cached' ? 'cached' : supplied === 'stale' ? 'stale'
    : supplied === 'none' || !raw ? 'none' : raw.sourceCut || raw.generatedAt ? 'stale' : 'none';
  return { status, generatedAt: number(raw?.generatedAt), sourceCut: analysisReferenceCut(raw?.sourceCut),
    analyzerVersion: text(raw?.analyzerVersion, 100), policyVersion: count(raw?.policyVersion),
    reason: text(raw?.reason ?? raw?.missReason, 200) };
}

/** A bounded metadata snapshot, never an event-log read or Agent activation. */
export class SessionCatalog {
  #snapshots = new Map();
  constructor(ctx, { analysisStatus = () => undefined, allows, maxEntries = 10_000,
    maxSnapshots = 4, snapshotTtlMs = 120_000, now = Date.now } = {}) {
    for (const [name, value] of Object.entries({ maxEntries, maxSnapshots, snapshotTtlMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid catalog ${name}`);
    }
    this.ctx = ctx; this.analysisStatus = analysisStatus; this.allows = allows;
    this.maxEntries = maxEntries; this.maxSnapshots = maxSnapshots; this.snapshotTtlMs = snapshotTtlMs; this.now = now;
  }

  async #allowed(id, options) {
    if (options.visibleIds && !options.visibleIds.has(id)) return false;
    if (this.allows) return Boolean(await this.allows(id, options));
    // The HTTP adapter admits only connection.browserPeer, whose native
    // principal is owner. A non-owner caller must supply an explicit scope.
    if (ownerOf(options) !== 'browser' && !options.visibleIds) return false;
    const access = this.ctx.get?.('remoteAccess');
    return access?.allows ? Boolean(access.allows({ kind: 'session', id })) : true;
  }

  async assertVisible(ids, options = {}) {
    options = optionsOf(options);
    if (!ownerOf(options)) throw invalid('目录访问者无效。');
    let processed = 0;
    for (const id of ids) {
      options.signal?.throwIfAborted();
      if (++processed % 128 === 0) { await yieldImmediate(); options.signal?.throwIfAborted(); }
      catalogId(id);
      if (!await this.#allowed(id, options)) throw new CatalogError('CACHE_HELPER_SESSION_FORBIDDEN', '所选会话不在当前可见范围内。', 403);
    }
    options.signal?.throwIfAborted();
    return true;
  }

  #trim() {
    for (const [id, snapshot] of this.#snapshots) if (this.now() - snapshot.generatedAt > this.snapshotTtlMs) this.#snapshots.delete(id);
    while (this.#snapshots.size > this.maxSnapshots) this.#snapshots.delete(this.#snapshots.keys().next().value);
  }

  #snapshot(id, options) {
    this.#trim();
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) throw new CatalogError('CACHE_HELPER_CATALOG_EXPIRED', '会话目录快照已过期，请刷新后重新选择。', 409);
    if (snapshot.owner !== ownerOf(options)) throw new CatalogError('CACHE_HELPER_SESSION_FORBIDDEN', '目录快照不属于当前访问者。', 403);
    return snapshot;
  }

  async #capture(options) {
    options.signal?.throwIfAborted();
    if (!ownerOf(options)) throw invalid('目录访问者无效。');
    const records = new Map();
    const listingErrors = [];
    let historyAvailable = false;
    const persistence = this.ctx.get?.('sessionPersistence');
    if (persistence?.list) {
      try {
        const stored = await persistence.list({ signal: options.signal });
        historyAvailable = true;
        for (const item of stored) if (text(item?.header?.id, 200)) records.set(item.header.id, { ...item, live: false, persisted: true });
      } catch (error) {
        if (options.signal?.aborted || error.name === 'AbortError') throw error;
        listingErrors.push({ code: 'persistence-list-unavailable', message: '部分历史目录无法枚举。' });
      }
    } else {
      const query = this.ctx.get?.('sessionQuery');
      if (query?.listSessions) {
        try {
          const listed = await query.listSessions(options.signal); historyAvailable = true;
          for (const item of listed) if (text(item?.header?.id, 200)) records.set(item.header.id, { ...item });
        } catch (error) {
          if (options.signal?.aborted || error.name === 'AbortError') throw error;
          listingErrors.push({ code: 'query-list-unavailable', message: '部分历史目录无法枚举。' });
        }
      }
    }
    for (const session of this.ctx.sessions.list?.() ?? []) {
      const stored = records.get(session.id);
      records.set(session.id, { ...stored, header: session.header, live: true, persisted: Boolean(stored?.persisted),
        eventCount: count(session.seq), session });
    }
    const rows = [];
    let processed = 0;
    for (const entry of records.values()) {
      options.signal?.throwIfAborted();
      if (++processed % 128 === 0) { await yieldImmediate(); options.signal?.throwIfAborted(); }
      const header = entry.header;
      const sessionId = header.id;
      if (!await this.#allowed(sessionId, options)) continue;
      let projection;
      try {
        projection = entry.live
          ? this.ctx.get?.('sessionProjections')?.cachedSnapshot(entry.session)
          : this.ctx.get?.('sessionProjectionCache')?.cachedSnapshot(header);
      } catch { /* A missing/stale projection is an explicit metadata gap. */ }
      const title = text(projection?.values?.title);
      const activity = number(projection?.values?.sessionListMetadata?.lastPromptAt);
      const createdAt = number(header.createdAt);
      let rawAnalysis;
      let analysisAvailable = true;
      try { rawAnalysis = await this.analysisStatus(header, { live: Boolean(entry.live), persisted: Boolean(entry.persisted),
        eventCount: count(entry.eventCount), sizeBytes: entry.live ? null : count(entry.sizeBytes),
        physicalStoredBytes: entry.live ? count(entry.sizeBytes) : null, revision: entry.revision,
        formatStatus: entry.formatStatus, source: entry.live ? 'live' : 'persistence' }); }
      catch { analysisAvailable = false; }
      const analysis = analysisOf(rawAnalysis);
      analysis.available = analysisAvailable;
      if (!analysisAvailable) analysis.reason = 'metadata-unavailable';
      const isChild = child(header);
      const kind = isChild ? 'sub' : header.parentSession ? 'fork' : 'main';
      const eventCount = count(entry.eventCount);
      const sizeBytes = entry.live ? null : count(entry.sizeBytes);
      rows.push({ sessionId, title: title ?? sessionId, titleKnown: title !== null,
        titleSource: title === null ? 'id' : 'cached-projection', cwd: text(header.cwd), createdAt,
        activityAt: activity === null ? createdAt : Math.max(activity, createdAt ?? 0),
        activitySource: activity !== null ? 'cached-last-prompt' : createdAt !== null ? 'created-fallback' : 'unknown',
        role: isChild ? 'sub' : 'main', kind,
        directParentId: isChild ? text(header.parentSession, 200) : null,
        forkParentId: text(header.parentSession, 200), live: Boolean(entry.live), persisted: Boolean(entry.persisted),
        formatStatus: text(entry.formatStatus, 100), analysisStatus: analysis.status, analysis,
        eventCount, sizeBytes, physicalStoredBytes: entry.live ? count(entry.sizeBytes) : null,
        budgetKnown: eventCount !== null && sizeBytes !== null,
        model: analysis.status === 'none' ? null : text(rawAnalysis?.model, 256),
        warningCount: analysis.status === 'none' ? null : count(rawAnalysis?.warningCount) });
    }
    options.signal?.throwIfAborted();
    rows.sort((a, b) => (b.activityAt ?? -1) - (a.activityAt ?? -1)
      || (b.createdAt ?? -1) - (a.createdAt ?? -1) || a.sessionId.localeCompare(b.sessionId));
    const total = rows.length;
    rows.length = Math.min(rows.length, this.maxEntries);
    const snapshot = { id: randomUUID(), owner: ownerOf(options), generatedAt: this.now(), rows,
      coverage: { listed: rows.length, total, limited: rows.length < total, historyAvailable,
        titleUnknown: rows.filter(row => !row.titleKnown).length,
        activityUnknown: rows.filter(row => row.activitySource !== 'cached-last-prompt').length,
        budgetUnknown: rows.filter(row => !row.budgetKnown).length, listingErrors, physicalPagination: false } };
    this.#snapshots.set(snapshot.id, snapshot); this.#trim();
    return snapshot;
  }

  async list(query = {}, options = {}) {
    options = optionsOf(options);
    const filters = filtersOf(query);
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('目录分页大小无效。');
    const filterHash = hash([filters, limit]);
    let snapshot;
    let offset = 0;
    if (query.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); } catch { throw invalid('目录分页游标无效。'); }
      if (typeof cursor?.id !== 'string' || cursor.filter !== filterHash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw invalid('目录筛选已变化，请从第一页重新查询。');
      snapshot = this.#snapshot(cursor.id, options); offset = cursor.offset;
    } else snapshot = await this.#capture(options);
    const visible = [];
    let processed = 0;
    for (const row of snapshot.rows) {
      options.signal?.throwIfAborted();
      if (++processed % 128 === 0) { await yieldImmediate(); options.signal?.throwIfAborted(); }
      if (matches(row, filters) && await this.#allowed(row.sessionId, options)) visible.push(row);
    }
    options.signal?.throwIfAborted();
    const next = offset + limit;
    return { snapshotId: snapshot.id, items: structuredClone(visible.slice(offset, next)), total: visible.length,
      nextCursor: next < visible.length ? Buffer.from(JSON.stringify({ id: snapshot.id, offset: next, filter: filterHash })).toString('base64url') : null,
      generatedAt: snapshot.generatedAt, coverage: structuredClone(snapshot.coverage) };
  }

  async select(ids, { includeChildren = false, snapshotId, ...options } = {}) {
    options = optionsOf(options);
    if (!Array.isArray(ids) || !ids.length || ids.length > this.maxEntries || typeof includeChildren !== 'boolean') throw invalid('请选择有效的会话集合。');
    const selected = [...new Set(ids.map(catalogId))];
    await this.assertVisible(selected, options);
    const snapshot = snapshotId ? this.#snapshot(snapshotId, options) : await this.#capture(options);
    const rows = new Map(snapshot.rows.map(row => [row.sessionId, row]));
    for (const id of selected) if (!rows.has(id)) throw new CatalogError(snapshot.coverage.limited ? 'CACHE_HELPER_CATALOG_LIMIT' : 'CACHE_HELPER_SESSION_NOT_FOUND',
      snapshot.coverage.limited ? '所选会话不在有界目录快照中，请缩小目录范围。' : '所选会话已不在可见目录中。', snapshot.coverage.limited ? 413 : 404);
    const expanded = new Set(selected);
    if (includeChildren) {
      // ParentSession is fork lineage for main Sessions; only native sub rows
      // enter this expansion. Missing parents do not prevent direct selection.
      const descendants = new Map();
      for (const row of snapshot.rows) if (row.role === 'sub' && row.directParentId) {
        const list = descendants.get(row.directParentId) ?? []; list.push(row.sessionId); descendants.set(row.directParentId, list);
      }
      const queue = [...selected];
      let inspected = 0;
      for (let index = 0; index < queue.length; index++) {
        options.signal?.throwIfAborted();
        if (index % 128 === 0) { await yieldImmediate(); options.signal?.throwIfAborted(); }
        for (const id of descendants.get(queue[index]) ?? []) {
          if (++inspected % 128 === 0) { await yieldImmediate(); options.signal?.throwIfAborted(); }
          if (expanded.has(id) || !await this.#allowed(id, options)) continue;
          expanded.add(id); queue.push(id);
        }
      }
    }
    const selectedIds = [...expanded];
    await this.assertVisible(selectedIds, options);
    return { snapshotId: snapshot.id, selectedIds, items: structuredClone(selectedIds.map(id => rows.get(id))),
      coverage: structuredClone(snapshot.coverage) };
  }

  dispose() { this.#snapshots.clear(); }
}
