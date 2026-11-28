import { afterEach, beforeEach, expect, test } from 'vitest';
import { createPlanet } from '../planets.js';
import { remindCutoff } from '../remind.js';
import { insertStar } from '../stars.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };
const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

let app;
let dataDir;
let planet;

beforeEach(async () => {
  ({ app, dataDir } = await makeApp({ remind: { now: () => NOW } }));
  planet = createPlanet(app.db, { name: '행성' });
});

afterEach(async () => {
  await app.close();
  cleanup(dataDir);
});

function call(method, url, payload) {
  return app.inject({ method, url, headers: HOST, ...(payload === undefined ? {} : { payload }) });
}

// 본 때(seen_at)를 정해서 별을 넣는다
function seed(title, seenDaysAgo, fields = {}) {
  return insertStar(app.db, { title, body: '글', planet_id: planet.id, created_at: daysAgo(60), seen_at: daysAgo(seenDaysAgo), ...fields });
}

test('remindCutoff: days before now, null when off', () => {
  expect(remindCutoff(NOW, 14)).toBe(daysAgo(14));
  expect(remindCutoff(NOW, 0)).toBeNull();
});

test('GET /api/remind: stars not seen for more than 14 days (default), oldest first, with the total', async () => {
  seed('어제 본 별', 1);
  seed('13일', 13);
  const a = seed('40일', 40);
  const b = seed('15일', 15);
  const c = seed('20일', 20);
  const res = await call('GET', '/api/remind');
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.days).toBe(14);
  expect(body.total).toBe(3);
  expect(body.stars.map((s) => s.id)).toEqual([a.id, c.id, b.id]);
  expect(body.stars[0]).toMatchObject({ title: '40일', seen_at: daysAgo(40), remind_off: false });
});

test('GET /api/remind?limit: only that many, total still counts all; bad limit → 400', async () => {
  for (let i = 0; i < 5; i += 1) seed(`별 ${i}`, 20 + i);
  const res = (await call('GET', '/api/remind?limit=2')).json();
  expect(res.total).toBe(5);
  expect(res.stars.map((s) => s.title)).toEqual(['별 4', '별 3']);
  for (const bad of ['0', '-1', 'x', '101', '1.5']) {
    expect((await call('GET', `/api/remind?limit=${bad}`)).statusCode, bad).toBe(400);
  }
});

test('POST /api/stars/:id/seen moves the star out of the black hole (later = seen now); unknown id → 404', async () => {
  const s = seed('오래된 별', 30);
  expect((await call('GET', '/api/remind')).json().total).toBe(1);
  const res = await call('POST', `/api/stars/${s.id}/seen`);
  expect(res.statusCode).toBe(200);
  expect(Date.parse(res.json().seen_at)).toBeGreaterThan(NOW - 60000 * 60 * 24 * 365 * 10);
  expect((await call('GET', `/api/stars/${s.id}`)).json().seen_at).toBe(res.json().seen_at);
  expect((await call('GET', '/api/remind')).json().total).toBe(0);
  expect((await call('POST', '/api/stars/nope/seen')).statusCode).toBe(404);
});

test('PATCH seen_at / remind_off (undo) does not touch the chatbot index; bad values → 400', async () => {
  const s = seed('별', 30);
  const marked = [];
  app.ragSync = { markStars: (ids, reason) => marked.push([ids, reason]) };
  await call('POST', `/api/stars/${s.id}/seen`);
  const back = await call('PATCH', `/api/stars/${s.id}`, { seen_at: daysAgo(30) });
  expect(back.statusCode).toBe(200);
  expect(back.json().seen_at).toBe(daysAgo(30));
  const off = await call('PATCH', `/api/stars/${s.id}`, { remind_off: true });
  expect(off.json().remind_off).toBe(true);
  expect((await call('GET', '/api/remind')).json().total).toBe(0);
  const on = await call('PATCH', `/api/stars/${s.id}`, { remind_off: false });
  expect(on.json()).toMatchObject({ remind_off: false, seen_at: daysAgo(30) }); // 되돌리기는 본 때를 바꾸지 않는다
  expect((await call('GET', '/api/remind')).json().total).toBe(1);
  expect(marked).toEqual([]);
  for (const [patch, error] of [[{ seen_at: 'x' }, 'invalid_seen_at'], [{ seen_at: 5 }, 'invalid_seen_at'], [{ remind_off: 1 }, 'invalid_remind_off']]) {
    const res = await call('PATCH', `/api/stars/${s.id}`, patch);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
  }
});

test('POST /api/remind/off: off → listed newest first and left out; on again → seen now, so it does not come straight back', async () => {
  const a = seed('A', 30);
  const b = seed('B', 40);
  seed('C', 50);
  let res = await call('POST', '/api/remind/off', { ids: [a.id, b.id, a.id], off: true });
  expect(res.json()).toEqual({ changed: 2 });
  expect((await call('GET', '/api/remind')).json().stars.map((s) => s.title)).toEqual(['C']);
  const list = (await call('GET', '/api/remind/off')).json().stars;
  expect(list.map((s) => s.title).sort()).toEqual(['A', 'B']);
  expect(list.every((s) => s.remind_off)).toBe(true);

  res = await call('POST', '/api/remind/off', { ids: [a.id, 'nope'], off: false });
  expect(res.json()).toEqual({ changed: 1 });
  expect((await call('GET', '/api/remind/off')).json().stars.map((s) => s.title)).toEqual(['B']);
  expect((await call('GET', `/api/stars/${a.id}`)).json().seen_at).toBe(new Date(NOW).toISOString());
  expect((await call('GET', '/api/remind')).json().stars.map((s) => s.title)).toEqual(['C']);

  for (const bad of [{ ids: [], off: true }, { ids: 'x', off: true }, { ids: [a.id] }, { ids: [a.id], off: 'yes' }]) {
    expect((await call('POST', '/api/remind/off', bad)).statusCode).toBe(400);
  }
});

test('settings: default 14; 7 / 30 / 0(off) change the list; anything else → 400', async () => {
  seed('10일', 10);
  seed('20일', 20);
  seed('40일', 40);
  expect((await call('GET', '/api/remind/settings')).json()).toEqual({ days: 14 });
  const totals = {};
  for (const days of [7, 14, 30, 0]) {
    const put = await call('PUT', '/api/remind/settings', { days });
    expect(put.json()).toEqual({ days });
    const list = (await call('GET', '/api/remind')).json();
    expect(list.days).toBe(days);
    totals[days] = list.total;
  }
  expect(totals).toEqual({ 7: 3, 14: 2, 30: 1, 0: 0 });
  expect((await call('GET', '/api/remind/settings')).json()).toEqual({ days: 0 });
  for (const bad of [{ days: 5 }, { days: '14' }, {}, { days: 14, x: 1 }, [14]]) {
    expect((await call('PUT', '/api/remind/settings', bad)).statusCode).toBe(400);
  }
});

test('new stars start counting from when they were saved', async () => {
  const res = await call('POST', '/api/stars', { planet_id: planet.id, body: '새 글' });
  const star = res.json().star;
  expect(star.seen_at).toBe(star.created_at);
  expect(star.remind_off).toBe(false);
});
