import {
  iterateCallSteps, iterateAccountingSteps, latestReceiptSeq, normalizeRequest, reconstructCall, splitRecords,
} from './history.mjs';
import { selectReceiptBaseline } from './session-identity.mjs';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';

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
  const baseline = config.baseline ?? selectReceiptBaseline(records, config);
  if (baseline.kind === 'none') return null;
  if (baseline.kind === 'unknown') {
    const current = normalizeRequest(options, config);
    const recentSeq = latestReceiptSeq(records);
    const recent = recentSeq === null ? null : reconstructCall(records, recentSeq, config);
    const scale = recent?.usage.promptTokens ?? (current.comparable ? current.chars / 4 : null);
    if (scale !== null && scale < setting(config).minLostTokens) return null;
    return { baseline, baselineSeq: null, unknown: true, significant: true, estimated: true,
      lossTokens: null, lossRatio: null, previousPromptTokens: recent?.usage.promptTokens ?? null,
      fingerprint: current.fingerprint, changes: [{ kind: 'unknown', message: '继承切点或回执归属无法确认' }],
      reason: '大上下文的继承基线无法确认，需要确认后发送。' };
  }
  const seq = baseline.seq;
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
    ...risk, baselineSeq: seq, baseline,
    turn: previous.turn, step: previous.step,
    ...(risk.unknown ? { reason: risk.message ?? '历史输入检查不完整，需要确认后发送。' } : {}),
    ...(previous.unknown ? { unknown: true, message: previous.unknown } : {}),
  };
}

export const ANALYZER_VERSION = 'p1-facts-v2';
export const FACTS_SCHEMA_VERSION = 2;
const sha = value => createHash('sha256').update(value).digest('hex');

function inputProof(input) {
  if (!input.comparable) return { comparable: false, unknown: diagnostic(input.unknown),
    provider: input.provider ?? null, model: input.model ?? null };
  const history = historyText(input);
  return { comparable: true, provider: input.provider ?? null, model: input.model ?? null,
    chars: input.chars, textHash: sha(input.text), historyChars: history.length, historyHash: sha(history),
    systemHash: sha(JSON.stringify(input.system)), fingerprint: input.fingerprint,
    // Too many declarations force a clear miss instead of unbounded retention.
    toolHashes: input.tools.length <= 128 && input.tools.every(tool => typeof tool.name === 'string' && tool.name.length <= 256) ? input.tools.map(tool => ({ name: tool.name,
      hash: sha(JSON.stringify(tool)) })) : null };
}

function proofChanges(proof, current) {
  if (!proof.toolHashes || current.tools.length > 128) return null;
  const changes = [];
  if (proof.provider !== (current.provider ?? null) || proof.model !== (current.model ?? null)) changes.push({ kind: 'route',
    message: `提供方或模型变化：${proof.provider ?? '?'} / ${proof.model ?? '?'} → ${current.provider ?? '?'} / ${current.model ?? '?'}` });
  const oldTools = new Map(proof.toolHashes.map(tool => [tool.name, tool.hash]));
  const newTools = new Map(current.tools.map(tool => [tool.name, sha(JSON.stringify(tool))]));
  const added = [...newTools.keys()].filter(name => !oldTools.has(name));
  const removed = [...oldTools.keys()].filter(name => !newTools.has(name));
  const changed = [...newTools.keys()].filter(name => oldTools.has(name) && oldTools.get(name) !== newTools.get(name));
  const reordered = !added.length && !removed.length && !same([...oldTools.keys()], [...newTools.keys()]);
  if (added.length || removed.length || changed.length || reordered) changes.push({ kind: 'tools',
    message: '模型实际工具声明发生变化，可能破坏旧请求前缀', added, removed, changed, reordered });
  if (proof.systemHash !== sha(JSON.stringify(current.system))) changes.push({ kind: 'system', message: '头部 system 内容发生变化' });
  const history = historyText(current);
  if (history.length < proof.historyChars || sha(history.slice(0, proof.historyChars)) !== proof.historyHash)
    changes.push({ kind: 'history', message: '既有消息前缀被替换、截断或重新投影，可能与压缩或历史改写有关' });
  return changes;
}

