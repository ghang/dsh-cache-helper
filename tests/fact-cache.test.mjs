import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture, usage } from './history-fixtures.mjs';
const tested = name => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', name)).href
  : new URL(`../src/${name}`, import.meta.url).href;
const { FactCache, sourceProof, stableDependencySignature } = await import(tested('fact-cache.mjs'));
const { AnalysisService } = await import(tested('analysis-service.mjs'));
const { analyzeSession } = await import(tested('analysis.mjs'));
const fields = (result, expected) => Object.fromEntries(Object.keys(expected).map(key => [key, result[key]]));
const generated = () => { const f = fixture({ text: 'PRIVATE_PROMPT_CANARY '.repeat(20) });
  f.response(usage(100, 100_000)); f.next(); f.user('ordinary append'); f.response(usage(100, 101_000)); return f; };
function request(f, config = {}, extra = {}) {
  const records = f.records();
  return { sessionId: f.session.id, sourceCut: { sessionId: f.session.id, serviceInstance: 1,
    revision: records.length, lifecycle: 1 }, config, load: async () => ({ records }), ...extra };
}
async function environment(t, budget = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-facts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const make = async () => { const cache = new FactCache({ directory: join(directory, 'cache'), ...budget }); await cache.init(); return cache; };
  return { directory, make };
}

test('disk restart validates the authoritative cut and reuses every old call without normalization', async t => {
  const { directory, make } = await environment(t);
  const f = generated();
  const first = new AnalysisService({ factCache: await make() });
  const expected = analyzeSession(f.records());
  const initial = await first.analyze(request(f));
  assert.deepEqual(fields(initial, expected), expected);
  assert.equal(initial.cacheDetails.storage.stored, true);
  await first.dispose();
  const cache = await make();
  assert.equal(cache.status(f.session.id, f.session.header).state, 'cached');
  const second = new AnalysisService({ factCache: cache });
  const stale = await second.cached(f.session.id);
  assert.equal(stale.cacheStatus, 'stale-disk');
  assert.equal(stale.sourceCut.validation, 'unverified');
  assert.equal(stale.coverage.validated, false);
  let normalized = 0;
  const current = await second.analyze(request(f, { onNormalize() { normalized++; } }, {
    sourceCut: { ...request(f).sourceCut, serviceInstance: 'new-process-instance' },
  }));
  assert.equal(normalized, 0);
  assert.equal(current.cacheStatus, 'validated-disk');
  assert.equal(current.cacheDetails.reason, 'validated-cut');
  assert.equal(current.cacheDetails.reusedCalls, 2);
  assert.deepEqual(fields(current, expected), expected);
  const filename = (await readdir(join(directory, 'cache'))).find(name => name.endsWith('.facts.json'));
  const raw = await readFile(join(directory, 'cache', filename), 'utf8');
  assert.equal(raw.includes('PRIVATE_PROMPT_CANARY'), false);
  assert.equal(raw.includes('ordinary append'), false);
  assert.equal((await stat(join(directory, 'cache'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'cache', filename))).mode & 0o777, 0o600);
  await second.dispose();
});

test('stable append reuses old pairs and normalizes only new calls, including after restart', async t => {
  const { make } = await environment(t);
  const f = generated();
  const first = new AnalysisService({ factCache: await make() });
  await first.analyze(request(f)); await first.dispose();
  f.next(); f.user('new one'); f.response(usage(100, 102_000));
  f.next(); f.user('new two'); f.response(usage(100, 103_000));
  const seqs = [];
  const second = new AnalysisService({ factCache: await make() });
  const result = await second.analyze(request(f, { onNormalize(event) { seqs.push(event.seq); } }));
  const expected = analyzeSession(f.records());
  assert.deepEqual(fields(result, expected), expected);
  assert.equal(result.cacheDetails.reason, 'validated-append');
  assert.equal(result.cacheDetails.reusedCalls, 2);
  assert.equal(result.cacheDetails.normalizedCalls, 2);
  assert.equal(seqs.length, 2);
  assert.ok(seqs.every(seq => seq > expected.calls[1].seq));
  await second.dispose();
});

test('changed prefixes rebuild the necessary baseline exactly and preserve full-analysis warnings', async t => {
  const { make } = await environment(t);
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  await service.analyze(request(f));
  f.next(); f.header([f.tools[0]]); f.update([{ type: 'tool-removal', toolName: 'beta' }]);
  f.user('changed input'); f.response(usage(110_000, 100));
  const result = await service.analyze(request(f));
  const expected = analyzeSession(f.records());
  assert.deepEqual(fields(result, expected), expected);
  assert.deepEqual(result.cacheDetails.rebuildReasons, ['prefix-proof-mismatch']);
  assert.equal(result.cacheDetails.reusedCalls, 2);
  assert.equal(result.cacheDetails.normalizedCalls, 2, 'Only the new call and its necessary prior baseline rebuild');
  assert.equal(result.warnings.length, 1);
  await service.dispose();
});

