import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';

// This is the complete public source projection, never a copy of the Lab tree.
const SOURCE_FILES = ['package.json', 'package-lock.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', 'screenshots.json'];
const SOURCE_DIRS = ['src', 'tests', 'scripts', 'docs', '.github'];
export const RUNTIME_FILES = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const CREDENTIAL_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9]{24,}|\bnpm_[A-Za-z0-9]{20,}/;
const AUTH_PARAMETER = /^(?:token|access[_-]?token|auth(?:[_-]?token)?|api[_-]?key)$/i;
const redactedPath = value => value.replace(EMAIL_PATTERN, '[redacted-email]')
  .replace(new RegExp(CREDENTIAL_PATTERN.source, 'g'), '[redacted-credential]')
  .replace(/([?&#](?:token|access[_-]?token|auth(?:[_-]?token)?|api[_-]?key)=)[^/\s&#]+/gi, '$1[redacted-credential]');

function privatePath(file) {
  return /(^|\/)(?:node_modules|vendor|\.git|\.dsh|\.ssh|\.aws|out|\.release|profiles|sessions|storages)(\/|$)|(^|\/)\.(?:env|npmrc|yarnrc|netrc|pypirc)(?:[.-]|$)|credentials|(^|\/)(?:auth|secrets?|tokens?)\.(?:json|ya?ml|ini|toml)$|(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:pem|key)$|\.jsonl(?:\.(?:zstd?|gz))?$/i.test(file);
}

function authenticatedLoopbackUrl(line) {
  for (const match of line.matchAll(/\bhttps?:\/\/[^\s<>"'`\\)]+/gi)) {
    let url;
    try { url = new URL(match[0]); } catch { continue; }
    if (!/^(?:localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)) continue;
    if (url.username || url.password) return true;
    for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
      for (const [key, value] of parameters) if (AUTH_PARAMETER.test(key) && value) return true;
    }
  }
  return false;
}
function privateEmail(value) {
  return [...value.matchAll(EMAIL_PATTERN)].some(match => {
    const domain = match[1].toLowerCase();
    return domain !== 'users.noreply.github.com' && !/(?:^|\.)example\.(?:com|org|net)$|\.invalid$/.test(domain);
  });
}

export async function sourceFiles(root) {
  const result = [];
  async function visit(relative, optional = false) {
    const path = join(root, relative);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Public source contains a symbolic link: ${redactedPath(relative)}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(posix.join(relative, name));
    } else if (stat.isFile()) result.push(relative);
    else throw new Error(`Unsupported public source entry: ${redactedPath(relative)}`);
  }
  for (const file of SOURCE_FILES) await visit(file, file === 'screenshots.json');
  for (const directory of SOURCE_DIRS) await visit(directory);
  return result.sort();
}

export async function sourceDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(await readFile(join(root, file))).update('\0');
  return hash.digest('hex');
}

export function runtimeFileAllowed(file) {
  return !privatePath(file) && (RUNTIME_FILES.has(file) || /^lib\/[\w-]+\.(?:mjs|js|css)$/.test(file) || file.startsWith('docs/'));
}

// Conservative content gate: errors report only filenames/line numbers, never
// the matched personal value. Synthetic example/invalid domains are permitted.
export async function auditFiles(root, files) {
  const issues = [];
  for (const file of files) {
    if (privateEmail(file)) { issues.push({ file: redactedPath(file), rule: 'non-public-email-in-path' }); continue; }
    if (CREDENTIAL_PATTERN.test(file)) { issues.push({ file: redactedPath(file), rule: 'credential-pattern-in-path' }); continue; }
    if (privatePath(file)) {
      issues.push({ file: redactedPath(file), rule: 'private-path' }); continue;
    }
    const buffer = await readFile(join(root, file));
    if (buffer.length > 2 * 1024 * 1024) issues.push({ file: redactedPath(file), rule: 'large-file' });
    if (/\.(?:png|webp|jpe?g)$/i.test(file)) continue; // Images also require human/synthetic-fixture review.
    if (buffer.includes(0)) { issues.push({ file: redactedPath(file), rule: 'unexpected-binary' }); continue; }
    const content = buffer.toString('utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (/\/(?:Users|home)\/[^\s/'"<>]+\/|\/private\/var\/folders\//.test(line)) issues.push({ file: redactedPath(file), line: index + 1, rule: 'personal-absolute-path' });
      if (CREDENTIAL_PATTERN.test(line)) issues.push({ file: redactedPath(file), line: index + 1, rule: 'credential-pattern' });
      if (authenticatedLoopbackUrl(line)) issues.push({ file: redactedPath(file), line: index + 1, rule: 'authenticated-loopback-url' });
      if (privateEmail(line)) issues.push({ file: redactedPath(file), line: index + 1, rule: 'non-public-email' });
    });
    // Public Markdown links must remain inside the exported source/package.
    if (file.endsWith('.md')) {
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split(/[ #]/)[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(file), target));
        if (resolved.startsWith('../') || resolved.startsWith('/')) issues.push({ file: redactedPath(file), rule: 'link-outside-public-root' });
        else if (!files.includes(resolved)) issues.push({ file: redactedPath(file), rule: 'missing-link-target' });
      }
    }
    if (file === 'package-lock.json') {
      let lock;
      try { lock = JSON.parse(content); }
      catch { issues.push({ file: redactedPath(file), rule: 'invalid-lockfile' }); continue; }
      for (const entry of Object.values(lock.packages ?? {})) {
        if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) issues.push({ file: redactedPath(file), rule: 'non-public-dependency-source' });
        if (entry.link) issues.push({ file: redactedPath(file), rule: 'linked-dependency' });
      }
    }
  }
  if (issues.length) throw new Error(`Public content gate failed:\n${issues.map(item => JSON.stringify(item)).join('\n')}`);
  return { files: files.length, rules: ['paths', 'emails', 'credential-patterns', 'authenticated-loopback-urls', 'size', 'relative-links', 'public-lockfile'] };
}
