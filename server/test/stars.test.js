import { afterEach, beforeEach, expect, test } from 'vitest';
import { fetchLinkTitle } from '../linkTitle.js';
import { createPlanet } from '../planets.js';
import { buildSearchText, insertStar, toStarJson } from '../stars.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };
const STAR_KEYS = [
  'id', 'type', 'title', 'body', 'url', 'link_title', 'file_name', 'file_ext', 'file_size',
  'memo', 'planet_id', 'created_at', 'has_thumb',
].sort();

let app;
let dataDir;
let planet;
let fetched;
const extra = [];

beforeEach(async () => {
  fetched = [];
  ({ app, dataDir } = await makeApp({
    fetchTitle: async (url) => {
      fetched.push(url);
      return '가짜 제목';
    },
  }));
  planet = createPlanet(app.db, { name: '행성' });
});

afterEach(async () => {
  await app.close();
  cleanup(dataDir);
  for (const other of extra.splice(0)) {
    await other.app.close();
    cleanup(other.dataDir);
  }
});

function call(method, url, payload, target = app) {
  return target.inject({ method, url, headers: HOST, ...(payload === undefined ? {} : { payload }) });
}

async function post(body, target = app) {
  const res = await call('POST', '/api/stars', body, target);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function dbRow(id) {
  return app.db.prepare('SELECT * FROM stars WHERE id = ?').get(id);
}

// created_at 을 정해서 별을 직접 넣는다.
function seed(createdAt, fields = {}) {
  return insertStar(app.db, { type: 'text', title: '별', body: '본문', planet_id: planet.id, created_at: createdAt, ...fields });
}

const sumCodes = (s) => [...s].reduce((n, ch) => n + ch.charCodeAt(0), 0);

test('text star: title defaults to first line, max 40 chars', async () => {
  const star = await post({ type: 'text', body: '첫 줄입니다\n둘째 줄', planet_id: planet.id });
  expect(star).toEqual({
    id: expect.any(String),
    type: 'text',
    title: '첫 줄입니다',
    body: '첫 줄입니다\n둘째 줄',
    url: null,
    link_title: null,
    file_name: null,
    file_ext: null,
    file_size: null,
    memo: '',
    planet_id: planet.id,
    created_at: expect.any(String),
    has_thumb: false,
  });
  expect(new Date(star.created_at).toISOString()).toBe(star.created_at);

  const long = await post({ type: 'text', body: `${'가'.repeat(50)}\n다음`, planet_id: planet.id });
  expect(long.title).toBe('가'.repeat(40));

  // 앞의 빈 줄은 건너뛰고, 공백뿐인 title 은 없는 것으로 본다.
  const padded = await post({ type: 'text', title: '   ', body: '\n\n  실제 첫 줄  \n끝', planet_id: planet.id });
  expect(padded.title).toBe('실제 첫 줄');

  const given = await post({ type: 'text', title: '  내 제목  ', body: '본문', memo: '메모', planet_id: planet.id });
  expect(given.title).toBe('내 제목');
  expect(given.memo).toBe('메모');
  expect(fetched).toEqual([]);
});

test('text star: blank body → 400 empty_body', async () => {
  for (const body of ['', '   \n\t ', undefined, null, 5, ['a']]) {
    const res = await call('POST', '/api/stars', { type: 'text', title: '제목', body, planet_id: planet.id });
    expect(res.statusCode, JSON.stringify(body)).toBe(400);
    expect(res.json()).toEqual({ error: 'empty_body' });
  }
  expect(app.db.prepare('SELECT COUNT(*) AS c FROM stars').get().c).toBe(0);
});

test('link star: uses fetched title', async () => {
  const star = await post({ type: 'link', url: 'https://example.com/a?b=1', planet_id: planet.id });
  expect(star.type).toBe('link');
  expect(star.title).toBe('가짜 제목');
  expect(star.link_title).toBe('가짜 제목');
  expect(star.url).toBe('https://example.com/a?b=1');
  expect(star.body).toBeNull();
  expect(fetched).toEqual(['https://example.com/a?b=1']);

  const named = await post({ type: 'link', title: '내가 붙인 이름', url: 'http://example.com', planet_id: planet.id });
  expect(named.title).toBe('내가 붙인 이름');
  expect(named.link_title).toBe('가짜 제목');
});

test('link star: falls back to url when fetch returns null', async () => {
  const other = await makeApp({ fetchTitle: async () => null });
  extra.push(other);
  const p = createPlanet(other.app.db, { name: 'p' });
  const star = await post({ type: 'link', url: 'https://example.com/x', planet_id: p.id }, other.app);
  expect(star.title).toBe('https://example.com/x');
  expect(star.link_title).toBeNull();
});

test('link star: falls back to url when fetchTitle throws or returns junk', async () => {
  const throwing = await makeApp({
    fetchTitle: async () => {
      throw new Error('boom');
    },
  });
  extra.push(throwing);
  const p = createPlanet(throwing.app.db, { name: 'p' });
  const star = await post({ type: 'link', url: 'https://example.com/x', planet_id: p.id }, throwing.app);
  expect(star.title).toBe('https://example.com/x');
  expect(star.link_title).toBeNull();

  const junk = await makeApp({ fetchTitle: async () => '   ' });
  extra.push(junk);
  const q = createPlanet(junk.app.db, { name: 'q' });
  const blank = await post({ type: 'link', url: 'https://example.com/y', planet_id: q.id }, junk.app);
  expect(blank.title).toBe('https://example.com/y');
  expect(blank.link_title).toBeNull();
});

test('fetchTitle defaults to fetchLinkTitle', async () => {
  const other = await makeApp();
  extra.push(other);
  expect(other.app.config.fetchTitle).toBe(fetchLinkTitle);
});

test('link star: ftp:// and javascript: → 400 invalid_url', async () => {
  const bad = ['ftp://example.com/a', 'javascript:alert(1)', 'example.com', '', '  ', 'http://', 'https:// bad host', undefined, 5, 'file:///c:/x'];
  for (const url of bad) {
    const res = await call('POST', '/api/stars', { type: 'link', url, planet_id: planet.id });
    expect(res.statusCode, String(url)).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_url' });
  }
  expect(fetched).toEqual([]);
  expect(app.db.prepare('SELECT COUNT(*) AS c FROM stars').get().c).toBe(0);
});

test('unknown planet → 400', async () => {
  for (const planet_id of ['nope', undefined, 5, '']) {
    const text = await call('POST', '/api/stars', { type: 'text', body: '본문', planet_id });
    expect(text.statusCode, String(planet_id)).toBe(400);
    expect(text.json()).toEqual({ error: 'unknown_planet' });
    const link = await call('POST', '/api/stars', { type: 'link', url: 'https://example.com', planet_id });
    expect(link.statusCode, String(planet_id)).toBe(400);
    expect(link.json()).toEqual({ error: 'unknown_planet' });
  }
  // 없는 행성이면 밖으로 요청을 보내지 않는다.
  expect(fetched).toEqual([]);
  expect(app.db.prepare('SELECT COUNT(*) AS c FROM stars').get().c).toBe(0);
});

test('invalid type, title, memo → 400', async () => {
  const cases = [
    [{ type: 'file', body: 'x' }, 'invalid_type'],
    [{ type: 'image', body: 'x' }, 'invalid_type'],
    [{ body: 'x' }, 'invalid_type'],
    [{ type: 5, body: 'x' }, 'invalid_type'],
    [{ type: 'text', body: 'x', title: 5 }, 'invalid_title'],
    [{ type: 'text', body: 'x', memo: { a: 1 } }, 'invalid_memo'],
    [{ type: 'link', url: 'https://example.com', title: ['a'] }, 'invalid_title'],
  ];
  for (const [body, code] of cases) {
    const res = await call('POST', '/api/stars', { planet_id: planet.id, ...body });
    expect(res.statusCode, JSON.stringify(body)).toBe(400);
    expect(res.json()).toEqual({ error: code });
  }
  const noBody = await call('POST', '/api/stars');
  expect(noBody.statusCode).toBe(400);
  expect(app.db.prepare('SELECT COUNT(*) AS c FROM stars').get().c).toBe(0);
});

test('list filters by period and planet, newest first, honours limit', async () => {
  const other = createPlanet(app.db, { name: '다른 행성' });
  const a = seed('2026-11-10T00:00:00.000Z', { title: 'a' });
  const b = seed('2026-11-10T12:00:00.000Z', { title: 'b' });
  const c = seed('2026-11-11T00:00:00.000Z', { title: 'c' });
  const d = seed('2026-11-10T06:00:00.000Z', { title: 'd', planet_id: other.id });
  const old = seed('2026-10-01T00:00:00.000Z', { title: 'old' });

  const ids = async (query) => {
    const res = await call('GET', `/api/stars${query}`);
    expect(res.statusCode).toBe(200);
    return res.json().map((s) => s.id);
  };

  expect(await ids('')).toEqual([c.id, b.id, d.id, a.id, old.id]);
  // from 포함, to 미포함
  expect(await ids('?from=2026-11-10T00:00:00.000Z&to=2026-11-11T00:00:00.000Z')).toEqual([b.id, d.id, a.id]);
  expect(await ids(`?planet_id=${planet.id}`)).toEqual([c.id, b.id, a.id, old.id]);
  expect(await ids(`?from=2026-11-10T00:00:00.000Z&to=2026-11-11T00:00:00.000Z&planet_id=${other.id}`)).toEqual([d.id]);
  expect(await ids('?planet_id=nope')).toEqual([]);
  expect(await ids('?limit=2')).toEqual([c.id, b.id]);
  expect(await ids(`?planet_id=${planet.id}&limit=1`)).toEqual([c.id]);
  // 쓸 수 없는 limit 은 무시한다.
  for (const bad of ['0', '-1', 'abc', '1.5', '']) {
    expect((await ids(`?limit=${bad}`)).length, bad).toBe(5);
  }

  const res = await call('GET', '/api/stars?limit=1');
  expect(Object.keys(res.json()[0]).sort()).toEqual(STAR_KEYS);
});

test('get one star, unknown id → 404', async () => {
  const star = await post({ type: 'text', body: '본문', planet_id: planet.id });
  const res = await call('GET', `/api/stars/${star.id}`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual(star);

  for (const [method, url, payload] of [
    ['GET', '/api/stars/nope'],
    ['PATCH', '/api/stars/nope', { memo: 'x' }],
    ['DELETE', '/api/stars/nope'],
  ]) {
    const missing = await call(method, url, payload);
    expect(missing.statusCode, method).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  }
});

test('create builds search_text from title, body, memo, link title, url', async () => {
  const text = await post({ type: 'text', title: '제목', body: '본문 글', memo: '메모 글', planet_id: planet.id });
  expect(dbRow(text.id).search_text).toBe('제목\n본문 글\n메모 글');
  const link = await post({ type: 'link', url: 'https://example.com/a', memo: '링크 메모', planet_id: planet.id });
  expect(dbRow(link.id).search_text).toBe('가짜 제목\n링크 메모\n가짜 제목\nhttps://example.com/a');
});

test('buildSearchText joins the present fields with newlines', () => {
  expect(
    buildSearchText({ title: 't', body: 'b', memo: 'm', link_title: 'lt', url: 'u', file_name: 'f.pdf' }),
  ).toBe('t\nb\nm\nlt\nu\nf.pdf');
  expect(buildSearchText({ title: 't', body: null, memo: '', link_title: null, url: null, file_name: 'f.pdf' })).toBe('t\nf.pdf');
});

test('patch memo updates search_text', async () => {
  const star = await post({ type: 'text', title: '제목', body: '본문', planet_id: planet.id });
  expect(dbRow(star.id).search_text).not.toContain('나중에 쓴 메모');
  const res = await call('PATCH', `/api/stars/${star.id}`, { memo: '나중에 쓴 메모' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...star, memo: '나중에 쓴 메모' });
  expect(dbRow(star.id).search_text).toBe('제목\n본문\n나중에 쓴 메모');

  const cleared = await call('PATCH', `/api/stars/${star.id}`, { memo: '' });
  expect(cleared.json().memo).toBe('');
  expect(dbRow(star.id).search_text).toBe('제목\n본문');
});

test('patch title updates title and search_text; blank or non-string title → 400 invalid_title', async () => {
  const star = await post({ type: 'text', title: '옛 제목', body: '본문', planet_id: planet.id });
  const res = await call('PATCH', `/api/stars/${star.id}`, { title: '  새 제목  ' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...star, title: '새 제목' });
  expect(dbRow(star.id).search_text).toBe('새 제목\n본문');

  for (const [body, code] of [
    [{ title: '' }, 'invalid_title'],
    [{ title: '   ' }, 'invalid_title'],
    [{ title: 5 }, 'invalid_title'],
    [{ title: null }, 'invalid_title'],
    [{ memo: 5 }, 'invalid_memo'],
    [{ memo: null }, 'invalid_memo'],
  ]) {
    const bad = await call('PATCH', `/api/stars/${star.id}`, body);
    expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    expect(bad.json()).toEqual({ error: code });
  }
  expect(dbRow(star.id).title).toBe('새 제목');
  expect(dbRow(star.id).memo).toBe('');

  // 바꿀 것이 없으면 그대로 돌려준다. 다른 필드는 바뀌지 않는다.
  const noop = await call('PATCH', `/api/stars/${star.id}`, { body: '몰래 바꾸기', type: 'link', id: 'x', created_at: 'y' });
  expect(noop.statusCode).toBe(200);
  expect(noop.json()).toEqual({ ...star, title: '새 제목' });
});

test('patch planet_id moves star', async () => {
  const other = createPlanet(app.db, { name: '다른 행성' });
  const star = await post({ type: 'text', body: '본문', planet_id: planet.id });
  const res = await call('PATCH', `/api/stars/${star.id}`, { planet_id: other.id });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ...star, planet_id: other.id });
  expect(dbRow(star.id).planet_id).toBe(other.id);

  for (const planet_id of ['nope', 5, null, '']) {
    const bad = await call('PATCH', `/api/stars/${star.id}`, { memo: '같이 온 메모', planet_id });
    expect(bad.statusCode, String(planet_id)).toBe(400);
    expect(bad.json()).toEqual({ error: 'unknown_planet' });
  }
  expect(dbRow(star.id).planet_id).toBe(other.id);
  expect(dbRow(star.id).memo).toBe('');
});

