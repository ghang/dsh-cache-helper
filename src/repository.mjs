import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { analyzeSession } from './analysis.mjs';

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
    if (event.type === 'assistant/message' || (event.type === 'assistant/attempt'
      && (event.data?.usage !== undefined || event.data?.stream?.length > 0))) return event.seq;
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

  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.statePath = config.statePath ?? join(resolveDshHome(), 'storages', 'cache-helper', 'web-state.json');
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

  async records(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    if (live) {
      if (live.snapshotEvents().length > this.config.maxEvents) throw Object.assign(new Error('会话事件数超过本地分析上限。'), { status: 413 });
      return liveRecords(live);
    }
    const persistence = this.ctx.get?.('sessionPersistence');
    if (!persistence) throw Object.assign(new Error('会话不在内存中，宿主也未提供持久化读取接口。'), { status: 404 });
    const handle = await persistence.open(sessionId, 'read');
    try {
      const { events } = await handle.read(0, this.config.maxEvents + 1);
      if (events.length > this.config.maxEvents) throw Object.assign(new Error('会话事件数超过本地分析上限。'), { status: 413 });
      return [{ type: 'session', ...handle.header, inheritedEventCount: handle.inheritedEventCount }, ...events];
    } finally {
      await handle.close();
    }
  }

  async session(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    const persistence = this.ctx.get?.('sessionPersistence');
    // Tool output / title / request assembly alone cannot change settled usage.
    // Avoid re-analyzing a long history on every poll while a call is in flight.
    const revision = live
      ? `live:${latestStatisticsSeq(live.snapshotEvents())}:${live.surface.contentGeneration}`
      : (await persistence?.stat(sessionId))?.revision;
    let cached = this.#cache.get(sessionId);
    if (!cached || revision === undefined || cached.revision !== revision) {
      const records = await this.records(sessionId);
      const metrics = await analyzeSession(records, {
        ...this.config, messageProjections: this.ctx.sessions.messageProjections ?? [],
      });
      cached = { revision, value: {
        ...metrics, sessionId, title: titleOf(records), cwd: records[0].cwd,
        config: { minLostTokens: this.config.minLostTokens, minLossRatio: this.config.minLossRatio },
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

  async dashboard() {
    if (this.#dashboard && Date.now() - this.#dashboardAt < 10000) return this.#dashboard;
    const promise = this.#scanDashboard();
    this.#dashboard = promise;
    this.#dashboardAt = Date.now();
    try { return await promise; }
    catch (error) { this.#dashboard = undefined; throw error; }
  }

  async #scanDashboard() {
    const rows = new Map(this.ctx.sessions.list().map(session => [session.id, session.header]));
    const errors = [];
    try {
      const snapshots = await this.ctx.get?.('sessionPersistence')?.list();
      for (const snapshot of snapshots ?? []) rows.set(snapshot.header.id, snapshot.header);
    } catch { errors.push({ stage: 'list', message: '部分持久化会话无法枚举。' }); }
    const selected = [...rows.values()]
      .filter(header => header.origin !== 'subagent' && !(header.delegationDepth > 0))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, this.config.dashboardLimit);
    const sessions = [];
    // Bounded serial scan avoids retaining several large histories at once.
    for (const header of selected) {
      try {
        const data = await this.session(header.id);
        sessions.push({
          sessionId: data.sessionId, title: data.title, cwd: data.cwd,
          latest: data.latest, cumulative: data.cumulative,
          warningCount: data.warnings.length, lastWarningAt: data.warnings.at(-1)?.at ?? null,
        });
      } catch { errors.push({ sessionId: header.id, message: '此会话无法完整重建，未计入统计。' }); }
    }
    return { sessions, generatedAt: Date.now(), coverage: {
      scanned: selected.length, included: sessions.length, total: rows.size,
      limit: this.config.dashboardLimit, errors,
    } };
  }

  async dispose() { await this.#write.catch(() => {}); this.#cache.clear(); }
}
