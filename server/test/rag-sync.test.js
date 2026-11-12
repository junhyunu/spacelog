import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RagError } from '../rag/client.js';
import { insertStar } from '../stars.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };
const T0 = Date.parse('2026-11-13T00:00:00.000Z');

// 가짜 파이썬. 부른 것을 calls 에 적고, 색인된 별을 indexed 에 들고 있다(/stats 가 센다).
function fakeRag({ state = 'ready', embed = 'emb-a', key = true } = {}) {
  const calls = [];
  const indexed = new Set();
  const rag = {
    st: { state },
    embed,
    calls,
    indexed,
    onIndex: null, // (payload) => 결과 | throw
    status: () => rag.st,
    client: {
      health: async () => ({ ok: true, key, model: 'm', embed_model: rag.embed, fake: true }),
      indexStar: async (payload) => {
        calls.push(['index', payload.id, payload]);
        const res = rag.onIndex ? await rag.onIndex(payload) : { chunks: 1, notes: [] };
        indexed.add(payload.id);
        return res;
      },
      removeStars: async (ids) => {
        calls.push(['remove', [...ids]]);
        for (const id of ids) indexed.delete(id);
        return { removed: ids.length };
      },
      reset: async () => {
        calls.push(['reset']);
        indexed.clear();
        return { ok: true };
      },
      stats: async () => ({ chunks: indexed.size, stars: indexed.size }),
      answer: async function* () {},
    },
  };
  rag.indexCalls = () => calls.filter((c) => c[0] === 'index').map((c) => c[1]);
  rag.reset = () => calls.splice(0);
  return rag;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const apps = [];
afterEach(async () => {
  for (const { app, dataDir } of apps.splice(0)) {
    await app.close();
    cleanup(dataDir);
  }
});

async function setup(ragOpts = {}, syncOpts = {}) {
  const rag = fakeRag(ragOpts);
  const clock = { t: T0 };
  const made = await makeApp({
    rag,
    fetchTitle: async () => null,
    opener: { open() {}, reveal() {} },
    ragSync: { now: () => clock.t, setTimer: () => null, clearTimer: () => {}, log: { error() {} }, ...syncOpts },
  });
  apps.push(made);
  const { app } = made;
  const api = async (method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: HOST });
    return { code: res.statusCode, body: res.body ? res.json() : null };
  };
  const planet = async (name) => (await api('POST', '/api/planets', { name })).body.id;
  const star = async (planetId, body) => (await api('POST', '/api/stars', { planet_id: planetId, body })).body.star.id;
  const enable = async (extra = {}) => {
    const r = await api('PUT', '/api/chat/settings', { enabled: true, consented: true, ...extra });
    await app.ragSync.idle();
    return r;
  };
  const row = (id) => app.db.prepare('SELECT * FROM rag_status WHERE star_id = ?').get(id);
  const tick = async () => {
    app.ragSync.tick();
    await app.ragSync.idle();
  };
  return { app, rag, clock, api, planet, star, enable, row, tick, dataDir: made.dataDir };
}

describe('nothing leaves while the chatbot is off', () => {
  test('creating, editing and deleting stars makes no rag call', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const id = await s.star(p, '오늘은 비');
    await s.api('PATCH', `/api/stars/${id}`, { memo: '메모' });
    await s.api('DELETE', `/api/stars/${id}`);
    await s.tick();
    expect(s.rag.calls).toEqual([]);
    const settings = (await s.api('GET', '/api/chat/settings')).body;
    expect(settings).toMatchObject({ enabled: false, consented: false, excluded_planets: [], key: true });
    expect(settings.rag).toEqual({ state: 'ready', reason: null });
  });

  test('turning it off stops the queue but keeps statuses; turning it on again resumes', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    expect(s.row(a).status).toBe('done');
    await s.api('PUT', '/api/chat/settings', { enabled: false });
    s.rag.reset();
    await s.api('PATCH', `/api/stars/${a}`, { memo: '바뀜' });
    const b = await s.star(p, 'b');
    await s.tick();
    expect(s.rag.calls).toEqual([]);
    expect(s.row(a).status).toBe('done');
    await s.enable();
    expect(s.rag.indexCalls().sort()).toEqual([a, b].sort());
  });
});

