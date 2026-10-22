// The content security policy keeps a WebBrowser frame from ever showing a page of the app's own origin (where it could reach the
// form window and its IPC): frame-src allows other sites only. The capability split is tested in Rust (src-tauri/src/lib.rs).
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');   // vitest runs in the project folder

/** What a frame-src value would allow: the app's origins (bundled, Windows-style, dev server) must all be refused. */
function frameAllows(sources: string[], url: string): boolean {
  const u = new URL(url);
  const defaultPort = (u.protocol === 'http:' && (u.port === '' || u.port === '80')) || (u.protocol === 'https:' && (u.port === '' || u.port === '443'));
  return sources.some(s => {
    if (s === "'self'" || s === '*') return true;
    if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return u.protocol === s;   // a scheme source
    const m = /^([a-z]+):\/\/(\*|[^:/]+)(?::(\d+|\*))?$/.exec(s);
    if (!m) throw new Error(`unexpected source ${s}`);
    if (`${m[1]}:` !== u.protocol || (m[2] !== '*' && m[2] !== u.hostname)) return false;
    return m[3] === '*' || (m[3] === undefined ? defaultPort : u.port === m[3]);
  });
}

test('frame-src (tauri.conf.json and the meta tags) allows other sites, never the app itself', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const csp = conf.app.security.csp as Record<string, string>;
  const metas = ['index.html', 'form.html'].map(f => /http-equiv="Content-Security-Policy" content="frame-src ([^"]+)"/.exec(read(f))?.[1]);
  for (const value of [csp['frame-src'], ...metas]) {
    expect(value).toBeTruthy();
    const sources = value!.split(/\s+/);
    for (const own of ['tauri://localhost/form.html', 'http://localhost:1420/form.html', 'http://127.0.0.1:1420/']) expect(frameAllows(sources, own), own).toBe(false);
    for (const site of ['https://example.com/', 'http://example.com/page']) expect(frameAllows(sources, site), site).toBe(true);
  }
  expect(csp['connect-src']).toContain('ipc:');
  expect(csp['connect-src']).toContain('http://ipc.localhost');
  expect(csp['default-src']).not.toContain('*');
});
