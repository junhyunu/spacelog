import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_CHARACTER } from '../character.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };
const DEFAULTS = { kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' };

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

const stored = () => app.db.prepare("SELECT value FROM meta WHERE key = 'character'").get()?.value;
const store = (value) =>
  app.db
    .prepare("INSERT INTO meta (key, value) VALUES ('character', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(value);

test('nothing stored → defaults (the current astronaut)', async () => {
  const res = await call('GET', '/api/character');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(DEFAULTS);
  expect(DEFAULT_CHARACTER).toEqual(DEFAULTS);
  expect(stored()).toBeUndefined(); // reading does not write
});

test('PUT stores the look and GET returns it', async () => {
  const look = { kind: 'cat', suit: 16, accent: 3, flame: 'pink' };
  const put = await call('PUT', '/api/character', look);
  expect(put.statusCode).toBe(200);
  expect(put.json()).toEqual(look);
  expect(JSON.parse(stored())).toEqual(look);
  expect((await call('GET', '/api/character')).json()).toEqual(look);

  // overwriting keeps one row
  const next = { kind: 'human', suit: 0, accent: 0, flame: 'blue' };
  expect((await call('PUT', '/api/character', next)).statusCode).toBe(200);
  expect((await call('GET', '/api/character')).json()).toEqual(next);
  expect(app.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'character'").get().n).toBe(1);
});

test('every kind and every flame is accepted', async () => {
  for (const kind of ['astronaut', 'robot', 'cat', 'alien', 'bear', 'human']) {
    for (const flame of ['orange', 'blue', 'green', 'pink']) {
      const res = await call('PUT', '/api/character', { kind, suit: 1, accent: 2, flame });
      expect(res.statusCode, `${kind} ${flame}`).toBe(200);
    }
  }
});

test('unknown fields are not stored', async () => {
  const res = await call('PUT', '/api/character', { kind: 'bear', suit: 2, accent: 4, flame: 'green', extra: 'x' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ kind: 'bear', suit: 2, accent: 4, flame: 'green' });
  expect(JSON.parse(stored())).toEqual({ kind: 'bear', suit: 2, accent: 4, flame: 'green' });
});

const GOOD = { kind: 'robot', suit: 5, accent: 6, flame: 'green' };
const BAD = [
  ['kind unknown', { kind: 'dog' }],
  ['kind missing', { kind: undefined }],
  ['kind not a string', { kind: 3 }],
  ['kind from the prototype', { kind: 'constructor' }],
  ['suit below 0', { suit: -1 }],
  ['suit above 16', { suit: 17 }],
  ['suit fractional', { suit: 1.5 }],
  ['suit as text', { suit: '3' }],
  ['suit null', { suit: null }],
  ['suit missing', { suit: undefined }],
  ['accent below 0', { accent: -1 }],
  ['accent above 16', { accent: 17 }],
  ['accent fractional', { accent: 0.2 }],
  ['accent as text', { accent: '0' }],
  ['accent boolean', { accent: true }],
  ['accent missing', { accent: undefined }],
  ['flame unknown', { flame: 'red' }],
  ['flame missing', { flame: undefined }],
  ['flame not a string', { flame: 1 }],
  ['flame from the prototype', { flame: 'toString' }],
];

test.each(BAD)('invalid: %s → 400 invalid_character, nothing stored', async (_name, patch) => {
  const res = await call('PUT', '/api/character', { ...GOOD, ...patch });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_character' });
  expect(stored()).toBeUndefined();
});

test('an invalid PUT keeps the look saved before', async () => {
  await call('PUT', '/api/character', GOOD);
  expect((await call('PUT', '/api/character', { ...GOOD, suit: 99 })).statusCode).toBe(400);
  expect((await call('GET', '/api/character')).json()).toEqual(GOOD);
});

test.each([
  ['array', '[1,2]'],
  ['string', '"cat"'],
  ['number', '3'],
  ['null', 'null'],
])('non-object body (%s) → 400 invalid_character', async (_name, payload) => {
  const res = await app.inject({
    method: 'PUT',
    url: '/api/character',
    headers: { ...HOST, 'content-type': 'application/json' },
    payload,
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_character' });
});

test('no body → 400 invalid_character', async () => {
  const res = await call('PUT', '/api/character');
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_character' });
});

test.each([
  ['not JSON', '{kind:'],
  ['empty text', ''],
  ['an array', '[]'],
  ['null', 'null'],
  ['a string', '"astronaut"'],
  ['unknown kind', JSON.stringify({ kind: 'dog', suit: 0, accent: 0, flame: 'orange' })],
  ['suit out of range', JSON.stringify({ kind: 'cat', suit: 40, accent: 0, flame: 'orange' })],
  ['missing flame', JSON.stringify({ kind: 'cat', suit: 1, accent: 0 })],
])('corrupt stored value (%s) → defaults', async (_name, value) => {
  store(value);
  const res = await call('GET', '/api/character');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(DEFAULTS);
});

test('a PUT repairs a corrupt stored value', async () => {
  store('{broken');
  expect((await call('PUT', '/api/character', GOOD)).statusCode).toBe(200);
  expect((await call('GET', '/api/character')).json()).toEqual(GOOD);
});