/** Return null on a mismatch that needs the exact previous input rebuilt. */
function compareProof(proof, current, promptTokens) {
  if (!proof) return null;
  if (!proof.comparable || !current.comparable) return {
    unknown: true, estimated: true, message: proof.unknown ?? current.unknown ?? '请求输入不可可靠比较',
    lossTokens: null, lossRatio: null, previousPromptTokens: promptTokens, previousChars: proof.chars,
    changes: [{ kind: 'unknown', message: proof.unknown ?? current.unknown ?? '请求重建不完整' }],
    previousFingerprint: proof.fingerprint, fingerprint: current.fingerprint,
  };
  const changes = proofChanges(proof, current);
  if (!changes) return null;
  const routeChanged = proof.provider !== (current.provider ?? null) || proof.model !== (current.model ?? null);
  if (!routeChanged && (current.chars < proof.chars || sha(current.text.slice(0, proof.chars)) !== proof.textHash)) return null;
  const lossRatio = routeChanged && proof.chars > 0 ? 1 : 0;
  const lossTokens = promptTokens === null ? null : Math.round(promptTokens * lossRatio);
  if (lossRatio === 0) for (const change of changes) change.preservesPrefix = true;
  return { unknown: promptTokens === null, estimated: true, lossTokens, lossRatio,
    previousPromptTokens: promptTokens, commonPrefixChars: routeChanged ? 0 : proof.chars,
    previousChars: proof.chars, changes, previousFingerprint: proof.fingerprint, fingerprint: current.fingerprint,
    ...(promptTokens === null ? { message: '上次回执没有完整输入用量，无法可靠估计损失 Token' } : {}) };
}

// Retained diagnostics must not turn a projection exception into a prompt copy.
function diagnostic(value) {
  if (!value) return undefined;
  const text = String(value);
  const fixed = [
    '缺少 request/header，无法重建实际模型输入', '历史输入重建失败', 'Session surface 重建失败',
    '无法重建上次请求', '当前模型的适配器输入投影尚未覆盖', 'system 包含非文本输入',
    'system 更新缺少前置 user/tool turn', '空 system 历史更新', '输入投影失败',
  ];
  if (fixed.includes(text)) return text;
  const types = ['image', 'file', 'audio', 'video', 'document', 'resource'];
  for (const type of types) {
    if (text === `不支持可靠比较的输入内容：${type}（附件/文件需适配器投影）`)
      return text;
  }
  return '历史输入重建或适配投影失败';
}

function retainedChanges(changes) {
  return changes.map(change => {
    if (change.kind === 'unknown') return { ...change, message: diagnostic(change.message) };
    if (change.kind !== 'tools') return { ...change };
    const result = { ...change };
    for (const key of ['added', 'removed', 'changed']) {
      result[key] = (change[key] ?? []).slice(0, 128).map(name => String(name).slice(0, 256));
      if ((change[key]?.length ?? 0) > 128) result[`${key}Omitted`] = change[key].length - 128;
    }
    return result;
  });
}

/**
 * The iterator owns temporary replay state only while it runs. Its return value
 * retains usage, hashes and finite diagnostics; no request, prompt or stream is
 * retained. Both execution modes consume this exact iterator.
 */