test('delete removes star', async () => {
  const star = await post({ type: 'text', body: '본문', planet_id: planet.id });
  const keep = await post({ type: 'text', body: '남는 별', planet_id: planet.id });
  const res = await call('DELETE', `/api/stars/${star.id}`);
  expect(res.statusCode).toBe(204);
  expect(res.body).toBe('');
  expect(dbRow(star.id)).toBeUndefined();
  expect((await call('GET', `/api/stars/${star.id}`)).statusCode).toBe(404);
  expect((await call('GET', '/api/stars')).json().map((s) => s.id)).toEqual([keep.id]);
  expect((await call('DELETE', `/api/stars/${star.id}`)).statusCode).toBe(404);
});

test('response never leaks vault_path, file_hash, search_text', async () => {
  const fileStar = insertStar(app.db, {
    type: 'image',
    title: '사진',
    file_name: '사진.png',
    file_ext: 'PNG',
    file_size: 12,
    file_hash: 'abc123',
    vault_path: 'vault/x.png',
    thumb_path: 'thumbs/x.webp',
    memo: '메모',
    planet_id: planet.id,
  });
  expect(Object.keys(fileStar).sort()).toEqual(STAR_KEYS);
  expect(fileStar.has_thumb).toBe(true);
  expect(fileStar.file_name).toBe('사진.png');
  expect(dbRow(fileStar.id).vault_path).toBe('vault/x.png');
  expect(dbRow(fileStar.id).file_hash).toBe('abc123');
  expect(dbRow(fileStar.id).search_text).toBe('사진\n메모\n사진.png');
  expect(Object.keys(toStarJson(dbRow(fileStar.id))).sort()).toEqual(STAR_KEYS);

  const created = await call('POST', '/api/stars', { type: 'text', body: '본문', planet_id: planet.id });
  const responses = [
    created,
    await call('GET', '/api/stars'),
    await call('GET', `/api/stars/${fileStar.id}`),
    await call('PATCH', `/api/stars/${fileStar.id}`, { memo: '새 메모' }),
    await call('GET', '/api/rediscovery?today=2026-11-12&before=2100-01-01T00:00:00.000Z'),
  ];
  for (const res of responses) {
    expect(res.statusCode).toBeLessThan(300);
    for (const leaked of ['vault_path', 'file_hash', 'search_text', 'thumb_path', 'vault/x.png', 'abc123']) {
      expect(res.body, leaked).not.toContain(leaked);
    }
    const data = res.json();
    for (const star of Array.isArray(data) ? data : [data]) {
      expect(Object.keys(star).sort()).toEqual(STAR_KEYS);
    }
  }
});

