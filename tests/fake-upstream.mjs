import { createServer } from 'node:http';
import { once } from 'node:events';

/** A synthetic Messages response. All numbers are disjoint provider usage buckets. */
export function messageEvents({
  text = 'Synthetic reply',
  model = 'deepseek-v4-flash',
  id = 'msg_cache_helper_fixture',
  usage = { inputTokens: 100, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 8 },
  toolCalls = [],
} = {}) {
  const counters = {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: 0,
    ...(usage.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens }),
  };
  const events = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], usage: counters } }];
  let index = 0;
  if (text !== undefined && text !== '') {
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index },
    );
    index += 1;
  }
  for (const call of toolCalls) {
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} } },
      { type: 'content_block_stop', index },
    );
    index += 1;
  }
  events.push(
    { type: 'message_delta', delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.outputTokens ?? 0 } },
    { type: 'message_stop' },
  );
  return events;
}

export function encodeSse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/**
 * Actual loopback HTTP/SSE endpoint for the real DeepSeek adapter. It has no
 * access to the user's credentials or network. Missing scripted replies fail
 * closed, making accidental duplicate upstream calls visible in assertions.
 */
export async function createFakeUpstream({ script = [] } = {}) {
  const replies = [...script];
  const requests = [];
  const sockets = new Set();
  const timers = new Set();
  const waiters = new Set();
  let closed = false;

  function publish() {
    for (const waiter of [...waiters]) {
      if (requests.length >= waiter.count) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(requests);
      }
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { body = raw; }
      requests.push({ method: request.method, path: request.url, headers: { ...request.headers }, body, raw, at: Date.now() });
      publish();
      if (request.method !== 'POST' || request.url !== '/anthropic/v1/messages') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Only the synthetic Messages endpoint is available' } }));
        return;
      }
      const reply = replies.shift();
      if (reply === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'api_error', message: 'Synthetic reply script exhausted' } }));
        return;
      }
      if (reply.status !== undefined && reply.status !== 200) {
        response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        response.end(JSON.stringify(reply.body ?? { error: { type: 'api_error', message: 'Synthetic HTTP failure' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events = reply.events ?? messageEvents(reply);
      if (!reply.delayMs) {
        response.end(encodeSse(events));
        return;
      }
      let index = 0;
      function writeNext() {
        if (closed || response.destroyed) return;
        if (index === events.length) {
          response.end();
          return;
        }
        response.write(encodeSse([events[index++]]));
        const timer = setTimeout(() => {
          timers.delete(timer);
          writeNext();
        }, reply.delayMs);
        timers.add(timer);
      }
      writeNext();
    })().catch(error => response.destroy(error));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing loopback listener');

  return {
    url: `http://127.0.0.1:${address.port}/anthropic`,
    requests,
    enqueue(...nextReplies) { replies.push(...nextReplies); },
    waitForRequests(count, timeoutMs = 3_000) {
      if (requests.length >= count) return Promise.resolve(requests);
      if (closed) return Promise.reject(new Error('Synthetic endpoint is closed'));
      return new Promise((resolve, reject) => {
        const waiter = { count, resolve, reject };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Expected ${count} upstream requests, observed ${requests.length}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Synthetic endpoint closed while waiting'));
      }
      waiters.clear();
      const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}
