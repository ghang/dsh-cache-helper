import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, rename, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

export const FACT_CACHE_SCHEMA = 1;
export const ADAPTER_VERSION = 'deepseek-messages-text-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const finite = value => Number.isSafeInteger(value) && value >= 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, allowed) => value && typeof value === 'object'
  && Object.keys(value).every(key => allowed.includes(key));
const fileOf = id => digest(id) + '.facts.json';
const headerOf = records => records[0]?.type === 'session' ? records[0] : undefined;
export function lifecycleHash(header) {
  if (!header) return null;
  const fields = Object.keys(header).filter(key => !['type', 'inheritedEventCount'].includes(key)).sort();
  return digest(JSON.stringify(Object.fromEntries(fields.map(key => [key, header[key]]))));
}

/** A whole-log witness is computed event by event, never one giant log string. */
export async function sourceProof(records, { prefixCount, signal, sliceEvents = 128, scheduler = yieldImmediate } = {}) {
  const header = headerOf(records);
  const offset = header ? 1 : 0;
  const eventCount = records.length - offset;
  const inheritedEventCount = header?.inheritedEventCount ?? (header?.isSeeded ? null : 0);
  const lifecycle = { headerHash: lifecycleHash(header), inheritedEventCount };
  const hash = createHash('sha256').update(JSON.stringify(lifecycle));
  let prefixSha256 = prefixCount === 0 ? hash.copy().digest('hex') : null;
  for (let index = 0; index < eventCount; index++) {
    signal?.throwIfAborted();
    hash.update('\0').update(JSON.stringify(records[index + offset]));
    if (index + 1 === prefixCount) prefixSha256 = hash.copy().digest('hex');
    if ((index + 1) % sliceEvents === 0) { await scheduler(); signal?.throwIfAborted(); }
  }
  signal?.throwIfAborted();
  return { lifecycle, source: { eventCount, lastSeq: eventCount ? records.at(-1)?.seq ?? null : null,
    prefixSha256: hash.digest('hex') }, candidatePrefixSha256: prefixSha256 };
}

/** Host projections have no standard semantic version: absence must miss. */
export function stableDependencySignature(config = {}) {
  const projections = config.messageProjections ?? config.projections ?? [];
  if (projections.length) return null;
  const encode = (value, depth = 0) => {
    if (depth > 12) throw new Error('dependency-depth');
    if (value === undefined) return ['undefined'];
    if (value === null || ['string', 'boolean'].includes(typeof value)) return [typeof value, value];
    if (typeof value === 'number' && Number.isFinite(value)) return ['number', value];
    if (Array.isArray(value)) return ['array', value.map(item => encode(item, depth + 1))];
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return ['object', Object.keys(value).sort().map(key => {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error('dependency-getter');
        return [key, encode(value[key], depth + 1)];
      })];
    }
    throw new Error('dependency-not-stable');
  };
  try { return digest(JSON.stringify([ADAPTER_VERSION, encode(config.historicalCapabilities)])); }
  catch { return null; }
}

// Fail closed on malformed caches and prohibit all raw-context vocabulary.
function safeTree(value, key = '', depth = 0) {
  if (depth > 32 || /^(?:request|messages|system|tools|toolHistory|stream|replayState|content|text|body|prompt|response|cwd|title)$/.test(key)) return false;
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 200_000 && value.every(item => safeTree(item, '', depth + 1));
  if (value && typeof value === 'object') return Object.keys(value).length <= 64
    && Object.entries(value).every(([name, item]) => safeTree(item, name, depth + 1));
  return false;
}
export function validEnvelope(value) {
  try { return value?.schema === FACT_CACHE_SCHEMA && typeof value.sessionId === 'string' && value.sessionId.length <= 200
    && keys(value, ['schema', 'sessionId', 'analyzerVersion', 'adapterVersion', 'lifecycle', 'source', 'dependencySignature', 'generatedAt', 'facts', 'factsSha256'])
    && keys(value.lifecycle, ['headerHash', 'inheritedEventCount']) && keys(value.source, ['eventCount', 'lastSeq', 'prefixSha256'])
    && typeof value.analyzerVersion === 'string' && value.adapterVersion === ADAPTER_VERSION
    && hex(value.lifecycle?.headerHash) && (value.lifecycle.inheritedEventCount === null || finite(value.lifecycle.inheritedEventCount))
    && finite(value.source?.eventCount) && value.source.lastSeq === (value.source.eventCount ? value.source.eventCount - 1 : null)
    && hex(value.source.prefixSha256) && (value.dependencySignature === null || hex(value.dependencySignature))
    && finite(value.generatedAt) && hex(value.factsSha256) && value.factsSha256 === digest(JSON.stringify(value.facts))
    && value.facts?.schema === 2 && value.facts?.sessionId === value.sessionId
    && value.facts?.analyzerVersion === value.analyzerVersion && Array.isArray(value.facts?.calls)
    && value.facts?.accounting && validFacts(value.facts, value.source.eventCount) && safeTree(value); }
  catch { return false; }
}

