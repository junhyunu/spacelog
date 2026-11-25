import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { RagError } from '../rag/client.js';
import { cleanup } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };
const T0 = Date.parse('2026-11-13T03:00:00.000Z');

// 흘려 보낼 이벤트를 테스트가 하나씩 밀어 넣는 가짜 /answer.
function controlStream(signal) {
  const items = [];
  let wake = null;
  let ended = false;
  let failure = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  signal?.addEventListener('abort', notify);
  return {
    push(...evs) {
      items.push(...evs);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    fail(err) {
      failure = err;
      notify();
    },
    aborted: () => Boolean(signal?.aborted),
    async *iter() {
      while (true) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise((r) => {
          wake = r;
        });
      }
    },
  };
}

function fakeRag() {
  const rag = {
    st: { state: 'ready' },
    bodies: [],
    streams: [],
    status: () => rag.st,
    client: {
      health: async () => ({ ok: true, key: true, model: 'm', embed_model: 'e', fake: true }),
      indexStar: async () => ({ chunks: 1, notes: [] }),
      removeStars: async (ids) => ({ removed: ids.length }),
      reset: async () => ({ ok: true }),
      stats: async () => ({ chunks: 0, stars: 0 }),
      answer: (body, { signal } = {}) => {
        rag.bodies.push(structuredClone(body));
        const s = controlStream(signal);
        rag.streams.push(s);
        return s.iter();
      },
    },
  };
  rag.last = () => rag.streams.at(-1);
  return rag;
}

async function waitFor(fn, ms = 2_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const apps = [];
afterEach(async () => {
  for (const { app, dataDir } of apps.splice(0)) {
    await app.close();
    cleanup(dataDir);
  }
});

async function setup({ enable = true, listen = false, chat = {}, dataDir } = {}) {
  const rag = fakeRag();
  const clock = { t: T0 };
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'spacelog-test-'));
  const app = buildApp({
    dataDir: dir,
    rag,
    fetchTitle: async () => null,
    opener: { open() {}, reveal() {} },
    ragSync: { now: () => clock.t, setTimer: () => null, clearTimer: () => {}, log: { error() {} } },
    chat: { now: () => clock.t, persistMs: 20, log: { error() {} }, ...chat },
  });
  await app.ready();
  const made = { app, dataDir: dir };
  apps.push(made);
  let port = null;
  if (listen) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = app.server.address().port;
  }
  const api = async (method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: HOST });
    return { code: res.statusCode, body: res.body ? res.json() : null };
  };
  if (enable) expect((await api('PUT', '/api/chat/settings', { consented: true, enabled: true })).code).toBe(200);
  const planet = async (name) => (await api('POST', '/api/planets', { name })).body.id;
  const star = async (planetId, body) => (await api('POST', '/api/stars', { planet_id: planetId, body })).body.star.id;
  const conversation = async () => (await api('POST', '/api/chat/conversations')).body.conversation.id;
  const ask = (convId, question = '이번 주에 뭐 했어?', extra = {}) =>
    api('POST', `/api/chat/conversations/${convId}/messages`, { question, today: '2026-11-13', tz_offset_min: 540, ...extra });
  const msgRow = (id) => app.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const sse = (id, headers = {}) => openSse(port, id, headers);
  return { app, rag, clock, api, planet, star, conversation, ask, msgRow, sse, dataDir: dir };
}

