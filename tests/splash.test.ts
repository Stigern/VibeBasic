import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { splashVersion } from '../src/splash/splash';

test('the splash shows the version as major.minor', () => {
  expect(splashVersion('0.10.0')).toBe('0.10');
  expect(splashVersion('1.2.13')).toBe('1.2');
  expect(splashVersion('2')).toBe('2');
});

test('splash.html: the version slot and its script, and it is built (vite input)', () => {
  const html = readFileSync('splash.html', 'utf8');
  expect(html).toContain('id="version"');
  expect(html).toContain('src="/src/splash/splash.ts"');
  expect(readFileSync('vite.config.ts', 'utf8')).toContain("splash: 'splash.html'");
});
