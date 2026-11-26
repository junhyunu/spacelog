// 체험판 가짜 서버(web/demo/mockApi.js)의 계약 테스트 + 동작 테스트.
// 계약: 실제 서버(makeApp + inject)와 가짜 서버(메모리 저장소, 빈 상태)에 같은 순서의 요청을 보내
//       성공이면 응답을 canon()으로 맞춰(id · 시각은 타입만, 나머지는 값까지) 같은지, 실패면 status · 오류 본문이 같은지 본다.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cleanup, makeApp, multipartBody } from '../../../server/test/helpers.js';
import {
  DEMO_LINK_TITLE_TOAST,
  DEMO_MAX_FILE_BYTES,
  DEMO_OPEN_TOAST,
  DEMO_TOO_BIG_TOAST,
  MISSING_URL,
  createMockApi,
} from '../../demo/mockApi.js';
import { CONVERSATIONS, PLANETS, STARS, makePng } from '../../demo/seed.js';
import { STORAGE_ERROR_TOAST, buildEmptyState, memoryAdapter, openStore } from '../../demo/store.js';

const HOST = { host: '127.0.0.1:4747' };
const ID_KEYS = new Set(['id', 'planet_id', 'thumb_attachment_id']);
const TIME_KEYS = new Set(['created_at']);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// id · 시각은 타입만, 그 밖의 값은 그대로 남긴 비교용 모양
function canon(v, key) {
  if (key && (ID_KEYS.has(key) || TIME_KEYS.has(key))) return v === null ? 'null' : `<${typeof v}>`;
  if (Array.isArray(v)) return v.map((x) => canon(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k], k)]));
  return v;
}

// 키 집합 · 타입만(값이 다른 응답끼리 — 예: 서버의 축소본 크기)
function shape(v) {
  if (Array.isArray(v)) return v.map(shape);
  if (v === null) return 'null';
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return typeof v;
}

const pngA = makePng({ top: [10, 20, 30], bottom: [200, 180, 160], w: 40, h: 30 });
const txtA = new TextEncoder().encode('hello demo\n');

let server;
let dataDir;
let api;
let notices;

async function srv(method, url, body) {
  const opts = { method, url, headers: { ...HOST } };
  if (body?.multipart) {
    const { payload, contentType } = multipartBody(body.multipart);
    opts.payload = payload;
    opts.headers['content-type'] = contentType;
  } else if (body !== undefined) {
    opts.payload = body;
  }
  const res = await server.inject(opts);
  const data = res.body ? JSON.parse(res.body) : null;
  if (res.statusCode >= 400) return { ok: false, status: res.statusCode, error: data };
  return { ok: true, status: res.statusCode, value: data };
}

async function mock(call) {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (err?.name !== 'ApiError') throw err;
    return { ok: false, status: err.status, error: err.data };
  }
}

// 같은 요청을 둘에 보내고 결과가 같은지 본다. → [서버 값, 가짜 값]
async function both(serverReq, mockCall, { compare = canon } = {}) {
  const s = await srv(...serverReq);
  const m = await mock(mockCall);
  expect({ ok: m.ok, status: m.ok ? undefined : m.status, error: m.error }).toEqual({
    ok: s.ok,
    status: s.ok ? undefined : s.status,
    error: s.error,
  });
  if (s.ok) expect(compare(m.value)).toEqual(compare(s.status === 204 ? null : s.value));
  return [s.value, m.value, s];
}

const err = (status, code) => ({ status, code });
async function bothFail(serverReq, mockCall, expected) {
  const [, , s] = await both(serverReq, mockCall);
  expect({ status: s.status, code: s.error?.error }).toEqual(expected);
}

const file = (bytes, name, type) => new File([bytes], name, { type });
const fakeThumb = async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

beforeAll(async () => {
  ({ app: server, dataDir } = await makeApp({ fetchTitle: async () => null, maxFileBytes: DEMO_MAX_FILE_BYTES }));
  const store = await openStore({ adapter: memoryAdapter(), seed: buildEmptyState });
  notices = [];
  api = createMockApi({ store, notify: (m) => notices.push(m), noticeDelay: 0, makeThumb: fakeThumb });
});

afterAll(async () => {
  await server.close();
  cleanup(dataDir);
});