test('source rewrite, shrink and lifecycle replacement have explicit conservative miss reasons', async t => {
  const { make } = await environment(t);
  const f = generated();
  const original = f.records();
  const cases = [
    { reason: 'source-prefix-changed', records: original.map(record => record.type === 'session/title' ? record : record.seq === 0 ? { ...record, time: record.time + 1 } : record) },
    { reason: 'log-shortened', records: original.slice(0, -1) },
    { reason: 'lifecycle-changed', records: [{ ...original[0], createdAt: original[0].createdAt + 1 }, ...original.slice(1)] },
  ];
  for (const scenario of cases) {
    const first = new AnalysisService({ factCache: await make() });
    await first.analyze(request(f, {}, { mode: 'refresh' })); await first.dispose();
    const next = new AnalysisService({ factCache: await make() });
    const result = await next.analyze(request(f, {}, { load: async () => ({ records: scenario.records }) }));
    assert.equal(result.cacheDetails.reason, scenario.reason);
    assert.equal(result.cacheDetails.reusedCalls, 0);
    await next.dispose();
  }
});

test('unknown projector semantics can display stale accounting but cannot reuse disk prefix facts', async t => {
  const { make } = await environment(t);
  const f = generated();
  const config = { messageProjections: [{ type: 'synthetic/unused', project() { return new Map(); } }] };
  const first = new AnalysisService({ factCache: await make() });
  await first.analyze(request(f, config, { dependencyKey: 'first-function-reference' })); await first.dispose();
  const second = new AnalysisService({ factCache: await make() });
  assert.equal((await second.cached(f.session.id, { config })).latest.cacheReadTokens, 101_000);
  const result = await second.analyze(request(f, config, { dependencyKey: 'second-function-reference' }));
  assert.equal(result.cacheDetails.reason, 'unknown-dependency');
  assert.equal(result.cacheDetails.normalizedCalls, 2);
  await second.dispose();
});

test('refresh bypasses cached facts and preserves ordinary reuse for policy changes', async t => {
  const { make } = await environment(t);
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  await service.analyze(request(f));
  const refresh = await service.analyze(request(f, {}, { mode: 'refresh' }));
  assert.equal(refresh.cacheDetails.reason, 'refresh-requested');
  assert.equal(refresh.cacheDetails.normalizedCalls, 2);
  const policy = await service.analyze(request(f, { minLostTokens: 1 }, { policyVersion: 2 }));
  assert.equal(policy.cacheDetails.normalizedCalls, 0);
  await service.dispose();
});

test('corrupt facts and explicit clear never modify a Session source', async t => {
  const { directory, make } = await environment(t, { maxEntries: 1, maxEntryBytes: 100_000, maxBytes: 100_000 });
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  await service.analyze(request(f));
  const files = await readdir(join(directory, 'cache'));
  const file = join(directory, 'cache', files.find(name => name.endsWith('.facts.json')));
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.facts.calls[0].usage.cacheReadTokens++;
  await writeFile(file, JSON.stringify(envelope));
  assert.equal((await service.factCache.get(f.session.id)).reason, 'corrupt-cache', 'Facts checksum rejects numeric corruption');
  assert.equal((await service.factCache.put({ ...envelope, factsSha256: createHash('sha256').update(JSON.stringify(envelope.facts)).digest('hex'),
    facts: { ...envelope.facts, prompt: 'PRIVATE_PROMPT_CANARY' } })).reason, 'invalid-facts');
  const original = f.records();
  await service.clearCache();
  assert.deepEqual(f.records(), original);
  assert.equal(service.cacheSummary().entries, 0);
  await service.dispose();
});

test('entry bytes, total entries, idle expiry and cleanup are bounded without trimming source facts', async t => {
  const { directory } = await environment(t);
  let now = Date.now();
  const cache = new FactCache({ directory: join(directory, 'limited'), maxEntries: 1,
    maxEntryBytes: 100_000, maxBytes: 100_000, idleMs: 1000, now: () => now });
  await cache.init();
  const first = generated();
  const service = new AnalysisService({ factCache: cache });
  await service.analyze(request(first));
  const firstName = (await readdir(cache.directory)).find(name => name.endsWith('.facts.json'));
  const envelope = JSON.parse(await readFile(join(cache.directory, firstName), 'utf8'));
  const second = structuredClone(envelope);
  second.sessionId = 'second'; second.facts.sessionId = 'second'; second.facts.accounting.identity.targetSessionId = 'second';
  second.factsSha256 = createHash('sha256').update(JSON.stringify(second.facts)).digest('hex');
  now++;
  assert.equal((await cache.put(second)).stored, true);
  assert.equal(cache.summary().entries, 1);
  assert.equal((await cache.get(first.session.id)).envelope, undefined);
  assert.equal((await readdir(cache.directory)).filter(name => name.endsWith('.facts.json')).length, 1);
  const tiny = new FactCache({ directory: join(directory, 'tiny'), maxEntryBytes: 100, maxBytes: 100 });
  await tiny.init();
  assert.equal((await tiny.put(second)).reason, 'cache-entry-limit');
  assert.equal(tiny.summary().entries, 0);
  now += 2000;
  assert.equal(cache.status('second').reason, 'cache-expired');
  assert.equal((await cache.get('second')).reason, 'cache-expired');
  assert.equal(cache.summary().entries, 0);
  await service.dispose();
});

