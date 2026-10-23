const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'promptTokens'];
const finite = value => Number.isFinite(value) && value >= 0;
const timestamp = value => finite(value) && Number.isFinite(new Date(value + SHANGHAI_OFFSET).getTime());
const evidenceOf = (sessionId, call) => ({ sessionId, seq: call.seq,
  ...(call.turn === undefined ? {} : { turn: call.turn }), ...(call.step === undefined ? {} : { step: call.step }) });

/** Calendar dates are assigned to the actual call time in Asia/Shanghai. */
export function statisticsDate(at) {
  return timestamp(at) ? new Date(at + SHANGHAI_OFFSET).toISOString().slice(0, 10) : null;
}

function badFilter(message) { throw Object.assign(new Error(message), { status: 400 }); }
function dateStart(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) badFilter('日期必须为 YYYY-MM-DD。');
  const value = Date.parse(`${date}T00:00:00.000Z`) - SHANGHAI_OFFSET;
  if (!Number.isFinite(value) || new Date(value + SHANGHAI_OFFSET).toISOString().slice(0, 10) !== date) badFilter('日期无效。');
  return value;
}

export function statisticsFilters(options = {}) {
  const period = options.period ?? '7d';
  if (!['7d', '30d', 'all'].includes(period)) badFilter('统计范围只支持 7d、30d 或 all。');
  const now = options.now ?? Date.now();
  if (!timestamp(now)) badFilter('统计截止时间无效。');
  const today = Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
  let from = period === 'all' ? null : today - ((period === '7d' ? 7 : 30) - 1) * DAY;
  let to = now;
  if (options.fromDate !== undefined) from = Math.max(from ?? -Infinity, dateStart(options.fromDate));
  if (options.toDate !== undefined) to = Math.min(to, dateStart(options.toDate) + DAY - 1);
  if (from !== null && from > to) badFilter('开始日期不能晚于结束日期。');
  const text = (key) => {
    const value = options[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) badFilter('模型筛选参数无效。');
    return value;
  };
  return { period, from, to, model: text('model'), provider: text('provider'),
    timeZone: 'Asia/Shanghai', includeUnknownDates: period === 'all'
      && options.fromDate === undefined && options.toDate === undefined };
}

function ownership(session, item) {
  if (typeof item.inherited === 'boolean') return item.inherited ? 'inherited' : 'owned';
  if (session.ownership?.known === true && Number.isSafeInteger(session.ownership.inheritedEventCount)
    && Number.isSafeInteger(item.seq)) {
    return item.seq < session.ownership.inheritedEventCount ? 'inherited' : 'owned';
  }
  return 'unknown';
}
function modelMatches(call, filters) {
  return (!filters.model || call.model === filters.model) && (!filters.provider || call.provider === filters.provider);
}
function dateMatches(call, filters) {
  return timestamp(call.at) ? (filters.from === null || call.at >= filters.from) && call.at <= filters.to : filters.includeUnknownDates;
}