function* iterateFacts(records, config) {
  const accounting = yield* iterateAccountingSteps(records, config);
  const sessionId = splitRecords(records).header?.id ?? config.sessionId;
  const inherited = seq => accounting.ownership.known ? seq < accounting.ownership.inheritedEventCount : null;
  const calls = [];
  const reusable = config.reuseFacts?.analyzerVersion === ANALYZER_VERSION ? config.reuseFacts.calls : [];
  const oldCalls = new Map(reusable.map(call => [call.seq, call]));
  const skipCallBeforeSeq = reusable.length ? reusable.at(-1).seq + 1 : -1;
  const receiptSeqs = [];
  let previous;
  let compactionIndex = 0;
  let lastCompactionSeq = -1;
  for (const checkpoint of iterateCallSteps(records, { ...config, skipCallBeforeSeq })) {
    if (!checkpoint?.call) { yield null; continue; }
    const call = checkpoint.call;
    while (accounting.compactionSeqs[compactionIndex] < call.seq) {
      lastCompactionSeq = accounting.compactionSeqs[compactionIndex++];
      yield null;
    }
    const old = oldCalls.get(call.seq);
    if (old) {
      calls.push({ ...old, baseline: selectReceiptBaseline(records, { ...config, receiptSeqs }) });
      if (call.settlement === 'assistant/message' || call.usage.reported) {
        previous = { call, proof: old.inputProof };
        receiptSeqs.push(call.seq);
      }
      config.onReuseCall?.({ seq: call.seq });
      yield null;
      continue;
    }
    config.onNormalize?.({ seq: call.seq });
    const currentInput = normalizeRequest(call.request, config.historicalCapabilities ?? {});
    let comparison;
    if (previous) {
      let input = previous.input;
      let neutral = input ? null : compareProof(previous.proof, currentInput, previous.call.usage.promptTokens);
      if (!input && !neutral) {
        config.onNormalize?.({ seq: previous.call.seq, reason: 'prefix-proof-mismatch' });
        config.onCacheMiss?.({ reason: 'prefix-proof-mismatch', seq: previous.call.seq });
        const rebuilt = reconstructCall(records, previous.call.seq, config);
        input = normalizeRequest(rebuilt?.request, config.historicalCapabilities ?? {});
      }
      if (!neutral) { const { significant, ...value } = compareRequests(input, currentInput, {
        previousPromptTokens: previous.call.usage.promptTokens,
      }); neutral = value; }
      comparison = { ...neutral, changes: retainedChanges(neutral.changes),
        ...(neutral.message ? { message: diagnostic(neutral.message) } : {}) };
    }
    calls.push({
      turn: call.turn, step: call.step, seq: call.seq, at: call.at,
      provider: call.provider, model: call.model, inherited: inherited(call.seq),
      settlement: call.settlement, usage: call.usage,
      inputProof: inputProof(currentInput),
      baseline: selectReceiptBaseline(records, { ...config, receiptSeqs }),
      previousPromptTokens: previous?.call.usage.promptTokens ?? null,
      comparison: comparison ?? null,
      comparisonUnknown: previous ? !currentInput.comparable || (previous.input ? !previous.input.comparable : !previous.proof?.comparable) : false,
      expectedRebuild: Boolean(previous && lastCompactionSeq > previous.call.seq),
      ...(call.unknown || currentInput.unknown ? { unknown: diagnostic(call.unknown ?? currentInput.unknown) } : {}),
    });
    // Nonempty failed streams without usage remain calls with unknown accounting,
    // but cannot establish a successful request baseline for the following call.
    if (call.settlement === 'assistant/message' || call.usage.reported) {
      previous = { call, input: currentInput };
      receiptSeqs.push(call.seq);
    }
    yield null;
  }
  return { schema: FACTS_SCHEMA_VERSION, analyzerVersion: ANALYZER_VERSION, sessionId,
    accounting, calls, baseline: selectReceiptBaseline(records, { ...config, receiptSeqs }) };
}

