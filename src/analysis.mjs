import {
  iterateCalls, latestReceiptSeq, normalizeRequest, reconstructCall, splitRecords,
} from './history.mjs';

export const DEFAULT_CONFIG = Object.freeze({ minLostTokens: 50_000, minLossRatio: 0.2 });
const setting = config => ({ ...DEFAULT_CONFIG, ...config });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

function changesBetween(previous, current) {
  const changes = [];
  if (previous.provider !== current.provider || previous.model !== current.model) changes.push({
    kind: 'route', message: `提供方或模型变化：${previous.provider ?? '?'} / ${previous.model ?? '?'} → ${current.provider ?? '?'} / ${current.model ?? '?'}`,
  });
  const oldTools = new Map((previous.tools ?? []).map(tool => [tool.name, tool]));
  const newTools = new Map((current.tools ?? []).map(tool => [tool.name, tool]));
  const added = [...newTools.keys()].filter(name => !oldTools.has(name));
  const removed = [...oldTools.keys()].filter(name => !newTools.has(name));
  const changed = [...newTools.keys()].filter(name => oldTools.has(name) && !same(oldTools.get(name), newTools.get(name)));
  const reordered = !added.length && !removed.length
    && !same([...oldTools.keys()], [...newTools.keys()]);
  if (added.length || removed.length || changed.length || reordered) changes.push({
    kind: 'tools', message: '模型实际工具声明发生变化，可能破坏旧请求前缀',
    added, removed, changed, reordered,
  });
  if (previous.system !== current.system) changes.push({
    kind: 'system', message: '头部 system 内容发生变化',
  });
  const previousHistory = historyText(previous);
  const currentHistory = historyText(current);
  if (!currentHistory.startsWith(previousHistory)) changes.push({
    kind: 'history', message: '既有消息前缀被替换、截断或重新投影，可能与压缩或历史改写有关',
  });
  return changes;
}

function historyText(input) {
  return (input.messages ?? []).map(message => `role:${message.role}\n`
    + message.content.map(block => `${JSON.stringify(block)}\n`).join('')).join('');
}

function measuredScale(previous, config) {
  const tokens = config.previousPromptTokens ?? previous.promptTokens ?? previous.usage?.promptTokens;
  return Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
}

/**
 * Compare semantic provider inputs. Only estimated old-prefix loss is counted;
 * appending a very large new input remains a zero-loss operation.
 */
export function compareRequests(previousRequest, currentRequest, config = {}) {
  const resolved = setting(config);
  const previous = previousRequest?.comparable !== undefined ? previousRequest : normalizeRequest(previousRequest, config.previousCapabilities ?? config);
  const current = currentRequest?.comparable !== undefined ? currentRequest : normalizeRequest(currentRequest, config);
  const promptTokens = measuredScale(previousRequest ?? {}, config);
  if (!previous.comparable || !current.comparable) return {
    unknown: true, estimated: true,
    message: previous.unknown ?? current.unknown ?? '请求输入不可可靠比较',
    lossTokens: null, lossRatio: null, previousPromptTokens: promptTokens,
    previousChars: previous.chars,
    changes: [{ kind: 'unknown', message: previous.unknown ?? current.unknown ?? '请求重建不完整' }],
    previousFingerprint: previous.fingerprint, fingerprint: current.fingerprint,
    significant: promptTokens !== null && promptTokens >= resolved.minLostTokens,
  };
  const changes = changesBetween(previous, current);
  const routeChanged = previous.provider !== current.provider || previous.model !== current.model;
  const commonChars = routeChanged ? 0 : commonPrefixLength(previous.text, current.text);
  const lossRatio = previous.chars > 0 ? 1 - commonChars / previous.chars : 0;
  const lossTokens = promptTokens === null ? null : Math.round(promptTokens * lossRatio);
  if (lossRatio === 0) {
    for (const change of changes) change.preservesPrefix = true;
  }
  return {
    unknown: promptTokens === null,
    estimated: true,
    lossTokens, lossRatio, previousPromptTokens: promptTokens,
    commonPrefixChars: commonChars, previousChars: previous.chars,
    changes, previousFingerprint: previous.fingerprint, fingerprint: current.fingerprint,
    significant: lossTokens !== null && lossTokens >= resolved.minLostTokens && lossRatio >= resolved.minLossRatio,
    ...(promptTokens === null ? { message: '上次回执没有完整输入用量，无法可靠估计损失 Token' } : {}),
  };
}