describe('settings', () => {
  test('enabling needs consent in the same or an earlier request', async () => {
    const s = await setup();
    expect(await s.api('PUT', '/api/chat/settings', { enabled: true })).toEqual({ code: 400, body: { error: 'consent_required' } });
    expect((await s.api('PUT', '/api/chat/settings', { consented: true })).code).toBe(200);
    const r = await s.api('PUT', '/api/chat/settings', { enabled: true });
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, consented: true });
    // 동의를 거두면 꺼진다
    expect((await s.api('PUT', '/api/chat/settings', { consented: false })).body).toMatchObject({ enabled: false, consented: false });
    expect((await s.api('PUT', '/api/chat/settings', { enabled: true, consented: false })).body).toEqual({ error: 'consent_required' });
  });

  test('validation: unknown planet, wrong types, unknown keys', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    expect((await s.api('PUT', '/api/chat/settings', { excluded_planets: ['nope'] })).body).toEqual({ error: 'unknown_planet' });
    expect((await s.api('PUT', '/api/chat/settings', { excluded_planets: 'x' })).body).toEqual({ error: 'invalid_settings' });
    expect((await s.api('PUT', '/api/chat/settings', { enabled: 'yes' })).body).toEqual({ error: 'invalid_settings' });
    expect((await s.api('PUT', '/api/chat/settings', { other: 1 })).body).toEqual({ error: 'invalid_settings' });
    const ok = await s.api('PUT', '/api/chat/settings', { excluded_planets: [p, p] });
    expect(ok.body.excluded_planets).toEqual([p]);
  });

  test('response shape: index status and this month usage', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.star(p, 'a');
    let body = (await s.api('GET', '/api/chat/settings')).body;
    expect(body.index).toEqual({ total: 1, done: 0, failed: 0, pending: 1, skipped: 0, indexing: false, last_indexed_at: null });
    expect(body.usage).toEqual({ month: new Date().toISOString().slice(0, 7), requests: 0 });
    const month = new Date().toISOString().slice(0, 7);
    s.app.db.prepare("INSERT INTO meta (key, value) VALUES ('chat_usage', ?)").run(JSON.stringify({ month, requests: 7 }));
    body = (await s.api('GET', '/api/chat/settings')).body;
    expect(body.usage).toEqual({ month, requests: 7 });
    s.app.db.prepare("UPDATE meta SET value = ? WHERE key = 'chat_usage'").run(JSON.stringify({ month: '2000-01', requests: 7 }));
    expect((await s.api('GET', '/api/chat/settings')).body.usage.requests).toBe(0);
  });

  test('without a rag service the settings still work and nothing is synced', async () => {
    const made = await makeApp();
    apps.push(made);
    expect(made.app.ragSync).toBeUndefined();
    const res = await made.app.inject({ url: '/api/chat/settings', headers: HOST });
    expect(res.json()).toMatchObject({ enabled: false, key: null, rag: { state: 'off', reason: null }, index: { total: 0 } });
    const re = await made.app.inject({ method: 'POST', url: '/api/chat/reindex', payload: { scope: 'all' }, headers: HOST });
    expect(re.json()).toEqual({ error: 'chat_off' });
  });
});

