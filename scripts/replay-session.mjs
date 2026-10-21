import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { analyzeSession } from '../src/analysis.mjs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/replay-session.mjs /absolute/path/session.v4.jsonl[.zstd]');
  process.exitCode = 2;
} else {
  const content = /\.(?:zstd|zst)$/.test(path)
    ? execFileSync(process.env.ZSTD_BIN ?? 'zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
    : await readFile(path, 'utf8');
  const records = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = performance.now();
  const data = analyzeSession(records);
  console.log(JSON.stringify({
    sessionId: data.sessionId, calls: data.calls.length,
    elapsedMs: Math.round(performance.now() - started),
    latest: data.latest, turns: data.turns, cumulative: data.cumulative, coverage: data.coverage,
    warnings: data.warnings.map(({ turn, step, hitRate, missTokens, cacheReadTokens, lossTokens, changes, recovered }) =>
      ({ turn, step, hitRate, missTokens, cacheReadTokens, lossTokens, changes, recovered })),
  }, null, 2));
}
