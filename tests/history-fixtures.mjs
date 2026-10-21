import { Session } from '@deepseek-ai/dsh-session';
import {
  createSystemMessage, createUserMessage, createAssistantMessage, createDeveloperMessage,
} from '@deepseek-ai/dsh-llm';

export const tool = (name, description = name) => ({ name, description, parameters: { type: 'object', properties: {} } });
export const usage = (inputTokens, cacheReadTokens = 0, outputTokens = 10) => ({
  inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens,
});

export function fixture({ text = 'old '.repeat(30_000), tools = [tool('alpha'), tool('beta')], projections = [] } = {}) {
  const session = Session.create('cache-test', undefined, undefined, undefined, projections);
  let turn = 1;
  let step = 1;
  const config = { provider: 'deepseek-test', model: 'deepseek-flash' };
  const position = () => ({ turn, step });
  const user = content => session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: content }] }), { surfaceOp: 'append' });
  const system = (text, opts = { surfaceOp: 'append' }) => session.append('system/message', {
    ...position(), message: createSystemMessage(text),
  }, opts);
  const header = (active, reason = 'change', extra = {}) => session.append('request/header', {
    header: { config, ...(active.length ? { tools: active } : {}) }, reason, ...extra,
  });
  const response = (counts = usage(100, 100_000), extra = {}) => session.append('assistant/message', {
    ...position(), message: createAssistantMessage({ content: [{ type: 'text', text: 'response' }],
      source: { provider: config.provider, model: config.model } }), stream: [], usage: counts, ...extra,
  }, { surfaceOp: 'append' });
  const update = (blocks, headerSeq) => session.append('developer/message', {
    ...position(), message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: blocks }),
    ...(headerSeq === undefined ? {} : { headerSeq }),
  }, { surfaceOp: 'append' });
  session.append('turn/start', { turn });
  session.append('step/start', position());
  system('first system');
  user(text);
  header(tools, 'initial');
  session.append('request/context', { ...config, systemPromptUpdate: 'in-history' });
  return { session, config, tools, user, system, header, response, update,
    next(nextTurn = turn, nextStep = step + 1) {
      turn = nextTurn; step = nextStep;
      session.append('step/start', position());
    },
    records() { return [{ type: 'session', ...session.header }, ...session.snapshotEvents()]; },
  };
}