test('owner-directory symlinks and unavailable writes fail soft without touching their targets', async t => {
  const { directory } = await environment(t);
  const source = join(directory, 'source'); await mkdir(source);
  await writeFile(join(source, 'keep.txt'), 'source must survive');
  const alias = join(directory, 'alias'); await symlink(source, alias, 'dir');
  const cache = new FactCache({ directory: alias });
  assert.equal((await cache.init()).error, 'cache-unavailable');
  assert.equal((await cache.get('missing')).envelope, undefined);
  const service = new AnalysisService({ factCache: cache });
  const f = generated();
  const result = await service.analyze(request(f));
  assert.equal(result.cacheDetails.storage.reason, 'cache-write-failed');
  assert.equal(result.latest.cacheReadTokens, 101_000);
  await service.dispose();
  assert.equal(await readFile(join(source, 'keep.txt'), 'utf8'), 'source must survive');
});

test('source hashing yields and obeys abort instead of serializing the complete log at once', async () => {
  const f = generated();
  const controller = new AbortController();
  let slices = 0;
  await assert.rejects(sourceProof(f.records(), { signal: controller.signal, sliceEvents: 1,
    scheduler: async () => { slices++; controller.abort(); } }), { name: 'AbortError' });
  assert.equal(slices, 1);
});

test('nested functions, getters and explicit unsupported capabilities cannot pretend to be a stable dependency', () => {
  assert.equal(stableDependencySignature({ historicalCapabilities: { capabilities() {} } }), null);
  const capabilities = {}; Object.defineProperty(capabilities, 'toolUpdate', { enumerable: true, get() { return 'addition-only'; } });
  assert.equal(stableDependencySignature({ historicalCapabilities: capabilities }), null);
  assert.notEqual(stableDependencySignature({ historicalCapabilities: {} }),
    stableDependencySignature({ historicalCapabilities: { toolUpdate: undefined } }));
});

test('numeric-shaped malformed usage fails schema even when its facts checksum is replaced', async t => {
  const { directory, make } = await environment(t);
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  await service.analyze(request(f));
  const name = (await readdir(join(directory, 'cache'))).find(file => file.endsWith('.facts.json'));
  const path = join(directory, 'cache', name);
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.facts.calls[0].usage.inputTokens = '100';
  envelope.factsSha256 = createHash('sha256').update(JSON.stringify(envelope.facts)).digest('hex');
  await writeFile(path, JSON.stringify(envelope));
  assert.equal((await service.factCache.get(f.session.id)).reason, 'corrupt-cache');
  await service.dispose();
});

test('an older analysis finishing after a newer one cannot overwrite the durable latest cut', async t => {
  const { make } = await environment(t);
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  const old = request(f, {}, { order: 1 });
  let release; const barrier = new Promise(resolve => { release = resolve; });
  old.load = async () => { await barrier; return { records: f.records().slice(0, old.sourceCut.revision) }; };
  // Freeze the old prefix rather than taking a moving view after the wait.
  const oldRecords = f.records(); old.load = async () => { await barrier; return { records: oldRecords }; };
  const oldWork = service.analyze(old);
  f.next(); f.user('newest cut'); f.response(usage(10, 105_000));
  const newest = await service.analyze(request(f, {}, { order: 2 }));
  release(); await oldWork;
  assert.equal((await service.factCache.get(f.session.id)).envelope.source.eventCount, newest.sourceCut.eventCount ?? f.records().length - 1);
  await service.dispose();
});

test('clearing cache while computation is active cannot repopulate it with the older epoch', async t => {
  const { make } = await environment(t);
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  const extract = service.extract;
  let release; const barrier = new Promise(resolve => { release = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  service.extract = async (...args) => { const result = await extract(...args); entered(); await barrier; return result; };
  const work = service.analyze(request(f));
  await ready; await service.clearCache(); release();
  assert.equal((await work).latest.cacheReadTokens, 101_000);
  assert.equal(service.cacheSummary().entries, 0);
  assert.equal(service.diagnostics().cachedSessions, 0);
  await service.dispose();
});

test('late corrupt readers cannot remove the complete entry written after an explicit clear', async t => {
  const { directory, make } = await environment(t);
  const f = generated();
  const service = new AnalysisService({ factCache: await make() });
  await service.analyze(request(f));
  const cache = service.factCache;
  const original = (await cache.get(f.session.id)).envelope;
  const filename = (await readdir(join(directory, 'cache'))).find(name => name.endsWith('.facts.json'));
  for (let round = 1; round <= 10; round++) {
    await writeFile(join(directory, 'cache', filename), '{corrupt');
    const reading = cache.get(f.session.id);
    const clearing = cache.clear();
    const replacement = { ...original, generatedAt: original.generatedAt + round };
    const storing = cache.put(replacement);
    await Promise.all([reading, clearing, storing]);
    assert.equal((await cache.get(f.session.id)).envelope?.generatedAt, replacement.generatedAt);
  }
  await service.dispose();
});