function validFacts(facts, eventCount) {
  const scalar = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const text = value => typeof value === 'string' && value.length <= 4096;
  const nullable = (value, check) => value === null || check(value);
  const optional = (value, check) => value === undefined || check(value);
  const bool = value => typeof value === 'boolean';
  const position = value => value && finite(value.seq) && value.seq < eventCount
    && optional(value.at, scalar) && optional(value.turn, finite) && optional(value.step, finite)
    && nullable(value.inherited, bool);
  const usage = value => value && typeof value.reported === 'boolean'
    && keys(value, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'promptTokens', 'hitRate', 'reported', 'turn', 'step', 'seq'])
    && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'promptTokens', 'hitRate']
      .every(key => value[key] === null || typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
  const baseline = value => value && ['own', 'inherited', 'none', 'unknown'].includes(value.kind)
    && keys(value, ['kind', 'seq', 'receiptSessionId', 'inheritedEventCount', 'ownershipKnown'])
    && (value.seq === null || finite(value.seq) && value.seq < eventCount)
    && nullable(value.receiptSessionId, text) && nullable(value.inheritedEventCount, finite)
    && bool(value.ownershipKnown);
  const accounting = facts.accounting;
  if (!keys(facts, ['schema', 'analyzerVersion', 'sessionId', 'accounting', 'calls', 'baseline'])
    || !keys(accounting, ['role', 'ownership', 'identity', 'auxiliaryCalls', 'auxiliaryCoverage', 'emptyAttempts', 'compactionSeqs'])
    || !keys(accounting.ownership, ['known', 'inheritedEventCount'])
    || !keys(accounting.auxiliaryCoverage, ['complete', 'unrecorded', 'reason'])
    || !['main', 'sub'].includes(accounting.role) || typeof accounting.ownership?.known !== 'boolean'
    || !Array.isArray(accounting.auxiliaryCalls) || !Array.isArray(accounting.emptyAttempts)
    || !Array.isArray(accounting.compactionSeqs) || !Array.isArray(accounting.auxiliaryCoverage?.unrecorded)
    || !baseline(facts.baseline) || !nullable(accounting.ownership.inheritedEventCount, finite)
    || accounting.ownership.known !== (accounting.ownership.inheritedEventCount !== null)
    || accounting.ownership.inheritedEventCount > eventCount || typeof accounting.auxiliaryCoverage.reason !== 'string'
    || !bool(accounting.auxiliaryCoverage.complete)) return false;
  const identity = accounting.identity;
  if (!identity || identity.role !== accounting.role || identity.targetSessionId !== facts.sessionId || !bool(identity.relationshipKnown)
    || !keys(identity, ['targetSessionId', 'role', 'directParentId', 'rootSessionId', 'depth', 'activationGeneration', 'forkParentId', 'relationshipKnown', 'unknownReasons'])
    || !['targetSessionId', 'directParentId', 'rootSessionId', 'forkParentId'].every(key => nullable(identity[key], text))
    || !nullable(identity.depth, finite) || !nullable(identity.activationGeneration, value => text(value) || finite(value))
    || !Array.isArray(identity.unknownReasons) || identity.unknownReasons.some(value => !text(value))) return false;
  for (const call of accounting.auxiliaryCalls) {
    if (!keys(call, ['seq', 'at', 'atSource', 'inherited', 'compactionId', 'purpose', 'provider', 'model', 'settlement', 'role', 'usage',
      'operationElapsedMs', 'durationSource', 'modelDurationMs', 'outcome', 'operationOutcome', 'recording'])
      || !position(call) || !usage(call.usage) || call.role !== 'auxiliary'
      || call.purpose !== 'compaction' || call.settlement !== 'compaction/summary'
      || !nullable(call.provider, text) || !nullable(call.model, text) || !nullable(call.compactionId, text)
      || !nullable(call.operationElapsedMs, scalar) || !nullable(call.modelDurationMs, scalar)
      || !nullable(call.durationSource, text) || !text(call.atSource)
      || !['completed'].includes(call.outcome) || !['completed', 'partial', 'pending'].includes(call.operationOutcome)
      || !['local-stream', 'reported-usage'].includes(call.recording)) return false;
  }
  for (const item of accounting.auxiliaryCoverage.unrecorded) {
    if (!keys(item, ['seq', 'at', 'atSource', 'inherited', 'compactionId', 'purpose', 'provider', 'model', 'reason'])
      || !position(item) || item.purpose !== 'compaction' || !nullable(item.compactionId, text)
      || !optional(item.provider, value => nullable(value, text)) || !optional(item.model, value => nullable(value, text))
      || !optional(item.atSource, text)
      || !['summary-without-call-receipt', 'compaction-without-summary-receipt', 'compaction-in-progress'].includes(item.reason)) return false;
  }
  if (accounting.emptyAttempts.some(item => !keys(item, ['seq', 'at', 'turn', 'step', 'inherited', 'dispatch']) || !position(item) || item.dispatch !== 'unknown')
    || accounting.compactionSeqs.some(seq => !finite(seq) || seq >= eventCount)) return false;
  let previous = -1;
  for (const call of facts.calls) {
    if (!keys(call, ['turn', 'step', 'seq', 'at', 'provider', 'model', 'inherited', 'settlement', 'usage', 'inputProof', 'baseline',
      'previousPromptTokens', 'comparison', 'comparisonUnknown', 'expectedRebuild', 'unknown'])
      || !position(call) || call.seq <= previous || !usage(call.usage)
      || !nullable(call.provider, text) || !nullable(call.model, text)
      || !['assistant/message', 'assistant/attempt'].includes(call.settlement) || !baseline(call.baseline)
      || typeof call.comparisonUnknown !== 'boolean' || typeof call.expectedRebuild !== 'boolean'
      || !(call.previousPromptTokens === null || finite(call.previousPromptTokens))
      || call.comparison !== null && (!call.comparison || !Array.isArray(call.comparison.changes))) return false;
    previous = call.seq;
    if (call.comparison) {
      const comparison = call.comparison;
      if (!keys(comparison, ['unknown', 'estimated', 'message', 'lossTokens', 'lossRatio', 'previousPromptTokens', 'commonPrefixChars',
        'previousChars', 'changes', 'previousFingerprint', 'fingerprint'])
        || !bool(comparison.unknown) || comparison.estimated !== true
        || !nullable(comparison.lossTokens, scalar) || !nullable(comparison.lossRatio, scalar)
        || !nullable(comparison.previousPromptTokens, scalar)
        || !optional(comparison.previousChars, scalar) || !optional(comparison.commonPrefixChars, scalar)
        || !optional(comparison.previousFingerprint, hex) || !optional(comparison.fingerprint, hex)
        || !optional(comparison.message, text)) return false;
      for (const change of comparison.changes) {
        if (!keys(change, ['kind', 'message', 'preservesPrefix', 'added', 'removed', 'changed', 'reordered', 'addedOmitted', 'removedOmitted', 'changedOmitted'])
          || !['route', 'tools', 'system', 'history', 'unknown'].includes(change.kind) || !text(change.message)
          || !optional(change.preservesPrefix, bool)) return false;
        if (change.kind !== 'tools' && !keys(change, ['kind', 'message', 'preservesPrefix'])) return false;
        if (change.kind === 'tools' && (!bool(change.reordered)
          || ['added', 'removed', 'changed'].some(key => !Array.isArray(change[key]) || change[key].length > 128
            || change[key].some(name => !text(name) || name.length > 256) || !optional(change[key + 'Omitted'], finite)))) return false;
      }
    }
    const proof = call.inputProof;
    if (!proof || typeof proof.comparable !== 'boolean'
      || !keys(proof, ['comparable', 'unknown', 'provider', 'model', 'chars', 'textHash', 'historyChars', 'historyHash', 'systemHash', 'fingerprint', 'toolHashes'])
      || !nullable(proof.provider, text) || !nullable(proof.model, text)
      || !optional(proof.unknown, text)) return false;
    if (!proof.comparable && !keys(proof, ['comparable', 'unknown', 'provider', 'model'])) return false;
    if (proof.comparable && (!finite(proof.chars) || !finite(proof.historyChars)
      || ![proof.textHash, proof.historyHash, proof.systemHash, proof.fingerprint].every(hex)
      || proof.toolHashes !== null && (!Array.isArray(proof.toolHashes) || proof.toolHashes.length > 128
        || proof.toolHashes.some(tool => !keys(tool, ['name', 'hash']) || typeof tool.name !== 'string' || tool.name.length > 256 || !hex(tool.hash))))) return false;
  }
  return true;
}

