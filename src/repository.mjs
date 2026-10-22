import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { analyzeSession } from './analysis.mjs';
import { aggregateStatistics } from './statistics.mjs';

export function liveRecords(session) {
  return [{ type: 'session', ...session.header, inheritedEventCount: session.inheritedEventCount ?? 0 }, ...session.snapshotEvents()];
}

export function requestRevision(records) {
  for (let index = records.length - 1; index > 0; index--) {
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

function latestStatisticsSeq(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt'
      || event.type.startsWith('compaction/')) return event.seq;
  }
  return -1;
}

/** Read through the host backend; cache only derived metrics, never another request body. */
export class SessionRepository {
  #cache = new Map();
  #dismissed = new Set();
  #write = Promise.resolve();
  #dashboard;
  #dashboardAt = 0;
  policyVersion = 1;

  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.statePath = config.statePath ?? join(resolveDshHome(), 'storages', 'cache-helper', 'web-state.json');
  }

  updatePolicy(config, version) {
    if (this.policyVersion === version) return;
    this.config = config;
    this.policyVersion = version;
    this.#cache.clear();
    this.#dashboard = undefined;
  }

  async init() {
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

  async records(sessionId, config = this.config) {
    const live = this.ctx.sessions.get(sessionId);
    if (live) {
      if (live.snapshotEvents().length > config.maxEvents) throw Object.assign(new Error('会话事件数超过本地分析上限。'), { status: 413 });
      return liveRecords(live);
    }
    const persistence = this.ctx.get?.('sessionPersistence');
    if (!persistence) throw Object.assign(new Error('会话不在内存中，宿主也未提供持久化读取接口。'), { status: 404 });
    const handle = await persistence.open(sessionId, 'read');
    try {
      const { events } = await handle.read(0, config.maxEvents + 1);
      if (events.length > config.maxEvents) throw Object.assign(new Error('会话事件数超过本地分析上限。'), { status: 413 });
      return [{ type: 'session', ...handle.header, inheritedEventCount: handle.inheritedEventCount }, ...events];
    } finally {
      await handle.close();
    }
  }

  async session(sessionId) {
    const config = this.config;
    const policyVersion = this.policyVersion;
    const live = this.ctx.sessions.get(sessionId);
    const persistence = this.ctx.get?.('sessionPersistence');
    // Include auxiliary lifecycle and empty-attempt coverage even when the
    // latest main-model receipt and visible conversation are unchanged.
    const revision = live
      ? `live:${latestStatisticsSeq(live.snapshotEvents())}:${live.surface.contentGeneration}`
      : (await persistence?.stat(sessionId))?.revision;
    let cached = this.#cache.get(sessionId);
    if (!cached || revision === undefined || cached.revision !== revision || cached.policyVersion !== policyVersion) {
      const records = await this.records(sessionId, config);
      const metrics = await analyzeSession(records, {
        ...config, messageProjections: this.ctx.sessions.messageProjections ?? [],
      });
      if (policyVersion !== this.policyVersion) return this.session(sessionId);
      cached = { revision, policyVersion, value: {
        ...metrics, sessionId, title: titleOf(records), cwd: records[0].cwd,
        policyVersion,
        config: { minLostTokens: config.minLostTokens, minLossRatio: config.minLossRatio },
      } };
      this.#cache.delete(sessionId);
      this.#cache.set(sessionId, cached);
      while (this.#cache.size > this.config.maxCachedSessions) this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.delete(sessionId);
    this.#cache.set(sessionId, cached);
    return {
      ...cached.value,
      ...(live ? { title: titleOf(liveRecords(live)) } : {}),
      warnings: (cached.value.warnings ?? []).map(warning => ({
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

  async dashboard(query = {}) {
    const filters = { period: query.period ?? '7d', model: query.model, provider: query.provider };
    if (!['7d', '30d', 'all'].includes(filters.period)
      || [filters.model, filters.provider].some(value => value !== undefined && (typeof value !== 'string' || value.length > 200))) {
      throw Object.assign(new Error('无效的统计筛选条件。'), { status: 400 });
    }
    const operationRevision = (this.operations?.() ?? []).map(item => [item.id, item.state, item.updatedAt, item.summaryCalls?.length]);
    const key = JSON.stringify({ ...filters, version: this.policyVersion, operationRevision });
    if (this.#dashboard?.key === key && Date.now() - this.#dashboardAt < 10000) return this.#dashboard.promise;
    const promise = this.#scanDashboard(filters);
    this.#dashboard = { key, promise };
    this.#dashboardAt = Date.now();
    try { return await promise; }
    catch (error) { if (this.#dashboard?.promise === promise) this.#dashboard = undefined; throw error; }
  }

  async #scanDashboard(filters) {
    const config = this.config;
    const policyVersion = this.policyVersion;
    const liveSessions = new Map(this.ctx.sessions.list().map(session => [session.id, session]));
    const rows = new Map([...liveSessions.values()].map(session => [session.id, session.header]));
    const errors = [];
    try {
      const snapshots = await this.ctx.get?.('sessionPersistence')?.list();
      for (const snapshot of snapshots ?? []) rows.set(snapshot.header.id, snapshot.header);
    } catch { errors.push({ stage: 'list', message: '部分持久化会话无法枚举。' }); }
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
      try {
        const data = await this.session(header.id);
        details.push(data);
        sessions.push({
          sessionId: data.sessionId, title: data.title, cwd: data.cwd,
          latest: data.latest, cumulative: data.cumulative,
          warningCount: data.warnings.length, lastWarningAt: data.warnings.at(-1)?.at ?? null,
          role: data.role, activityAt,
        });
      } catch (error) { errors.push({ sessionId: header.id,
        code: error.status === 413 ? 'event-limit' : 'read-failed',
        message: error.status === 413 ? '此会话事件数超过分析上限，未计入统计。' : '此会话无法完整重建，未计入统计。' }); }
    }
    if (policyVersion !== this.policyVersion) return this.#scanDashboard(filters);
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

  async dispose() { await this.#write.catch(() => {}); this.#cache.clear(); }
}