function totals(rows) {
  const value = { calls: rows.length,
    successfulCalls: rows.filter(row => row.call.settlement === 'assistant/message'
      || (row.role === 'auxiliary' && (row.call.outcome === 'completed'
        || row.call.settlement === 'compaction/summary'))).length,
    failedAttempts: rows.filter(row => row.call.settlement === 'assistant/attempt'
      || (row.role === 'auxiliary' && row.call.outcome === 'failed')).length,
    cancelledAuxiliaryCalls: rows.filter(row => row.role === 'auxiliary' && row.call.outcome === 'cancelled').length,
    auxiliaryCalls: rows.filter(row => row.role === 'auxiliary').length,
    coldStarts: rows.filter(row => row.call.category === 'cold-start').length,
    warnings: 0, recoveredWarnings: 0, unrecoveredWarnings: 0, recoveryUnknownWarnings: 0,
    estimatedLossTokens: 0, expectedRebuilds: 0, expectedRebuildLossTokens: 0,
    cacheKnownCalls: 0, missingUsageCalls: 0, emptyAttempts: 0, unrecordedAuxiliaryOperations: 0 };
  for (const field of FIELDS) {
    const complete = rows.every(row => finite(row.call.usage?.[field]));
    const sum = rows.reduce((amount, row) => amount + (finite(row.call.usage?.[field]) ? row.call.usage[field] : 0), 0);
    value[field] = complete ? sum : null;
    value[`known${field[0].toUpperCase()}${field.slice(1)}`] = sum;
  }
  const known = rows.filter(row => finite(row.call.usage?.promptTokens)
    && finite(row.call.usage?.cacheReadTokens));
  value.cacheKnownCalls = known.length;
  value.cacheUnknownCalls = rows.length - known.length;
  value.missingUsageCalls = rows.filter(row => !row.call.usage?.reported).length;
  const prompt = known.reduce((amount, row) => amount + row.call.usage.promptTokens, 0);
  const read = known.reduce((amount, row) => amount + row.call.usage.cacheReadTokens, 0);
  value.knownHitRate = prompt > 0 ? read / prompt : null;
  value.hitRate = known.length === rows.length ? value.knownHitRate : null;
  for (const row of rows) {
    const warning = row.warning;
    if (!warning) continue;
    if (warning.category === 'expected-rebuild') {
      value.expectedRebuilds++;
      value.expectedRebuildLossTokens += finite(warning.lossTokens) ? warning.lossTokens : 0;
      continue;
    }
    value.warnings++;
    value.estimatedLossTokens += finite(warning.lossTokens) ? warning.lossTokens : 0;
    if (row.recovery === 'recovered') value.recoveredWarnings++;
    else if (row.recovery === 'unknown') value.recoveryUnknownWarnings++;
    else value.unrecoveredWarnings++;
  }
  return value;
}

const SUGGESTIONS = {
  tools: ['检查工具声明变化', '对照异常步骤的工具增删、顺序和定义；将必要插件变更集中在任务间隙。'],
  system: ['检查 system 前缀变化', '核对提示词或插件配置变更，保留当前真实能力与权限。'],
  history: ['检查历史替换', '核对历史替换与压缩记录；压缩后的预期重建需与意外失效分别观察。'],
  route: ['核对模型路由', '提供方或模型变化会改变缓存域，先核对实际路由。'],
  'upstream-unknown': ['观察后续实际回执', '未观察到本地前缀变化；服务端过期或淘汰无法由客户端确定。'],
  'comparison-unknown': ['核对输入覆盖', '请求投影不完整，先检查附件、适配器与历史记录，避免把未知解释成正常。'],
};

/**
 * Aggregate derived DTOs only. Session history remains authoritative and is not
 * copied into a second ledger. Global billing includes only child-owned events.
 */
