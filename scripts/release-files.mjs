import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';

// This is the complete public source projection, never a copy of the Lab tree.
const SOURCE_FILES = ['package.json', 'package-lock.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', 'screenshots.json'];
const SOURCE_DIRS = ['src', 'tests', 'scripts', 'docs', '.github'];
export const RUNTIME_FILES = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const redactedPath = value => value.replace(EMAIL_PATTERN, '[redacted-email]');
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
  return RUNTIME_FILES.has(file) || /^lib\/[\w-]+\.(?:mjs|js|css)$/.test(file) || file.startsWith('docs/');
}

// Conservative content gate: errors report only filenames/line numbers, never
// the matched personal value. Synthetic example/invalid domains are permitted.
export async function auditFiles(root, files) {
  const issues = [];
  for (const file of files) {
    if (privateEmail(file)) { issues.push({ file: redactedPath(file), rule: 'non-public-email-in-path' }); continue; }
    if (/(^|\/)(?:node_modules|vendor|\.git|\.dsh|out|\.release)(\/|$)|(^|\/)\.env(?:\.|$)|credentials|\.pem$|\.key$/i.test(file)) {
      issues.push({ file, rule: 'private-path' }); continue;
    }
    const buffer = await readFile(join(root, file));
    if (buffer.length > 2 * 1024 * 1024) issues.push({ file, rule: 'large-file' });
    if (/\.(?:png|webp|jpe?g)$/i.test(file)) continue; // Images also require human/synthetic-fixture review.
    if (buffer.includes(0)) { issues.push({ file, rule: 'unexpected-binary' }); continue; }
    const content = buffer.toString('utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (/\/(?:Users|home)\/[^\s/'"<>]+\/|\/private\/var\/folders\//.test(line)) issues.push({ file, line: index + 1, rule: 'personal-absolute-path' });
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9]{24,}/.test(line)) issues.push({ file, line: index + 1, rule: 'credential-pattern' });
      if (privateEmail(line)) issues.push({ file, line: index + 1, rule: 'non-public-email' });
    });
    // Public Markdown links must remain inside the exported source/package.
    if (file.endsWith('.md')) {
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split(/[ #]/)[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(file), target));
        if (resolved.startsWith('../') || resolved.startsWith('/')) issues.push({ file, rule: 'link-outside-public-root' });
        else if (!files.includes(resolved)) issues.push({ file, rule: `missing-link-target:${redactedPath(resolved)}` });
      }
    }
    if (file === 'package-lock.json') {
      const lock = JSON.parse(content);
      for (const entry of Object.values(lock.packages ?? {})) {
        if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) issues.push({ file, rule: 'non-public-dependency-source' });
        if (entry.link) issues.push({ file, rule: 'linked-dependency' });
      }
    }
  }
  if (issues.length) throw new Error(`Public content gate failed:\n${issues.map(item => JSON.stringify(item)).join('\n')}`);
  return { files: files.length, rules: ['paths', 'emails', 'credential-patterns', 'size', 'relative-links', 'public-lockfile'] };
}
