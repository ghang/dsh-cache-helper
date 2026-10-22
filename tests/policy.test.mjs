import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_DEFAULTS, POLICY_FIELDS, PolicyStore } from '../src/policy.mjs';

test('policy snapshots expose only validated fields and are immutable', () => {
  const policy = new PolicyStore({ registerHttp: false, persistState: false });
  const snapshot = policy.snapshot();
  assert.deepEqual(snapshot, { version: 1, values: POLICY_DEFAULTS });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.values));
  assert.ok(Object.isFrozen(POLICY_FIELDS));
  assert.throws(() => { snapshot.values.minLossRatio = 1; }, TypeError);
  assert.equal(snapshot.values.registerHttp, undefined);
});

test('a volatile update affects future snapshots while a pending request keeps its original policy', () => {
  let threshold = 50_000;
  const raw = { minLostTokens: { get: () => threshold } };
  const policy = new PolicyStore(raw);
  const pending = policy.snapshot();
  threshold = 80_000;
  assert.equal(policy.snapshot(), pending, 'Only the accepted Host update advances the policy');
  const next = policy.updateResolvedConfig();
  assert.equal(next.version, 2);
  assert.equal(next.values.minLostTokens, 80_000);
  assert.equal(pending.version, 1);
  assert.equal(pending.values.minLostTokens, 50_000);
  assert.equal(policy.updateResolvedConfig({ minLostTokens: 80_000 }), next, 'Equal saves do not invalidate analysis');
  assert.equal(policy.updateResolvedConfig({}).version, 3);
});

test('invalid types and ranges never replace the accepted policy or its config source', () => {
  const policy = new PolicyStore({ minLostTokens: 80_000 });
  const accepted = policy.snapshot();
  const invalid = [
    null, [], 'config',
    { minLostTokens: '50000' }, { minLostTokens: null }, { minLostTokens: 0 }, { minLostTokens: 1.5 },
    { minLostTokens: Number.MAX_SAFE_INTEGER + 1 },
    { minLossRatio: NaN }, { minLossRatio: Infinity }, { minLossRatio: -0.01 }, { minLossRatio: 1.01 },
    { dashboardLimit: 201 }, { dashboardLimit: false }, { maxEvents: -1 }, { maxCachedSessions: 201 },
    { minLostTokens: 2, minLossRatio: '0.5' },
  ];
  for (const config of invalid) {
    assert.throws(() => policy.updateResolvedConfig(config), { code: 'CACHE_HELPER_INVALID_POLICY', status: 400 });
    assert.equal(policy.snapshot(), accepted);
  }
  assert.equal(policy.updateResolvedConfig(), accepted, 'An invalid update cannot replace the prior source');
});

test('zero and one ratio boundaries and inherited defaults remain valid', () => {
  const policy = new PolicyStore({ minLossRatio: 0, dashboardLimit: 200, maxCachedSessions: 200 });
  assert.equal(policy.snapshot().values.minLossRatio, 0);
  assert.equal(policy.updateResolvedConfig({ minLossRatio: 1 }).values.minLossRatio, 1);
  assert.equal(policy.updateResolvedConfig({ minLostTokens: undefined }).values.minLostTokens, 50_000);
});

test('legacy minLossTokens is accepted without mutating the input config', () => {
  const raw = Object.freeze({ minLossTokens: 12_000, minLostTokens: 99_000 });
  const policy = new PolicyStore(raw);
  assert.equal(policy.snapshot().values.minLostTokens, 12_000);
  assert.equal(raw.minLostTokens, 99_000);
  assert.equal(policy.snapshot().values.minLossTokens, undefined);
});
