import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { syncCargoLock, syncCargoToml, syncVersion } from '../../scripts/sync-version.mjs';

const TOML = '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1" }\nfoo = "1"\n[build-dependencies]\nversion = "9"\n';
const LOCK = '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "other",\n]\n';

test('syncCargoToml only touches the [package] version', () => {
  const out = syncCargoToml(TOML, '0.7.0');
  expect(out).toContain('[package]\nname = "app"\nversion = "0.7.0"\n');
  expect(out).toContain('serde = { version = "1" }');
  expect(out).toContain('[build-dependencies]\nversion = "9"');
});

test('syncCargoLock only touches the named package', () => {
  const out = syncCargoLock(LOCK, 'app', '0.7.0');
  expect(out).toContain('name = "other"\nversion = "1.0.0"');
  expect(out).toContain('name = "app"\nversion = "0.7.0"');
});

test('syncVersion copies package.json version into a temp tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'vb-sync-'));
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'package.json'), '{"version":"2.3.4"}');
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), TOML);
  writeFileSync(join(root, 'src-tauri', 'Cargo.lock'), LOCK);
  expect(syncVersion(root)).toBe('2.3.4');
  expect(readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8')).toContain('version = "2.3.4"\nedition');
  expect(readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8')).toContain('name = "app"\nversion = "2.3.4"');
});

test('package.json, Cargo.toml and tauri.conf.json agree', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
  expect(readFileSync('src-tauri/Cargo.toml', 'utf8')).toContain(`version = "${pkg}"`);
  expect(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version).toBe('../package.json');
  expect(__APP_VERSION__).toBe(pkg);
});