/** Rebuild only the latest receipt; failed/unreported candidates cannot replace it. */
export function inspectNextRequest(records, options, config = {}) {
  const seq = latestReceiptSeq(records);
  if (seq === null) return null;
  const previous = reconstructCall(records, seq, config);
  const risk = compareRequests(previous.request, options, {
    ...config, previousPromptTokens: previous.usage.promptTokens,
    // Historical capabilities must follow their own recorded model/context.
    previousCapabilities: config.historicalCapabilities ?? {},
  });
  const estimatedScale = previous.usage.promptTokens
    ?? (Number.isFinite(risk.previousChars) ? risk.previousChars / 4 : null);
  const resolved = setting(config);
  // Missing usage or unsupported projection is explicitly unknown. For large
  // histories we still ask a human, rather than reporting a successful check.
  const unknownLarge = risk.unknown && (estimatedScale === null
    || (estimatedScale >= resolved.minLostTokens && (risk.lossRatio === null || risk.lossRatio >= resolved.minLossRatio)));
  if (!risk.significant && !unknownLarge) return null;
  return {
    ...risk, baselineSeq: seq,
    turn: previous.turn, step: previous.step,
    ...(risk.unknown ? { reason: risk.message ?? '历史输入检查不完整，需要确认后发送。' } : {}),
    ...(previous.unknown ? { unknown: true, message: previous.unknown } : {}),
  };
}

function cumulativeUsage(calls) {
  const sum = field => calls.reduce((total, call) => total + (call.usage[field] ?? 0), 0);
  const completeSum = field => calls.every(call => call.usage[field] !== null) ? sum(field) : null;
  const cacheKnownCalls = calls.filter(call => call.usage.promptTokens !== null).length;
  const read = sum('cacheReadTokens');
  const knownRead = calls.filter(call => call.usage.promptTokens !== null)
    .reduce((total, call) => total + call.usage.cacheReadTokens, 0);
  const prompt = calls.reduce((total, call) => total + (call.usage.promptTokens ?? 0), 0);
  return {
    inputTokens: completeSum('inputTokens'), cacheReadTokens: completeSum('cacheReadTokens'),
    cacheWriteTokens: completeSum('cacheWriteTokens'), outputTokens: completeSum('outputTokens'),
    knownCacheReadTokens: read,
    promptTokens: cacheKnownCalls === calls.length ? prompt : null,
    hitRate: cacheKnownCalls === calls.length && prompt > 0 ? read / prompt : null,
    knownHitRate: prompt > 0 ? knownRead / prompt : null,
    calls: calls.length, cacheKnownCalls,
    missingUsageCalls: calls.filter(call => !call.usage.reported).length,
  };
}