test('title with <script> is stored verbatim', async () => {
  const title = '<script>alert("x")</script> & <b>굵게</b>';
  const star = await post({ type: 'text', title, body: '<img src=x onerror=1>', memo: '<i>메모</i>', planet_id: planet.id });
  expect(star.title).toBe(title);
  expect(star.body).toBe('<img src=x onerror=1>');
  expect(star.memo).toBe('<i>메모</i>');
  expect(dbRow(star.id).title).toBe(title);
  expect((await call('GET', `/api/stars/${star.id}`)).json().title).toBe(title);
});

test('rediscovery: null when nothing older than `before`', async () => {
  const empty = await call('GET', '/api/rediscovery?today=2026-11-12&before=2026-11-05T00:00:00.000Z');
  expect(empty.statusCode).toBe(200);
  expect(empty.headers['content-type']).toContain('application/json');
  expect(empty.json()).toBeNull();

  seed('2026-11-05T00:00:00.000Z'); // before 와 같으면 포함하지 않는다
  seed('2026-11-10T00:00:00.000Z');
  const res = await call('GET', '/api/rediscovery?today=2026-11-12&before=2026-11-05T00:00:00.000Z');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toBeNull();

  for (const q of ['', '?today=2026-11-12', '?before=2026-11-05T00:00:00.000Z']) {
    const bad = await call('GET', `/api/rediscovery${q}`);
    expect(bad.statusCode, q).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_query' });
  }
});

