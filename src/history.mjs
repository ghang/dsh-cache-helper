import { Session } from '@deepseek-ai/dsh-session';
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface';
import { lastAssistantStreamChunk, projectToolUpdates, fileHandleText, requestImageHandleText, offloadedImageText } from '@deepseek-ai/dsh-llm';
import { createHash } from 'node:crypto';
import { inheritanceCut, sessionIdentity } from './session-identity.mjs';

/** The records remain borrowed from Session; no durable prompt copy is made. */
export function splitRecords(records) {
  const header = records[0]?.type === 'session' ? records[0] : undefined;
  return { header, events: header ? records.slice(1) : records };
}

const count = value => Number.isFinite(value) && value >= 0 ? value : null;

/** Usage counters are disjoint in DSH: inputTokens is the uncached part. */
export function normalizeUsage(raw, position = {}) {
  const inputTokens = count(raw?.inputTokens);
  const outputTokens = count(raw?.outputTokens);
  const cacheReadTokens = count(raw?.cacheReadTokens);
  const cacheWriteTokens = count(raw?.cacheWriteTokens);
  const complete = [inputTokens, cacheReadTokens, cacheWriteTokens].every(value => value !== null);
  const promptTokens = complete ? inputTokens + cacheReadTokens + cacheWriteTokens : null;
  return {
    inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, promptTokens,
    hitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
    reported: raw !== undefined && raw !== null,
    ...position,
  };
}

function eventUsage(event) {
  if (event.data?.usage !== undefined) return event.data.usage;
  return lastAssistantStreamChunk(event.data?.stream ?? [], 'usage')?.usage;
}

/**
 * Yield each actual main-loop settlement and its input before its output enters
 * the surface. step/start is deliberately not a boundary: admission of system,
 * runtime/user context, request/header and developer updates happens after it.
 * SurfaceManager is the host's incremental fold, including replacements and
 * plugin-supplied message projections. Tool history is rebuilt only when its
 * small set of governing events changes, then reused for ordinary steps.
 */
export function* iterateCallSteps(records, config = {}) {
  const { header: storage, events } = splitRecords(records);
  const prefix = [];
  const projections = config.messageProjections ?? config.projections ?? [];
  const surface = new SurfaceManager(prefix, 0, projections);
  let header;
  let context;
  let toolHistory;
  let toolsDirty = true;
  let failure;
  const sessionId = storage?.id ?? config.sessionId ?? 'cache-helper-replay';
  for (const event of events) {
    if (event.type === 'assistant/message'
      || (event.type === 'assistant/attempt'
        && (eventUsage(event) !== undefined || event.data?.stream?.length > 0))) {
      let request;
      let unknown = failure;
      if (!unknown && !(event.seq < (config.skipCallBeforeSeq ?? -1))) {
        try {
          if (!header) throw new Error('缺少 request/header，无法重建实际模型输入');
          if (toolsDirty) {
            // Detached restore borrows immutable data and never copies streams.
            // This temporary Session is not published, persisted or registered.
            const replay = Session.fromRestore(sessionId, prefix, {
              version: 4, id: sessionId, createdAt: storage?.createdAt ?? 0, isSeeded: false,
            }, 0, 'shared-frozen', projections);
            toolHistory = replay.toolHistory();
            toolsDirty = false;
          }
          const messages = surface.nodes.map(seq => surface.deriveEventMessage(prefix[seq])).filter(Boolean);
          request = {
            ...header.config,
            messages,
            toolHistory,
            ...(header.tools === undefined ? {} : { tools: header.tools }),
            sessionId,
            requestContext: context,
          };
        } catch (error) {
          unknown = error instanceof Error ? error.message : '历史输入重建失败';
        }
      }
      yield { call: {
        turn: event.data?.turn, step: event.data?.step, seq: event.seq,
        at: event.time, settlement: event.type,
        provider: event.data?.message?.source?.provider ?? header?.config?.provider ?? null,
        model: event.data?.message?.source?.model ?? header?.config?.model ?? null,
        usage: normalizeUsage(eventUsage(event), {
          turn: event.data?.turn, step: event.data?.step, seq: event.seq,
        }),
        ...(request ? { request } : {}),
        ...(unknown ? { unknown } : {}),
      } };
    }
    if (event.type === 'request/header') { header = event.data?.header; toolsDirty = true; }
    if (event.type === 'request/context') context = event.data;
    if (event.type === 'developer/message') toolsDirty = true;
    if (!failure) {
      try { surface.validateNext(event); }
      catch (error) { failure = error instanceof Error ? error.message : 'Session surface 重建失败'; }
    }
    prefix.push(event);
    // Checkpoints cover events without receipts as well as actual calls.
    yield null;
  }
}

