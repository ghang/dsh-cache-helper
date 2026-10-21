import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOREPLY = /^(?:\d+\+)?[a-z0-9][a-z0-9-]*@users\.noreply\.github\.com$/i;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EMAILS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi;
const REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS'];
const IDENTITY_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'EMAIL'];

const HELP = `Read-only public Git identity gate; never changes config or pushes.

Usage: node scripts/check-identity.mjs [--repo PATH] [--all | --range REF..HEAD]

  --repo PATH       Exact independent Git worktree root; defaults to this plugin.
                    A parent Lab repository is never discovered implicitly.
  --all             Check commits reachable from every local ref and HEAD.
  --range A..B      Check the explicitly selected two-dot commit range.
  --help            Show this help without inspecting Git or requiring identity.

PUBLIC_GIT_EMAIL must contain the exact GitHub noreply address already checked
in the account settings. No username, account ID, or address is guessed.
The repository must explicitly set local user.name, user.email and
user.useConfigOnly=true. Effective author/committer identities and identity
environment overrides must agree with that local identity.

By default, check upstream..HEAD; without an upstream check all local refs and
HEAD. All reachable annotated tag objects are checked in every mode, including
nested tags. Commit email trailers must use the same approved noreply address.
--all does not include unreachable objects or reflog-only commits.
Shallow repositories are refused; release CI must check out complete history.

Output reports object IDs and problem fields only; it never prints addresses,
names, paths, ref names, commit bodies or raw Git errors. Exit 0 means passed;
exit 1 means blocked. Missing account identity blocks this gate, not a build.
`;

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--all') options.all = true;
    else if (argument === '--repo' || argument === '--range') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      options[argument.slice(2)] = value;
    } else throw new Error('INVALID_ARGUMENTS');
  }
  if (options.all && options.range !== undefined) throw new Error('INVALID_ARGUMENTS');
  return options;
}

function ident(value) {
  const match = /^(.+) <([^<>\r\n]+)> -?\d+ [+-]\d{4}$/.exec(value);
  return match ? { name: match[1], email: match[2] } : null;
}

function emails(value) { return value.match(EMAILS) ?? []; }

/**
 * Call only read-only Git plumbing. Diagnostics deliberately never include the
 * process stderr: it can contain private paths, ref names, messages or emails.
 */