export function aggregateStatistics(sessions, options = {}) {
  const filters = statisticsFilters(options);
  const coverage = { ...options.coverage, analyzedSessions: sessions.length,
    inheritedCallsExcluded: 0, ownershipUnknownCalls: 0, duplicateCallsExcluded: 0,
    unknownDateCalls: 0, unknownModelCalls: 0, dateFilteredOutCalls: 0, modelFilteredOutCalls: 0,
    auxiliaryRecordingComplete: false, emptyAttemptDispatchKnown: false,
    operationReceiptCalls: 0, operationReceiptsDuplicateExcluded: 0, operationsOutsideScanExcluded: 0,
    operationSummaryRecordsUnconfirmed: 0,
    pendingAuxiliaryCalls: 0,
    unrecordedAuxiliaryOperations: 0, matchingSessions: 0,
    source: 'bounded-session-scan', onlyOwnedCalls: true };
  const rows = [];
  const seen = new Set();
  const models = new Map();
  const emptyAttempts = [];
  let unrecorded = [];
  const allUnrecorded = [];
  const recordedCompactions = new Set();
  const nonCallSeen = new Set();
  const matching = new Set();
  const scannedIds = new Set(sessions.map(session => session.sessionId));
  const scopedOperations = [];
  const summaryStartTimes = new Map();
  for (const operation of options.operations ?? []) {
    if (!scannedIds.has(operation.sessionId) && !scannedIds.has(operation.branchId)) {
      coverage.operationsOutsideScanExcluded++;
      continue;
    }
    scopedOperations.push(operation);
    if (typeof operation.branchId !== 'string') continue;
    for (const receipt of operation.summaryCalls ?? []) {
      if (receipt.atSource !== 'llm-stream-start' || receipt.llmStreamCall === false
        || !timestamp(receipt.at) || !Number.isSafeInteger(receipt.summarySeq) || receipt.summarySeq < 0) continue;
      summaryStartTimes.set(JSON.stringify([operation.branchId, receipt.summarySeq]), receipt.at);
    }
  }
  for (const session of sessions) {
    const sessionId = session.sessionId;
    const warnings = new Map((session.warnings ?? []).map(warning => [warning.seq, warning]));
    const actual = [
      ...(session.calls ?? []).map(call => ({ call, role: ['main', 'sub'].includes(session.role) ? session.role : 'unknown' })),
      ...(session.auxiliaryCalls ?? []).map(call => ({ call, role: 'auxiliary' })),
    ];
    for (const { call: sourceCall, role } of actual) {
      const start = role === 'auxiliary' ? summaryStartTimes.get(JSON.stringify([sessionId, sourceCall.seq])) : undefined;
      const call = role === 'auxiliary' ? { ...sourceCall,
        at: start ?? sourceCall.at,
        atSource: start === undefined ? sourceCall.atSource ?? 'session-summary-settlement' : 'llm-stream-start',
        settledAt: sourceCall.at, settledAtSource: sourceCall.atSource ?? 'session-summary-settlement' } : sourceCall;
      const owns = ownership(session, call);
      if (owns === 'inherited') { coverage.inheritedCallsExcluded++; continue; }
      if (owns === 'unknown') { coverage.ownershipUnknownCalls++; continue; }
      const key = JSON.stringify([sessionId, call.seq]);
      if (seen.has(key)) { coverage.duplicateCallsExcluded++; continue; }
      seen.add(key);
      if (!timestamp(call.at)) coverage.unknownDateCalls++;
      if (!call.model || !call.provider) coverage.unknownModelCalls++;
      if (!dateMatches(call, filters)) { coverage.dateFilteredOutCalls++; continue; }
      models.set(JSON.stringify([call.provider ?? null, call.model ?? null]), { provider: call.provider ?? null, model: call.model ?? null });
      if (!modelMatches(call, filters)) { coverage.modelFilteredOutCalls++; continue; }
      const warning = warnings.get(call.seq);
      const recovery = !warning?.recovered ? 'unrecovered'
        : !finite(warning.recoveredAt?.at) ? 'unknown'
          : warning.recoveredAt.at <= filters.to ? 'recovered' : 'unrecovered';
      rows.push({ sessionId, call, role, warning, recovery });
      matching.add(sessionId);
    }
    for (const call of session.emptyAttempts ?? []) {
      const key = JSON.stringify(['empty', sessionId, call.seq]);
      if (nonCallSeen.has(key)) continue;
      nonCallSeen.add(key);
      if (ownership(session, call) === 'owned' && dateMatches(call, filters)
        && !filters.model && !filters.provider) emptyAttempts.push({ sessionId, call });
    }
    for (const call of session.auxiliaryCoverage?.unrecorded ?? []) {
      const key = JSON.stringify(['auxiliary', sessionId, call.seq]);
      if (nonCallSeen.has(key)) continue;
      nonCallSeen.add(key);
      if (ownership(session, call) !== 'owned') continue;
      coverage.unrecordedAuxiliaryOperations++;
      allUnrecorded.push({ sessionId, call });
      if (dateMatches(call, filters) && modelMatches(call, filters)) unrecorded.push({ sessionId, call });
    }
  }
  // Operation-scoped receipts preserve failed/cancelled summary attempts that
  // have no compaction/summary event. Successful receipts share that event's
  // identity, so the operation ledger cannot bill the same summary twice.
  const sessionAuxiliaryReceiptGaps = allUnrecorded.length;
  for (const operation of scopedOperations) {
    for (const [index, receipt] of (operation.summaryCalls ?? []).entries()) {
      if (receipt.outcome === 'started' && ['stopping', 'creating', 'compacting'].includes(operation.state)) {
        coverage.pendingAuxiliaryCalls++;
        continue;
      }
      const sessionId = operation.branchId ?? operation.sessionId;
      const compactionId = receipt.compactionId ?? operation.compaction?.id;
      const seq = Number.isSafeInteger(receipt.summarySeq) && receipt.summarySeq >= 0 ? receipt.summarySeq : null;
      const key = seq === null ? JSON.stringify(['operation', operation.id, index]) : JSON.stringify([sessionId, seq]);
      const raw = receipt.usage;
      // A durable summary can come from a local template or remote extension.
      // Preserve that record as a coverage gap unless it witnesses a stream or
      // reported usage. Legacy invocation receipts have no `source` marker.
      if (receipt.source === 'session-summary' && receipt.llmStreamCall !== true
        && receipt.usageRecorded !== true && !FIELDS.some(field => finite(raw?.[field]))) {
        if (seen.has(key)) { coverage.operationReceiptsDuplicateExcluded++; continue; }
        coverage.operationSummaryRecordsUnconfirmed++;
        const gapKey = seq === null ? key : JSON.stringify(['auxiliary', sessionId, seq]);
        if (!nonCallSeen.has(gapKey)) {
          nonCallSeen.add(gapKey);
          const call = { seq, at: receipt.at ?? null, provider: receipt.provider ?? null,
            model: receipt.model ?? null, compactionId,
            purpose: 'compaction', reason: 'summary-without-call-receipt' };
          const row = { sessionId, call };
          allUnrecorded.push(row);
          if (dateMatches(call, filters) && modelMatches(call, filters)) unrecorded.push(row);
        }
        continue;
      }
      if (compactionId) recordedCompactions.add(JSON.stringify([sessionId, compactionId]));
      if (seen.has(key)) { coverage.operationReceiptsDuplicateExcluded++; continue; }
      seen.add(key);
      const usage = Object.fromEntries(FIELDS.filter(field => field !== 'promptTokens')
        .map(field => [field, finite(raw?.[field]) ? raw[field] : null]));
      usage.promptTokens = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(field => usage[field] !== null)
        ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null;
      usage.reported = receipt.usageRecorded === true || Object.values(usage).some(value => finite(value));
      const call = { seq, at: receipt.at ?? null, atSource: receipt.atSource ?? null,
        settledAt: receipt.settledAt ?? null, settledAtSource: receipt.settledAtSource ?? null,
        provider: receipt.provider ?? null, model: receipt.model ?? null,
        purpose: 'compaction', settlement: 'operation/summary', usage,
        outcome: receipt.outcome ?? 'unknown', operationId: operation.id,
        modelDurationMs: finite(receipt.durationMs) ? receipt.durationMs : null };
      if (!timestamp(call.at)) coverage.unknownDateCalls++;
      if (!call.model || !call.provider) coverage.unknownModelCalls++;
      if (!dateMatches(call, filters)) { coverage.dateFilteredOutCalls++; continue; }
      models.set(JSON.stringify([call.provider, call.model]), { provider: call.provider, model: call.model });
      if (!modelMatches(call, filters)) { coverage.modelFilteredOutCalls++; continue; }
      rows.push({ sessionId, call, role: 'auxiliary', recovery: 'unknown' });
      matching.add(sessionId);
      coverage.operationReceiptCalls++;
    }
  }
  const recordedElsewhere = row => row.call.compactionId
    && recordedCompactions.has(JSON.stringify([row.sessionId, row.call.compactionId]));
  coverage.sessionAuxiliaryReceiptGaps = sessionAuxiliaryReceiptGaps;
  coverage.unrecordedAuxiliaryOperations = allUnrecorded.filter(row => !recordedElsewhere(row)).length;
  unrecorded = unrecorded.filter(row => !recordedElsewhere(row));
  coverage.matchingSessions = matching.size;
  coverage.callTimeBasis = 'recorded-summary-stream-start-else-receipt-settlement';
  coverage.callTimeSources = { summaryStreamStart: 0, receiptSettlement: 0, unknown: 0 };
  for (const row of rows) {
    const source = !timestamp(row.call.at) ? 'unknown'
      : row.call.atSource === 'llm-stream-start' ? 'summaryStreamStart'
        : row.role !== 'auxiliary' || row.call.atSource === 'session-summary-settlement' ? 'receiptSettlement' : 'unknown';
    coverage.callTimeSources[source]++;
  }
  const overall = totals(rows);
  overall.emptyAttempts = emptyAttempts.length;
  overall.unrecordedAuxiliaryOperations = unrecorded.length;
  const groups = {};
  for (const role of ['main', 'sub', 'auxiliary', 'unknown']) groups[role] = totals(rows.filter(row => row.role === role));
  const dated = new Map();
  const modeled = new Map();
  for (const row of rows) {
    const date = statisticsDate(row.call.at) ?? 'unknown';
    const dateRows = dated.get(date) ?? []; dateRows.push(row); dated.set(date, dateRows);
    const key = JSON.stringify([row.call.provider ?? null, row.call.model ?? null]);
    const modelRows = modeled.get(key) ?? []; modelRows.push(row); modeled.set(key, modelRows);
  }
  const causes = new Map();
  for (const row of rows) {
    if (!row.warning || row.warning.category === 'expected-rebuild') continue;
    const observed = [...new Set((row.warning.changes ?? [])
      .filter(change => !change.preservesPrefix && change.kind !== 'unknown').map(change => change.kind))];
    for (const kind of observed.length ? observed : [row.warning.cause ?? 'comparison-unknown']) {
      const cause = causes.get(kind) ?? { kind, count: 0, estimatedLossTokens: 0, evidence: [] };
      cause.count++;
      cause.estimatedLossTokens += finite(row.warning.lossTokens) ? row.warning.lossTokens : 0;
      if (cause.evidence.length < 5) cause.evidence.push(evidenceOf(row.sessionId, row.call));
      causes.set(kind, cause);
    }
  }
  const rankedCauses = [...causes.values()].sort((left, right) => right.estimatedLossTokens - left.estimatedLossTokens || right.count - left.count);
  const recommendations = rankedCauses.map(cause => {
    const [title, message] = SUGGESTIONS[cause.kind] ?? ['检查异常证据', '结合实际回执与前缀差异核对原因。'];
    return { id: cause.kind, title, message, action: 'inspect', evidence: cause.evidence };
  });
  if (overall.cacheUnknownCalls || coverage.ownershipUnknownCalls || unrecorded.length) recommendations.push({
    id: 'coverage', title: '核对未知与未记录用量',
    message: '缺少回执或归属的调用未被补成零；当前统计只覆盖已扫描且归属明确的记录。',
    action: 'inspect', evidence: [],
  });
  return {
    filters, generatedAt: options.now ?? Date.now(), policyVersion: options.policyVersion ?? null,
    totals: overall, groups,
    byDate: [...dated].sort(([a], [b]) => b.localeCompare(a)).map(([date, members]) => ({ date, ...totals(members) })),
    byModel: [...modeled].map(([key, members]) => { const [provider, model] = JSON.parse(key); return { provider, model, ...totals(members) }; }),
    availableModels: [...models.values()], causes: rankedCauses, recommendations,
    coverage: { ...coverage, missingUsageCalls: overall.missingUsageCalls,
      cacheUnknownCalls: overall.cacheUnknownCalls,
      auxiliaryNote: '仅包含已记录辅助调用；未记录不代表零开销。',
      operationScope: 'source-or-branch-in-scanned-sessions',
      causeCountsMayOverlap: true, lossesAreEstimates: true, monetarySavings: 'not-estimated' },
  };
}