export function* iterateCalls(records, config = {}) {
  for (const checkpoint of iterateCallSteps(records, config)) {
    if (checkpoint?.call) yield checkpoint.call;
  }
}

/** Read only recorded accounting facts; unknown auxiliary work is never free. */
export function* iterateAccountingSteps(records, config = {}) {
  const { events } = splitRecords(records);
  const ownership = inheritanceCut(records);
  const cut = ownership.inheritedEventCount;
  const identity = sessionIdentity(records, config);
  const inherited = seq => cut === null ? null : seq < cut;
  const starts = new Map();
  const ends = new Map();
  const emptyAttempts = [];
  for (const event of events) {
    if (event.type === 'compaction/start') starts.set(event.data?.compactionId, event);
    if (event.type === 'compaction/end') ends.set(event.data?.compactionId, event);
    if (event.type === 'assistant/attempt' && eventUsage(event) === undefined && !event.data?.stream?.length) {
      emptyAttempts.push({ seq: event.seq, at: event.time, turn: event.data?.turn,
        step: event.data?.step, inherited: inherited(event.seq), dispatch: 'unknown' });
    }
    yield null;
  }
  const auxiliaryCalls = [];
  const unrecorded = [];
  const summaries = new Set();
  const compactionSeqs = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    // A checkpoint before continue also makes long non-summary logs cancellable.
    yield null;
    if (event.type !== 'compaction/summary') continue;
    const data = event.data ?? {};
    const start = starts.get(data.compactionId);
    const end = ends.get(data.compactionId);
    summaries.add(data.compactionId);
    // Log-only summaries predict rebuilding only if a linked surface replacement landed.
    const replacement = events[index + 1];
    const range = data.shadowedRange;
    const operation = replacement?.surfaceOp;
    if (replacement?.type === 'user/message' && operation?.op === 'replace' && range && start
      && operation.startSeq === range.start && operation.endSeq === range.end
      && replacement.sourceEventSeqs?.includes(event.seq) && replacement.sourceEventSeqs?.includes(start.seq)) {
      compactionSeqs.push(replacement.seq);
    }
    const position = { seq: event.seq, at: event.time, atSource: 'session-summary-settlement',
      inherited: inherited(event.seq), compactionId: data.compactionId ?? null, purpose: 'compaction',
      provider: data.provider ?? null, model: data.model ?? null };
    // Template summaries are not evidence of a billable model call.
    if (data.llmStreamCall !== true && data.usage === undefined) {
      unrecorded.push({ ...position, reason: 'summary-without-call-receipt' });
      continue;
    }
    const elapsed = start && end && Number.isFinite(start.time) && Number.isFinite(end.time)
      && end.time >= start.time ? end.time - start.time : null;
    auxiliaryCalls.push({ ...position, settlement: 'compaction/summary', role: 'auxiliary',
      usage: normalizeUsage(data.usage), operationElapsedMs: elapsed,
      durationSource: elapsed === null ? null : 'compaction-lifecycle', modelDurationMs: null,
      outcome: 'completed', operationOutcome: end?.data?.error ? 'partial' : end ? 'completed' : 'pending',
      recording: data.llmStreamCall === true ? 'local-stream' : 'reported-usage' });
  }
  for (const [id, start] of starts) {
    yield null;
    if (summaries.has(id)) continue;
    const end = ends.get(id);
    unrecorded.push({ seq: start.seq, at: start.time, inherited: inherited(start.seq),
      compactionId: id ?? null, purpose: 'compaction',
      reason: end ? 'compaction-without-summary-receipt' : 'compaction-in-progress' });
  }
  return {
    role: identity.role, ownership, identity,
    auxiliaryCalls,
    auxiliaryCoverage: { complete: false, unrecorded,
      reason: '仅统计 Session 已记录的辅助回执；其他辅助调用及失败摘要可能没有用量记录。' },
    emptyAttempts, compactionSeqs,
  };
}