/** Disposable plugin data only; all filenames are hashes in one owned directory. */
export class FactCache {
  #index = new Map();
  #write = Promise.resolve();
  #ready = false;
  #initializing;
  #fault = null;
  constructor({ directory, maxEntryBytes = 4 * 1024 * 1024, maxBytes = 32 * 1024 * 1024,
    maxEntries = 128, idleMs = 14 * 86400_000, now = Date.now } = {}) {
    if (!directory) throw new TypeError('Fact cache requires its own directory');
    if (![maxEntryBytes, maxBytes, maxEntries, idleMs].every(value => Number.isSafeInteger(value) && value >= 1))
      throw new TypeError('Fact cache budgets must be positive safe integers');
    this.directory = resolve(directory);
    this.budget = { maxEntryBytes, maxBytes, maxEntries, idleMs };
    this.now = now;
  }

  async #directory() {
    try { const info = await lstat(this.directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('cache-directory-unsafe'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
    await chmod(this.directory, 0o700);
  }
  async #read(file) {
    const handle = await open(join(this.directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.budget.maxEntryBytes || (stat.mode & 0o077) !== 0) throw new Error('cache-entry-limit-or-permissions');
      return { value: JSON.parse(await handle.readFile('utf8')), stat };
    } finally { await handle.close(); }
  }
  async init() {
    if (this.#ready) return this.summary();
    this.#initializing ??= this.#initialize();
    return this.#initializing;
  }
  async #initialize() {
    try {
      await this.#directory();
      const inventory = await readdir(this.directory);
      for (const file of inventory.filter(file => /^[a-f0-9]{64}\.facts\.json\.[a-f0-9-]+\.tmp$/.test(file)))
        await rm(join(this.directory, file), { force: true });
      const files = inventory.filter(file => /^[a-f0-9]{64}\.facts\.json$/.test(file));
      const candidates = [];
      for (const file of files) {
        const stat = await lstat(join(this.directory, file));
        if (stat.isFile() && !stat.isSymbolicLink()) candidates.push({ file, stat });
      }
      // Cache enumeration is bounded; unknown files are never read or cleaned.
      let readBytes = 0;
      for (const { file, stat: metadata } of candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
        if (metadata.size > this.budget.maxEntryBytes || readBytes + metadata.size > this.budget.maxBytes
          || this.#index.size >= this.budget.maxEntries || this.now() - metadata.mtimeMs > this.budget.idleMs) {
          await rm(join(this.directory, file), { force: true }); continue;
        }
        try {
          readBytes += metadata.size;
          const { value, stat } = await this.#read(file);
          if (!validEnvelope(value) || file !== fileOf(value.sessionId)) { await rm(join(this.directory, file), { force: true }); continue; }
          this.#index.set(value.sessionId, { sessionId: value.sessionId, bytes: stat.size, touchedAt: stat.mtimeMs,
            generatedAt: value.generatedAt, lifecycle: value.lifecycle, source: value.source });
        } catch { await rm(join(this.directory, file), { force: true }).catch(() => {}); }
      }
      await this.#evict();
      this.#fault = null;
      this.#ready = true;
    } catch { this.#fault = 'cache-unavailable'; this.#ready = true; }
    return this.summary();
  }
  status(sessionId, header) {
    const row = this.#index.get(sessionId);
    if (!row) return { state: 'none', reason: this.#fault ?? 'not-cached' };
    if (this.now() - row.touchedAt > this.budget.idleMs) return { state: 'stale', reason: 'cache-expired',
      eventCount: row.source.eventCount, lastSeq: row.source.lastSeq, generatedAt: row.generatedAt, bytes: row.bytes };
    const same = !header || lifecycleHash(header) === row.lifecycle.headerHash;
    return { state: same ? 'cached' : 'stale', reason: same ? 'source-not-validated' : 'lifecycle-changed',
      generatedAt: row.generatedAt, eventCount: row.source.eventCount, lastSeq: row.source.lastSeq, bytes: row.bytes };
  }
  summary() { return { ready: this.#ready, entries: this.#index.size,
    bytes: [...this.#index.values()].reduce((sum, row) => sum + row.bytes, 0), budget: { ...this.budget }, error: this.#fault }; }
  async #removeObserved(sessionId, observed) {
    const work = this.#write.catch(() => {}).then(async () => {
      // A read can finish after clear + a newer atomic put. It owns only the
      // index row it observed, never the replacement at the same filename.
      if (this.#index.get(sessionId) !== observed) return;
      await this.#directory();
      await rm(join(this.directory, fileOf(sessionId)), { force: true });
      this.#index.delete(sessionId);
    });
    this.#write = work;
    await work.catch(() => {});
  }
  async get(sessionId) {
    if (!this.#ready) await this.init();
    const observed = this.#index.get(sessionId);
    if (!observed) return { reason: this.#fault ?? 'not-cached' };
    let directorySafe = false;
    try {
      await this.#directory();
      directorySafe = true;
      if (this.now() - observed.touchedAt > this.budget.idleMs) {
        await this.#removeObserved(sessionId, observed);
        return { reason: 'cache-expired' };
      }
      const { value, stat } = await this.#read(fileOf(sessionId));
      if (!validEnvelope(value) || value.sessionId !== sessionId) throw new Error('cache-schema');
      if (this.#index.get(sessionId) === observed) { observed.touchedAt = this.now(); observed.bytes = stat.size; }
      return { envelope: value, reason: 'unvalidated' };
    } catch {
      if (directorySafe) await this.#removeObserved(sessionId, observed);
      else if (this.#index.get(sessionId) === observed) this.#index.delete(sessionId);
      return { reason: 'corrupt-cache' };
    }
  }
  async #evict() {
    const rows = [...this.#index.values()].sort((a, b) => a.touchedAt - b.touchedAt);
    let bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    let count = rows.length;
    for (const row of rows) {
      if (this.now() - row.touchedAt <= this.budget.idleMs && bytes <= this.budget.maxBytes && count <= this.budget.maxEntries) continue;
      await rm(join(this.directory, fileOf(row.sessionId)), { force: true });
      this.#index.delete(row.sessionId); bytes -= row.bytes; count--;
    }
  }
  async put(envelope) {
    if (!validEnvelope(envelope)) return { stored: false, reason: 'invalid-facts' };
    const data = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(data);
    if (bytes > this.budget.maxEntryBytes || bytes > this.budget.maxBytes) return { stored: false, reason: 'cache-entry-limit' };
    const operation = this.#write.catch(() => {}).then(async () => {
      let temp;
      try {
        await this.#directory();
        temp = join(this.directory, fileOf(envelope.sessionId) + '.' + randomUUID() + '.tmp');
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
        await rename(temp, join(this.directory, fileOf(envelope.sessionId)));
        this.#index.set(envelope.sessionId, { sessionId: envelope.sessionId, bytes, touchedAt: this.now(),
          generatedAt: envelope.generatedAt, lifecycle: envelope.lifecycle, source: envelope.source });
        await this.#evict();
        this.#fault = null;
        return { stored: this.#index.has(envelope.sessionId), reason: 'stored' };
      } catch { if (temp) await rm(temp, { force: true }).catch(() => {}); this.#fault = 'cache-write-failed'; return { stored: false, reason: 'cache-write-failed' }; }
    });
    this.#write = operation;
    return operation;
  }
  async clear(sessionId) {
    const operation = this.#write.catch(() => {}).then(async () => {
      await this.#directory();
      const names = sessionId === undefined
        ? (await readdir(this.directory)).filter(file => /^[a-f0-9]{64}\.facts\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(file))
        : [fileOf(sessionId)];
      for (const file of names) await rm(join(this.directory, file), { force: true });
      if (sessionId === undefined) this.#index.clear(); else this.#index.delete(sessionId);
      return { cleared: names.length, ...this.summary() };
    });
    this.#write = operation;
    return operation;
  }
  async dispose() { await this.#write.catch(() => {}); }
}
