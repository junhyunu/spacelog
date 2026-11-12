import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { COLOR_COUNT, DECOS, createPlanet } from '../planets.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };

let app;
let dataDir;

beforeEach(async () => {
  ({ app, dataDir } = await makeApp());
});

afterEach(async () => {
  await app.close();
  cleanup(dataDir);
});

function call(method, url, payload) {
  return app.inject({ method, url, headers: HOST, ...(payload === undefined ? {} : { payload }) });
}

async function create(body = { name: '행성' }) {
  const res = await call('POST', '/api/planets', body);
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function list(query = '') {
  const res = await call('GET', `/api/planets${query}`);
  expect(res.statusCode).toBe(200);
  return res.json();
}

function addStar(planetId, createdAt = new Date().toISOString()) {
  const id = crypto.randomUUID();
  app.db
    .prepare("INSERT INTO stars (id, type, title, body, planet_id, created_at) VALUES (?, 'text', ?, ?, ?, ?)")
    .run(id, '별', '본문', planetId, createdAt);
  return id;
}

function starCount(planetId) {
  return app.db.prepare('SELECT COUNT(*) AS c FROM stars WHERE planet_id = ?').get(planetId).c;
}

test('exports the look tables', () => {
  expect(COLOR_COUNT).toBe(16);
  expect(DECOS).toEqual(['town', 'crystal', 'forest', 'rock', 'ice', 'volcano', 'mushroom', 'cactus', 'flower', 'cloud']);
  expect(typeof createPlanet).toBe('function');
});

test('first planet gets color 1, town, no ring, slot 0', async () => {
  const p = await create({ name: '첫 행성' });
  expect(p).toEqual({
    id: expect.any(String),
    name: '첫 행성',
    description: '',
    color_index: 1,
    deco: 'town',
    ring: false,
    slot: 0,
    count_in_period: 0,
    count_total: 0,
  });
});

test('second planet has a ring', async () => {
  await create();
  const p = await create();
  expect(p.ring).toBe(true);
  expect(p.deco).toBe('crystal');
  expect(p.color_index).toBe(2);
  expect(p.slot).toBe(1);
});

test('17th planet wraps to color 1 but deco is not town', async () => {
  let p;
  for (let i = 0; i < 17; i++) p = await create({ name: `p${i}` });
  expect(p.color_index).toBe(1);
  expect(p.deco).toBe('mushroom');
  expect(p.deco).toBe(DECOS[6]);
  expect(p.slot).toBe(16);
});

test('first 80 planets have unique colour+deco pairs', async () => {
  const pairs = new Set();
  for (let i = 0; i < 80; i++) {
    const p = await create({ name: `p${i}` });
    pairs.add(`${p.color_index}:${p.deco}`);
  }
  expect(pairs.size).toBe(80);
});

test('deleted slot is reused, look sequence is not', async () => {
  await create({ name: 'a' });
  const b = await create({ name: 'b' });
  await create({ name: 'c' });
  expect(b.slot).toBe(1);
  const del = await call('DELETE', `/api/planets/${b.id}`);
  expect(del.statusCode).toBe(204);
  const d = await create({ name: 'd' });
  expect(d.slot).toBe(1);
  expect(d.color_index).toBe(4);
  expect(d.deco).toBe('rock');
  expect(d.ring).toBe(false);
});

test('next-look matches what the next POST assigns', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await call('GET', '/api/planets/next-look');
    expect(res.statusCode).toBe(200);
    const look = res.json();
    expect(Object.keys(look).sort()).toEqual(['color_index', 'deco', 'ring']);
    const p = await create({ name: `p${i}` });
    expect({ color_index: p.color_index, deco: p.deco, ring: p.ring }).toEqual(look);
  }
});

test('POST with explicit look uses it', async () => {
  const p = await create({ name: '꾸민 행성', color_index: 12, deco: 'cloud', ring: true });
  expect(p.color_index).toBe(12);
  expect(p.deco).toBe('cloud');
  expect(p.ring).toBe(true);
  // 일부만 주면 나머지는 자동 배정 (n=1)
  const q = await create({ name: '반만', deco: 'ice' });
  expect(q.deco).toBe('ice');
  expect(q.color_index).toBe(2);
  expect(q.ring).toBe(true);
});

