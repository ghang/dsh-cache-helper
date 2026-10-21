import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REQUIRED_RUNTIME_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
];

function runtimeError(name, code) {
  return Object.assign(new Error(`DSH runtime check failed for ${name}.`), { code, packageName: name });
}

/**
 * Use the plugin's reproducible local dependencies by default. An existing
 * host installation is opt-in through DSH_CACHE_HELPER_RUNTIME_MODULES only;
 * this module never searches personal profiles, installs or changes packages.
 * Absolute entry paths are internal API data, omitted from CLI diagnostics.
 */
export async function resolveRuntimePackages({ packages = REQUIRED_RUNTIME_PACKAGES } = {}) {
  const modulesRoot = process.env.DSH_CACHE_HELPER_RUNTIME_MODULES;
  const require = modulesRoot
    ? createRequire(join(resolve(modulesRoot), '__cache_helper_validation__.cjs'))
    : createRequire(import.meta.url);
  return Promise.all(packages.map(async name => {
    try {
      const entry = require.resolve(name);
      const manifestPath = require.resolve(`${name}/package.json`);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest.version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(manifest.version)) {
        throw runtimeError(name, 'RUNTIME_MANIFEST_INVALID');
      }
      return { name, version: manifest.version, entry, manifestPath };
    } catch { throw runtimeError(name, 'RUNTIME_RESOLUTION_FAILED'); }
  }));
}

export async function loadRuntime(options) {
  const resolved = await resolveRuntimePackages(options);
  return Object.fromEntries(await Promise.all(resolved.map(async item => {
    try { return [item.name, await import(pathToFileURL(item.entry).href)]; }
    catch { throw runtimeError(item.name, 'RUNTIME_IMPORT_FAILED'); }
  })));
}

function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href; }
  catch { return false; }
}

if (isMain()) {
  try {
    const packages = await resolveRuntimePackages();
    await loadRuntime();
    process.stdout.write(`${JSON.stringify({
      node: process.version,
      source: process.env.DSH_CACHE_HELPER_RUNTIME_MODULES ? 'explicit-existing-installation' : 'plugin-local-dependencies',
      packages: packages.map(({ name, version }) => ({ name, version })),
      status: 'imports-ok',
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Unable to load the DSH runtime (${error.code ?? 'RUNTIME_CHECK_FAILED'}).\n`);
    process.stderr.write('Install the locked plugin development dependencies first. To explicitly test an existing installation, set DSH_CACHE_HELPER_RUNTIME_MODULES to its node_modules directory. No installation was attempted.\n');
    process.exitCode = 1;
  }
}