/** Public result contains metrics and limited cause metadata, never prompts. */
export function analyzeSession(records, config = {}) {
  const resolved = setting(config);
  const calls = [];
  const warnings = [];
  let previous;
  for (const call of iterateCalls(records, config)) {
    const currentInput = normalizeRequest(call.request, config.historicalCapabilities ?? {});
    let difference;
    let warning;
    if (previous) {
      difference = compareRequests(previous.input, currentInput, {
        ...resolved, previousPromptTokens: previous.call.usage.promptTokens,
      });
      const oldPrompt = previous.call.usage.promptTokens;
      const currentRead = call.usage.cacheReadTokens;
      if (oldPrompt !== null && currentRead !== null && call.usage.reported) {
        // Extra input can lower hit rate without losing old cached content.
        // Compare actual read against the old prompt, not current total input.
        const lossTokens = Math.max(0, oldPrompt - currentRead);
        const lossRatio = oldPrompt > 0 ? lossTokens / oldPrompt : 0;
        if (lossTokens >= resolved.minLostTokens && lossRatio >= resolved.minLossRatio) {
          const observed = difference.changes.filter(change => change.kind !== 'unknown' && !change.preservesPrefix);
          const unknown = !currentInput.comparable || !previous.input.comparable;
          warning = {
            id: `${splitRecords(records).header?.id ?? config.sessionId ?? 'session'}:${call.seq}`,
            turn: call.turn, step: call.step, seq: call.seq, at: call.at,
            usage: call.usage,
            inputTokens: call.usage.inputTokens, missTokens: call.usage.inputTokens,
            cacheReadTokens: call.usage.cacheReadTokens,
            cacheWriteTokens: call.usage.cacheWriteTokens, hitRate: call.usage.hitRate,
            summary: `第 ${call.turn} 轮 / 步骤 ${call.step}：缓存大规模未命中`,
            lossTokens: Math.round(lossTokens), lossRatio, estimated: true,
            previousPromptTokens: oldPrompt,
            changes: difference.changes,
            cause: observed.length ? 'observed-prefix-change' : unknown ? 'comparison-unknown' : 'upstream-unknown',
            reason: observed.length
              ? '观察到请求前缀变化，可能导致旧上下文缓存未命中，需要分析确认。'
              : unknown ? '输入重建或适配投影不完整，无法可靠归因，需要分析确认。'
                : '未观察到客户端旧前缀变化，可能为服务端过期、淘汰或其他原因，需要分析确认。',
            ...(unknown ? { unknown: true } : {}),
            recovered: false,
          };
          warnings.push(warning);
        }
      }
    }
    if (!warning && call.usage.hitRate !== null && call.usage.hitRate >= 0.8) {
      for (const old of warnings) {
        if (!old.recovered && call.usage.cacheReadTokens >= old.previousPromptTokens * (1 - resolved.minLossRatio)) {
          old.recovered = true;
          old.recoveredAt = { seq: call.seq, turn: call.turn, step: call.step, at: call.at };
        }
      }
    }
    calls.push({
      turn: call.turn, step: call.step, seq: call.seq, at: call.at,
      settlement: call.settlement, usage: call.usage,
      changes: difference?.changes ?? [],
      ...(warning ? { warningId: warning.id } : {}),
      ...(call.unknown || currentInput.unknown ? { unknown: call.unknown ?? currentInput.unknown } : {}),
    });
    // A successful message is an actual model receipt; usage-bearing failed
    // attempts are also billable. Pure cancellation/error logs are not baselines.
    if (call.settlement === 'assistant/message' || call.usage.reported) previous = { call, input: currentInput };
  }
  // Each answer footer describes the last actual input of its own turn. Reuse
  // the settled call's metrics; never sum steps or fall back to another turn
  // when the final call has missing cache counters.
  const turns = new Map();
  for (const call of calls) turns.set(call.turn, {
    turn: call.turn, latest: call.usage,
    seq: call.seq, step: call.step, at: call.at, settlement: call.settlement,
    ...(call.warningId ? { warningId: call.warningId } : {}),
    ...(call.unknown ? { unknown: call.unknown } : {}),
  });
  return {
    sessionId: splitRecords(records).header?.id ?? config.sessionId,
    latest: calls.at(-1)?.usage ?? null,
    cumulative: cumulativeUsage(calls), calls, turns: [...turns.values()], warnings,
    coverage: { adapter: 'deepseek-messages-text', estimatedPrefixTokens: true,
      unknownCalls: calls.filter(call => call.unknown).length },
  };
}
