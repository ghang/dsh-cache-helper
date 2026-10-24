import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const testedModule = process.env.DSH_CACHE_HELPER_TEST_ARTIFACT
  ? pathToFileURL(join(process.env.DSH_CACHE_HELPER_TEST_ARTIFACT, 'lib', 'session-catalog.mjs')).href
  : new URL('../src/session-catalog.mjs', import.meta.url).href;
const { SessionCatalog } = await import(testedModule);
const header = (id, createdAt = 1, extra = {}) => ({ id, version: 4, createdAt, cwd: '/synthetic/project', isSeeded: false, ...extra });
function environment(headers, { live = [], values = {}, access } = {}) {
  let listings = 0;
  const persistence = { list: async () => { listings++; return headers.map(header => ({ header, eventCount: 10, sizeBytes: 100, revision: 'metadata-token' })); },
    open() { assert.fail('Catalog must not open a log'); }, stat() { assert.fail('Catalog must not stat each row'); } };
  const sessions = live.map(item => ({ id: item.id, header: item, seq: 12,
    snapshotEvents() { assert.fail('Catalog must not read live events'); } }));
  return { get listings() { return listings; }, persistence, ctx: {
    sessions: { list: () => sessions }, get: name => ({ sessionPersistence: persistence,
      sessionProjections: { cachedSnapshot: session => ({ values: values[session.id] ?? {} }) },
      sessionProjectionCache: { cachedSnapshot: header => ({ values: values[header.id] ?? {} }) },
      remoteAccess: access }[name]),
    agents: { get() { assert.fail('Catalog must not activate or inspect an Agent'); } },
  } };
}

test('a metadata directory pages beyond fifty without reading logs or recomputing analysis', async () => {
  const headers = Array.from({ length: 73 }, (_, index) => header(`history-${index}`, index));
  const env = environment(headers);
  let statusReads = 0;
  const catalog = new SessionCatalog(env.ctx, { analysisStatus(_header, metadata) {
    statusReads++; assert.equal(metadata.eventCount, 10); assert.equal(metadata.sizeBytes, 100);
    assert.equal(metadata.revision, 'metadata-token'); return { status: 'none' };
  } });
  const ids = [];
  let cursor;
  let first;
  do {
    const page = await catalog.list({ limit: 20, ...(cursor ? { cursor } : {}) });
    first ??= page;
    ids.push(...page.items.map(row => row.sessionId)); cursor = page.nextCursor;
    if (!cursor) assert.equal(page.items.length, 13);
  } while (cursor);
  assert.equal(new Set(ids).size, 73); assert.equal(ids.at(-1), 'history-0');
  assert.equal(env.listings, 1); assert.equal(statusReads, 73);
  assert.equal(first.coverage.physicalPagination, false);
  assert.equal((await catalog.select(['history-0'], { snapshotId: first.snapshotId })).selectedIds[0], 'history-0');
  headers.push(header('arrived-after-snapshot', 100));
  const next = await catalog.list({ limit: 20, cursor: first.nextCursor });
  assert.equal(next.total, 73); assert.equal(next.items.some(row => row.sessionId === 'arrived-after-snapshot'), false);
  assert.equal((await catalog.list({ limit: 20 })).total, 74);
});

test('metadata filters keep unknown activity, title, model and warnings explicit', async () => {
  const main = header('main', 10);
  const sub = header('child', 20, { origin: 'subagent', delegationDepth: 1, parentSession: 'main' });
  const fork = header('manual-fork', 30, { parentSession: 'main', isSeeded: true });
  const env = environment([main, sub, fork], { live: [sub], values: {
    main: { title: 'A cached title', sessionListMetadata: { lastPromptAt: 50 } },
  } });
  const catalog = new SessionCatalog(env.ctx, { analysisStatus: header => header.id === 'main'
    ? { status: 'cached', warningCount: 2, model: 'synthetic-model' }
    : header.id === 'child' ? { status: 'stale', warningCount: 1 } : undefined });
  const title = await catalog.list({ q: 'cached title' });
  assert.deepEqual(title.items.map(row => row.sessionId), ['main']);
  assert.equal(title.items[0].activitySource, 'cached-last-prompt');
  assert.equal(title.items[0].model, 'synthetic-model');
  const forks = await catalog.list({ role: 'fork', availability: 'history', analysis: 'none' });
  assert.deepEqual(forks.items.map(row => row.sessionId), ['manual-fork']);
  assert.equal(forks.items[0].role, 'main'); assert.equal(forks.items[0].titleSource, 'id');
  assert.equal(forks.items[0].model, null); assert.equal(forks.items[0].warningCount, null);
  assert.equal(forks.items[0].activitySource, 'created-fallback');
  assert.equal((await catalog.list({ role: 'sub', availability: 'live', analysis: 'stale' })).total, 1);
  assert.equal((await catalog.list({ createdFrom: 25, activityTo: 40 })).total, 1);
  assert.equal((await catalog.list({ q: '/synthetic/project' })).total, 3);
  for (const query of [{ role: 'external' }, { limit: 0 }, { createdFrom: 30, createdTo: 10 }, { activityFrom: 'NaN' }]) {
    await assert.rejects(catalog.list(query), { status: 400 });
  }
});