describe('계약: 실제 서버와 같은 응답 모양 · 오류 코드', () => {
  // 두 쪽의 id(서버 / 가짜)
  const P = {};
  const S = {};

  test('health · 처음 목록 · 다음 모습', async () => {
    await both(['GET', '/api/health'], () => api.health());
    await both(['GET', '/api/planets'], () => api.planets());
    await both(['GET', '/api/planets/next-look'], () => api.nextLook());
    await both(['GET', '/api/summary'], () => api.summary());
    await both(['GET', '/api/stars'], () => api.stars());
  });

  test('행성 만들기 · 검사', async () => {
    let [s, m] = await both(['POST', '/api/planets', { name: ' 행성A ' }], () => api.createPlanet({ name: ' 행성A ' }));
    P.a = [s.id, m.id];
    [s, m] = await both(['POST', '/api/planets', { name: 'B', color_index: 3, deco: 'ice', ring: true, description: '설명' }], () =>
      api.createPlanet({ name: 'B', color_index: 3, deco: 'ice', ring: true, description: '설명' }),
    );
    P.b = [s.id, m.id];
    [s, m] = await both(['POST', '/api/planets', { name: 'C' }], () => api.createPlanet({ name: 'C' }));
    P.c = [s.id, m.id];
    await bothFail(['POST', '/api/planets', {}], () => api.createPlanet({}), err(400, 'invalid_name'));
    await bothFail(['POST', '/api/planets', { name: '​ ' }], () => api.createPlanet({ name: '​ ' }), err(400, 'invalid_name'));
    await bothFail(['POST', '/api/planets', { name: 'x'.repeat(21) }], () => api.createPlanet({ name: 'x'.repeat(21) }), err(400, 'invalid_name'));
    await bothFail(['POST', '/api/planets', { name: 'x', description: 'y'.repeat(21) }], () => api.createPlanet({ name: 'x', description: 'y'.repeat(21) }), err(400, 'invalid_description'));
    await bothFail(['POST', '/api/planets', { name: 'x', color_index: 17 }], () => api.createPlanet({ name: 'x', color_index: 17 }), err(400, 'invalid_look'));
    await bothFail(['POST', '/api/planets', { name: 'x', deco: 'moon' }], () => api.createPlanet({ name: 'x', deco: 'moon' }), err(400, 'invalid_look'));
    await bothFail(['POST', '/api/planets', { name: 'x', ring: 'yes' }], () => api.createPlanet({ name: 'x', ring: 'yes' }), err(400, 'invalid_look'));
    await both(['GET', '/api/planets'], () => api.planets());
    await both(['GET', '/api/planets/next-look'], () => api.nextLook());
  });

  test('행성 고치기 · 미분류 잠금', async () => {
    await both(['PATCH', `/api/planets/${P.a[0]}`, { name: 'A2', ring: true }], () => api.patchPlanet(P.a[1], { name: 'A2', ring: true }));
    await both(['PATCH', `/api/planets/${P.a[0]}`, {}], () => api.patchPlanet(P.a[1], {}));
    await bothFail(['PATCH', '/api/planets/unsorted', { name: 'x' }], () => api.patchPlanet('unsorted', { name: 'x' }), err(403, 'locked'));
    await bothFail(['PATCH', '/api/planets/nope', { name: 'x' }], () => api.patchPlanet('nope', { name: 'x' }), err(404, 'not_found'));
    await bothFail(['PATCH', `/api/planets/${P.a[0]}`, { deco: 1 }], () => api.patchPlanet(P.a[1], { deco: 1 }), err(400, 'invalid_look'));
    await bothFail(['POST', '/api/planets/unsorted/merge', { into: P.a[0] }], () => api.mergePlanet('unsorted', P.a[1]), err(403, 'locked'));
    await bothFail(['DELETE', '/api/planets/unsorted'], () => api.deletePlanet('unsorted'), err(403, 'locked'));
  });

  test('별 만들기: 글 · 링크 · 파일 · 검사', async () => {
    // 글(JSON)
    let [s, m] = await both(['POST', '/api/stars', { planet_id: P.a[0], title: '', body: '첫 줄 제목\n둘째 줄', links: [] }], () =>
      api.createStar({ planet_id: P.a[1], body: '첫 줄 제목\n둘째 줄' }),
    );
    S.text = [s.star.id, m.star.id];
    // 링크(JSON). 서버의 제목 가져오기는 못 가져온 것(null)으로 두었다 — 체험판의 새 링크와 같다
    [s, m] = await both(['POST', '/api/stars', { planet_id: P.a[0], title: '', body: '', links: [' https://example.com/a ', 'https://example.com/a'] }], () =>
      api.createStar({ planet_id: P.a[1], links: [' https://example.com/a ', 'https://example.com/a'] }),
    );
    S.link = [s.star.id, m.star.id];
    expect(m.star.attachments[0].link_title).toBeNull();
    // 파일(서버: multipart, 가짜: File). 그림 + 글 파일 + 같은 요청 안의 같은 파일(알리지 않고 하나만)
    [s, m] = await both(
      ['POST', '/api/stars', { multipart: [
        ['field', 'planet_id', P.b[0]], ['field', 'title', ''], ['field', 'body', ''], ['field', 'links', '["https://example.com/b"]'],
        ['file', 'files', 'pic.png', 'image/png', Buffer.from(pngA)], ['file', 'files', 'note.txt', 'text/plain', Buffer.from(txtA)],
        ['file', 'files', 'again.txt', 'text/plain', Buffer.from(txtA)],
      ] }],
      () => api.createStar({ planet_id: P.b[1], links: ['https://example.com/b'], files: [file(pngA, 'pic.png', 'image/png'), file(txtA, 'note.txt', 'text/plain'), file(txtA, 'again.txt', 'text/plain')] }),
    );
    S.file = [s.star.id, m.star.id];
    expect(m.star.type).toBe('image');
    expect(m.star.has_thumb).toBe(true);
    // 이미 있는 파일뿐 → 409 nothing_to_save(skipped)
    await bothFail(
      ['POST', '/api/stars', { multipart: [['field', 'planet_id', P.b[0]], ['field', 'links', '[]'], ['file', 'files', 'dup.png', 'image/png', Buffer.from(pngA)]] }],
      () => api.createStar({ planet_id: P.b[1], files: [file(pngA, 'dup.png', 'image/png')] }),
      err(409, 'nothing_to_save'),
    );
    // 50MB 를 넘는 파일은 빼고 저장(skipped too_large)
    const big = new Uint8Array(DEMO_MAX_FILE_BYTES + 1);
    await both(
      ['POST', '/api/stars', { multipart: [['field', 'planet_id', P.b[0]], ['field', 'body', '큰 파일'], ['field', 'links', '[]'], ['file', 'files', 'big.bin', 'application/octet-stream', Buffer.from(big)]] }],
      () => api.createStar({ planet_id: P.b[1], body: '큰 파일', files: [file(big, 'big.bin', 'application/octet-stream')] }),
    );
    // 검사
    await bothFail(['POST', '/api/stars', { planet_id: P.a[0], title: '', body: '  ', links: [] }], () => api.createStar({ planet_id: P.a[1], body: '  ' }), err(400, 'empty_star'));
    await bothFail(['POST', '/api/stars', { planet_id: P.a[0], title: '', body: '', links: ['ftp://x'] }], () => api.createStar({ planet_id: P.a[1], links: ['ftp://x'] }), err(400, 'invalid_url'));
    await bothFail(['POST', '/api/stars', { planet_id: 'nope', title: '', body: 'x', links: [] }], () => api.createStar({ planet_id: 'nope', body: 'x' }), err(400, 'unknown_planet'));
    await bothFail(['POST', '/api/stars', { planet_id: '', title: '', body: 'x', links: [] }], () => api.createStar({ body: 'x' }), err(400, 'unknown_planet'));
    await bothFail(['POST', '/api/stars', { planet_id: P.a[0], title: '', body: 'x'.repeat(20001), links: [] }], () => api.createStar({ planet_id: P.a[1], body: 'x'.repeat(20001) }), err(400, 'invalid_body'));
    const many = Array.from({ length: 51 }, (_, i) => `https://example.com/${i}`);
    await bothFail(['POST', '/api/stars', { planet_id: P.a[0], title: '', body: '', links: many }], () => api.createStar({ planet_id: P.a[1], links: many }), err(400, 'too_many_attachments'));
    // 긴 제목은 200자로 자른다
    [s, m] = await both(['POST', '/api/stars', { planet_id: 'unsorted', title: `  ${'가'.repeat(250)}`, body: 'x', links: [] }], () =>
      api.createStar({ planet_id: 'unsorted', title: `  ${'가'.repeat(250)}`, body: 'x' }),
    );
    S.unsorted = [s.star.id, m.star.id];
  });

  test('별 읽기 · 목록 거르기', async () => {
    await both(['GET', '/api/stars'], () => api.stars());
    await both(['GET', `/api/stars?planet_id=${P.b[0]}`], () => api.stars({ planet_id: P.b[1] }));
    await both(['GET', '/api/stars?limit=2'], () => api.stars({ limit: 2 }));
    await both(['GET', '/api/stars?limit=0'], () => api.stars({ limit: 0 }));
    await both([`GET`, `/api/stars/${S.file[0]}`], () => api.star(S.file[1]));
    await bothFail(['GET', '/api/stars/nope'], () => api.star('nope'), err(404, 'not_found'));
    await bothFail(['GET', '/api/stars?from=yesterday'], () => api.stars({ from: 'yesterday' }), err(400, 'invalid_period'));
  });

  test('별 고치기 · 자주 찾음', async () => {
    await both(['PATCH', `/api/stars/${S.text[0]}`, { title: '  새 제목 ', body: '새 본문' }], () => api.patchStar(S.text[1], { title: '  새 제목 ', body: '새 본문' }));
    await both(['PATCH', `/api/stars/${S.text[0]}`, { fav: true }], () => api.patchStar(S.text[1], { fav: true }));
    await both(['PATCH', `/api/stars/${S.text[0]}`, { body: '   ' }], () => api.patchStar(S.text[1], { body: '   ' }));
    await both(['GET', '/api/stars?fav=1'], () => api.stars({ fav: true }));
    await both(['PATCH', `/api/stars/${S.link[0]}`, { planet_id: P.c[0] }], () => api.patchStar(S.link[1], { planet_id: P.c[1] }));
    await bothFail(['PATCH', `/api/stars/${S.text[0]}`, { title: ' ' }], () => api.patchStar(S.text[1], { title: ' ' }), err(400, 'invalid_title'));
    await bothFail(['PATCH', `/api/stars/${S.text[0]}`, { fav: 1 }], () => api.patchStar(S.text[1], { fav: 1 }), err(400, 'invalid_fav'));
    await bothFail(['PATCH', `/api/stars/${S.text[0]}`, { body: null }], () => api.patchStar(S.text[1], { body: null }), err(400, 'invalid_body'));
    await bothFail(['PATCH', `/api/stars/${S.text[0]}`, { planet_id: 'nope' }], () => api.patchStar(S.text[1], { planet_id: 'nope' }), err(400, 'unknown_planet'));
    await bothFail(['PATCH', '/api/stars/nope', { fav: true }], () => api.patchStar('nope', { fav: true }), err(404, 'not_found'));
  });

  test('여러 개 옮기기 · 지우기(500개 제한 포함)', async () => {
    await both(['POST', '/api/stars/move', { ids: [S.text[0], S.text[0], 'nope', S.file[0]], planet_id: P.c[0] }], () =>
      api.moveStars([S.text[1], S.text[1], 'nope', S.file[1]], P.c[1]),
    );
    await both(['POST', '/api/stars/move', { ids: [S.text[0]], planet_id: P.c[0] }], () => api.moveStars([S.text[1]], P.c[1])); // 이미 거기 → 0
    await both(['POST', '/api/stars/move', { ids: [S.text[0]], planet_id: 'unsorted' }], () => api.moveStars([S.text[1]], 'unsorted'));
    const tooMany = Array.from({ length: 501 }, (_, i) => `id${i}`);
    for (const ids of [[], tooMany, [1], 'x', null]) {
      await bothFail(['POST', '/api/stars/move', { ids, planet_id: P.c[0] }], () => api.moveStars(ids, P.c[1]), err(400, 'invalid_ids'));
      await bothFail(['POST', '/api/stars/delete', { ids }], () => api.deleteStars(ids), err(400, 'invalid_ids'));
    }
    await both(['POST', '/api/stars/move', { ids: Array.from({ length: 500 }, (_, i) => `id${i}`), planet_id: P.c[0] }], () =>
      api.moveStars(Array.from({ length: 500 }, (_, i) => `id${i}`), P.c[1]),
    );
    await bothFail(['POST', '/api/stars/move', { ids: [S.text[0]], planet_id: 'nope' }], () => api.moveStars([S.text[1]], 'nope'), err(400, 'unknown_planet'));
    await both(['POST', '/api/stars/delete', { ids: [S.unsorted[0], S.unsorted[0], 'nope'] }], () => api.deleteStars([S.unsorted[1], S.unsorted[1], 'nope']));
    await bothFail(['DELETE', '/api/stars/nope'], () => api.deleteStar('nope'), err(404, 'not_found'));
    await both(['DELETE', `/api/stars/${S.link[0]}`], () => api.deleteStar(S.link[1]));
  });

  test('요약 · 기간', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    await both(['GET', '/api/summary'], () => api.summary());
    await both(['GET', `/api/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`], () => api.summary({ from, to }));
    await both(['GET', `/api/summary?to=${encodeURIComponent(from)}`], () => api.summary({ to: from }));
    await both(['GET', `/api/planets?from=${encodeURIComponent(from)}`], () => api.planets({ from }));
    await bothFail(['GET', '/api/summary?from=nope'], () => api.summary({ from: 'nope' }), err(400, 'invalid_period'));
  });

  test('행성 합치기 · 지우기 3가지', async () => {
    // 비어 있지 않음
    await bothFail(['DELETE', `/api/planets/${P.c[0]}`], () => api.deletePlanet(P.c[1]), err(409, 'not_empty'));
    await bothFail(['DELETE', '/api/planets/nope'], () => api.deletePlanet('nope'), err(404, 'not_found'));
    await bothFail(['DELETE', `/api/planets/${P.c[0]}?stars=move&into=${P.c[0]}`], () => api.deletePlanet(P.c[1], { stars: 'move', into: P.c[1] }), err(400, 'invalid_target'));
    await bothFail(['DELETE', `/api/planets/${P.c[0]}?stars=move`], () => api.deletePlanet(P.c[1], { stars: 'move' }), err(400, 'invalid_target'));
    // 합치기 검사
    await bothFail(['POST', `/api/planets/${P.c[0]}/merge`, { into: P.c[0] }], () => api.mergePlanet(P.c[1], P.c[1]), err(400, 'invalid_target'));
    await bothFail(['POST', `/api/planets/${P.c[0]}/merge`, {}], () => api.mergePlanet(P.c[1]), err(400, 'invalid_target'));
    await bothFail(['POST', `/api/planets/${P.c[0]}/merge`, { into: 'nope' }], () => api.mergePlanet(P.c[1], 'nope'), err(404, 'not_found'));
    await bothFail(['POST', '/api/planets/nope/merge', { into: P.c[0] }], () => api.mergePlanet('nope', P.c[1]), err(404, 'not_found'));
    // 옮기고 지우기: C → A
    await both(['DELETE', `/api/planets/${P.c[0]}?stars=move&into=${P.a[0]}`], () => api.deletePlanet(P.c[1], { stars: 'move', into: P.a[1] }));
    // 합치기: A → B
    await both(['POST', `/api/planets/${P.a[0]}/merge`, { into: P.b[0] }], () => api.mergePlanet(P.a[1], P.b[1]));
    await both(['GET', '/api/planets'], () => api.planets());
    // 별과 함께 지우기: B
    await both(['DELETE', `/api/planets/${P.b[0]}?stars=delete`], () => api.deletePlanet(P.b[1], { stars: 'delete' }));
    // 빈 행성 지우기
    const [s, m] = await both(['POST', '/api/planets', { name: 'D' }], () => api.createPlanet({ name: 'D' }));
    expect(m.slot).toBe(0); // 가장 작은 빈 자리
    await both(['DELETE', `/api/planets/${s.id}`], () => api.deletePlanet(m.id));
    await both(['GET', '/api/planets'], () => api.planets());
    await both(['GET', '/api/stars'], () => api.stars());
    await both(['GET', '/api/summary'], () => api.summary());
    await both(['GET', '/api/planets/next-look'], () => api.nextLook());
  });

  test('캐릭터', async () => {
    await both(['GET', '/api/character'], () => api.character());
    const look = { kind: 'cat', suit: 3, accent: 16, flame: 'blue' };
    await both(['PUT', '/api/character', look], () => api.saveCharacter(look));
    await both(['GET', '/api/character'], () => api.character());
    for (const bad of [{ ...look, kind: 'dog' }, { ...look, suit: 17 }, { ...look, accent: -1 }, { ...look, flame: 'red' }, {}]) {
      await bothFail(['PUT', '/api/character', bad], () => api.saveCharacter(bad), err(400, 'invalid_character'));
    }
  });

  test('첨부 열기: 없는 첨부 · 링크는 서버와 같은 오류', async () => {
    const [s, m] = await both(['POST', '/api/stars', { planet_id: 'unsorted', title: '', body: '', links: ['https://example.com/z'] }], () =>
      api.createStar({ planet_id: 'unsorted', links: ['https://example.com/z'] }),
    );
    await bothFail(['POST', `/api/attachments/${s.star.attachments[0].id}/open`], () => api.openAttachment(m.star.attachments[0].id), err(400, 'no_file'));
    await bothFail(['POST', '/api/attachments/nope/reveal'], () => api.revealAttachment('nope'), err(404, 'not_found'));
  });

  test('챗봇: 키 집합 · 오류 코드가 서버와 같다(체험판은 늘 준비됨이라 상태 값은 다르다)', async () => {
    const keys = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, keys(v[k])])) : '*');
    await both(['GET', '/api/chat/status'], () => api.chatStatus(), { compare: keys });
    await both(['GET', '/api/chat/settings'], () => api.chatSettings(), { compare: keys });
    await bothFail(['PUT', '/api/chat/settings', { nope: 1 }], () => api.saveChatSettings({ nope: 1 }), err(400, 'invalid_settings'));
    await bothFail(['PUT', '/api/chat/settings', { enabled: true }], () => api.saveChatSettings({ enabled: true }), err(400, 'consent_required'));
    await bothFail(['PUT', '/api/chat/settings', { excluded_planets: ['nope'] }], () => api.saveChatSettings({ excluded_planets: ['nope'] }), err(400, 'unknown_planet'));
    await bothFail(['POST', '/api/chat/reindex', { scope: 'x' }], () => api.reindex('x'), err(400, 'invalid_scope'));
    await bothFail(['POST', '/api/chat/reindex', { scope: 'all' }], () => api.reindex('all'), err(409, 'chat_off'));
    await bothFail(['GET', '/api/chat/conversations/nope'], () => api.conversation('nope'), err(404, 'not_found'));
    await bothFail(['POST', '/api/chat/messages/nope/stop'], () => api.stopAnswer('nope'), err(404, 'not_found'));
    await both(['GET', '/api/chat/unread'], () => api.unread());
    await both(['GET', '/api/chat/conversations'], () => api.conversations());
  });
});

