/** Runtime policy snapshots. Host ConfigForms owns validation/persistence/CAS. */
export const POLICY_DEFAULTS = Object.freeze({
  minLostTokens: 50_000,
  minLossRatio: 0.2,
  dashboardLimit: 50,
  maxEvents: 200_000,
  maxCachedSessions: 64,
});

export const POLICY_FIELDS = Object.freeze(Object.keys(POLICY_DEFAULTS));

export class PolicyError extends Error {
  constructor(field) {
    super(field ? `缓存策略字段 ${field} 的类型或范围无效。` : '缓存策略必须是配置对象。');
    this.name = 'PolicyError';
    this.code = 'CACHE_HELPER_INVALID_POLICY';
    this.status = 400;
  }
}

function readValue(value) {
  // The Loader hands apply stable Volatile references. Read them once per
  // snapshot; an in-flight request retains the frozen numbers across awaits.
  return value && typeof value.get === 'function' ? value.get() : value;
}

function resolvePolicy(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new PolicyError();
  const values = {};
  for (const field of POLICY_FIELDS) {
    const raw = field === 'minLostTokens' && config.minLossTokens !== undefined
      ? config.minLossTokens : config[field];
    const resolved = readValue(raw);
    const value = resolved === undefined ? POLICY_DEFAULTS[field] : resolved;
    const valid = field === 'minLossRatio'
      ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      : Number.isSafeInteger(value) && value >= 1
        && (!['dashboardLimit', 'maxCachedSessions'].includes(field) || value <= 200);
    if (!valid) throw new PolicyError(field);
    values[field] = value;
  }
  return Object.freeze(values);
}

/**
 * Observe accepted Host config values without reloading the plugin or owning
 * another settings document. A version advances only when effective policy
 * changes; a failed candidate leaves both the source and snapshot unchanged.
 */
export class PolicyStore {
  #config;
  #snapshot;

  constructor(config = {}) {
    this.#config = config;
    this.#snapshot = Object.freeze({ version: 1, values: resolvePolicy(config) });
  }

  snapshot() { return this.#snapshot; }

  updateResolvedConfig(config = this.#config) {
    const values = resolvePolicy(config);
    this.#config = config;
    if (POLICY_FIELDS.every(field => values[field] === this.#snapshot.values[field])) return this.#snapshot;
    this.#snapshot = Object.freeze({ version: this.#snapshot.version + 1, values });
    return this.#snapshot;
  }
}