describe('indexing', () => {
  test('enabling indexes every existing star with the full payload', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, '본문 a');
    const f = insertStar(s.app.db, {
      title: '문서', planet_id: p,
      attachments: [
        { kind: 'file', file_name: '문서.pdf', file_ext: 'PDF', file_size: 3, file_hash: 'h1', vault_path: 'vault/x.pdf' },
        { kind: 'link', url: 'https://example.com', link_title: '예시' },
      ],
    }).id;
    await s.enable();
    expect(s.rag.indexCalls().sort()).toEqual([a, f].sort());
    const payload = s.rag.calls.find((c) => c[1] === f)[2];
    expect(payload).toMatchObject({ id: f, planet_id: p, planet_name: '일기', title: '문서', body: null, memo: '' });
    expect(payload.attachments).toEqual([
      expect.objectContaining({ kind: 'file', file_name: '문서.pdf', path: path.resolve(s.dataDir, 'vault/x.pdf') }),
      expect.objectContaining({ kind: 'link', url: 'https://example.com', link_title: '예시', path: null }),
    ]);
    expect(s.row(a)).toMatchObject({ status: 'done', attempts: 0, notes: '[]', indexed_at: new Date(T0).toISOString() });
    expect((await s.api('GET', '/api/chat/settings')).body.index).toMatchObject({ total: 2, done: 2, pending: 0, indexing: false });
  });

  test('new stars are indexed once the chatbot is on', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    const a = await s.star(p, 'a');
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a]);
  });

  test('same content is not sent again; a memo change is', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.reset();
    await s.app.ragSync.reconcile();
    await s.app.ragSync.idle();
    await s.api('PATCH', `/api/stars/${a}`, { title: (await s.api('GET', `/api/stars/${a}`)).body.title });
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([]);
    await s.api('PATCH', `/api/stars/${a}`, { memo: '새 메모' });
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a]);
    expect(s.rag.calls.at(-1)[2].memo).toBe('새 메모');
  });

  test('renaming a planet re-sends its stars', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.reset();
    await s.api('PATCH', `/api/planets/${p}`, { name: '새 이름' });
    await s.app.ragSync.idle();
    expect(s.rag.calls.map((c) => [c[1], c[2]?.planet_name])).toEqual([[a, '새 이름']]);
  });

  test('planet merge / move re-sends the moved stars; deleting a planet with its stars removes them', async () => {
    const s = await setup();
    const p1 = await s.planet('하나');
    const p2 = await s.planet('둘');
    const p3 = await s.planet('셋');
    const a = await s.star(p1, 'a');
    const b = await s.star(p2, 'b');
    await s.enable();
    s.rag.reset();
    expect((await s.api('POST', `/api/planets/${p1}/merge`, { into: p2 })).body).toEqual({ moved: 1 });
    await s.app.ragSync.idle();
    expect(s.rag.calls.map((c) => [c[1], c[2]?.planet_id])).toEqual([[a, p2]]);
    s.rag.reset();
    expect((await s.api('DELETE', `/api/planets/${p2}?stars=move&into=${p3}`)).code).toBe(204);
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls().sort()).toEqual([a, b].sort());
    s.rag.reset();
    expect((await s.api('DELETE', `/api/planets/${p3}?stars=delete`)).code).toBe(204);
    await s.app.ragSync.idle();
    expect(s.rag.calls.length).toBeGreaterThan(0);
    expect(s.rag.calls.every((c) => c[0] === 'remove')).toBe(true);
    expect(s.rag.calls.flatMap((c) => c[1]).sort()).toEqual([a, b].sort());
  });

  test('deleting a star removes it from the index', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.reset();
    await s.api('DELETE', `/api/stars/${a}`);
    await s.app.ragSync.idle();
    expect(s.rag.calls).toEqual([['remove', [a]]]);
  });

  test('a star deleted while the chatbot is off is removed when it is turned on', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    await s.api('PUT', '/api/chat/settings', { enabled: false });
    s.rag.reset();
    await s.api('DELETE', `/api/stars/${a}`);
    expect(s.rag.calls).toEqual([]);
    await s.enable();
    expect(s.rag.calls.filter((c) => c[0] === 'remove')).toEqual([['remove', [a]]]);
  });
});

describe('excluded planets', () => {
  test('stars of an excluded planet are never sent and are skipped', async () => {
    const s = await setup();
    const keep = await s.planet('공개');
    const hide = await s.planet('비밀');
    const a = await s.star(keep, 'a');
    const b = await s.star(hide, '비밀 글');
    await s.enable({ excluded_planets: [hide] });
    expect(s.rag.indexCalls()).toEqual([a]);
    expect(s.rag.calls.some((c) => c[0] === 'index' && c[1] === b)).toBe(false);
    expect(s.row(b).status).toBe('skipped');
    // 나중에 만든 별도
    const c = await s.star(hide, '또 비밀');
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a]);
    expect(s.row(c).status).toBe('skipped');
    expect((await s.api('GET', '/api/chat/settings')).body.index).toMatchObject({ total: 3, done: 1, skipped: 2 });
  });

  test('excluding a planet later removes its stars at once; including it again re-indexes', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.reset();
    const r = await s.api('PUT', '/api/chat/settings', { excluded_planets: [p] });
    // 응답 전에 지워졌다
    expect(s.rag.calls).toEqual([['remove', [a]]]);
    expect(s.row(a).status).toBe('skipped');
    expect(r.body.excluded_planets).toEqual([p]);
    await s.app.ragSync.idle();
    s.rag.reset();
    await s.api('PUT', '/api/chat/settings', { excluded_planets: [] });
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a]);
    expect(s.row(a).status).toBe('done');
  });
});