describe('동작: 체험판 안내 · 파일 · 멈추기', () => {
  async function fresh(opts = {}) {
    const store = await openStore({ adapter: memoryAdapter(), seed: buildEmptyState });
    const log = [];
    const a = createMockApi({ store, notify: (msg) => log.push(msg), noticeDelay: 0, makeThumb: fakeThumb, ...opts });
    return { store, api: a, log };
  }

  test('원본 열기 · 폴더에서 보기: 아무것도 열지 않고(앱이 말하지 않는 응답) 체험판 안내만', async () => {
    const { api: a, log } = await fresh();
    const { star } = await a.createStar({ planet_id: 'unsorted', files: [file(txtA, 'a.txt', 'text/plain')] });
    const attId = star.attachments[0].id;
    // detail.js: open 은 action === 'revealed' 일 때만, reveal 은 아무 토스트도 띄우지 않는다
    expect(await a.openAttachment(attId)).toEqual({ action: 'demo' });
    expect(await a.revealAttachment(attId)).toEqual({ action: 'demo' });
    await tick(20);
    expect(log).toEqual([DEMO_OPEN_TOAST, DEMO_OPEN_TOAST]);
    expect(DEMO_OPEN_TOAST).toBe('체험판에서는 쓸 수 없어요. 실제 앱에서는 내 컴퓨터에 보관된 원본 파일을 열어요');
  });

  test('링크 제목 안내는 링크가 있을 때만', async () => {
    const { api: a, log } = await fresh();
    await a.createStar({ planet_id: 'unsorted', body: '글만' });
    await tick(20);
    expect(log).toEqual([]);
    const { star } = await a.createStar({ planet_id: 'unsorted', links: ['https://example.com/q'] });
    expect(star.title).toBe('https://example.com/q'); // 제목이 없으면 주소가 제목
    await tick(20);
    expect(log).toEqual([DEMO_LINK_TITLE_TOAST]);
    expect(DEMO_LINK_TITLE_TOAST).toBe('체험판에서는 링크 제목을 가져오지 않아요');
  });

  test('50MB 를 넘는 파일: 빼고 저장 + 안내, 그것뿐이면 409', async () => {
    const { api: a, log } = await fresh();
    const big = file(new Uint8Array(DEMO_MAX_FILE_BYTES + 1), 'big.bin', '');
    const res = await a.createStar({ planet_id: 'unsorted', body: 'x', files: [big] });
    expect(res.skipped).toEqual([{ file_name: 'big.bin', reason: 'too_large' }]);
    await expect(a.createStar({ planet_id: 'unsorted', files: [big] })).rejects.toMatchObject({
      status: 409, code: 'nothing_to_save', data: { error: 'nothing_to_save', skipped: [{ file_name: 'big.bin', reason: 'too_large' }] },
    });
    await tick(20);
    expect(log).toEqual([DEMO_TOO_BIG_TOAST, DEMO_TOO_BIG_TOAST]);
    expect(DEMO_MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(DEMO_TOO_BIG_TOAST).toBe('체험판에서는 50MB보다 큰 파일은 담을 수 없어요');
  });

  test('올리기 진행률 · onUploaded · 멈추기', async () => {
    const { api: a, store } = await fresh({ uploadMs: 50 });
    const pcts = [];
    let uploaded = 0;
    await a.createStar({ planet_id: 'unsorted', files: [file(txtA, 'p.txt', 'text/plain')] }, (p) => pcts.push(p), { onUploaded: () => (uploaded += 1) });
    expect(pcts.at(-1)).toBe(100);
    expect(pcts).toEqual([...pcts].sort((x, y) => x - y));
    expect(uploaded).toBe(1);

    const ctl = new AbortController();
    ctl.abort();
    await expect(a.createStar({ planet_id: 'unsorted', body: 'x' }, null, { signal: ctl.signal })).rejects.toMatchObject({ status: 0, code: 'aborted' });

    const before = store.state.stars.length;
    const ctl2 = new AbortController();
    const p = a.createStar({ planet_id: 'unsorted', files: [file(pngA, 'q.png', 'image/png')] }, () => ctl2.abort(), { signal: ctl2.signal });
    await expect(p).rejects.toMatchObject({ status: 0, code: 'aborted' });
    expect(store.state.stars.length).toBe(before);
  });

  test('첨부 주소: 그림 원본 · 축소본은 <img src> 에 쓸 수 있는 주소, 없으면 MISSING_URL', async () => {
    const { api: a } = await fresh();
    const { star } = await a.createStar({ planet_id: 'unsorted', files: [file(pngA, 'r.png', 'image/png'), file(txtA, 'r.txt', 'text/plain')] });
    expect(a.attachmentFileUrl(star.attachments[0].id)).toMatch(/^blob:/);
    expect(a.attachmentThumbUrl(star.thumb_attachment_id)).toMatch(/^blob:/);
    expect(a.attachmentThumbUrl(star.attachments[1].id)).toBe(MISSING_URL);
    expect(a.attachmentFileUrl('nope')).toBe(MISSING_URL);
    // 축소본을 못 만든 곳(node · 캔버스 없음)에서는 has_thumb false
    const { api: b } = await fresh({ makeThumb: async () => null });
    const res = await b.createStar({ planet_id: 'unsorted', files: [file(pngA, 's.png', 'image/png')] });
    expect(res.star).toMatchObject({ type: 'image', has_thumb: false, thumb_attachment_id: null });
    // 지우면 바이트도 지운다
    await a.deleteStar(star.id);
    expect(a.attachmentFileUrl(star.attachments[0].id)).toBe(MISSING_URL);
  });

  test('읽을 수 없는 파일 → upload_failed', async () => {
    const { api: a } = await fresh();
    const broken = { name: 'folder', size: 0, type: '', arrayBuffer: () => Promise.reject(new Error('dir')) };
    await expect(a.createStar({ planet_id: 'unsorted', files: [broken] })).rejects.toMatchObject({ status: 0, code: 'upload_failed' });
  });
});

describe('동작: 더미 데이터 · 상대 날짜 · 저장소', () => {
  const T1 = new Date(2026, 10, 27, 15, 30, 0); // 현지 15:30
  const T2 = new Date(2026, 10, 29, 9, 0, 0); // 이틀 뒤

  test('처음 열면 더미 데이터를 기준 시각에 맞춰 심는다', async () => {
    const store = await openStore({ adapter: memoryAdapter(), now: () => T1 });
    const a = createMockApi({ store, notify: () => {} });
    expect(store.anchor).toBe(T1.toISOString());
    const planets = await a.planets();
    expect(planets.map((p) => p.name)).toEqual(['미분류', ...PLANETS.map((p) => p.name)]);
    expect(planets.map((p) => p.slot)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6]);
    const stars = await a.stars();
    expect(stars).toHaveLength(STARS.length);
    expect(stars.filter((s) => s.fav)).toHaveLength(STARS.filter((s) => s.fav).length);
    // 오늘(기준일) 0시 이후 · 기준 시각 이전인 별이 있다
    const today0 = new Date(2026, 10, 27).toISOString();
    const todays = await a.summary({ from: today0, to: T1.toISOString() });
    expect(todays.in_period).toBe(STARS.filter((s) => s.d === 0).length);
    expect(stars.every((s) => s.created_at <= T1.toISOString())).toBe(true);
    // 미리 넣은 링크는 제목이 있다
    const links = stars.flatMap((s) => s.attachments).filter((x) => x.kind === 'link');
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((x) => typeof x.link_title === 'string' && x.link_title)).toBe(true);
    // 그림은 축소본(원본 그대로)이 있고 <img> 주소가 나온다
    const img = stars.find((s) => s.has_thumb);
    expect(a.attachmentThumbUrl(img.thumb_attachment_id)).toMatch(/^blob:/);
    // 대화 기록 4개(Task 2 가 쓴다)
    expect(store.state.conversations).toHaveLength(CONVERSATIONS.length);
    expect(await a.character()).toEqual({ kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' });
  });

  test('다시 열어도(다음 날) 기준 시각이 그대로라 날짜가 밀리지 않고, 처음 상태로 때만 다시 계산한다', async () => {
    const adapter = memoryAdapter();
    const first = await openStore({ adapter, now: () => T1 });
    const a1 = createMockApi({ store: first, notify: () => {} });
    const dates1 = (await a1.stars()).map((s) => s.created_at);
    await a1.createPlanet({ name: '내 행성' });

    const again = await openStore({ adapter, now: () => T2 }); // 새로 고침
    const a2 = createMockApi({ store: again, notify: () => {} });
    expect(again.anchor).toBe(T1.toISOString());
    expect((await a2.stars()).map((s) => s.created_at)).toEqual(dates1);
    expect((await a2.planets()).some((p) => p.name === '내 행성')).toBe(true); // 바꾼 것도 남는다

    await a2.resetDemo();
    expect(again.anchor).toBe(T2.toISOString());
    const dates2 = (await a2.stars()).map((s) => s.created_at);
    expect(dates2).not.toEqual(dates1);
    expect((await a2.planets()).some((p) => p.name === '내 행성')).toBe(false);
    // 같은 d 의 별은 이틀 뒤로 밀린다(오늘 별 중 기준 시각보다 늦은 시각으로 당긴 것은 빼고 본다)
    const idx = STARS.findIndex((s) => s.d === 5);
    const byTitle = (list) => list.find((s) => s.title === STARS[idx].title).created_at;
    const before = byTitle(await a1.stars());
    const after = byTitle(await a2.stars());
    expect(Math.round((Date.parse(after) - Date.parse(before)) / 86_400_000)).toBe(2);

    const reopened = await openStore({ adapter, now: () => new Date(2027, 0, 1) });
    expect(reopened.anchor).toBe(T2.toISOString());
  });

  test('저장 실패(용량 초과): 죽지 않고 메모리로 계속 + 안내', async () => {
    const adapter = memoryAdapter({ failState: true, failBlobs: true });
    const store = await openStore({ adapter, now: () => T1 });
    expect(store.storageError?.message).toBe(STORAGE_ERROR_TOAST);
    const log = [];
    const a = createMockApi({ store, notify: (m) => log.push(m), noticeDelay: 0, makeThumb: fakeThumb });
    const p = await a.createPlanet({ name: '메모리 행성' });
    const { star } = await a.createStar({ planet_id: p.id, files: [file(pngA, 'm.png', 'image/png')] });
    expect(a.attachmentFileUrl(star.attachments[0].id)).toMatch(/^blob:/); // 저장소에 못 써도 이번 방문엔 보인다
    expect((await a.planets()).some((x) => x.name === '메모리 행성')).toBe(true);
    await tick(20);
    expect(log).toEqual([STORAGE_ERROR_TOAST]); // 실패가 이어지는 동안은 한 번만

    // 다시 저장되면 오류가 걷히고, 다음 실패에 다시 알린다
    adapter.failing.state = false;
    await a.patchPlanet(p.id, { name: '다시 저장' });
    expect(store.storageError).toBeNull();
    adapter.failing.state = true;
    await a.patchPlanet(p.id, { name: '또 실패' });
    await tick(20);
    expect(log).toEqual([STORAGE_ERROR_TOAST, STORAGE_ERROR_TOAST]);
  });

  test('저장소를 읽지 못하면(깨짐 · 막힘) 처음 상태로 심고 돈다', async () => {
    const adapter = memoryAdapter({ failLoad: true });
    const store = await openStore({ adapter, now: () => T1 });
    expect(store.state.stars).toHaveLength(STARS.length);
    expect(adapter.peek().state.anchor).toBe(T1.toISOString()); // 쓰기는 되므로 새로 심은 것을 저장했다
    // 쓰기까지 막힌 저장소(사이트 데이터 차단)도 메모리로 돈다
    const blocked = memoryAdapter({ failLoad: true, failState: true, failBlobs: true });
    const s2 = await openStore({ adapter: blocked, now: () => T1 });
    expect(s2.state.stars).toHaveLength(STARS.length);
    expect(s2.storageError?.message).toBe(STORAGE_ERROR_TOAST);
  });

  test('scripts/demo.mjs 는 같은 목록을 쓴다', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../../scripts/demo.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/from '\.\.\/web\/demo\/seed\.js'/);
    expect(src).not.toMatch(/const STARS = \[/);
  });
});