test('rediscovery: same star for same `today`, deterministic', async () => {
  const old = [];
  for (let i = 0; i < 5; i++) old.push(seed(`2026-10-0${i + 1}T00:00:00.000Z`, { title: `옛 별 ${i}` }));
  seed('2026-11-11T00:00:00.000Z', { title: '새 별' });
  const sorted = old.map((s) => s.id).sort();
  const before = encodeURIComponent('2026-11-05T00:00:00.000Z');

  const pick = async (today) => {
    const res = await call('GET', `/api/rediscovery?today=${today}&before=${before}`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const first = await pick('2026-11-12');
  expect(first.id).toBe(sorted[sumCodes('2026-11-12') % 5]);
  expect(Object.keys(first).sort()).toEqual(STAR_KEYS);
  expect((await pick('2026-11-12')).id).toBe(first.id);

  const seen = new Set();
  for (const today of ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']) {
    const star = await pick(today);
    expect(star.id).toBe(sorted[sumCodes(today) % 5]);
    seen.add(star.id);
  }
  expect(seen.size).toBe(5);
});

test('summary counts', async () => {
  const empty = await call('GET', '/api/summary');
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({ in_period: 0, total: 0, planets: 1 });

  createPlanet(app.db, { name: '빈 행성' });
  seed('2026-11-10T00:00:00.000Z');
  seed('2026-11-10T12:00:00.000Z');
  seed('2026-11-11T00:00:00.000Z');
  seed('2026-10-01T00:00:00.000Z');

  const period = await call('GET', '/api/summary?from=2026-11-10T00:00:00.000Z&to=2026-11-11T00:00:00.000Z');
  expect(period.json()).toEqual({ in_period: 2, total: 4, planets: 2 });
  const all = await call('GET', '/api/summary');
  expect(all.json()).toEqual({ in_period: 4, total: 4, planets: 2 });
  const fromOnly = await call('GET', '/api/summary?from=2026-11-11T00:00:00.000Z');
  expect(fromOnly.json()).toEqual({ in_period: 1, total: 4, planets: 2 });
});

test('a star literally named "rediscovery" or "summary" does not shadow those routes', async () => {
  const res = await call('GET', '/api/stars/rediscovery');
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: 'not_found' });
  expect((await call('GET', '/api/stars/summary')).statusCode).toBe(404);
  expect((await call('GET', '/api/summary')).json()).toEqual({ in_period: 0, total: 0, planets: 1 });
});

// --- 검토에서 나온 경우들 ---
test('oversized, malformed and repeated inputs get { error: code }', async () => {
  const headers = { host: '127.0.0.1:4747', 'content-type': 'application/json' };
  const big = await app.inject({ method: 'POST', url: '/api/stars', headers, payload: JSON.stringify({ body: 'a'.repeat(1100000) }) });
  expect(big.statusCode).toBe(413);
  expect(big.json()).toEqual({ error: 'too_large' });
  const bad = await app.inject({ method: 'POST', url: '/api/stars', headers, payload: '{not json' });
  expect(bad.statusCode).toBe(400);
  expect(bad.json()).toEqual({ error: 'invalid_json' });
  const arr = await app.inject({ url: '/api/stars?planet_id=a&planet_id=b', headers: { host: '127.0.0.1:4747' } });
  expect(arr.statusCode).toBe(400);
  expect(arr.json()).toEqual({ error: 'invalid_query' });
});
