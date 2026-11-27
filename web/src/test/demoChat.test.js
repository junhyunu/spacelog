// 체험판 가짜 챗봇(web/demo/chat.js + mockApi.js): 준비된 질문 매칭, 그 밖의 질문 안내, 흘려 보내기 순서, 멈추기,
// 출처 거르기(지운 별 · 빼 둔 행성), 새로 고침 뒤 기록, 읽지 않음.
import { describe, expect, test } from 'vitest';
import { FALLBACK_INTRO, NOT_FOUND_TEXT, SUGGESTIONS, buildAnswer, matchId, normalizeQuestion, tokenize } from '../../demo/chat.js';
import { createMockApi } from '../../demo/mockApi.js';
import { STORAGE_ERROR_TOAST, buildSeedState, memoryAdapter, openStore } from '../../demo/store.js';
import { isLongAnswer, quickQuestions } from '../ui/chatLogic.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ANCHOR = new Date('2026-11-27T12:00:00');
const META = { today: '2026-11-27', tz_offset_min: -ANCHOR.getTimezoneOffset() };

async function seeded(adapter = memoryAdapter()) {
  return openStore({ adapter, now: () => ANCHOR, seed: buildSeedState });
}

async function setup(opts = {}) {
  const adapter = opts.adapter ?? memoryAdapter();
  const store = await seeded(adapter);
  const api = createMockApi({ store, notify: () => {}, tokenMs: 0, thinkMs: 0, makeThumb: async () => null, ...opts.api });
  return { store, api, adapter };
}

// 흘려 받기를 끝까지 모은다 → { events, done }
function collect(api, messageId) {
  const events = [];
  let closeFn;
  const done = new Promise((resolve) => {
    closeFn = api.streamAnswer(messageId, {
      onSnapshot: (d) => events.push(['snapshot', d]),
      onToken: (t) => events.push(['token', t]),
      onReplace: (t) => events.push(['replace', t]),
      onSources: (s) => events.push(['sources', s]),
      onDone: (d) => {
        events.push(['done', d]);
        resolve(d);
      },
      onError: (d) => {
        events.push(['error', d]);
        resolve(d);
      },
    });
  });
  return { events, done, close: () => closeFn() };
}

async function askOne(api, question, context = {}) {
  const { conversation } = await api.createConversation();
  const r = await api.ask(conversation.id, { question, context, ...META });
  return { conv: conversation, ...r };
}

// 만들던 답이 끝날 때까지(구독하지 않고) 기다린다
async function idle(api) {
  for (let i = 0; i < 500; i++) {
    if (!(await api.conversations()).some((c) => c.running)) return;
    await tick(5);
  }
  throw new Error('답이 끝나지 않았어요');
}

const planetId = (store, name) => store.state.planets.find((p) => p.name === name).id;