function consume(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function aborted(signal) {
  if (signal?.aborted) {
    const error = new Error('本地分析已取消');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }
}

async function consumeAsync(iterator, options = {}) {
  const { signal, sliceEvents = 128, sliceMs = 8, scheduler = yieldImmediate } = options;
  if (!Number.isSafeInteger(sliceEvents) || sliceEvents < 1 || !Number.isFinite(sliceMs) || sliceMs <= 0)
    throw new TypeError('Invalid analysis slice budget');
  let processed = 0;
  let started = performance.now();
  try {
    while (true) {
      aborted(signal);
      const step = iterator.next();
      aborted(signal);
      if (step.done) return step.value;
      processed++;
      if (processed >= sliceEvents || performance.now() - started >= sliceMs) {
        await scheduler();
        aborted(signal);
        processed = 0;
        started = performance.now();
      }
    }
  } finally {
    iterator.return?.();
  }
}

export function extractSessionFacts(records, config = {}) {
  return consume(iterateFacts(records, config));
}

export function extractSessionFactsAsync(records, config = {}, options = {}) {
  return consumeAsync(iterateFacts(records, config), options);
}

function* iterateDerivation(facts, config) {
  if (facts?.schema !== FACTS_SCHEMA_VERSION || facts.analyzerVersion !== ANALYZER_VERSION)
    throw new TypeError('Unsupported analysis facts schema');
  const resolved = setting(config);
  const { accounting, sessionId } = facts;
  const calls = [];
  const warnings = [];
  const turns = new Map();
  const sums = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const complete = { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, outputTokens: true };
  let knownRead = 0;
  let prompt = 0;
  let cacheKnownCalls = 0;
  let missingUsageCalls = 0;
  let unknownCalls = 0;
  for (const fact of facts.calls) {
    const call = { ...fact, usage: { ...fact.usage } };
    const difference = fact.comparison;
    const oldPrompt = fact.previousPromptTokens;
    const currentRead = call.usage.cacheReadTokens;
    let warning;
    if (difference && oldPrompt !== null && currentRead !== null && call.usage.reported) {
      const lossTokens = Math.max(0, oldPrompt - currentRead);
      const lossRatio = oldPrompt > 0 ? lossTokens / oldPrompt : 0;
      if (lossTokens >= resolved.minLostTokens && lossRatio >= resolved.minLossRatio) {
        const changes = retainedChanges(difference.changes);
        const observed = changes.filter(change => change.kind !== 'unknown' && !change.preservesPrefix);
        const unknown = fact.comparisonUnknown;
        warning = {
          id: `${sessionId ?? 'session'}:${call.seq}`,
          turn: call.turn, step: call.step, seq: call.seq, at: call.at,
          provider: call.provider, model: call.model, inherited: call.inherited,
          category: fact.expectedRebuild ? 'expected-rebuild' : 'unexpected-loss',
          usage: call.usage,
          inputTokens: call.usage.inputTokens, missTokens: call.usage.inputTokens,
          cacheReadTokens: call.usage.cacheReadTokens,
          cacheWriteTokens: call.usage.cacheWriteTokens, hitRate: call.usage.hitRate,
          summary: `第 ${call.turn} 轮 / 步骤 ${call.step}：缓存大规模未命中`,
          lossTokens: Math.round(lossTokens), lossRatio, estimated: true,
          previousPromptTokens: oldPrompt, changes,
          cause: observed.length ? 'observed-prefix-change' : unknown ? 'comparison-unknown' : 'upstream-unknown',
          reason: observed.length
            ? '观察到请求前缀变化，可能导致旧上下文缓存未命中，需要分析确认。'
            : unknown ? '输入重建或适配投影不完整，无法可靠归因，需要分析确认。'
              : '未观察到客户端旧前缀变化，可能为服务端过期、淘汰或其他原因，需要分析确认。',
          ...(unknown ? { unknown: true } : {}), recovered: false,
        };
        warnings.push(warning);
      }
    }
    if (!warning && call.usage.hitRate !== null && call.usage.hitRate >= 0.8) {
      for (const old of warnings) {
        if (!old.recovered && old.provider === call.provider && old.model === call.model
          && call.usage.cacheReadTokens >= old.previousPromptTokens * (1 - resolved.minLossRatio)) {
          old.recovered = true;
          old.recoveredAt = { seq: call.seq, turn: call.turn, step: call.step, at: call.at };
        }
        yield null;
      }
    }
    const result = {
      turn: call.turn, step: call.step, seq: call.seq, at: call.at,
      provider: call.provider, model: call.model, inherited: call.inherited,
      category: warning?.category ?? (difference ? 'ordinary' : 'cold-start'),
      settlement: call.settlement, usage: call.usage,
      changes: retainedChanges(difference?.changes ?? []), baseline: { ...fact.baseline },
      ...(warning ? { warningId: warning.id } : {}),
      ...(call.unknown ? { unknown: call.unknown } : {}),
    };
    calls.push(result);
    turns.set(call.turn, { turn: call.turn, latest: call.usage,
      seq: call.seq, step: call.step, at: call.at, settlement: call.settlement,
      ...(warning ? { warningId: warning.id } : {}),
      ...(call.unknown ? { unknown: call.unknown } : {}) });
    for (const field of Object.keys(sums)) {
      sums[field] += call.usage[field] ?? 0;
      complete[field] &&= call.usage[field] !== null;
    }
    if (call.usage.promptTokens !== null) {
      cacheKnownCalls++; prompt += call.usage.promptTokens; knownRead += call.usage.cacheReadTokens;
    }
    if (!call.usage.reported) missingUsageCalls++;
    if (call.unknown) unknownCalls++;
    yield null;
  }
  return {
    sessionId, role: accounting.role, ownership: { ...accounting.ownership },
    identity: { ...accounting.identity }, baseline: { ...facts.baseline },
    auxiliaryCalls: accounting.auxiliaryCalls,
    auxiliaryCoverage: accounting.auxiliaryCoverage, emptyAttempts: accounting.emptyAttempts,
    latest: calls.at(-1)?.usage ?? null,
    cumulative: {
      ...Object.fromEntries(Object.keys(sums).map(field => [field, complete[field] ? sums[field] : null])),
      knownCacheReadTokens: sums.cacheReadTokens,
      promptTokens: cacheKnownCalls === calls.length ? prompt : null,
      hitRate: cacheKnownCalls === calls.length && prompt > 0 ? sums.cacheReadTokens / prompt : null,
      knownHitRate: prompt > 0 ? knownRead / prompt : null,
      calls: calls.length, cacheKnownCalls, missingUsageCalls,
    },
    calls, turns: [...turns.values()], warnings,
    coverage: { adapter: 'deepseek-messages-text', estimatedPrefixTokens: true, unknownCalls },
  };
}

/** Threshold and presentation policy can change without replaying old inputs. */
export function deriveSessionAnalysis(facts, config = {}) {
  return consume(iterateDerivation(facts, config));
}

export function deriveSessionAnalysisAsync(facts, config = {}, options = {}) {
  return consumeAsync(iterateDerivation(facts, config), options);
}

/** Public result contains metrics and limited cause metadata, never prompts. */
export function analyzeSession(records, config = {}) {
  return deriveSessionAnalysis(extractSessionFacts(records, config), config);
}
