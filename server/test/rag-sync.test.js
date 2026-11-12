import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
    onHealth: null, // () => 기다릴 것 | throw
    onRemove: null, // (ids) => throw
    healthCalls: 0,
    status: () => rag.st,
    client: {
      health: async () => {
        rag.healthCalls += 1;
        if (rag.onHealth) await rag.onHealth();
        return { ok: true, key, model: 'm', embed_model: rag.embed, fake: true };
      },
      indexStar: async (payload) => {
        calls.push(['index', payload.id, payload]);
        const res = rag.onIndex ? await rag.onIndex(payload) : { chunks: 1, notes: [] };
        if (!res?.discarded) indexed.add(payload.id);
        return res;
      },
      removeStars: async (ids) => {
        calls.push(['remove', [...ids]]);
        if (rag.onRemove) await rag.onRemove(ids);
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
    // 동의 전에는 파이썬의 /health 도 부르지 않는다(key 는 null).
    expect(settings).toMatchObject({ enabled: false, consented: false, excluded_planets: [], key: null });
    expect(settings.rag).toEqual({ state: 'ready', reason: null });
    expect(s.rag.healthCalls).toBe(0);
    const after = (await s.api('PUT', '/api/chat/settings', { consented: true })).body;
    expect(after.key).toBe(true);
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

describe('review fixes', () => {
  const removals = (s) => {
    const v = s.app.db.prepare("SELECT value FROM meta WHERE key = 'rag_removals'").get();
    return v ? JSON.parse(v.value) : [];
  };
  const removeCalls = (s) => s.rag.calls.filter((c) => c[0] === 'remove');
  const chatSettings = (s) => JSON.parse(s.app.db.prepare("SELECT value FROM meta WHERE key = 'chat'").get().value);

  test('/remove failing (500) → one call, then retried only after the 1 min / 5 min backoff; reset on success', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.reset();
    let n = 0;
    s.rag.onRemove = async () => {
      n += 1;
      if (n > 20) s.rag.st = { state: 'off' }; // 끝없이 돌면 멈추게 하는 안전장치
      throw new RagError('rag_error', { status: 500, detail: 'storage_error' });
    };
    await s.api('DELETE', `/api/stars/${a}`);
    await s.app.ragSync.idle();
    expect(removeCalls(s)).toHaveLength(1);
    expect(removals(s)).toEqual([a]);
    s.clock.t = T0 + 30_000;
    await s.tick();
    await s.tick();
    expect(removeCalls(s)).toHaveLength(1);
    s.clock.t = T0 + 60_000;
    await s.tick();
    expect(removeCalls(s)).toHaveLength(2);
    s.clock.t = T0 + 60_000 + 4 * 60_000;
    await s.tick();
    expect(removeCalls(s)).toHaveLength(2);
    s.rag.onRemove = null;
    s.clock.t = T0 + 60_000 + 5 * 60_000;
    await s.tick();
    expect(removeCalls(s)).toHaveLength(3);
    expect(removals(s)).toEqual([]);
  });

  test('/remove unavailable also backs off and keeps the removal', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.reset();
    s.rag.onRemove = async () => {
      throw new RagError('unavailable', { detail: 'ECONNREFUSED' });
    };
    await s.api('DELETE', `/api/stars/${a}`);
    await s.app.ragSync.idle();
    await s.tick();
    expect(removeCalls(s)).toHaveLength(1);
    expect(removals(s)).toEqual([a]);
  });

  test('a /remove failure does not hold up indexing of other stars', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    s.rag.onRemove = async () => {
      throw new RagError('rag_error', { status: 500, detail: 'storage_error' });
    };
    await s.api('DELETE', `/api/stars/${a}`);
    await s.app.ragSync.idle();
    s.rag.reset();
    const b = await s.star(p, 'b');
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([b]);
    expect(s.row(b).status).toBe('done');
  });

  test('discarded: excluded and included again while being indexed → indexed again, ends done', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    const gate = deferred();
    s.rag.onIndex = async () => gate.promise;
    const a = await s.star(p, 'a'); // 색인 중(막힘)
    await s.api('PUT', '/api/chat/settings', { excluded_planets: [p] });
    await s.api('PUT', '/api/chat/settings', { excluded_planets: [] });
    s.rag.onIndex = null;
    gate.resolve({ chunks: 0, notes: [], discarded: true });
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a, a]);
    expect(s.row(a)).toMatchObject({ status: 'done' });
    expect(s.rag.indexed.has(a)).toBe(true);
  });

  test('discarded while the planet is still excluded → stays skipped, not sent again', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    const gate = deferred();
    s.rag.onIndex = async () => gate.promise;
    const a = await s.star(p, 'a');
    await s.api('PUT', '/api/chat/settings', { excluded_planets: [p] });
    gate.resolve({ chunks: 0, notes: [], discarded: true });
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([a]);
    expect(s.row(a)).toMatchObject({ status: 'skipped', content_hash: null });
  });

  test('a discarded result is recorded as pending with no hash, never as done', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    let first = true;
    const seen = [];
    s.rag.onIndex = async (payload) => {
      if (first) {
        first = false;
        return { chunks: 0, notes: [], discarded: true };
      }
      seen.push(s.row(payload.id));
      return { chunks: 1, notes: [] };
    };
    const a = await s.star(p, 'a');
    await s.app.ragSync.idle();
    expect(seen[0]).toMatchObject({ status: 'pending', content_hash: null });
    expect(s.row(a).status).toBe('done');
  });

  test('excluding the planet during the awaited health check → no /index call', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    // 파이썬이 다시 켜졌는데 /health 가 실패 → embedKey 가 비어 있다
    s.rag.onHealth = async () => {
      throw new RagError('unavailable', { detail: 'ECONNREFUSED' });
    };
    s.rag.st = { state: 'starting' };
    await s.tick();
    s.rag.st = { state: 'ready' };
    await s.tick();
    const gate = deferred();
    s.rag.onHealth = () => gate.promise;
    s.rag.reset();
    const a = await s.star(p, 'a'); // /health 를 기다리는 중
    // 설정 응답도 /health 를 기다리므로, 설정이 적힌 것을 본 뒤 /health 를 풀어 준다.
    const put = s.api('PUT', '/api/chat/settings', { excluded_planets: [p] });
    await vi.waitFor(() => expect(chatSettings(s).excluded_planets).toEqual([p]));
    gate.resolve();
    await put;
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([]);
    expect(s.row(a).status).toBe('skipped');
  });

  test('turning the chatbot off during the awaited health check → no /index call', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    await s.enable();
    s.rag.onHealth = async () => {
      throw new RagError('unavailable', { detail: 'ECONNREFUSED' });
    };
    s.rag.st = { state: 'starting' };
    await s.tick();
    s.rag.st = { state: 'ready' };
    await s.tick();
    const gate = deferred();
    s.rag.onHealth = () => gate.promise;
    s.rag.reset();
    await s.star(p, 'a');
    const put = s.api('PUT', '/api/chat/settings', { enabled: false });
    await vi.waitFor(() => expect(chatSettings(s).enabled).toBe(false));
    gate.resolve();
    await put;
    await s.app.ragSync.idle();
    expect(s.rag.indexCalls()).toEqual([]);
  });

  test('star delete records the removal in the same transaction (lost notification still removes it)', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    const mark = s.app.ragSync.markStars;
    s.app.ragSync.markStars = () => {}; // 커밋 뒤 알림 전에 꺼졌다
    await s.api('DELETE', `/api/stars/${a}`);
    s.app.ragSync.markStars = mark;
    expect(removals(s)).toEqual([a]);
    s.rag.reset();
    await s.tick();
    expect(s.rag.calls).toEqual([['remove', [a]]]);
    expect(removals(s)).toEqual([]);
  });

  test('planet ?stars=delete records only stars that were sent to the index', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    await s.api('PUT', '/api/chat/settings', { enabled: false });
    await s.star(p, 'b'); // 꺼져 있는 동안 만든 별: 보낸 적 없다
    const mark = s.app.ragSync.markStars;
    s.app.ragSync.markStars = () => {};
    expect((await s.api('DELETE', `/api/planets/${p}?stars=delete`)).code).toBe(204);
    s.app.ragSync.markStars = mark;
    expect(removals(s)).toEqual([a]);
  });

  test('a never-indexed star leaves nothing in rag_removals; an in-flight one does', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const off = await s.star(p, 'off');
    await s.api('DELETE', `/api/stars/${off}`);
    expect(removals(s)).toEqual([]);
    await s.enable();
    const gate = deferred();
    s.rag.onIndex = async () => gate.promise;
    const a = await s.star(p, 'a'); // 색인 중
    s.rag.onRemove = async () => {
      throw new RagError('rag_error', { status: 500, detail: 'storage_error' });
    };
    await s.api('DELETE', `/api/stars/${a}`);
    expect(removals(s)).toEqual([a]);
    gate.resolve({ chunks: 1, notes: [] });
    await s.app.ragSync.idle();
  });

  test('rag_removals is capped at 10,000 ids (oldest dropped with a warning)', async () => {
    const s = await setup();
    const p = await s.planet('일기');
    const a = await s.star(p, 'a');
    await s.enable();
    const old = Array.from({ length: 10_000 }, (_, i) => `old-${i}`);
    s.app.db.prepare("INSERT INTO meta (key, value) VALUES ('rag_removals', ?)").run(JSON.stringify(old));
    s.rag.onRemove = async () => {
      throw new RagError('rag_error', { status: 500, detail: 'storage_error' });
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mark = s.app.ragSync.markStars;
      s.app.ragSync.markStars = () => {};
      await s.api('DELETE', `/api/stars/${a}`);
      s.app.ragSync.markStars = mark;
      const list = removals(s);
      expect(list).toHaveLength(10_000);
      expect(list[0]).toBe('old-1');
      expect(list.at(-1)).toBe(a);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