test('directory, explicit selection and continued pages apply the same current visibility', async () => {
  const env = environment([header('public', 4), header('later', 3), header('secret', 2)]);
  const allowed = new Set(['public', 'later']);
  const catalog = new SessionCatalog(env.ctx, { allows: id => allowed.has(id) });
  const first = await catalog.list({ limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.items[0].sessionId, 'public');
  await assert.rejects(catalog.select(['secret']), { status: 403 });
  allowed.delete('later');
  const page = await catalog.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(page.items.length, 0); assert.equal(page.total, 1);
  await assert.rejects(catalog.select(['later'], { snapshotId: first.snapshotId }), { status: 403 });
  await assert.rejects(catalog.list({ limit: 1, cursor: first.nextCursor }, { owner: 'other' }), { status: 403 });
  const scoped = await catalog.list({}, { owner: 'browser', visibleIds: ['public'] });
  assert.deepEqual(scoped.items.map(row => row.sessionId), ['public']);
});

test('the native owner fallback still obeys remoteAccess and refuses unscoped non-owners', async () => {
  const env = environment([header('yes'), header('no')], { access: { allows: resource => resource.id === 'yes' } });
  const catalog = new SessionCatalog(env.ctx);
  assert.deepEqual((await catalog.list()).items.map(row => row.sessionId), ['yes']);
  await assert.rejects(catalog.select(['no']), { status: 403 });
  assert.equal((await catalog.list({}, { owner: 'operator' })).total, 0);
  assert.equal((await catalog.list({}, { owner: 'operator', visibleIds: ['yes'] })).total, 1);
});

test('subtree expansion fixes a deduplicated set and excludes ordinary forks', async () => {
  const rows = [header('root'), header('child', 2, { origin: 'subagent', parentSession: 'root', delegationDepth: 1 }),
    header('nested', 3, { origin: 'subagent', parentSession: 'child', delegationDepth: 2 }),
    header('manual', 4, { isSeeded: true, parentSession: 'root' }),
    header('orphan', 5, { origin: 'subagent', parentSession: 'lost', delegationDepth: 1 })];
  const env = environment(rows); const catalog = new SessionCatalog(env.ctx);
  const page = await catalog.list({ q: 'root' });
  assert.equal(page.items.length, 1);
  const selection = await catalog.select(['root', 'child', 'root'], { includeChildren: true, snapshotId: page.snapshotId });
  assert.deepEqual(selection.selectedIds, ['root', 'child', 'nested']);
  assert.equal(selection.selectedIds.includes('manual'), false);
  assert.deepEqual((await catalog.select(['root'], { includeChildren: false })).selectedIds, ['root']);
  assert.deepEqual((await catalog.select(['orphan'], { includeChildren: true })).selectedIds, ['orphan']);
  rows.push(header('new-child', 6, { origin: 'subagent', parentSession: 'root', delegationDepth: 1 }));
  assert.equal((await catalog.select(['root'], { includeChildren: true, snapshotId: page.snapshotId })).selectedIds.includes('new-child'), false);
  page.items[0].title = 'mutated client title';
  assert.notEqual((await catalog.select(['root'], { snapshotId: page.snapshotId })).items[0].title, 'mutated client title');
});

test('bounded and expired snapshots refuse selection instead of silently widening the corpus', async () => {
  let now = 1;
  const env = environment([header('one', 1), header('two', 2), header('three', 3)]);
  const catalog = new SessionCatalog(env.ctx, { maxEntries: 2, maxSnapshots: 2, snapshotTtlMs: 5, now: () => now });
  const first = await catalog.list({ limit: 1 });
  assert.equal(first.coverage.total, 3); assert.equal(first.coverage.listed, 2); assert.equal(first.coverage.limited, true);
  await assert.rejects(catalog.select(['one'], { snapshotId: first.snapshotId }), { status: 413 });
  now = 10;
  await assert.rejects(catalog.select(['three'], { snapshotId: first.snapshotId }), { code: 'CACHE_HELPER_CATALOG_EXPIRED' });
  await assert.rejects(catalog.list({ limit: 1, cursor: first.nextCursor }), { status: 409 });
});

test('missing projections and analysis metadata do not trigger hidden replay', async () => {
  const env = environment([header('unknown', undefined)]);
  env.ctx.get = name => name === 'sessionPersistence' ? { list: async () => [{ header: { id: 'unknown', version: 4, isSeeded: false } }] } : undefined;
  const catalog = new SessionCatalog(env.ctx, { analysisStatus() { throw new Error('PRIVATE_METADATA_CANARY'); } });
  const page = await catalog.list();
  assert.equal(page.items[0].title, 'unknown'); assert.equal(page.items[0].activityAt, null);
  assert.equal(page.items[0].activitySource, 'unknown'); assert.equal(page.items[0].budgetKnown, false);
  assert.equal(page.items[0].analysis.available, false); assert.equal(page.items[0].warningCount, null);
  assert.equal(JSON.stringify(page).includes('PRIVATE_METADATA_CANARY'), false);
});

test('listing errors retain live rows and cancellation reaches the host list', async () => {
  const env = environment([], { live: [header('live')] });
  env.persistence.list = async () => { throw new Error('PRIVATE_LIST_PATH_CANARY'); };
  const catalog = new SessionCatalog(env.ctx);
  const page = await catalog.list();
  assert.equal(page.items[0].sessionId, 'live'); assert.equal(page.coverage.listingErrors.length, 1);
  assert.equal(JSON.stringify(page).includes('PRIVATE_LIST_PATH_CANARY'), false);
  const controller = new AbortController();
  env.persistence.list = async ({ signal }) => { assert.equal(signal, controller.signal); controller.abort(); signal.throwIfAborted(); };
  await assert.rejects(catalog.list({}, { signal: controller.signal }), { name: 'AbortError' });
});

test('a large denied directory still yields so cancellation reaches the visibility loop', async () => {
  const controller = new AbortController();
  let inspected = 0;
  const env = environment(Array.from({ length: 1000 }, (_, index) => header(`denied-${index}`)));
  const catalog = new SessionCatalog(env.ctx, { allows() {
    inspected++; if (inspected === 64) setImmediate(() => controller.abort()); return false;
  } });
  await assert.rejects(catalog.list({}, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(inspected >= 64 && inspected < 1000, String(inspected));
});
