import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';

const MAX_LINEAGE_DEPTH = 128;
const id = value => typeof value === 'string' && value.length > 0 ? value : null;
const depth = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const headerOf = records => records[0]?.type === 'session' ? records[0] : undefined;
const isChild = header => header?.origin === 'subagent' || depth(header?.delegationDepth) > 0;

/** The exact seed boundary is Session state, not implied by parentSession. */
export function inheritanceCut(records) {
  const header = headerOf(records);
  const eventCount = records.length - (header ? 1 : 0);
  const supplied = header?.inheritedEventCount;
  const valid = Number.isSafeInteger(supplied) && supplied >= 0 && supplied <= eventCount
    && (header?.isSeeded === true || supplied === 0);
  const inheritedEventCount = valid ? supplied
    : supplied !== undefined || header?.isSeeded ? null : 0;
  return { inheritedEventCount, known: inheritedEventCount !== null };
}

function parentHeader(headers, targetId) {
  const value = headers instanceof Map ? headers.get(targetId)
    : Array.isArray(headers) ? headers.slice(0, MAX_LINEAGE_DEPTH).find(item => item?.id === targetId)
      : headers && Object.hasOwn(headers, targetId) ? headers[targetId] : undefined;
  return value?.id === targetId ? value : undefined;
}

function checkedRuntime(config, targetSessionId) {
  const runtime = config.runtimeIdentity;
  return targetSessionId !== null && runtime?.local === true
    && runtime.targetSessionId === targetSessionId ? runtime : undefined;
}

/**
 * Read-only classification, never interrupt/continuation authority. Runtime
 * metadata must be a trusted, local snapshot bound to this exact target. A
 * durable Session id is deliberately never used as an activation generation.
 */
export function sessionIdentity(records, config = {}) {
  const header = headerOf(records);
  const targetSessionId = id(header?.id) ?? id(config.sessionId);
  const runtime = checkedRuntime(config, targetSessionId);
  const runtimeDepth = depth(runtime?.depth);
  const child = isChild(header) || (runtimeDepth !== null && runtimeDepth > 0);
  const role = child ? 'sub' : 'main';
  const unknownReasons = [];
  if (!header || !targetSessionId) unknownReasons.push('session-header-unavailable');
  if (config.runtimeIdentity && !runtime) unknownReasons.push('runtime-identity-unavailable');
  const durableParent = child ? id(header?.parentSession) : null;
  const runtimeParent = child ? id(runtime?.directParentId) : null;
  const parentConflict = durableParent && runtimeParent && durableParent !== runtimeParent;
  const directParentId = parentConflict ? null : durableParent ?? runtimeParent;
  if (parentConflict) unknownReasons.push('parent-conflict');
  const durableDepth = depth(header?.delegationDepth);
  const resolvedDepth = child ? (durableDepth > 0 ? durableDepth : runtimeDepth > 0 ? runtimeDepth : null) : 0;
  if (child && !directParentId) unknownReasons.push('direct-parent-unavailable');
  if (child && resolvedDepth === null) unknownReasons.push('depth-unavailable');
  if (durableDepth !== null && runtimeDepth !== null && durableDepth !== runtimeDepth) unknownReasons.push('depth-conflict');
  let rootSessionId = child ? null : targetSessionId;
  if (child && directParentId) {
    const seen = new Set([targetSessionId]);
    let currentId = directParentId;
    let expectedDepth = resolvedDepth === null ? null : resolvedDepth - 1;
    for (let hops = 0; hops < MAX_LINEAGE_DEPTH; hops++) {
      if (seen.has(currentId)) { unknownReasons.push('parent-cycle'); break; }
      seen.add(currentId);
      const parent = parentHeader(config.parentHeaders, currentId);
      if (!parent) { unknownReasons.push('parent-chain-unavailable'); break; }
      const parentDepth = depth(parent.delegationDepth) ?? (isChild(parent) ? null : 0);
      if (expectedDepth !== null && parentDepth !== null && parentDepth !== expectedDepth) {
        unknownReasons.push('parent-depth-conflict'); break;
      }
      if (!isChild(parent)) { rootSessionId = currentId; break; }
      currentId = id(parent.parentSession);
      if (!currentId) { unknownReasons.push('parent-chain-unavailable'); break; }
      expectedDepth = parentDepth === null ? null : parentDepth - 1;
      if (hops === MAX_LINEAGE_DEPTH - 1) unknownReasons.push('parent-chain-limit');
    }
  }
  if (unknownReasons.includes('depth-conflict') || parentConflict) rootSessionId = null;
  const generation = runtime?.activationGeneration;
  const activationGeneration = typeof generation === 'string' && generation.length > 0
    || Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
  return {
    targetSessionId, role, directParentId, rootSessionId, depth: resolvedDepth,
    activationGeneration, forkParentId: id(header?.parentSession),
    relationshipKnown: unknownReasons.length === 0,
    unknownReasons,
  };
}

