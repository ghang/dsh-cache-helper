import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { fixture, usage } from './history-fixtures.mjs';
const tested = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { normalizeRequest, reconstructCalls } = await import(tested('history.mjs'));
const { compareRequests, inspectNextRequest, analyzeSession } = await import(tested('analysis.mjs'));
const { AnalysisService } = await import(tested('analysis-service.mjs'));
const attachment = (type = 'image', digit = 'a', bytes = 3_000_000) => ({ type, attachment: {
  attachmentId: `sha256:${digit.repeat(64)}`, bytes, name: type === 'file' ? 'example.txt' : 'example.png',
  ...(type === 'image' ? { mediaType: 'image/png', width: 2048, height: 2048 } : {}),
} });
const request = blocks => ({ provider: 'deepseek-test', model: 'deepseek-flash', messages: [
  createUserMessage({ source: { kind: 'user' }, content: blocks }),
] });

for (const type of ['image', 'file']) {
  test(`${type}: identical attachments preserve the prefix, replacements report loss, and missing identities stay unknown`, () => {
    const first = request([attachment(type), { type: 'text', text: 'keep this history' }]);
    const same = structuredClone(first);
    same.messages[0].content.push({ type: 'text', text: 'ordinary appended input' });
    const unchanged = compareRequests(first, same, { previousPromptTokens: 100_000 });
    assert.equal(unchanged.unknown, false);
    assert.equal(unchanged.lossTokens, 0);
    assert.equal(unchanged.lossRatio, 0);
    const replaced = request([attachment(type, 'b'), { type: 'text', text: 'keep this history' }]);
    const changed = compareRequests(first, replaced, { previousPromptTokens: 100_000 });
    assert.ok(changed.lossTokens > 50_000);
    assert.equal(changed.significant, true);
    const missing = structuredClone(first);
    delete missing.messages[0].content[0].attachment.attachmentId;
    assert.equal(normalizeRequest(missing).comparable, false);
    assert.equal(compareRequests(first, missing, { previousPromptTokens: 100_000 }).unknown, true);
  });
}

test('image weights follow base64 byte expansion without allocating a dummy payload; files stay handle-sized', () => {
  const small = normalizeRequest(request([attachment('image', 'a', 300)]));
  const large = normalizeRequest(request([attachment('image', 'a', 3_000_000)]));
  assert.equal(large.chars - small.chars, 4_000_000 - 400);
  assert.ok(large.text.length < 2000);
  const tiny = attachment('image', 'a', 42); tiny.attachment.mediaType = 'image/gif';
  const tinyInput = normalizeRequest(request([tiny]));
  assert.equal(tinyInput.chars - tinyInput.text.length, 56 - `${tiny.attachment.attachmentId}:42`.length,
    'Even a tiny GIF uses its wire base64 length rather than the longer identity placeholder');
  assert.equal(compareRequests(request([tiny]), request([tiny]), { previousPromptTokens: 100_000 }).lossTokens, 0);
  const offloaded = attachment(); offloaded.offloaded = true;
  const omitted = normalizeRequest(request([offloaded]));
  assert.ok(omitted.chars < 1000, 'Logged offload is handle text rather than inline image bytes');
  assert.match(omitted.messages[0].content[0].text, /image omitted/);
  assert.ok(normalizeRequest(request([attachment('file', 'a', 30_000_000)])).chars < 1000);
  const old = request([attachment(), { type: 'text', text: 'x'.repeat(1000) }]);
  const replacement = request([attachment(), { type: 'text', text: 'y'.repeat(1000) }]);
  assert.ok(compareRequests(old, replacement, { previousPromptTokens: 100_000 }).lossTokens < 100,
    'A small text edit after an unchanged large image must not lose the image weight');
});

test('historical and live user/tool-result attachments share the projection, including incremental prefix proofs', async () => {
  const f = fixture({ text: 'brief input' });
  const append = content => f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content }), { surfaceOp: 'append' });
  append([attachment(), attachment('file')]);
  f.response(usage(100, 100_000));
  f.next();
  const toolMessage = { role: 'tool', toolCallId: 'image-tool', content: [attachment('image', 'b')] };
  const first = reconstructCalls(f.records())[0].request;
  const live = { ...first, messages: [...f.session.deriveMessages(), toolMessage] };
  assert.equal(inspectNextRequest(f.records(), live), null);
  assert.equal(normalizeRequest(live).comparable, true);
  const missing = structuredClone(live);
  delete missing.messages.at(-1).content[0].attachment.attachmentId;
  assert.equal(inspectNextRequest(f.records(), missing).unknown, true);
  const service = new AnalysisService();
  const analyze = () => service.analyze({ sessionId: f.session.id, sourceCut: { revision: f.records().length },
    config: {}, load: async () => ({ records: f.records() }) });
  await analyze();
  append([{ type: 'text', text: 'append one' }]); f.response(usage(100, 101_000));
  const result = await analyze();
  assert.equal(result.cacheDetails.rebuildReasons.length, 0);
  assert.equal(result.cacheDetails.normalizedCalls, 1);
  assert.equal(result.calls.at(-1).category, 'ordinary');
  const full = analyzeSession(f.records());
  assert.deepEqual(result.calls, full.calls);
  await service.dispose();
});