test('invalid look → 400 invalid_look', async () => {
  const bad = [{ color_index: 0 }, { color_index: 17 }, { color_index: 1.5 }, { color_index: '3' }, { deco: 'x' }, { ring: 'yes' }];
  for (const look of bad) {
    const res = await call('POST', '/api/planets', { name: '행성', ...look });
    expect(res.statusCode, JSON.stringify(look)).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_look' });
  }
  expect(await list()).toEqual([]);

  const p = await create();
  for (const look of bad) {
    const res = await call('PATCH', `/api/planets/${p.id}`, look);
    expect(res.statusCode, JSON.stringify(look)).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_look' });
  }
});

test('PATCH changes look', async () => {
  const p = await create();
  const res = await call('PATCH', `/api/planets/${p.id}`, { color_index: 9, deco: 'flower', ring: true });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...p, color_index: 9, deco: 'flower', ring: true });
  expect((await list())[0]).toEqual({ ...p, color_index: 9, deco: 'flower', ring: true });
});

test('PATCH unknown id → 404', async () => {
  const res = await call('PATCH', '/api/planets/nope', { name: 'x' });
  expect(res.statusCode).toBe(404);
});

test('delete with stars and stars=move moves them', async () => {
  const a = await create({ name: 'a' });
  const b = await create({ name: 'b' });
  addStar(a.id);
  addStar(a.id);
  addStar(b.id);
  const res = await call('DELETE', `/api/planets/${a.id}?stars=move&into=${b.id}`);
  expect(res.statusCode).toBe(204);
  const planets = await list();
  expect(planets.map((p) => p.id)).toEqual([b.id]);
  expect(planets[0].count_total).toBe(3);
  expect(starCount(a.id)).toBe(0);
  const gone = await call('PATCH', `/api/planets/${a.id}`, { name: 'x' });
  expect(gone.statusCode).toBe(404);
});

test('delete with stars and stars=delete removes them and calls removeStarFiles for each', async () => {
  const a = await create({ name: 'a' });
  const b = await create({ name: 'b' });
  const s1 = addStar(a.id);
  const s2 = addStar(a.id);
  const keep = addStar(b.id);
  const seen = [];
  app.removeStarFiles = (star) => {
    seen.push(star.id);
  };
  const res = await call('DELETE', `/api/planets/${a.id}?stars=delete`);
  expect(res.statusCode).toBe(204);
  expect(seen.sort()).toEqual([s1, s2].sort());
  expect(app.db.prepare('SELECT id FROM stars').all().map((r) => r.id)).toEqual([keep]);
  expect((await list()).map((p) => p.id)).toEqual([b.id]);
});

test('default removeStarFiles is a no-op function', async () => {
  expect(typeof app.removeStarFiles).toBe('function');
  const a = await create();
  addStar(a.id);
  const res = await call('DELETE', `/api/planets/${a.id}?stars=delete`);
  expect(res.statusCode).toBe(204);
});

test('stars=move without into, or into itself → 400 invalid_target', async () => {
  const a = await create({ name: 'a' });
  addStar(a.id);
  for (const q of ['?stars=move', `?stars=move&into=${a.id}`, '?stars=move&into=nope']) {
    const res = await call('DELETE', `/api/planets/${a.id}${q}`);
    expect(res.statusCode, q).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_target' });
  }
  expect(starCount(a.id)).toBe(1);
  expect((await list()).length).toBe(1);
});

test('rejects empty and 21-char names', async () => {
  for (const name of ['', '   ', 'a'.repeat(21), undefined, 5]) {
    const res = await call('POST', '/api/planets', { name });
    expect(res.statusCode, String(name)).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_name' });
  }
  const ok = await call('POST', '/api/planets', { name: '가'.repeat(20) });
  expect(ok.statusCode).toBe(201);

  const patch = await call('PATCH', `/api/planets/${ok.json().id}`, { name: ' ' });
  expect(patch.statusCode).toBe(400);
  expect(patch.json()).toEqual({ error: 'invalid_name' });
});