export function sessionAccounting(records, config = {}) {
  const iterator = iterateAccountingSteps(records, config);
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

/** Internal/testing API; callers must not expose raw request content in UI DTOs. */
export function reconstructCalls(records, config = {}) {
  return [...iterateCalls(records, config)];
}

/** Rebuild just one settled input, used by the live pre-send check. */
export function reconstructCall(records, seq, config = {}) {
  const { header: storage, events } = splitRecords(records);
  const event = events.find(item => item.seq === seq);
  if (!event || !['assistant/message', 'assistant/attempt'].includes(event.type)) return null;
  const result = {
    turn: event.data?.turn, step: event.data?.step, seq: event.seq, at: event.time,
    settlement: event.type,
    usage: normalizeUsage(eventUsage(event), { turn: event.data?.turn, step: event.data?.step, seq: event.seq }),
  };
  try {
    const prefix = events.slice(0, events.indexOf(event));
    const sessionId = storage?.id ?? config.sessionId ?? 'cache-helper-replay';
    const replay = Session.fromRestore(sessionId, prefix, {
      version: 4, id: sessionId, createdAt: storage?.createdAt ?? 0, isSeeded: false,
    }, 0, 'shared-frozen', config.messageProjections ?? config.projections ?? []);
    const header = replay.requestHeader();
    if (!header) throw new Error('缺少 request/header，无法重建实际模型输入');
    result.request = { ...header.config, messages: replay.deriveMessages(),
      ...(header.tools === undefined ? {} : { tools: header.tools }),
      toolHistory: replay.toolHistory(), requestContext: replay.requestContext(), sessionId };
  } catch (error) { result.unknown = error instanceof Error ? error.message : '历史输入重建失败'; }
  return result;
}

/** A successful message is a receipt even if a provider omitted its usage. */
export function latestReceiptSeq(records) {
  const { events } = splitRecords(records);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'assistant/message'
      || (event.type === 'assistant/attempt' && eventUsage(event) != null)) return event.seq;
  }
  return null;
}

function capabilities(request, config) {
  const supplied = typeof config.capabilities === 'function'
    ? config.capabilities(request) : config.capabilities;
  const knownFlash = request.model === 'deepseek-flash';
  const route = supplied ?? {};
  return {
    // Own-property checks allow a resolved model to explicitly omit support.
    toolUpdate: Object.hasOwn(config, 'toolUpdate') ? config.toolUpdate
      : Object.hasOwn(route, 'toolUpdate') ? route.toolUpdate
        : knownFlash ? 'addition-only' : undefined,
    systemPromptUpdate: Object.hasOwn(config, 'systemPromptUpdate') ? config.systemPromptUpdate
      : Object.hasOwn(route, 'systemPromptUpdate') ? route.systemPromptUpdate
        : request.requestContext !== undefined ? request.requestContext.systemPromptUpdate
          : knownFlash ? 'in-history' : undefined,
    comparisonMode: route.comparisonMode ?? config.comparisonMode
      ?? (/^deepseek(?:-|$)/.test(request.model ?? '') ? 'deepseek-messages' : undefined),
  };
}