describe('준비된 질문 매칭', () => {
  test('추천 질문 칩: 행성 패널이 닫혔을 때 · 열린 모든 행성(미분류 · 빈 행성 포함)', async () => {
    const store = await seeded();
    const st = store.state;
    const variants = [quickQuestions({})];
    for (const p of st.planets) variants.push(quickQuestions({ inWorld: true, panelPlanetId: p.id, planets: st.planets }));
    const seen = new Set();
    for (const qs of variants) {
      for (const q of qs) {
        seen.add(q);
        const id = matchId(st, q, META);
        expect(id, q).not.toBeNull();
        const a = buildAnswer(st, q, META);
        expect(a.content.startsWith(FALLBACK_INTRO), q).toBe(false);
      }
    }
    expect(matchId(st, '오늘 띄운 별 요약해 줘', META)).toBe('today');
    expect(matchId(st, '이번 주 기록 정리해 줘', META)).toBe('week');
    expect(matchId(st, '이번 달 기록에서 링크 찾아 줘', META)).toBe('month-links');
    expect(matchId(st, "'독서 노트' 행성 요약해 줘", META)).toBe('planet-chip');
    expect(seen.size).toBe(3 + st.planets.length);
  });

  test('행성 칩의 답은 그 행성의 지금 별로 만든다(빈 행성 · 사용자가 만든 행성도)', async () => {
    const { store, api } = await setup();
    const book = buildAnswer(store.state, "'독서 노트' 행성 요약해 줘", META);
    expect(book.content).toContain("'독서 노트' 행성");
    expect(book.content).toContain('『데미안』 밑줄');
    expect(book.sources.length).toBeGreaterThan(0);
    expect(buildAnswer(store.state, "'영화 · 드라마' 행성 요약해 줘", META).content).toContain('아직 비어 있어요');
    const p = await api.createPlanet({ name: '새 행성' });
    await api.createStar({ planet_id: p.id, title: '첫 별', body: '내용' });
    const mine = buildAnswer(store.state, "'새 행성' 행성 요약해 줘", META);
    expect(mine.content).toContain('첫 별');
  });

  test('대표 질문들(띄어쓰기 · 대소문자 · NFD 무시)', async () => {
    const store = await seeded();
    const st = store.state;
    const cases = [
      ['RAG가 뭐야?', 'rag'],
      ['rag 가 뭐야', 'rag'],
      ['이번 주에 뭐 기록했어?', 'week'],
      ['이번주에 뭐 기록했어', 'week'],
      ['오늘 뭐 했어?', 'today'],
      ['교토 여행 링크 있어?', 'trip-links'],
      ['독서 노트 요약해 줘', 'books'],
      ['최근에 읽은 책 알려 줘', 'books'],
      ['운동 기록 알려 줘', 'workout'],
      ['미분류에 뭐 있어?', 'planet-name'],
      ['발표 준비 기록 찾아 줘', 'talk'],
      ['일 아이디어 뭐 있었지?', 'ideas'],
      ['제주 준비물 뭐 적어 뒀어?', 'jeju-pack'],
      ['항공권은 어디가 제일 쌌어?', 'flight'],
      ['여행 계획 정리해 줘', 'planet-name'],
      ['이번 주 기록 정리해 줘'.normalize('NFD'), 'week'],
    ];
    for (const [q, id] of cases) expect(matchId(st, q, META), q).toBe(id);
    for (const q of SUGGESTIONS) expect(matchId(st, q, META), q).not.toBeNull();
    expect(normalizeQuestion('  이번 주,  기록 정리해 줘?! ')).toBe('이번주기록정리해줘');
  });

  test('답 내용: 지금 데이터로 계산한다', async () => {
    const { store, api } = await setup();
    const rag = buildAnswer(store.state, 'RAG가 뭐야?', META);
    expect(rag.content).toContain('500자, 겹침 50자');
    expect(rag.sources.map((s) => store.state.stars.find((x) => x.id === s.star_id)?.title)).toEqual([
      'RAG 파이프라인 노트',
      'RAG 실습 3일차',
      'Retrieval-augmented generation 위키',
    ]);
    expect(rag.sources[0].file_name).toBe('RAG 파이프라인 정리.md');
    const kyoto = buildAnswer(store.state, '교토 여행 링크 있어?', META);
    expect(kyoto.content).toContain("'여행 가고 싶은 곳'");
    expect(kyoto.content).toContain('https://ko.wikipedia.org/wiki/제주특별자치도');
    // 오늘 띄운 별: 방문자가 새로 띄운 별이 들어간다
    await api.createStar({ planet_id: 'unsorted', title: '방금 띄운 별', body: '테스트' });
    const today = buildAnswer(store.state, '오늘 띄운 별 요약해 줘', { ...META, today: new Date().toISOString().slice(0, 10), tz_offset_min: 0 });
    expect(today.content).toContain('방금 띄운 별');
    const links = buildAnswer(store.state, '이번 달 기록에서 링크 찾아 줘', META);
    expect(links.content).toContain('https://');
  });

  test('그 밖의 질문: 안내 + 추천 질문 3개, 출처 없음', async () => {
    const store = await seeded();
    for (const q of ['날씨 어때?', '파이썬으로 웹 크롤러 만드는 법', 'hello']) {
      expect(matchId(store.state, q, META), q).toBeNull();
      const a = buildAnswer(store.state, q, META);
      const lines = a.content.split('\n');
      expect(lines[0]).toBe('체험판에서는 준비된 질문에만 답해요. 아래 같은 질문을 해 보세요:');
      expect(lines).toHaveLength(4);
      for (const l of lines.slice(1)) {
        expect(l.startsWith('- ')).toBe(true);
        expect(SUGGESTIONS).toContain(l.slice(2));
      }
      expect(new Set(lines.slice(1)).size).toBe(3);
      expect(a.sources).toEqual([]);
      expect(a.not_found).toBe(true);
    }
  });

  test('tokenize: 2~4글자씩, 합치면 원문', () => {
    const t = tokenize('안녕하세요. 체험판이에요 👋');
    expect(t.join('')).toBe('안녕하세요. 체험판이에요 👋');
    expect(t.every((x) => [...x].length >= 1 && [...x].length <= 4)).toBe(true);
  });
});