function gitReader(repo, environment) {
  const env = {
    ...environment, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE')) delete env[key];
  return function git(args, { input, optional = false } = {}) {
    const result = spawnSync('git', ['-C', repo, ...args], {
      env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      if (optional) return null;
      throw new Error('GIT_READ_FAILED');
    }
    return result.stdout;
  };
}

export function checkIdentity({
  repo = PLUGIN_ROOT,
  all = false,
  range,
  expectedEmail = process.env.PUBLIC_GIT_EMAIL,
  environment = process.env,
} = {}) {
  const report = {
    status: 'blocked', scope: range === undefined ? all ? 'all' : 'pending' : 'range',
    commitsChecked: 0, annotatedTagsChecked: 0, overrideVariables: [], failures: [],
  };
  const fail = (code, field, object = {}) => report.failures.push({ code, ...(field ? { field } : {}), ...object });
  const finish = () => ({ ...report, status: report.failures.length ? 'blocked' : 'passed' });
  if (all && range !== undefined) { fail('INVALID_ARGUMENTS', 'range'); return finish(); }
  if (typeof expectedEmail !== 'string' || !expectedEmail) fail('PUBLIC_EMAIL_REQUIRED', 'PUBLIC_GIT_EMAIL');
  else if (!NOREPLY.test(expectedEmail) || expectedEmail.trim() !== expectedEmail) fail('INVALID_PUBLIC_EMAIL', 'PUBLIC_GIT_EMAIL');

  const redirects = Object.keys(environment).filter(key => (
    REDIRECT_ENV.includes(key) || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
  ) && environment[key] !== undefined && environment[key] !== '' && !(key === 'GIT_CONFIG_COUNT' && environment[key] === '0'));
  for (const key of redirects) fail('GIT_CONTEXT_OVERRIDE', key);
  if (redirects.length) return finish();

  let root;
  try {
    root = realpathSync(resolve(repo));
    // Presence is checked before invoking Git so this plugin can never fall
    // through to its parent Lab's .git and accidentally audit that history.
    const marker = lstatSync(join(root, '.git'));
    if (!marker.isDirectory() && !marker.isFile()) throw new Error();
  } catch { fail('INDEPENDENT_REPOSITORY_REQUIRED', 'repository'); return finish(); }
  const git = gitReader(root, environment);
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    if (realpathSync(top) !== root || git(['rev-parse', '--is-bare-repository']).trim() !== 'false') {
      fail('INDEPENDENT_REPOSITORY_REQUIRED', 'repository');
      return finish();
    }
    if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
      fail('COMPLETE_HISTORY_REQUIRED', 'repository');
      return finish();
    }
    if (report.failures.length) return finish();

    const local = key => {
      const value = git(['config', '--local', '--get-all', key], { optional: true });
      return value === null ? [] : value.trimEnd().split('\n');
    };
    const names = local('user.name');
    const addresses = local('user.email');
    const only = local('user.useConfigOnly');
    const localName = names.length === 1 ? names[0] : null;
    if (!localName || emails(localName).length) fail('LOCAL_IDENTITY_REQUIRED', 'user.name');
    if (addresses.length !== 1 || addresses[0] !== expectedEmail) fail('LOCAL_IDENTITY_REQUIRED', 'user.email');
    if (only.length !== 1 || !/^(true|yes|on|1)$/i.test(only[0])) fail('LOCAL_IDENTITY_REQUIRED', 'user.useConfigOnly');

    for (const key of IDENTITY_ENV) {
      const value = environment[key];
      if (value === undefined || value === '') continue;
      report.overrideVariables.push(key);
      if (key === 'EMAIL' || key.endsWith('_EMAIL')) {
        if (value !== expectedEmail) fail('UNAPPROVED_ENV_IDENTITY', key);
      } else if (key.endsWith('_NAME') && value !== localName) fail('UNAPPROVED_ENV_IDENTITY', key);
    }
    for (const [kind, variable] of [['author', 'GIT_AUTHOR_IDENT'], ['committer', 'GIT_COMMITTER_IDENT']]) {
      const value = ident(git(['var', variable]).trim());
      if (!value) fail('INVALID_EFFECTIVE_IDENTITY', `${kind}.ident`);
      else {
        if (value.email !== expectedEmail) fail('UNAPPROVED_EFFECTIVE_IDENTITY', `${kind}.email`);
        if (!localName || value.name !== localName) fail('UNAPPROVED_EFFECTIVE_IDENTITY', `${kind}.name`);
      }
    }

    const head = git(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], { optional: true })?.trim();
    let selected;
    if (range !== undefined) {
      const match = /^(.+)\.\.([^.].*)$/.exec(range);
      if (!match || match[1].endsWith('.') || /[\r\n\0]/.test(range)) {
        fail('INVALID_RANGE', 'range');
        return finish();
      }
      const base = git(['rev-parse', '--verify', '--end-of-options', `${match[1]}^{commit}`], { optional: true })?.trim();
      const tip = git(['rev-parse', '--verify', '--end-of-options', `${match[2]}^{commit}`], { optional: true })?.trim();
      if (!base || !tip || !OBJECT_ID.test(base) || !OBJECT_ID.test(tip)) {
        fail('INVALID_RANGE', 'range');
        return finish();
      }
      selected = git(['rev-list', `${base}..${tip}`]);
    } else if (head) {
      const upstream = all ? null : git(['rev-parse', '--verify', '--end-of-options', '@{upstream}^{commit}'], { optional: true })?.trim();
      if (upstream && OBJECT_ID.test(upstream)) selected = git(['rev-list', `${upstream}..${head}`]);
      else {
        report.scope = 'all';
        selected = git(['rev-list', '--all', head]);
      }
    } else {
      // An unborn branch can still validate its identity before first commit.
      report.scope = 'all';
      selected = git(['rev-list', '--all']);
    }
    const commits = [...new Set(selected.trim().split('\n').filter(Boolean))];
    const validateAddress = (value, field, object) => {
      if (value !== expectedEmail) fail('UNAPPROVED_EMAIL', field, object);
    };
    const validateTrailers = (body, object) => {
      const trailers = git(['interpret-trailers', '--parse'], { input: body });
      for (const address of emails(trailers)) validateAddress(address, 'trailer.email', object);
    };
    for (const commit of commits) {
      if (!OBJECT_ID.test(commit)) throw new Error('GIT_READ_FAILED');
      const text = git(['cat-file', 'commit', commit]);
      const boundary = text.indexOf('\n\n');
      const header = boundary < 0 ? text : text.slice(0, boundary);
      for (const kind of ['author', 'committer']) {
        const value = ident(new RegExp(`^${kind} (.+)$`, 'm').exec(header)?.[1] ?? '');
        if (!value) fail('INVALID_COMMIT_IDENTITY', `${kind}.ident`, { commit });
        else {
          validateAddress(value.email, `${kind}.email`, { commit });
          if (emails(value.name).length) fail('IDENTITY_NAME_CONTAINS_EMAIL', `${kind}.name`, { commit });
        }
      }
      validateTrailers(boundary < 0 ? '' : text.slice(boundary + 2), { commit });
      report.commitsChecked += 1;
    }

    const tagRefs = git(['for-each-ref', '--format=%(objectname) %(objecttype)', 'refs/tags']);
    const queue = tagRefs.trim().split('\n').map(line => line.split(' ')).filter(([, type]) => type === 'tag').map(([oid]) => oid);
    const visited = new Set();
    for (const tag of queue) {
      if (visited.has(tag)) continue;
      if (!OBJECT_ID.test(tag)) throw new Error('GIT_READ_FAILED');
      visited.add(tag);
      const text = git(['cat-file', 'tag', tag]);
      const boundary = text.indexOf('\n\n');
      const header = boundary < 0 ? text : text.slice(0, boundary);
      const value = ident(/^tagger (.+)$/m.exec(header)?.[1] ?? '');
      if (!value) fail('INVALID_TAG_IDENTITY', 'tagger.ident', { tag });
      else {
        validateAddress(value.email, 'tagger.email', { tag });
        if (emails(value.name).length) fail('IDENTITY_NAME_CONTAINS_EMAIL', 'tagger.name', { tag });
      }
      validateTrailers(boundary < 0 ? '' : text.slice(boundary + 2), { tag });
      if (/^type tag$/m.test(header)) queue.push(/^object (.+)$/m.exec(header)?.[1] ?? '');
      report.annotatedTagsChecked += 1;
    }
  } catch { fail('GIT_READ_FAILED', 'git'); }
  return finish();
}

function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href; }
  catch { return false; }
}

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      const report = checkIdentity(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.status === 'passed' ? 0 : 1;
    }
  } catch {
    process.stderr.write('Identity gate blocked: invalid arguments. Use --help.\n');
    process.exitCode = 1;
  }
}
