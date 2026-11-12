import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { cleanup, makeApp } from './helpers.js';

let app;
let dataDir;
const extra = [];

beforeAll(async () => {
  ({ app, dataDir } = await makeApp());
});

afterAll(async () => {
  for (const e of [{ app, dataDir }, ...extra]) {
    if (!e.app) continue;
    await e.app.close();
    cleanup(e.dataDir);
  }
});

test('health', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4747' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('creates data folders and tables', () => {
  expect(fs.existsSync(path.join(dataDir, 'vault'))).toBe(true);
  expect(fs.existsSync(path.join(dataDir, 'thumbs'))).toBe(true);
  const names = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  expect(names).toEqual(expect.arrayContaining(['planets', 'stars', 'meta']));
});

test('planets table has the ring column', () => {
  const cols = app.db.prepare("SELECT name FROM pragma_table_info('planets')").all().map((r) => r.name);
  expect(cols).toContain('ring');
});

test('rejects foreign Host', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: 'evil.example' } });
  expect(res.statusCode).toBe(403);
});

test('allows localhost Host on the server port', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: 'localhost:4747' } });
  expect(res.statusCode).toBe(200);
});

test('rejects cross-site fetch without Origin', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4747', 'sec-fetch-site': 'cross-site' } });
  expect(res.statusCode).toBe(403);
});
test('allows same-origin fetch metadata', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4747', 'sec-fetch-site': 'same-origin' } });
  expect(res.statusCode).toBe(200);
});
test('malformed allowedOrigins throws before opening the db', async () => {
  await expect(makeApp({ allowedOrigins: ['not a url'] })).rejects.toThrow();
});
test('rejects foreign Origin', async () => {
  const res = await app.inject({
    url: '/api/health',
    headers: { host: '127.0.0.1:4747', origin: 'http://evil.example' },
  });
  expect(res.statusCode).toBe(403);
});

test('allows same-origin Origin', async () => {
  const res = await app.inject({
    url: '/api/health',
    headers: { host: '127.0.0.1:4747', origin: 'http://127.0.0.1:4747' },
  });
  expect(res.statusCode).toBe(200);
});

test('rejects dev origin when not configured', async () => {
  const res = await app.inject({
    url: '/api/health',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  expect(res.statusCode).toBe(403);
});

test('allows configured dev origin', async () => {
  const made = await makeApp({ allowedOrigins: ['http://localhost:5173'] });
  extra.push(made);
  const { app: a2 } = made;
  const res = await a2.inject({
    url: '/api/health',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  expect(res.statusCode).toBe(200);
});