test('rejects 21-char description', async () => {
  const res = await call('POST', '/api/planets', { name: 'a', description: 'd'.repeat(21) });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_description' });
  const ok = await create({ name: 'a', description: 'd'.repeat(20) });
  expect(ok.description).toBe('d'.repeat(20));
});

test('trims name', async () => {
  const p = await create({ name: '  a  ' });
  expect(p.name).toBe('a');
});

test('rename and describe', async () => {
  const p = await create({ name: '옛 이름' });
  const res = await call('PATCH', `/api/planets/${p.id}`, { name: '새 이름', description: '설명' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...p, name: '새 이름', description: '설명' });
  const [got] = await list();
  expect(got.name).toBe('새 이름');
  expect(got.description).toBe('설명');
});

test('delete non-empty without stars param → 409', async () => {
  const a = await create();
  addStar(a.id);
  const res = await call('DELETE', `/api/planets/${a.id}`);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: 'not_empty' });
  expect((await list()).length).toBe(1);
  expect(starCount(a.id)).toBe(1);
});

test('delete unknown id → 404', async () => {
  const res = await call('DELETE', '/api/planets/nope');
  expect(res.statusCode).toBe(404);
});

test('merge moves stars and removes source', async () => {
  const a = await create({ name: 'a' });
  const b = await create({ name: 'b' });
  addStar(a.id);
  addStar(a.id);
  const res = await call('POST', `/api/planets/${a.id}/merge`, { into: b.id });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ moved: 2 });
  const planets = await list();
  expect(planets.map((p) => p.id)).toEqual([b.id]);
  expect(planets[0].count_total).toBe(2);
  const gone = await call('PATCH', `/api/planets/${a.id}`, { name: 'x' });
  expect(gone.statusCode).toBe(404);
});

test('merge into itself or unknown → 400/404', async () => {
  const a = await create({ name: 'a' });
  addStar(a.id);
  const self = await call('POST', `/api/planets/${a.id}/merge`, { into: a.id });
  expect(self.statusCode).toBe(400);
  expect(self.json()).toEqual({ error: 'invalid_target' });
  const missing = await call('POST', `/api/planets/${a.id}/merge`, {});
  expect(missing.statusCode).toBe(400);
  const unknownTarget = await call('POST', `/api/planets/${a.id}/merge`, { into: 'nope' });
  expect(unknownTarget.statusCode).toBe(404);
  const unknownSource = await call('POST', '/api/planets/nope/merge', { into: a.id });
  expect(unknownSource.statusCode).toBe(404);
  expect((await list()).length).toBe(1);
  expect(starCount(a.id)).toBe(1);
});

test('counts respect period', async () => {
  const a = await create({ name: 'a' });
  const b = await create({ name: 'b' });
  addStar(a.id, '2026-11-10T03:00:00.000Z');
  addStar(a.id, '2026-10-01T03:00:00.000Z');
  const q = `?from=${encodeURIComponent('2026-11-10T00:00:00.000Z')}&to=${encodeURIComponent('2026-11-11T00:00:00.000Z')}`;
  const planets = await list(q);
  expect(planets.map((p) => p.slot)).toEqual([0, 1]);
  expect(planets[0].count_in_period).toBe(1);
  expect(planets[0].count_total).toBe(2);
  expect(planets[1].id).toBe(b.id);
  expect(planets[1].count_in_period).toBe(0);

  const all = await list();
  expect(all[0].count_in_period).toBe(2);
  expect(all[0].count_total).toBe(2);
});

test('period: from is inclusive, to is exclusive', async () => {
  const a = await create();
  addStar(a.id, '2026-11-10T00:00:00.000Z');
  addStar(a.id, '2026-11-11T00:00:00.000Z');
  const [p] = await list('?from=2026-11-10T00:00:00.000Z&to=2026-11-11T00:00:00.000Z');
  expect(p.count_in_period).toBe(1);
  const [onlyFrom] = await list('?from=2026-11-11T00:00:00.000Z');
  expect(onlyFrom.count_in_period).toBe(1);
});