describe('대화 · 흘려 보내기', () => {
  test('처음 상태: 켜져 있고 바로 쓸 수 있다, 미리 넣은 대화 5개(긴 답 1개) · 읽지 않음 1개', async () => {
    const { api } = await setup();
    expect(await api.chatStatus()).toEqual({ rag: { state: 'ready', reason: null }, key: true });
    const st = await api.chatSettings();
    expect(st).toMatchObject({ enabled: true, consented: true, excluded_planets: [], key: true, rag: { state: 'ready', reason: null } });
    expect(st.index.done).toBe(st.index.total);
    const list = await api.conversations();
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ title: '이번 달 운동 기록 요약해 줘', unread: true, running: false });
    expect(list[0].last).toMatchObject({ role: 'assistant', status: 'done' });
    expect(await api.unread()).toEqual({ count: 1 });
    const r = await api.conversation(list[0].id);
    // 긴 답 대화: 크게 보기 기준(600자 · 12줄)을 넘는다
    const long = list.find((c) => c.title === '3주차 회고 자세히 요약해 줘');
    const lr = await api.conversation(long.id);
    expect(isLongAnswer(lr.messages[1].content)).toBe(true);
    expect(lr.messages[1].sources.map((x) => x.exists)).toEqual([true, true, true]);
    expect(r.messages[1].sources[0]).toMatchObject({ exists: true, file_name: '운동 기록.csv' });
    expect(await api.unread()).toEqual({ count: 0 });
  });

  test('묻기 → 202 모양, 스트림 순서 snapshot → token… → sources → done, 기록에 남는다', async () => {
    const { api } = await setup();
    const r = await askOne(api, 'RAG가 뭐야?');
    expect(r.user_message).toMatchObject({ role: 'user', content: 'RAG가 뭐야?', status: 'done', sources: [], saved_star: null });
    expect(r.assistant_message).toMatchObject({ role: 'assistant', content: '', status: 'running', error: null });
    const { events, done } = collect(api, r.assistant_message.id);
    expect(await done).toEqual({ status: 'done', not_found: false });
    const kinds = events.map((e) => e[0]);
    expect(kinds[0]).toBe('snapshot');
    expect(events[0][1]).toMatchObject({ status: 'running', error: null });
    const firstSources = kinds.indexOf('sources');
    expect(kinds.slice(1, firstSources).every((k) => k === 'token')).toBe(true);
    expect(firstSources).toBeGreaterThan(3);
    expect(kinds.slice(firstSources)).toEqual(['sources', 'done']);
    const text = events.filter((e) => e[0] === 'token').map((e) => e[1]).join('');
    const sources = events[firstSources][1];
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({ exists: true, title: 'RAG 파이프라인 노트', file_name: 'RAG 파이프라인 정리.md' });
    const conv = await api.conversation(r.conv.id);
    expect(conv.conversation.title).toBe('RAG가 뭐야?');
    expect(conv.messages[1]).toMatchObject({ content: text, status: 'done' });
    expect(conv.messages[1].sources).toEqual(sources);
    // 끝난 답에 다시 붙으면 snapshot + done
    const again = collect(api, r.assistant_message.id);
    await again.done;
    expect(again.events.map((e) => e[0])).toEqual(['snapshot', 'done']);
    expect(again.events[0][1].content).toBe(text);
  });

  test('그 밖의 질문은 not_found: true 로 끝난다(별로 저장 없음)', async () => {
    const { api } = await setup();
    const r = await askOne(api, '날씨 어때?');
    const { events, done } = collect(api, r.assistant_message.id);
    expect(await done).toEqual({ status: 'done', not_found: true });
    expect(events.find((e) => e[0] === 'sources')[1]).toEqual([]);
  });

  test('한 번에 하나(409 busy), 꺼져 있으면 409 chat_off, 검사 오류', async () => {
    const { api } = await setup({ api: { tokenMs: 5 } });
    const r = await askOne(api, 'RAG가 뭐야?');
    await expect(api.ask(r.conv.id, { question: '또', ...META })).rejects.toMatchObject({ status: 409, code: 'busy' });
    await expect(api.ask(r.conv.id, { question: '   ', ...META })).rejects.toMatchObject({ status: 400, code: 'invalid_question' });
    await expect(api.ask(r.conv.id, { question: 'x', today: '2026-13-01' })).rejects.toMatchObject({ status: 400, code: 'invalid_today' });
    await expect(api.ask('nope', { question: 'x', ...META })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await api.stopAnswer(r.assistant_message.id);
    await api.saveChatSettings({ enabled: false });
    await expect(api.ask(r.conv.id, { question: 'x', ...META })).rejects.toMatchObject({ status: 409, code: 'chat_off' });
    await expect(api.reindex('all')).rejects.toMatchObject({ status: 409, code: 'chat_off' });
    await api.saveChatSettings({ enabled: true });
    expect(await api.reindex('all')).toHaveProperty('index.indexing', false);
  });

  test('멈추기: 그 자리까지의 글을 두고 stopped, 다시 멈추면 409 not_running', async () => {
    const { api } = await setup({ api: { tokenMs: 4 } });
    const r = await askOne(api, 'RAG가 뭐야?');
    const id = r.assistant_message.id;
    const { events, done } = collect(api, id);
    await tick(40);
    const res = await api.stopAnswer(id);
    expect(res.message.status).toBe('stopped');
    expect(await done).toEqual({ status: 'stopped', not_found: false });
    const text = events.filter((e) => e[0] === 'token').map((e) => e[1]).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(res.message.content).toBe(text);
    expect(text.length).toBeLessThan(buildAnswer((await api.demoStore()).state, 'RAG가 뭐야?', META).content.length);
    expect(events.some((e) => e[0] === 'sources')).toBe(false);
    await tick(30);
    const conv = await api.conversation(r.conv.id);
    expect(conv.messages[1]).toMatchObject({ status: 'stopped', content: text });
    await expect(api.stopAnswer(id)).rejects.toMatchObject({ status: 409, code: 'not_running' });
    expect(await api.unread()).toEqual({ count: 1 }); // 미리 넣은 것 하나뿐(멈춘 답은 읽지 않음이 아니다)
  });

  test('출처: 지운 별 · 빼 둔 행성의 별은 인용하지 않는다(흘리는 중에 지워도)', async () => {
    const { api, store } = await setup({ api: { tokenMs: 2 } });
    const rag3 = store.state.stars.find((s) => s.title === 'RAG 실습 3일차');
    await api.deleteStar(rag3.id);
    let a = buildAnswer(store.state, 'RAG가 뭐야?', META);
    expect(a.sources.map((s) => s.star_id)).not.toContain(rag3.id);
    expect(a.sources).toHaveLength(2);
    // 흘리는 중에 지운 별
    const r = await askOne(api, 'RAG가 뭐야?');
    const md = store.state.stars.find((s) => s.title === 'RAG 파이프라인 노트');
    await api.deleteStar(md.id);
    const { events, done } = collect(api, r.assistant_message.id);
    await done;
    const src = events.find((e) => e[0] === 'sources')[1];
    expect(src.map((s) => s.title)).toEqual(['Retrieval-augmented generation 위키']);
    // 빼 둔 행성: 그 행성의 별은 없는 것처럼
    const ai = planetId(store, '원티드 AI 교육');
    await api.saveChatSettings({ excluded_planets: [ai] });
    a = buildAnswer(store.state, 'RAG가 뭐야?', META);
    expect(a).toEqual({ content: NOT_FOUND_TEXT, sources: [], not_found: true });
    const chip = buildAnswer(store.state, "'원티드 AI 교육' 행성 요약해 줘", META);
    expect(chip.content).toContain('빼 두셨어요');
    expect(chip.sources).toEqual([]);
    const week = buildAnswer(store.state, '이번 주 기록 정리해 줘', META);
    const ids = new Set(store.state.stars.filter((s) => s.planet_id === ai).map((s) => s.id));
    expect(week.sources.some((s) => ids.has(s.star_id))).toBe(false);
    expect(week.content).not.toContain('원티드 AI 교육');
    const st = await api.chatSettings();
    expect(st.index.skipped).toBe(ids.size);
  });

  test('읽지 않음: 아무도 보지 않을 때 끝난 답만', async () => {
    const { api } = await setup();
    const first = await api.conversations();
    await api.conversation(first[0].id); // 미리 넣은 읽지 않음을 지운다
    expect(await api.unread()).toEqual({ count: 0 });
    const r = await askOne(api, '독서 노트 요약해 줘');
    await idle(api); // 구독하지 않은 채 끝난다
    expect(await api.unread()).toEqual({ count: 1 });
    const list = await api.conversations();
    expect(list.find((c) => c.id === r.conv.id)).toMatchObject({ unread: true, running: false });
    await api.conversation(r.conv.id);
    expect(await api.unread()).toEqual({ count: 0 });
    const r2 = await askOne(api, '운동 기록 알려 줘');
    await collect(api, r2.assistant_message.id).done; // 보고 있었다
    expect(await api.unread()).toEqual({ count: 0 });
  });

  test('새로 고침: 기록이 남고, 만들던 답은 failed / interrupted', async () => {
    const adapter = memoryAdapter();
    const one = await setup({ adapter });
    const done = await askOne(one.api, '독서 노트 요약해 줘');
    const full = await collect(one.api, done.assistant_message.id).done;
    expect(full.status).toBe('done');
    const slow = createMockApi({ store: one.store, notify: () => {}, tokenMs: 1000, thinkMs: 1000 });
    const running = await askOne(slow, 'RAG가 뭐야?');
    expect(adapter.peek().state.messages.find((m) => m.id === running.assistant_message.id).status).toBe('running');

    // 같은 저장소로 다시 연다(새로 고침)
    const store2 = await openStore({ adapter, now: () => ANCHOR, seed: buildSeedState });
    const api2 = createMockApi({ store: store2, notify: () => {}, tokenMs: 0, thinkMs: 0 });
    const conv = await api2.conversation(done.conv.id);
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1].status).toBe('done');
    expect(conv.messages[1].content).toContain('독서 기록은');
    const cut = await api2.conversation(running.conv.id);
    expect(cut.messages[1]).toMatchObject({ status: 'failed', error: 'interrupted' });
    const s = collect(api2, running.assistant_message.id);
    expect(await s.done).toEqual({ status: 'failed', code: 'interrupted' });
    expect(s.events.map((e) => e[0])).toEqual(['snapshot', 'error']);
    expect((await api2.conversations()).find((c) => c.id === running.conv.id).running).toBe(false);
    await slow.stopAnswer(running.assistant_message.id); // 앞 탭의 타이머 정리
  });

  test('대화 지우기(만들던 답도 멈춘다) · 별로 저장 잇기', async () => {
    const { api } = await setup({ api: { tokenMs: 5 } });
    const r = await askOne(api, 'RAG가 뭐야?');
    expect(await api.deleteConversation(r.conv.id)).toBeNull();
    await expect(api.conversation(r.conv.id)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await api.conversations()).some((c) => c.running)).toBe(false);
    const r2 = await askOne(api, '운동 기록 알려 줘');
    await collect(api, r2.assistant_message.id).done;
    const { star } = await api.createStar({ planet_id: 'unsorted', body: '답에서 띄운 별' });
    await expect(api.linkSavedStar(r2.user_message.id, star.id)).rejects.toMatchObject({ status: 400, code: 'not_an_answer' });
    await expect(api.linkSavedStar(r2.assistant_message.id, 'nope')).rejects.toMatchObject({ status: 400, code: 'unknown_star' });
    const linked = await api.linkSavedStar(r2.assistant_message.id, star.id);
    expect(linked.message.saved_star).toEqual({ id: star.id, planet_id: 'unsorted', created_at: star.created_at });
  });

  test('demoFetch: 창을 닫는 순간의 메모 저장(keepalive PATCH)을 가짜 서버가 받는다, 그 밖의 /api 는 404', async () => {
    const { api, adapter, store } = await setup();
    const star = store.state.stars[0];
    const res = await api.demoFetch(`/api/stars/${encodeURIComponent(star.id)}`, { method: 'PATCH', body: JSON.stringify({ body: '닫기 전 메모' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).body).toBe('닫기 전 메모');
    expect(adapter.peek().state.stars.find((s) => s.id === star.id).body).toBe('닫기 전 메모');
    expect((await api.demoFetch('/api/stars/nope', { method: 'PATCH', body: '{"body":"x"}' })).status).toBe(404);
    expect((await api.demoFetch(`/api/stars/${star.id}`, { method: 'PATCH', body: '{"body":1}' })).status).toBe(400);
    expect((await api.demoFetch('/api/health')).status).toBe(404);
  });

  test('저장 공간 안내 문구', () => {
    expect(STORAGE_ERROR_TOAST).toBe('브라우저 저장 공간이 부족해요. 이번에 바꾼 내용은 새로 고침하면 사라질 수 있어요');
  });
});
