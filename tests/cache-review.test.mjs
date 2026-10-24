import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, usage } from './history-fixtures.mjs';
const testedModule = file => process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', file)).href
  : new URL(`../src/${file}`, import.meta.url).href;
const { AnalysisService } = await import(testedModule('analysis-service.mjs'));
const { FactCache, validEnvelope } = await import(testedModule('fact-cache.mjs'));
const { SessionRepository } = await import(testedModule('repository.mjs'));

test('new in-memory lifecycle cannot make an old failed-write disk lifecycle displayable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-review-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = fixture({ text: 'same synthetic source' }); old.response(usage(100, 100_000));
  const next = fixture({ text: 'same synthetic source' }); next.response(usage(200, 200_000));
  const wrap = (value, createdAt) => ({ id: old.session.id, seq: value.session.seq,
    header: { ...value.session.header, id: old.session.id, createdAt }, surface: value.session.surface,
    snapshotEvents: () => value.session.snapshotEvents() });
  let live = wrap(old, 100);
  const ctx = { sessions: { get: () => live, list: () => [live], messageProjections: [] }, get: () => undefined };
  const config = { minLostTokens: 50_000, minLossRatio: 0.2, maxEvents: 1000,
    maxCachedSessions: 4, persistState: false };
  const repo = new SessionRepository(ctx, config);
  const disk = new FactCache({ directory: join(directory, 'cache') });
  await disk.init();
  repo.analysis = new AnalysisService({ factCache: disk });
  await repo.init();
  t.after(() => repo.dispose());
  assert.equal((await repo.session(live.id)).latest.cacheReadTokens, 100_000);
  disk.put = async () => ({ stored: false, reason: 'cache-write-failed' });
  live = wrap(next, 200);
  assert.equal((await repo.session(live.id)).latest.cacheReadTokens, 200_000);
  assert.equal(repo.analysis.analysisStatus(live.id, live.header).memory, true);
  assert.equal(await repo.cachedSession(live.id), null,
    'A display read must validate the disk envelope against the current header even when memory is newer');
});

test('persisted input proof schema rejects malformed route fields even with a matching checksum', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-helper-review-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture({ text: 'synthetic proof source' }); f.response(usage(100, 100_000));
  const cache = new FactCache({ directory: join(directory, 'cache') });
  await cache.init();
  const service = new AnalysisService({ factCache: cache });
  t.after(() => service.dispose());
  await service.analyze({ sessionId: f.session.id, sourceCut: { sessionId: f.session.id, revision: 1 },
    load: async () => ({ records: f.records() }) });
  const name = (await readdir(cache.directory)).find(value => value.endsWith('.facts.json'));
  const envelope = JSON.parse(await readFile(join(cache.directory, name), 'utf8'));
  assert.equal(validEnvelope(envelope), true);
  envelope.facts.calls[0].inputProof.provider = { malformed: true };
  envelope.factsSha256 = createHash('sha256').update(JSON.stringify(envelope.facts)).digest('hex');
  assert.equal(validEnvelope(envelope), false, 'Opaque input-proof route values cannot be treated as trustworthy prefix facts');
});
