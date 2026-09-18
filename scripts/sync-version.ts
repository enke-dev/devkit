/**
 * Carry the version in `package.json` into the three places a Tauri app repeats
 * it.
 *
 * `release-it` owns `package.json`; the crate, its lockfile entry and the bundle
 * config each keep their own copy, and a mismatch between them is only noticed
 * at build time — or, for `tauri.conf.json`, not at all until an update refuses
 * to install because the version it announces is not the version it is.
 *
 * Written as a script rather than as `sed` in a hook so it behaves the same on
 * the machine that cuts a release by hand and on the runner that does it for a
 * push.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const write = (file: string, contents: string) =>
  writeFileSync(join(root, file), contents);

const { version, name } = JSON.parse(read('package.json'));
if (!version) {
  throw new Error('package.json has no version to carry anywhere');
}

// The crate's own version.
const cargo = read('src-tauri/Cargo.toml');
const bumpedCargo = cargo.replace(
  /^version = "[^"]*"/m,
  `version = "${version}"`,
);
if (bumpedCargo === cargo && !cargo.includes(`version = "${version}"`)) {
  throw new Error('no version field found in src-tauri/Cargo.toml');
}
write('src-tauri/Cargo.toml', bumpedCargo);

// The lockfile's entry for the crate itself, which would otherwise be rewritten
// by the next build and dirty the release commit.
const lock = read('src-tauri/Cargo.lock');
write(
  'src-tauri/Cargo.lock',
  lock.replace(/(\nname = "devkit"\nversion = )"[^"]*"/, `$1"${version}"`),
);

// What the bundle announces, and what the updater compares against.
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
conf.version = version;
write('src-tauri/tauri.conf.json', `${JSON.stringify(conf, null, 2)}\n`);

console.log(
  `${name} ${version}: carried into Cargo.toml, Cargo.lock and tauri.conf.json`,
);
