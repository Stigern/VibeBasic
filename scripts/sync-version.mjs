// Copies package.json's version into src-tauri/Cargo.toml and the "app" entry of Cargo.lock.
// Wired as the npm `version` lifecycle script so `npm version minor` keeps everything in step.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** Sets `version` in the [package] table of a Cargo.toml text. */
export function syncCargoToml(text, version) {
  let inPackage = false, done = false;
  return text.split('\n').map(line => {
    const t = line.trim();
    if (t.startsWith('[')) inPackage = t === '[package]';
    if (inPackage && !done && /^version\s*=/.test(t)) { done = true; return `version = "${version}"`; }
    return line;
  }).join('\n');
}

/** Sets the version of the package called `name` in a Cargo.lock text. */
export function syncCargoLock(text, name, version) {
  return text.replace(
    new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = )"[^"]*"`),
    `$1"${version}"`,
  );
}

export function syncVersion(root) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const tomlPath = join(root, 'src-tauri', 'Cargo.toml');
  const toml = readFileSync(tomlPath, 'utf8');
  writeFileSync(tomlPath, syncCargoToml(toml, version));
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const lockPath = join(root, 'src-tauri', 'Cargo.lock');
  if (name && existsSync(lockPath)) writeFileSync(lockPath, syncCargoLock(readFileSync(lockPath, 'utf8'), name, version));
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`synced version ${syncVersion(root)}`);
}
