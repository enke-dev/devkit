/**
 * Stages the sidecar and its dependencies as a Tauri resource.
 *
 * Bun (like pnpm) builds `node_modules` out of symlinks into a content-addressed
 * store, which does not survive being copied into an app bundle. This script
 * walks the sidecar's runtime dependency closure and writes a plain, flat
 * `node_modules` that Node can resolve from inside the packaged app.
 *
 * Browser binaries are deliberately not included — they are downloaded on first
 * run, which is what keeps the installer small.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSONSchemaForNPMPackageJsonFiles as Manifest } from '@schemastore/package';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecar = join(root, 'packages/sidecar');
const bundle = join(root, 'src-tauri/sidecar-bundle');

async function readManifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Find the package root that owns a resolved file.
 *
 * A package's entry point can sit any number of directories deep (`dist/index.js`
 * is typical), so the root is whichever ancestor carries the `package.json`.
 */
async function manifestForEntry(entry: string): Promise<string | null> {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  return null;
}

/**
 * Every package the sidecar needs at runtime, keyed by package name.
 *
 * Resolution follows each package's own context rather than the workspace root,
 * so a nested version is found where one exists. Optional dependencies are
 * skipped when missing — they are optional precisely because the code copes.
 */
async function resolveClosure(
  fromManifestPath: string,
  found = new Map(),
): Promise<Map<string, string | null>> {
  const manifest = await readManifest(fromManifestPath);
  const require = createRequire(fromManifestPath);

  const dependencies = Object.keys(manifest.dependencies ?? {});
  await Promise.all(
    dependencies.map(async (name) => {
      if (found.has(name)) return;
      found.set(name, null); // claim the name before recursing, so cycles terminate
      let manifestPath;
      try {
        manifestPath = require.resolve(`${name}/package.json`);
      } catch {
        // A package whose `exports` map omits its manifest still has one; find
        // it by walking up from the entry point instead.
        try {
          manifestPath = await manifestForEntry(require.resolve(name));
        } catch {
          manifestPath = null;
        }
        if (!manifestPath) {
          console.warn(`  ! skipping unresolvable dependency: ${name}`);
          found.delete(name);
          return;
        }
      }
      found.set(name, dirname(manifestPath));
      await resolveClosure(manifestPath, found);
    }),
  );

  return found;
}

const dist = join(sidecar, 'dist');
await readManifest(join(sidecar, 'package.json')).catch(() => {
  throw new Error('Sidecar package.json missing.');
});

await rm(bundle, { recursive: true, force: true });
await mkdir(join(bundle, 'node_modules'), { recursive: true });

await cp(dist, join(bundle, 'dist'), { recursive: true, dereference: true });
// The app spawns exactly this file. A build that put it anywhere else — as a
// `rootDir` change once did, nesting it under `dist/src` — has to fail here,
// where CI sees it, not on the first launch after an update.
if (!existsSync(join(bundle, 'dist', 'index.js'))) {
  throw new Error(`sidecar entry missing at ${join(dist, 'index.js')}; check the sidecar tsconfig`);
}

const closure = await resolveClosure(join(sidecar, 'package.json'));
await Promise.all(
  [...closure]
    .filter(([, source]) => source !== null)
    .map(async ([name, source]) => {
      await cp(source as string, join(bundle, 'node_modules', name), {
        recursive: true,
        // `dereference` turns the store symlinks into real files.
        dereference: true,
        // Nested `node_modules` are skipped: every dependency is copied to the
        // bundle root, and a workspace package's own tree would otherwise drag
        // in the whole toolchain. The test is relative to the package root —
        // store paths like `node_modules/.bun/playwright@1.63.0/node_modules/playwright`
        // contain the segment themselves.
        filter: (from) =>
          !relative(source as string, from)
            .split(sep)
            .includes('node_modules'),
      });
      console.log(`  + ${name}`);
    }),
);

// A manifest marks the directory as a package root, so Node stops looking
// further up the tree — outside the app bundle — when resolving.
const manifest = await readManifest(join(sidecar, 'package.json'));
await writeFile(
  join(bundle, 'package.json'),
  `${JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module' }, null, 2)}\n`,
);

console.log(`sidecar bundle ready: ${bundle} (${closure.size} packages)`);
