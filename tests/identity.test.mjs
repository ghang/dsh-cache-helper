import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/check-identity.mjs', import.meta.url));
// Deliberately synthetic identities: these never configure a user's repository.
const APPROVED = '123456+fixture-user@users.noreply.github.com';
const PRIVATE = 'synthetic-private@company.invalid';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cache-helper-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_(?:AUTHOR|COMMITTER)_|GIT_CONFIG(?:_|$)|GIT_(?:DIR|WORK_TREE|COMMON_DIR)$|GIT_TRACE|EMAIL$|PUBLIC_GIT_EMAIL$)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', PUBLIC_GIT_EMAIL: APPROVED,
  });
  function git(args, overrides = {}) {
    const result = spawnSync('git', ['-C', root, ...args], { env: { ...env, ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Synthetic Git fixture setup failed');
    return result.stdout.trim();
  }
  git(['init', '--quiet']);
  git(['config', '--local', 'user.name', 'Fixture User']);
  git(['config', '--local', 'user.email', APPROVED]);
  git(['config', '--local', 'user.useConfigOnly', 'true']);
  function gate({ args = [], overrides = {}, repo = root, status = 1 } = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, '--repo', repo, ...args], {
      env: { ...env, ...overrides }, encoding: 'utf8',
    });
    assert.equal(result.status, status, 'Unexpected identity gate exit status');
    const output = `${result.stdout}${result.stderr}`;
    for (const value of [APPROVED, PRIVATE, root]) assert.ok(!output.includes(value), 'Identity diagnostics must omit addresses and private paths');
    return { report: JSON.parse(result.stdout), output };
  }
  return { root, env, git, gate };
}

function problem(report, field, object = {}) {
  assert.ok(report.failures.some(failure => failure.field === field
    && Object.entries(object).every(([key, value]) => failure[key] === value)), `Missing redacted problem field: ${field}`);
}

test('identity gate refuses a nested plugin without its own .git instead of scanning its parent', t => {
  const f = fixture(t);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic parent history']);
  const parentCommit = f.git(['rev-parse', 'HEAD']);
  const plugin = join(f.root, 'plugins', 'local', 'synthetic-plugin');
  mkdirSync(plugin, { recursive: true });
  const { report, output } = f.gate({ repo: plugin, args: ['--all'] });
  problem(report, 'repository');
  assert.equal(report.commitsChecked, 0);
  assert.ok(!output.includes(parentCommit), 'Parent history must never be inspected implicitly');
});

test('an exact local noreply passes; effective environment overrides and shallow history are refused', t => {
  const f = fixture(t);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Approved synthetic commit']);
  const { report } = f.gate({ args: ['--all'], status: 0 });
  assert.equal(report.status, 'passed');
  assert.equal(report.commitsChecked, 1);
  for (const key of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
    problem(f.gate({ overrides: { [key]: PRIVATE } }).report, key);
  }
  writeFileSync(join(f.root, '.git', 'shallow'), `${f.git(['rev-parse', 'HEAD'])}\n`);
  assert.ok(f.gate({ args: ['--all'] }).report.failures.some(failure => failure.code === 'COMPLETE_HISTORY_REQUIRED'));
});

test('the gate cannot infer a noreply or accept inherited global identity as repository-local', t => {
  const f = fixture(t);
  problem(f.gate({ overrides: { PUBLIC_GIT_EMAIL: '' } }).report, 'PUBLIC_GIT_EMAIL');
  problem(f.gate({ overrides: { PUBLIC_GIT_EMAIL: PRIVATE } }).report, 'PUBLIC_GIT_EMAIL');
  const global = join(f.root, 'synthetic-global-config');
  writeFileSync(global, `[user]\n  name = Fixture User\n  email = ${APPROVED}\n`);
  f.git(['config', '--local', '--unset', 'user.email']);
  problem(f.gate({ overrides: { GIT_CONFIG_GLOBAL: global } }).report, 'user.email');
});

test('--all checks old raw author and committer addresses despite a clean HEAD and mailmap', t => {
  const f = fixture(t);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic old author'], { GIT_AUTHOR_EMAIL: PRIVATE });
  const author = f.git(['rev-parse', 'HEAD']);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic old committer'], { GIT_COMMITTER_EMAIL: PRIVATE });
  const committer = f.git(['rev-parse', 'HEAD']);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Clean synthetic HEAD']);
  writeFileSync(join(f.root, '.mailmap'), `Fixture User <${APPROVED}> <${PRIVATE}>\n`);
  const { report } = f.gate({ args: ['--all'] });
  assert.equal(report.commitsChecked, 3);
  problem(report, 'author.email', { commit: author });
  problem(report, 'committer.email', { commit: committer });
});

test('email trailers block full history while an explicit clean range and pending scope remain precise', t => {
  const f = fixture(t);
  f.git(['commit', '--quiet', '--allow-empty', '-m', `Synthetic coauthor\n\nCo-authored-by: Fixture <${PRIVATE}>`]);
  const trailer = f.git(['rev-parse', 'HEAD']);
  f.git(['commit', '--quiet', '--allow-empty', '-m', `Approved trailer\n\nSigned-off-by: Fixture <${APPROVED}>`]);
  problem(f.gate({ args: ['--all'] }).report, 'trailer.email', { commit: trailer });
  assert.equal(f.gate({ args: ['--range', `${trailer}..HEAD`], status: 0 }).report.commitsChecked, 1);
  f.git(['branch', '-M', 'main']);
  f.git(['branch', 'synthetic-upstream', trailer]);
  f.git(['branch', '--set-upstream-to=synthetic-upstream', 'main']);
  const pending = f.gate({ status: 0 }).report;
  assert.equal(pending.scope, 'pending');
  assert.equal(pending.commitsChecked, 1);
});

test('annotated taggers are checked through nested tags even when the selected commit range is empty', t => {
  const f = fixture(t);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Approved synthetic commit']);
  f.git(['tag', '-a', 'synthetic-inner', '-m', 'Unapproved inner tagger'], { GIT_COMMITTER_EMAIL: PRIVATE });
  const inner = f.git(['rev-parse', 'refs/tags/synthetic-inner']);
  f.git(['tag', '-a', 'synthetic-outer', 'synthetic-inner', '-m', 'Approved outer tagger']);
  f.git(['tag', '-d', 'synthetic-inner']);
  const { report } = f.gate({ args: ['--range', 'HEAD..HEAD'] });
  assert.equal(report.commitsChecked, 0);
  assert.equal(report.annotatedTagsChecked, 2);
  problem(report, 'tagger.email', { tag: inner });
});