describe('failures and retries', () => {
  test('failure → failed with next try in 1 minute → retried and done', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    let fail = true;
    s.rag.onIndex = async () => {
      if (fail) throw new RagError('rag_error', { status: 502, detail: 'embed_failed' });
      return { chunks: 1, notes: [{ attachment_id: 'x', note: 'partial' }] };
    };
    await s.enable();
    expect(s.row(a)).toMatchObject({ status: 'failed', error: 'embed_failed', attempts: 1, next_try_at: new Date(T0 + 60_000).toISOString() });
    s.clock.t = T0 + 30_000;
    await s.tick();
    expect(s.rag.indexCalls()).toEqual([a]);
    // 두 번째 실패 → 5분
    s.clock.t = T0 + 61_000;
    await s.tick();
    expect(s.row(a)).toMatchObject({ status: 'failed', attempts: 2, next_try_at: new Date(T0 + 61_000 + 5 * 60_000).toISOString() });
    fail = false;
    s.clock.t = T0 + 61_000 + 5 * 60_000;
    await s.tick();
    expect(s.row(a)).toMatchObject({ status: 'done', attempts: 0, error: null, notes: JSON.stringify([{ attachment_id: 'x', note: 'partial' }]) });
    expect(s.rag.indexCalls()).toEqual([a, a, a]);
  });

  test('python unavailable → stays pending, sent when it comes back', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    let down = true;
    s.rag.onIndex = async () => {
      if (down) throw new RagError('unavailable', { detail: 'ECONNREFUSED' });
      return { chunks: 1, notes: [] };
    };
    await s.enable();
    expect(s.row(a)?.status ?? 'pending').toBe('pending');
    expect((await s.api('GET', '/api/chat/settings')).body.index).toMatchObject({ pending: 1, failed: 0 });
    down = false;
    await s.tick();
    expect(s.row(a).status).toBe('done');
  });

  test('python not ready → queue waits; becoming ready reconciles', async () => {
    const s = await setup({ state: 'starting' });
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    await s.tick();
    expect(s.rag.calls).toEqual([]);
    s.rag.st = { state: 'ready' };
    await s.tick();
    expect(s.rag.indexCalls()).toEqual([a]);
  });

  test('a timeout counts as a failure with backoff', async () => {
    const s = await setup({}, { indexTimeoutMs: 20 });
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    s.rag.onIndex = () => new Promise(() => {});
    await s.enable();
    expect(s.row(a)).toMatchObject({ status: 'failed', error: 'timeout', attempts: 1, next_try_at: new Date(T0 + 60_000).toISOString() });
  });

  test('key_missing: one call, all failed, no retry storm until settings change or python is ready again', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const ids = [await s.star(p, 'a'), await s.star(p, 'b'), await s.star(p, 'c')];
    s.rag.onIndex = async () => {
      throw new RagError('rag_error', { status: 503, detail: 'key_missing' });
    };
    await s.enable();
    expect(s.rag.indexCalls()).toHaveLength(1);
    for (const id of ids) expect(s.row(id)).toMatchObject({ status: 'failed', error: 'key_missing', attempts: 0, next_try_at: null });
    // 시간이 지나도, 새 별이 생겨도 보내지 않는다
    s.clock.t = T0 + 3_600_000;
    await s.tick();
    await s.tick();
    const d = await s.star(p, 'd');
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toHaveLength(1);
    expect(s.row(d).error).toBe('key_missing');
    // 파이썬이 다시 ready 가 되면(키를 넣고 다시 켬) 다시 시도한다
    s.rag.onIndex = null;
    s.rag.st = { state: 'starting' };
    await s.tick();
    s.rag.st = { state: 'ready' };
    await s.tick();
    expect(s.rag.indexCalls()).toHaveLength(5);
    for (const id of [...ids, d]) expect(s.row(id).status).toBe('done');
  });

  test('key_missing is retried after a settings change', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    s.rag.onIndex = async () => {
      throw new RagError('rag_error', { status: 503, detail: 'key_missing' });
    };
    await s.enable();
    s.rag.onIndex = null;
    await s.api('PUT', '/api/chat/settings', { excluded_planets: [] });
    await s.app.ragSync.idle();
    expect(s.row(a).status).toBe('done');
  });

  test('reindex failed retries now; reindex all resets and sends everything', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    const b = await s.star(p, 'b');
    s.rag.onIndex = async (payload) => {
      if (payload.id === b) throw new RagError('rag_error', { status: 500, detail: 'storage_error' });
      return { chunks: 1, notes: [] };
    };
    await s.enable();
    expect((await s.api('GET', '/api/chat/settings')).body.index).toMatchObject({ done: 1, failed: 1 });
    s.rag.onIndex = null;
    s.rag.reset();
    expect((await s.api('POST', '/api/chat/reindex', { scope: 'failed' })).code).toBe(200);
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([b]);

    s.rag.reset();
    const r = await s.api('POST', '/api/chat/reindex', { scope: 'all' });
    expect(r.code).toBe(200);
    await s.app.ragSync.idle();
    expect(s.rag.calls[0]).toEqual(['reset']);
    expect(s.rag.indexCalls().sort()).toEqual([a, b].sort());
    expect((await s.api('GET', '/api/chat/settings')).body.index).toMatchObject({ total: 2, done: 2, failed: 0, pending: 0 });
    expect((await s.api('POST', '/api/chat/reindex', { scope: 'x' })).body).toEqual({ error: 'invalid_scope' });
    s.rag.st = { state: 'crashed', reason: 'exited' };
    expect((await s.api('POST', '/api/chat/reindex', { scope: 'all' })).body).toEqual({ error: 'rag_unavailable' });
  });
});