// 진짜 HTTP 로 SSE 를 받는다(가드는 Host 헤더를 본다).
function openSse(port, id, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/chat/messages/${id}/stream`, headers: { ...HOST, ...headers } },
      (res) => {
        const c = { status: res.statusCode, headers: res.headers, events: [], comments: 0, raw: '', ended: false, close: () => req.destroy() };
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          c.raw += d;
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(':')) {
              c.comments += 1;
              continue;
            }
            const type = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            c.events.push({ type, data: data ? JSON.parse(data) : null });
          }
        });
        const done = () => {
          c.ended = true;
        };
        res.on('end', done);
        res.on('close', done);
        resolve(c);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const types = (c) => c.events.map((e) => e.type);

describe('conversations', () => {
  test('create, list, get, delete (messages go too)', async () => {
    const { api, conversation, ask, rag, app } = await setup();
    const id = await conversation();
    let list = (await api('GET', '/api/chat/conversations')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, title: '새 대화', unread: false, running: false, last: null });

    const r = await ask(id);
    rag.last().push({ type: 'token', text: '답' }, { type: 'done', not_found: false });
    await waitFor(() => app.db.prepare("SELECT 1 FROM messages WHERE id = ? AND status = 'done'").get(r.body.assistant_message.id));
    list = (await api('GET', '/api/chat/conversations')).body;
    expect(list[0].last).toMatchObject({ role: 'assistant', preview: '답' });

    expect((await api('DELETE', `/api/chat/conversations/${id}`)).code).toBe(204);
    expect((await api('GET', `/api/chat/conversations/${id}`)).code).toBe(404);
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n).toBe(0);
    expect((await api('DELETE', `/api/chat/conversations/${id}`)).code).toBe(404);
  });

  test('title is the first 30 characters of the first question only', async () => {
    const { api, conversation, ask, rag, app } = await setup();
    const id = await conversation();
    const q1 = '가나다라마바사아자차카타파하 가나다라마바사아자차카타파하 끝까지 긴 질문';
    const r = await ask(id, q1);
    expect(r.code).toBe(202);
    const conv = (await api('GET', `/api/chat/conversations/${id}`)).body.conversation;
    expect(conv.title).toBe([...q1].slice(0, 30).join('').trim());
    rag.last().push({ type: 'done', not_found: false });
    await waitFor(() => !app.chatAnswers.busy());
    await ask(id, '두 번째 질문');
    expect((await api('GET', `/api/chat/conversations/${id}`)).body.conversation.title).toBe(conv.title);
  });

  test('deleting a conversation with a running answer stops it first', async () => {
    const { api, conversation, ask, rag, app } = await setup();
    const id = await conversation();
    await ask(id);
    const s = rag.last();
    expect((await api('DELETE', `/api/chat/conversations/${id}`)).code).toBe(204);
    expect(s.aborted()).toBe(true);
    expect(app.chatAnswers.busy()).toBe(false);
    expect((await ask(await conversation())).code).toBe(202);
  });
});

describe('asking', () => {
  test('chat off → 409 chat_off, nothing sent to python', async () => {
    const { conversation, ask, rag } = await setup({ enable: false });
    const r = await ask(await conversation());
    expect(r).toEqual({ code: 409, body: { error: 'chat_off' } });
    expect(rag.bodies).toHaveLength(0);
  });

  test('python not ready → 503 rag_unavailable', async () => {
    const { conversation, ask, rag } = await setup();
    rag.st = { state: 'starting' };
    expect(await ask(await conversation())).toEqual({ code: 503, body: { error: 'rag_unavailable' } });
    expect(rag.bodies).toHaveLength(0);
  });

  test('validation: question length, context, today, tz', async () => {
    const { conversation, ask, api } = await setup();
    const id = await conversation();
    expect((await ask(id, '   ')).body).toEqual({ error: 'invalid_question' });
    expect((await ask(id, 'ㄱ'.repeat(2001))).body).toEqual({ error: 'invalid_question' });
    expect((await ask(id, 'x', { context: 'p' })).body).toEqual({ error: 'invalid_context' });
    expect((await ask(id, 'x', { context: { planet_id: 3 } })).body).toEqual({ error: 'invalid_context' });
    expect((await ask(id, 'x', { today: '2026-13-01' })).body).toEqual({ error: 'invalid_today' });
    expect((await ask(id, 'x', { tz_offset_min: '540' })).body).toEqual({ error: 'invalid_tz_offset' });
    expect((await ask(id, 'x', { tz_offset_min: 10_000 })).body).toEqual({ error: 'invalid_tz_offset' });
    expect((await api('POST', '/api/chat/conversations/nope/messages', { question: 'x' })).code).toBe(404);
    expect((await ask(id, 'ㄱ'.repeat(2000))).code).toBe(202);
  });

  test('202 with both messages; body forwards today, tz, excluded planets and planet list', async () => {
    const { conversation, ask, rag, api, planet, star } = await setup();
    const keep = await planet('화성');
    const hide = await planet('비밀');
    await star(keep, '보이는 별');
    const hidden = await star(hide, '숨긴 별');
    await api('PUT', '/api/chat/settings', { excluded_planets: [hide] });
    const id = await conversation();
    const r = await ask(id, '요약해 줘', { today: '2026-11-12', tz_offset_min: -300, context: { planet_id: hide, planet_name: '비밀', star_id: hidden } });
    expect(r.code).toBe(202);
    expect(r.body.user_message).toMatchObject({ role: 'user', content: '요약해 줘', status: 'done', sources: [], conversation_id: id });
    expect(r.body.assistant_message).toMatchObject({ role: 'assistant', content: '', status: 'running', error: null, sources: [] });
    const b = rag.bodies[0];
    expect(b).toMatchObject({ question: '요약해 줘', today: '2026-11-12', tz_offset_min: -300, excluded_planets: [hide], history: [] });
    expect(b.planets).toEqual([{ id: keep, name: '화성' }]);
    expect(b.context).toEqual({}); // 빼 둔 행성 · 그 별의 맥락은 보내지 않는다
  });

  test('context planet name comes from the db; missing today/tz fall back to server local', async () => {
    const { conversation, rag, api, planet } = await setup();
    const p = await planet('목성');
    const id = await conversation();
    const r = await api('POST', `/api/chat/conversations/${id}/messages`, { question: '이 행성 요약', context: { planet_id: p, planet_name: '가짜' } });
    expect(r.code).toBe(202);
    const b = rag.bodies[0];
    expect(b.context).toEqual({ planet_id: p, planet_name: '목성' });
    expect(b.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isInteger(b.tz_offset_min)).toBe(true);
  });

  test('second question while one is running → 409 busy', async () => {
    const { conversation, ask } = await setup();
    expect((await ask(await conversation())).code).toBe(202);
    expect(await ask(await conversation())).toEqual({ code: 409, body: { error: 'busy' } });
  });

  test('history: only the last 6 earlier messages, oldest first, not the new ones', async () => {
    const { conversation, ask, rag, app } = await setup();
    const id = await conversation();
    for (let i = 1; i <= 4; i += 1) {
      await ask(id, `질문${i}`);
      rag.last().push({ type: 'token', text: `답${i}` }, { type: 'done', not_found: false });
      await waitFor(() => !app.chatAnswers.busy());
    }
    await ask(id, '질문5');
    const h = rag.bodies.at(-1).history;
    expect(h).toEqual([
      { role: 'user', content: '질문2' },
      { role: 'assistant', content: '답2' },
      { role: 'user', content: '질문3' },
      { role: 'assistant', content: '답3' },
      { role: 'user', content: '질문4' },
      { role: 'assistant', content: '답4' },
    ]);
  });

  test('usage counter +1 per accepted question and resets on a new month', async () => {
    const { conversation, ask, rag, app, clock } = await setup();
    const usage = () => JSON.parse(app.db.prepare("SELECT value FROM meta WHERE key = 'chat_usage'").get().value);
    app.db.prepare("INSERT INTO meta (key, value) VALUES ('chat_usage', ?)").run(JSON.stringify({ month: '2026-10', requests: 7 }));
    const id = await conversation();
    await ask(id);
    expect(usage()).toEqual({ month: '2026-11', requests: 1 });
    expect((await ask(id)).code).toBe(409); // busy 는 세지 않는다
    expect(usage()).toEqual({ month: '2026-11', requests: 1 });
    rag.last().push({ type: 'done', not_found: false });
    await waitFor(() => !app.chatAnswers.busy());
    clock.t = Date.parse('2026-12-01T00:00:00.000Z');
    await ask(id);
    expect(usage()).toEqual({ month: '2026-12', requests: 1 });
  });
});

describe('answer job', () => {
  test('tokens are saved periodically and finally; sources enriched; deleted star → exists false', async () => {
    const { conversation, ask, rag, app, api, msgRow, planet, star } = await setup();
    const p = await planet('화성');
    const s1 = await star(p, '첫 별');
    const s2 = await star(p, '둘째 별');
    const id = await conversation();
    const mid = (await ask(id)).body.assistant_message.id;
    const s = rag.last();
    s.push({ type: 'plan', intent: 'ask' }, { type: 'progress' }, { type: 'token', text: '안녕' }, { type: 'mystery' });
    await waitFor(() => msgRow(mid).content === '안녕'); // 0.5초(테스트는 20ms)마다 저장
    expect(msgRow(mid).status).toBe('running');
    s.push(
      { type: 'token', text: '하세요' },
      { type: 'sources', stars: [{ star_id: s1, attachment_id: null, file_name: null }, { star_id: s2, attachment_id: 'a1', file_name: 'x.pdf' }, { star_id: 'ghost' }] },
      { type: 'done', not_found: false },
    );
    await waitFor(() => msgRow(mid).status === 'done');
    expect(msgRow(mid).content).toBe('안녕하세요');
    expect(JSON.parse(msgRow(mid).sources)).toEqual([
      { star_id: s1, attachment_id: null, file_name: null },
      { star_id: s2, attachment_id: 'a1', file_name: 'x.pdf' },
    ]);
    await api('DELETE', `/api/stars/${s2}`);
    const m = (await api('GET', `/api/chat/conversations/${id}`)).body.messages[1];
    expect(m.sources[0]).toMatchObject({ star_id: s1, exists: true, title: '첫 별', planet_id: p });
    expect(m.sources[0].created_at).toEqual(expect.any(String));
    expect(m.sources[1]).toEqual({ star_id: s2, attachment_id: 'a1', file_name: 'x.pdf', exists: false, title: null, planet_id: null, created_at: null });
  });

  test('sources from a planet excluded meanwhile are dropped', async () => {
    const { conversation, ask, rag, api, msgRow, planet, star } = await setup();
    const a = await planet('a');
    const b = await planet('b');
    const sa = await star(a, '별a');
    const sb = await star(b, '별b');
    const mid = (await ask(await conversation())).body.assistant_message.id;
    await api('PUT', '/api/chat/settings', { excluded_planets: [b] });
    rag.last().push({ type: 'sources', stars: [{ star_id: sa }, { star_id: sb }] }, { type: 'done', not_found: false });
    await waitFor(() => msgRow(mid).status === 'done');
    expect(JSON.parse(msgRow(mid).sources).map((x) => x.star_id)).toEqual([sa]);
  });

  test('replace mid-stream overwrites everything so far', async () => {
    const { conversation, ask, rag, msgRow } = await setup();
    const mid = (await ask(await conversation())).body.assistant_message.id;
    rag.last().push({ type: 'token', text: '틀린 ' }, { type: 'token', text: '답' }, { type: 'replace', text: '기록에서 찾지 못했어요.' }, { type: 'done', not_found: true });
    await waitFor(() => msgRow(mid).status === 'done');
    expect(msgRow(mid).content).toBe('기록에서 찾지 못했어요.');
  });

  test.each([
    ['error event', (s) => s.push({ type: 'token', text: '부분' }, { type: 'error', code: 'openai_error', message: 'x' }), 'openai_error', '부분'],
    ['too_broad', (s) => s.push({ type: 'error', code: 'too_broad' }), 'too_broad', ''],
    ['key_missing', (s) => s.push({ type: 'error', code: 'key_missing' }), 'key_missing', ''],
    ['unknown error code', (s) => s.push({ type: 'error', code: 'weird' }), 'internal', ''],
    ['bad_request (400)', (s) => s.fail(new RagError('rag_error', { status: 400, detail: 'bad_request' })), 'bad_request', ''],
    ['fetch failed', (s) => s.fail(new RagError('unavailable', { detail: 'ECONNREFUSED' })), 'rag_unavailable', ''],
    ['stream cut', (s) => { s.push({ type: 'token', text: '반' }); s.fail(new TypeError('terminated')); }, 'rag_unavailable', '반'],
    ['ended without done', (s) => s.end(), 'internal', ''],
  ])('%s → failed with error code', async (_n, act, code, content) => {
    const { conversation, ask, rag, msgRow, app } = await setup();
    const mid = (await ask(await conversation())).body.assistant_message.id;
    act(rag.last());
    await waitFor(() => msgRow(mid).status === 'failed');
    expect(msgRow(mid)).toMatchObject({ error: code, content });
    expect(app.chatAnswers.busy()).toBe(false);
  });

  test('stop → stopped, python stream aborted, later tokens not saved; stop again → 409 not_running', async () => {
    const { conversation, ask, rag, api, msgRow } = await setup();
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const s = rag.last();
    s.push({ type: 'token', text: '앞' });
    await waitFor(() => msgRow(mid).content === '앞');
    const r = await api('POST', `/api/chat/messages/${mid}/stop`);
    expect(r.code).toBe(200);
    expect(r.body.message).toMatchObject({ id: mid, status: 'stopped', content: '앞' });
    expect(s.aborted()).toBe(true);
    s.push({ type: 'token', text: '뒤' }, { type: 'done', not_found: false });
    await new Promise((res) => setTimeout(res, 60));
    expect(msgRow(mid)).toMatchObject({ status: 'stopped', content: '앞' });
    expect(await api('POST', `/api/chat/messages/${mid}/stop`)).toEqual({ code: 409, body: { error: 'not_running' } });
    expect((await api('POST', '/api/chat/messages/nope/stop')).code).toBe(404);
    // 직접 멈춘 답은 빨간 점을 남기지 않는다(보고 있지 않았어도)
    expect((await api('GET', '/api/chat/unread')).body).toEqual({ count: 0 });
  });

  test('unread: set when finished with no subscriber, cleared by GET; /api/chat/unread counts', async () => {
    const { conversation, ask, rag, api, msgRow } = await setup();
    const id = await conversation();
    const mid = (await ask(id)).body.assistant_message.id;
    rag.last().push({ type: 'done', not_found: false });
    await waitFor(() => msgRow(mid).status === 'done');
    expect((await api('GET', '/api/chat/unread')).body).toEqual({ count: 1 });
    expect((await api('GET', '/api/chat/conversations')).body[0].unread).toBe(true);
    expect((await api('GET', `/api/chat/conversations/${id}`)).body.conversation.unread).toBe(false);
    expect((await api('GET', '/api/chat/unread')).body).toEqual({ count: 0 });
  });

  test('restart marks running messages failed / interrupted', async () => {
    const first = await setup();
    const id = await first.conversation();
    const db = first.app.db;
    db.prepare("INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES ('m1', ?, 'assistant', '반쯤', 'running', ?)").run(id, new Date(T0).toISOString());
    await first.app.close();
    apps.splice(apps.findIndex((a) => a.app === first.app), 1);
    const second = await setup({ dataDir: first.dataDir });
    expect(second.msgRow('m1')).toMatchObject({ status: 'failed', error: 'interrupted', content: '반쯤' });
  });

  test('a stuck job does not block shutdown: close aborts it and marks failed / interrupted', async () => {
    const { conversation, ask, rag, msgRow, app, dataDir } = await setup();
    const mid = (await ask(await conversation())).body.assistant_message.id;
    rag.last().push({ type: 'token', text: '멈춘' });
    await waitFor(() => msgRow(mid).content === '멈춘');
    const t = Date.now();
    await app.close();
    expect(Date.now() - t).toBeLessThan(1_500);
    expect(rag.last().aborted()).toBe(true);
    apps.splice(apps.findIndex((a) => a.app === app), 1);
    const db = new Database(path.join(dataDir, 'spacelog.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT status, error, content FROM messages WHERE id = ?').get(mid)).toEqual({ status: 'failed', error: 'interrupted', content: '멈춘' });
    } finally {
      db.close();
    }
    cleanup(dataDir);
  });
});

describe('SSE stream', () => {
  test('foreign Host is rejected by the guard (403)', async () => {
    const { conversation, ask, sse } = await setup({ listen: true });
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const c = await sse(mid, { host: 'evil.example:4747' });
    expect(c.status).toBe(403);
    await waitFor(() => c.ended);
    expect(JSON.parse(c.raw)).toEqual({ error: 'forbidden_host' });
    const x = await sse(mid, { 'sec-fetch-site': 'cross-site' });
    expect(x.status).toBe(403);
  });

  test('unknown message → 404', async () => {
    const { sse } = await setup({ listen: true });
    const c = await sse('nope');
    expect(c.status).toBe(404);
  });

  test('live: snapshot then tokens, sources, done; headers; subscriber present → no unread', async () => {
    const { conversation, ask, rag, sse, api, star, planet } = await setup({ listen: true });
    const s1 = await star(await planet('화성'), '별 하나');
    const id = await conversation();
    const mid = (await ask(id)).body.assistant_message.id;
    const c = await sse(mid);
    expect(c.status).toBe(200);
    expect(c.headers['content-type']).toBe('text/event-stream');
    expect(c.headers['cache-control']).toBe('no-cache');
    expect(c.headers['x-accel-buffering']).toBe('no');
    await waitFor(() => c.events.length === 1);
    expect(c.events[0]).toEqual({ type: 'snapshot', data: { content: '', sources: [], status: 'running', error: null } });
    rag.last().push({ type: 'token', text: '가' }, { type: 'token', text: '나' }, { type: 'replace', text: '다' });
    rag.last().push({ type: 'sources', stars: [{ star_id: s1, attachment_id: null, file_name: null }] }, { type: 'done', not_found: false });
    await waitFor(() => c.ended);
    expect(types(c)).toEqual(['snapshot', 'token', 'token', 'replace', 'sources', 'done']);
    expect(c.events[3].data).toEqual({ text: '다' });
    expect(c.events[4].data.sources[0]).toMatchObject({ star_id: s1, exists: true, title: '별 하나' });
    expect(c.events[5].data).toEqual({ status: 'done', not_found: false });
    expect((await api('GET', '/api/chat/unread')).body).toEqual({ count: 0 });
  });

  test('two subscribers both receive tokens', async () => {
    const { conversation, ask, rag, sse } = await setup({ listen: true });
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const a = await sse(mid);
    const b = await sse(mid);
    await waitFor(() => a.events.length === 1 && b.events.length === 1);
    rag.last().push({ type: 'token', text: '하나' }, { type: 'token', text: '둘' }, { type: 'done', not_found: false });
    await waitFor(() => a.ended && b.ended);
    for (const c of [a, b]) {
      expect(types(c)).toEqual(['snapshot', 'token', 'token', 'done']);
      expect(c.events.filter((e) => e.type === 'token').map((e) => e.data.text).join('')).toBe('하나둘');
    }
  });

  test('reconnect: closing and re-attaching gets the snapshot so far, then continues without gap or duplicates', async () => {
    const { conversation, ask, rag, sse, app } = await setup({ listen: true });
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const first = await sse(mid);
    await waitFor(() => first.events.length === 1);
    rag.last().push({ type: 'token', text: '하나' });
    await waitFor(() => first.events.length === 2);
    first.close();
    await waitFor(() => app.chatAnswers.current().subscribers.size === 0);
    rag.last().push({ type: 'token', text: '둘' });
    await waitFor(() => app.chatAnswers.current().content === '하나둘');
    const again = await sse(mid);
    await waitFor(() => again.events.length === 1);
    expect(again.events[0].data).toMatchObject({ content: '하나둘', status: 'running' });
    rag.last().push({ type: 'token', text: '셋' }, { type: 'done', not_found: false });
    await waitFor(() => again.ended);
    expect(types(again)).toEqual(['snapshot', 'token', 'done']);
    expect(again.events[0].data.content + again.events[1].data.text).toBe('하나둘셋');
  });

  test('finished message: snapshot + done (or error) then the stream ends', async () => {
    const { conversation, ask, rag, sse, msgRow } = await setup({ listen: true });
    const id = await conversation();
    const ok = (await ask(id)).body.assistant_message.id;
    rag.last().push({ type: 'token', text: '끝' }, { type: 'done', not_found: false });
    await waitFor(() => msgRow(ok).status === 'done');
    const c = await sse(ok);
    await waitFor(() => c.ended);
    expect(c.events).toEqual([
      { type: 'snapshot', data: { content: '끝', sources: [], status: 'done', error: null } },
      { type: 'done', data: { status: 'done' } },
    ]);

    const bad = (await ask(id)).body.assistant_message.id;
    rag.last().push({ type: 'error', code: 'too_broad' });
    await waitFor(() => msgRow(bad).status === 'failed');
    const d = await sse(bad);
    await waitFor(() => d.ended);
    expect(types(d)).toEqual(['snapshot', 'error']);
    expect(d.events[1].data).toEqual({ status: 'failed', code: 'too_broad' });
  });

  test('stop while subscribed → done { status: stopped }', async () => {
    const { conversation, ask, sse, api } = await setup({ listen: true });
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const c = await sse(mid);
    await waitFor(() => c.events.length === 1);
    await api('POST', `/api/chat/messages/${mid}/stop`);
    await waitFor(() => c.ended);
    expect(c.events.at(-1)).toEqual({ type: 'done', data: { status: 'stopped', not_found: false } });
  });

  test('heartbeat comments are sent while waiting', async () => {
    const { conversation, ask, sse } = await setup({ listen: true, chat: { heartbeatMs: 20 } });
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const c = await sse(mid);
    await waitFor(() => c.comments >= 2);
  });

  test('closing the app with an open stream ends the stream and does not hang', async () => {
    const { conversation, ask, sse, app, dataDir } = await setup({ listen: true });
    const mid = (await ask(await conversation())).body.assistant_message.id;
    const c = await sse(mid);
    await waitFor(() => c.events.length === 1);
    await app.close();
    apps.splice(apps.findIndex((a) => a.app === app), 1);
    await waitFor(() => c.ended);
    expect(c.events.at(-1)).toEqual({ type: 'error', data: { status: 'failed', code: 'interrupted' } });
    cleanup(dataDir);
  });
});

// --- 별로 저장: 답 → 띄운 별 ---
describe('saved star (별로 저장)', () => {
  async function answered(t) {
    const p = await t.planet('화성');
    const id = await t.conversation();
    const res = (await t.ask(id)).body;
    const s = t.rag.last();
    s.push({ type: 'token', text: '답이에요' }, { type: 'done', not_found: false });
    await waitFor(() => t.msgRow(res.assistant_message.id).status === 'done');
    return { p, id, userId: res.user_message.id, mid: res.assistant_message.id };
  }

  test('a new answer has saved_star null; linking a star shows it on the message, also after reload', async () => {
    const t = await setup();
    const { p, id, mid } = await answered(t);
    expect((await t.api('GET', `/api/chat/conversations/${id}`)).body.messages[1].saved_star).toBeNull();
    const sid = await t.star(p, '답이에요');
    const res = await t.api('PUT', `/api/chat/messages/${mid}/saved-star`, { star_id: sid });
    expect(res.code).toBe(200);
    expect(res.body.message.saved_star).toMatchObject({ id: sid, planet_id: p });
    expect(res.body.message.saved_star.created_at).toEqual(expect.any(String));
    const again = (await t.api('GET', `/api/chat/conversations/${id}`)).body.messages[1];
    expect(again.saved_star).toMatchObject({ id: sid, planet_id: p });
  });

  test('deleting the star turns the message back to saved_star null', async () => {
    const t = await setup();
    const { p, id, mid } = await answered(t);
    const sid = await t.star(p, '답이에요');
    await t.api('PUT', `/api/chat/messages/${mid}/saved-star`, { star_id: sid });
    await t.api('DELETE', `/api/stars/${sid}`);
    expect((await t.api('GET', `/api/chat/conversations/${id}`)).body.messages[1].saved_star).toBeNull();
  });

  test('refused: unknown message 404, a question (user message) 400, unknown star 400, missing star_id 400', async () => {
    const t = await setup();
    const { p, userId, mid } = await answered(t);
    const sid = await t.star(p, '답이에요');
    expect((await t.api('PUT', '/api/chat/messages/nope/saved-star', { star_id: sid })).code).toBe(404);
    const q = await t.api('PUT', `/api/chat/messages/${userId}/saved-star`, { star_id: sid });
    expect(q.code).toBe(400);
    expect(q.body).toEqual({ error: 'not_an_answer' });
    const ghost = await t.api('PUT', `/api/chat/messages/${mid}/saved-star`, { star_id: 'ghost' });
    expect(ghost.code).toBe(400);
    expect(ghost.body).toEqual({ error: 'unknown_star' });
    for (const body of [{}, { star_id: 5 }, { star_id: '' }]) {
      const bad = await t.api('PUT', `/api/chat/messages/${mid}/saved-star`, body);
      expect(bad.code).toBe(400);
      expect(bad.body).toEqual({ error: 'invalid_star_id' });
    }
    expect(t.msgRow(mid).saved_star_id).toBeNull();
  });
});
