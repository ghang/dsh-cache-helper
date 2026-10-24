import { z } from 'zod';
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';
import { normalizeUsage } from './history.mjs';

export const ACCOUNTING_PROJECTION_KEY = 'cacheHelperAccounting';
const totalSchema = z.object({ calls: z.number().int().nonnegative(), knownInputTokens: z.number().nonnegative(),
  knownCacheReadTokens: z.number().nonnegative(), knownCacheWriteTokens: z.number().nonnegative(),
  knownOutputTokens: z.number().nonnegative(), knownPromptTokens: z.number().nonnegative(),
  unknownUsageCalls: z.number().int().nonnegative() }).strict();
const receiptSchema = z.object({ seq: z.number().int().nonnegative(), at: z.number().nullable(),
  turn: z.number().nullable(), step: z.number().nullable(), usage: z.object({
    inputTokens: z.number().nullable(), cacheReadTokens: z.number().nullable(), cacheWriteTokens: z.number().nullable(),
    outputTokens: z.number().nullable(), promptTokens: z.number().nullable(), hitRate: z.number().nullable(), reported: z.boolean(),
  }).strict() }).strict().nullable();
export const accountingProjectionSchema = z.object({ schema: z.literal(1), sessionId: z.string(),
  role: z.enum(['main', 'sub']), inheritedEventCount: z.number().int().nonnegative().nullable(),
  own: totalSchema, inherited: totalSchema, unknown: totalSchema,
  auxiliaryCalls: z.number().int().nonnegative(), unrecordedSummaries: z.number().int().nonnegative(),
  emptyAttempts: z.number().int().nonnegative(), lastReceipt: receiptSchema }).strict();
const totals = () => ({ calls: 0, knownInputTokens: 0, knownCacheReadTokens: 0, knownCacheWriteTokens: 0,
  knownOutputTokens: 0, knownPromptTokens: 0, unknownUsageCalls: 0 });
const usageOf = event => event.data?.usage !== undefined ? event.data.usage
  : lastAssistantStreamChunk(event.data?.stream ?? [], 'usage')?.usage;
const number = value => Number.isFinite(value) ? value : null;

/** Bounded numeric facts. No call list, prompt, route strings or tool bodies. */
export const accountingProjectionDefinition = {
  key: ACCOUNTING_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: accountingProjectionSchema,
  init(header, inheritedEventCount) {
    return { schema: 1, sessionId: header.id,
      role: header.origin === 'subagent' || header.delegationDepth > 0 ? 'sub' : 'main',
      inheritedEventCount: Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0 ? inheritedEventCount : null,
      own: totals(), inherited: totals(), unknown: totals(), auxiliaryCalls: 0, unrecordedSummaries: 0,
      emptyAttempts: 0, lastReceipt: null };
  },
  apply(state, event) {
    if (event.type === 'compaction/summary') {
      const actual = event.data?.llmStreamCall === true || event.data?.usage !== undefined;
      return { ...state, [actual ? 'auxiliaryCalls' : 'unrecordedSummaries']:
        state[actual ? 'auxiliaryCalls' : 'unrecordedSummaries'] + 1 };
    }
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return state;
    const raw = usageOf(event);
    if (event.type === 'assistant/attempt' && raw === undefined && !event.data?.stream?.length)
      return { ...state, emptyAttempts: state.emptyAttempts + 1 };
    const usage = normalizeUsage(raw);
    const group = state.inheritedEventCount === null ? 'unknown' : event.seq < state.inheritedEventCount ? 'inherited' : 'own';
    const sum = { ...state[group], calls: state[group].calls + 1,
      unknownUsageCalls: state[group].unknownUsageCalls + (usage.promptTokens === null ? 1 : 0) };
    for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'promptTokens'])
      sum['known' + key[0].toUpperCase() + key.slice(1)] += usage[key] ?? 0;
    const effective = event.type === 'assistant/message' || usage.reported;
    return { ...state, [group]: sum, ...(effective ? { lastReceipt: { seq: event.seq, at: number(event.time),
      turn: number(event.data?.turn), step: number(event.data?.step), usage } } : {}) };
  },
  wire: { viewSchema: accountingProjectionSchema, view: state => state },
};

export async function installAccountingProjection(ctx) {
  if (typeof ctx.inject === 'function') {
    const fiber = ctx.inject(['sessionProjections'], scope => {
      scope.sessionProjections.register(accountingProjectionDefinition);
    });
    await fiber;
    return () => fiber.dispose();
  }
  const registry = ctx.get?.('sessionProjections');
  return registry?.register ? registry.register(accountingProjectionDefinition) : () => {};
}