describe('reconcile', () => {
  test('embedding model change → full reindex', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const ids = [await s.star(p, 'a'), await s.star(p, 'b')];
    await s.enable();
    expect(s.app.db.prepare("SELECT value FROM meta WHERE key = 'rag_embed'").get().value).toBe('emb-a|true');
    s.rag.reset();
    // 같은 모델로 다시 켜지면 아무것도 보내지 않는다
    s.rag.st = { state: 'starting' };
    await s.tick();
    s.rag.st = { state: 'ready' };
    await s.tick();
    expect(s.rag.calls).toEqual([]);
    // 모델이 바뀌어 다시 켜진다
    s.rag.embed = 'emb-b';
    s.rag.st = { state: 'starting' };
    await s.tick();
    s.rag.st = { state: 'ready' };
    await s.tick();
    expect(s.rag.calls[0]).toEqual(['reset']);
    expect(s.rag.indexCalls().sort()).toEqual([...ids].sort());
    expect(s.app.db.prepare("SELECT value FROM meta WHERE key = 'rag_embed'").get().value).toBe('emb-b|true');
  });

  test('a broken (emptied) index on the python side → done stars are sent again', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const ids = [await s.star(p, 'a'), await s.star(p, 'b')];
    await s.enable();
    s.rag.reset();
    s.rag.indexed.clear(); // 파이썬이 깨진 index.json 을 옮기고 빈 색인으로 켜졌다
    s.rag.st = { state: 'starting' };
    await s.tick();
    s.rag.st = { state: 'ready' };
    await s.tick();
    expect(s.rag.calls.some((c) => c[0] === 'reset')).toBe(false);
    expect(s.rag.indexCalls().sort()).toEqual([...ids].sort());
  });

  test('queued ids are de-duplicated and run one at a time', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    const gate = deferred();
    let inFlight = 0;
    let maxInFlight = 0;
    s.rag.onIndex = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return { chunks: 1, notes: [] };
    };
    const a = await s.star(p, 'a'); // 색인 중(막힘)
    const b = await s.star(p, 'b');
    s.app.ragSync.markStars([b, b]);
    s.app.ragSync.markStars([b]);
    expect(s.app.ragSync.status().indexing).toBe(true);
    gate.resolve();
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a, b]);
    expect(maxInFlight).toBe(1);
  });

  test('a star changed while being indexed is sent again afterwards', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    const gate = deferred();
    s.rag.onIndex = async () => {
      await gate.promise;
      return { chunks: 1, notes: [] };
    };
    const a = await s.star(p, 'a');
    await s.api('PATCH', `/api/stars/${a}`, { memo: '색인 중에 바뀜' });
    gate.resolve();
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a, a]);
    expect(s.rag.calls.at(-1)[2].memo).toBe('색인 중에 바뀜');
    // 마지막 해시가 지금 내용과 맞다 → 다시 맞춰도 보내지 않는다
    s.rag.reset();
    await s.app.ragSync.reconcile();
    await s.app.ragSync.idle();
    expect(s.rag.calls.filter((c) => c[0] === 'index')).toEqual([]);
  });

  test('status counts', async () => {
    const s = await setup();
    const keep = await s.planet('공개');
    const hide = await s.planet('비밀');
    const a = await s.star(keep, 'a');
    const b = await s.star(keep, 'b');
    await s.star(hide, 'c');
    s.rag.onIndex = async (payload) => {
      if (payload.id === b) throw new RagError('rag_error', { status: 400, detail: 'bad_request' });
      return { chunks: 1, notes: [] };
    };
    await s.enable({ excluded_planets: [hide] });
    const st = s.app.ragSync.status();
    expect(st).toEqual({
      total: 3, done: 1, failed: 1, pending: 0, skipped: 1, indexing: false,
      last_indexed_at: s.row(a).indexed_at,
    });
  });
});