function parseToolArguments(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function replaySignatures(message, model) {
  const state = message.source?.replayState;
  if (message.source?.kind !== 'model' || state === undefined) return [];
  if (state.response?.kind !== 'deepseek-messages' || state.response?.version !== 1
    || state.response.model !== message.source.model || !Array.isArray(state.blocks)
    || state.blocks.length !== message.content.length) return [];
  if (state.blocks.some((block, index) => block.type !== message.content[index]?.type
    || !['text', 'reasoning', 'tool-call'].includes(block.type)
    || (block.signature !== undefined && (block.type !== 'reasoning' || typeof block.signature !== 'string')))) return [];
  return state.response.model === model ? state.blocks : [];
}

// The host owns attachment bytes and execution-world paths. Compare immutable
// content identities, never read the files or retain their base64 payloads.
function attachmentInput(block, weights) {
  const ref = block.attachment;
  if (!ref || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || ref.name !== undefined && typeof ref.name !== 'string') {
    throw new Error(`${block.type} 附件缺少有效 attachmentId 或大小，无法可靠比较`);
  }
  if (block.type === 'file') {
    // Files are handle text, not inline file bytes. Keep the full digest so
    // attachments sharing the displayed eight-character prefix stay distinct.
    return [{ type: 'text', text: fileHandleText(ref, undefined)
      .replace(`sha256:${ref.attachmentId.slice(7, 15)}`, ref.attachmentId) }];
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
    || ![ref.width, ref.height].every(value => Number.isSafeInteger(value) && value > 0)
    || ref.bytes > 32 * 1024 * 1024) throw new Error('image 附件元数据不完整或超过适配器上限');
  if (block.offloaded === true) return [{ type: 'text', text: offloadedImageText(ref) }];
  const source = { type: 'base64', media_type: ref.mediaType, data: `${ref.attachmentId}:${ref.bytes}` };
  // Mirror the adapter's handle + base64 image shape. Virtual character weight
  // avoids allocating tens of MiB of dummy base64 per image. Request transforms,
  // offload and Files API transport remain estimates, like text/token scaling.
  weights.set(source, 4 * Math.ceil(ref.bytes / 3) - source.data.length);
  return [{ type: 'text', text: requestImageHandleText(ref, ref) }, { type: 'image', source }];
}

function wireInput(blocks, weights) {
  const result = [];
  for (const block of blocks) {
    if (block.type === 'text') { if (block.text) result.push({ type: 'text', text: block.text }); }
    else if (block.type === 'image' || block.type === 'file') result.push(...attachmentInput(block, weights));
    else if (!['reasoning', 'tool-call'].includes(block.type)) {
      throw new Error(`不支持可靠比较的输入内容：${block.type}（附件/文件需适配器投影）`);
    }
  }
  return result;
}

/** Semantic input of the checked DeepSeek Messages adapter, without trace IDs. */
function deepseekInput(request, projected, mode, weights) {
  let system;
  const messages = [];
  const pendingSystem = [];
  const flush = () => {
    if (!pendingSystem.length) return;
    if (messages.at(-1)?.role !== 'user') throw new Error('system 更新缺少前置 user/tool turn');
    messages.push(...pendingSystem.splice(0));
  };
  for (const message of projected.messages) {
    if (message.role === 'system') {
      if (message.content.some(block => block.type !== 'text')) throw new Error('system 包含非文本输入');
      const text = message.content.map(block => block.text).join('');
      if (mode.systemPromptUpdate === 'in-history' && messages.length) {
        if (!text) throw new Error('空 system 历史更新');
        pendingSystem.push({ role: 'system', content: [{ type: 'text', text }] });
      } else system = text;
      continue;
    }
    if (message.role === 'developer') {
      const content = message.content.flatMap(block => {
        if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : [];
        if (block.type === 'tool-addition' || block.type === 'tool-removal') {
          return [{ type: block.type === 'tool-addition' ? 'tool_addition' : 'tool_removal',
            tool: { type: 'tool_reference', name: block.toolName } }];
        }
        throw new Error(`不支持的 developer 输入：${block.type}`);
      });
      if (content.length) pendingSystem.push({ role: 'system', content });
      continue;
    }
    let content;
    if (message.role === 'assistant') {
      const replay = replaySignatures(message, request.model);
      content = message.content.flatMap((block, index) => {
        if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : [];
        if (block.type === 'reasoning') return [{ type: 'thinking', thinking: block.text,
          ...(replay[index]?.signature === undefined ? {} : { signature: replay[index].signature }) }];
        if (block.type === 'tool-call') return [{ type: 'tool_use', id: block.id,
          name: block.name, input: parseToolArguments(block.arguments) }];
        throw new Error(`不支持的 assistant 输入：${block.type}`);
      });
    } else if (message.role === 'tool') {
      content = [{ type: 'tool_result', tool_use_id: message.toolCallId,
        content: wireInput(message.content, weights), ...(message.isError === undefined ? {} : { is_error: message.isError }) }];
    } else if (message.role === 'user') content = wireInput(message.content, weights);
    else throw new Error(`未知消息角色：${message.role}`);
    if (!content.length && ['user', 'assistant'].includes(message.role)) continue;
    if (message.role === 'assistant') flush();
    const role = message.role === 'tool' ? 'user' : message.role;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  flush();
  // The adapter puts immediate tool results before other content in a user turn.
  for (const message of messages) {
    if (message.role === 'user') message.content = [
      ...message.content.filter(block => block.type === 'tool_result'),
      ...message.content.filter(block => block.type !== 'tool_result'),
    ];
  }
  return {
    tools: (projected.tools ?? []).map(tool => ({ name: tool.name, description: tool.description,
      input_schema: tool.parameters, ...(tool.deferLoading ? { defer_loading: true } : {}) })),
    system: [request.system, system].filter(Boolean).join('\n\n'),
    messages,
  };
}

/**
 * Compare the provider's model-visible fields. This is not an exact tokenizer:
 * character positions are calibrated using the preceding authoritative usage.
 * Full wire serialisation is independently checked by the fake-upstream tests.
 */
export function normalizeRequest(request, config = {}) {
  if (!request) return { unknown: '无法重建上次请求', comparable: false };
  try {
    const mode = capabilities(request, config);
    if (mode.comparisonMode !== 'deepseek-messages') throw new Error('当前模型的适配器输入投影尚未覆盖');
    const projected = projectToolUpdates(request.messages ?? [], request.tools, mode.toolUpdate, request.toolHistory);
    const weights = new WeakMap();
    const input = deepseekInput(request, projected, mode, weights);
    // No closing message/array markers after the history: ordinary appended
    // blocks and messages keep the previous complete semantic prefix intact.
    // A deferred declaration is model-visible only at its activation block.
    // Moving its definition into the effective history is essential: a brand
    // new deferred tool can be appended without destroying the old prefix.
    const deferred = new Map(input.tools.filter(tool => tool.defer_loading).map(tool => [tool.name, tool]));
    const sequence = [`tools:${JSON.stringify(input.tools.filter(tool => !tool.defer_loading))}\n`, `system:${JSON.stringify(input.system)}\n`];
    const weightedSpans = [];
    let offset = sequence.join('').length;
    for (const message of input.messages) {
      const role = `role:${message.role}\n`;
      sequence.push(role); offset += role.length;
      for (const block of message.content) {
        if (block.type === 'tool_addition' && deferred.has(block.tool.name)) {
          const declaration = `deferred-tool:${JSON.stringify(deferred.get(block.tool.name))}\n`;
          sequence.push(declaration); offset += declaration.length;
        }
        const serialized = `${JSON.stringify(block)}\n`;
        let cursor = 0;
        for (const part of block.type === 'tool_result' ? block.content : [block]) {
          if (part.type !== 'image' || !weights.has(part.source)) continue;
          const source = JSON.stringify(part.source);
          const start = serialized.indexOf(source, cursor);
          if (start < 0) throw new Error('附件投影位置不一致');
          cursor = start + source.length;
          weightedSpans.push({ end: offset + cursor - 1, extra: weights.get(part.source) });
        }
        sequence.push(serialized); offset += serialized.length;
      }
    }
    const text = sequence.join('');
    const route = `${request.provider ?? ''}\0${request.model ?? ''}`;
    return {
      comparable: true, provider: request.provider, model: request.model,
      tools: input.tools, system: input.system, messages: input.messages,
      text, chars: text.length + weightedSpans.reduce((sum, span) => sum + span.extra, 0), weightedSpans,
      fingerprint: createHash('sha256').update(route).update(JSON.stringify(input)).digest('hex'),
      capabilities: mode,
    };
  } catch (error) {
    return { comparable: false, provider: request.provider, model: request.model,
      unknown: error instanceof Error ? error.message : '输入投影失败' };
  }
}