function receipt(event) {
  if (event.type === 'assistant/message') return true;
  if (event.type !== 'assistant/attempt') return false;
  // Match the host accounting precedence: an explicit settlement usage wins
  // over an earlier stream chunk, including an explicit null/unknown value.
  const usage = event.data?.usage !== undefined ? event.data.usage
    : lastAssistantStreamChunk(event.data?.stream ?? [], 'usage')?.usage;
  return usage != null;
}

function receiptOwner(records, seq, config) {
  const header = headerOf(records);
  let currentId = id(header?.parentSession);
  const seen = new Set([id(header?.id)]);
  for (let hops = 0; currentId && hops < MAX_LINEAGE_DEPTH; hops++) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);
    const parent = parentHeader(config.parentHeaders, currentId);
    if (!parent) return null;
    // We know this seq is present in the parent's inherited child prefix, but
    // need that parent's own cut to distinguish its receipt from an ancestor's.
    const cut = parent.inheritedEventCount;
    if (parent.isSeeded !== true) {
      if (cut === undefined || cut === 0) return currentId;
      return null;
    }
    if (!Number.isSafeInteger(cut) || cut < 0) return null;
    if (seq >= cut) return currentId;
    currentId = id(parent.parentSession);
  }
  return null;
}

/**
 * Choose a baseline by receipts, never by a new/resumed/spawn/fork label.
 * Async extraction can supply monotonically ordered effective receiptSeqs,
 * including an explicit empty array, to avoid another scan of the event log.
 * A nonempty failed stream without usage is not an effective baseline.
 */
export function selectReceiptBaseline(records, config = {}) {
  const ownership = inheritanceCut(records);
  const targetSessionId = id(headerOf(records)?.id) ?? id(config.sessionId);
  const result = { kind: 'unknown', seq: null, receiptSessionId: null,
    inheritedEventCount: ownership.inheritedEventCount, ownershipKnown: ownership.known };
  if (!ownership.known) return result;
  let seq = null;
  if (Object.hasOwn(config, 'receiptSeqs')) {
    if (!Array.isArray(config.receiptSeqs)) return result;
    if (config.receiptSeqs.length === 0) return { ...result, kind: 'none' };
    seq = config.receiptSeqs.at(-1);
    if (!Number.isSafeInteger(seq) || seq < 0) return result;
  } else {
    for (let index = records.length - 1; index >= 0; index--) {
      if (receipt(records[index])) { seq = records[index].seq; break; }
    }
  }
  if (seq === null) return { ...result, kind: 'none' };
  if (!Number.isSafeInteger(seq) || seq < 0) return result;
  const own = seq >= ownership.inheritedEventCount;
  return { ...result, kind: own ? 'own' : 'inherited', seq,
    receiptSessionId: own ? targetSessionId : receiptOwner(records, seq, config) };
}
