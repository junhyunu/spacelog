// 비교 테스트 빌드 전용: 서버(/api) 대신 더미 데이터를 돌려주는 가짜 api. 실제 앱(web/src/api.js)과 같은 이름 · 같은 모양이다.
// vite.abtest.config.js가 web/src/api.js를 이 파일로 바꿔 끼운다(실제 앱 코드는 그대로).
//
// 데이터는 data.js(window.SPACELOG_TEST)의 상태를 읽고 쓴다: 테스트 홈(spacelog-home.html)과 같은 곳(sessionStorage)이라
// 홈에서 바꾼 것이 우주에, 우주에서 바꾼 것이 홈에 보인다. 탭을 닫으면 처음 상태로 돌아간다.
// 상태의 별 모양(홈 쪽): { id, title, kind: 'csv'|'text', size, planet, fav, at, body, memo, notes }
// 앱이 받는 별 모양(서버 쪽): { id, type, title, body, memo, planet_id, created_at, attachment_count, attachments, ... }
import { toast } from '../src/ui/toast.js';

export class ApiError extends Error {
  constructor(status, code, data = null) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const T = window.SPACELOG_TEST;
// 테스트는 로그인한 상태로 시작한다(계정 메뉴에 보일 이름). account.js보다 먼저 읽힌다(main.js의 import 순서)
try {
  if (!localStorage.getItem('spacelog.demoAccount')) {
    localStorage.setItem('spacelog.demoAccount', JSON.stringify({ email: 'test@example.com', name: '우주선장' }));
  }
} catch {
  /* 저장소를 못 써도 화면은 돈다 */
}

const DECOS = ['town', 'crystal', 'forest', 'rock', 'ice', 'volcano', 'mushroom', 'cactus', 'flower', 'cloud'];
const COLOR_COUNT = 12;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const later = (v) => wait(60).then(() => structuredClone(v)); // 서버처럼 잠깐 뒤에, 복사본으로
const state = () => T.load();
const commit = (st) => T.save(st);
const same = (a, b) => String(a) === String(b);
const inRange = (iso, from, to) => (!from || iso >= from) && (!to || iso < to);

/* ---------- 모양 바꾸기 ---------- */
function planetLook(p, i) {
  // 행성 모습(장식 · 고리)은 데이터에 없으면 순서로 정한다(서버의 자동 배정과 같은 규칙)
  return {
    color_index: p.color_index || (i % COLOR_COUNT) + 1,
    deco: p.deco || DECOS[i % DECOS.length],
    ring: p.ring ?? i % 3 === 1,
  };
}

function toPlanet(st, p, i, range = {}) {
  const mine = st.stars.filter((s) => same(s.planet, p.id));
  return {
    id: p.id,
    name: p.name,
    description: p.description || '',
    ...planetLook(p, i),
    slot: i,
    count_in_period: mine.filter((s) => inRange(s.at, range.from, range.to)).length,
    count_total: mine.length,
  };
}

function attachmentsOf(s) {
  const list = [];
  if (s.kind === 'csv') {
    list.push({ id: `${s.id}-f`, kind: 'file', position: 0, file_name: s.title, file_ext: 'csv', file_size: 2048, url: null, link_title: null, has_thumb: false });
  }
  for (const a of s.attachments ?? []) list.push({ ...a, position: list.length });
  return list;
}

function toStar(s) {
  const atts = attachmentsOf(s);
  return {
    id: s.id,
    type: atts.length ? atts[0].kind : 'text',
    // 파일 기록의 본문(CSV 앞 몇 줄)은 미리보기라 글 칸에는 넣지 않는다. 글 기록은 본문 그대로
    title: s.title,
    body: s.kind === 'csv' ? null : s.body || null,
    memo: s.memo || '',
    planet_id: s.planet,
    created_at: s.at,
    has_thumb: false,
    thumb_attachment_id: null,
    attachment_count: atts.length,
    attachments: atts,
  };
}

const findStar = (st, id) => st.stars.find((s) => same(s.id, id));
const notFound = () => Promise.reject(new ApiError(404, 'not_found'));

/* ---------- 흉내 챗봇(대화 목록 · 흘려 받기) ---------- */
const chat = { convs: [], msgs: new Map(), seq: 0, pending: new Map() }; // pending: 답 메시지 id → { text, sources, not_found }
const nowIso = () => new Date().toISOString();
const SETTINGS = {
  enabled: true,
  consented: true,
  excluded_planets: [],
  key: true,
  rag: { state: 'ready' },
  index: { state: 'done', total: 0, done: 0, failed: 0 },
  usage: { requests: 0 },
};

function sourceOf(st, id) {
  const s = findStar(st, id);
  if (!s) return { exists: false };
  return { exists: true, star_id: s.id, title: s.title, planet_id: s.planet, created_at: s.at, file_name: s.kind === 'csv' ? s.title : null };
}

function convList() {
  return chat.convs
    .map((c) => {
      const msgs = chat.msgs.get(c.id) ?? [];
      const last = msgs[msgs.length - 1];
      return { ...c, unread: false, running: msgs.some((m) => m.status === 'running'), last: last ? String(last.content ?? '').slice(0, 60) : null };
    })
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

/* ---------- api ---------- */
export const api = {
  health: () => later({ ok: true }),

  summary: (range) => {
    const st = state();
    return later({
      in_period: st.stars.filter((s) => inRange(s.at, range?.from, range?.to)).length,
      total: st.stars.length,
      planets: st.planets.length,
    });
  },
  planets: (range) => {
    const st = state();
    return later(st.planets.map((p, i) => toPlanet(st, p, i, range ?? {})));
  },
  nextLook: () => {
    const n = state().planets.length;
    return later({ color_index: (n % COLOR_COUNT) + 1, deco: DECOS[n % DECOS.length], ring: n % 3 === 1 });
  },
  createPlanet: ({ name, description, color_index, deco, ring } = {}) => {
    const st = state();
    const clean = String(name ?? '').trim();
    if (!clean) return Promise.reject(new ApiError(400, 'name_required'));
    if (st.planets.some((p) => p.name === clean)) return Promise.reject(new ApiError(409, 'duplicate_name'));
    st.seq = (st.seq ?? 100) + 1;
    const p = { id: `p${st.seq}`, name: clean, description: description || '', color_index, deco, ring: Boolean(ring) };
    p.color = T.COLORS[(color_index - 1) % T.COLORS.length];
    st.planets.push(p);
    commit(st);
    return later(toPlanet(st, p, st.planets.length - 1));
  },
  patchPlanet: (planetId, patch) => {
    const st = state();
    const i = st.planets.findIndex((p) => same(p.id, planetId));
    if (i < 0) return notFound();
    const p = st.planets[i];
    for (const k of ['name', 'description', 'color_index', 'deco', 'ring']) if (patch?.[k] !== undefined) p[k] = patch[k];
    if (patch?.color_index) p.color = T.COLORS[(patch.color_index - 1) % T.COLORS.length];
    commit(st);
    return later(toPlanet(st, p, i));
  },
  mergePlanet: (planetId, into) => {
    const st = state();
    let moved = 0;
    for (const s of st.stars) if (same(s.planet, planetId)) { s.planet = into; moved += 1; }
    st.planets = st.planets.filter((p) => !same(p.id, planetId));
    commit(st);
    return later({ moved });
  },
  deletePlanet: (planetId, { stars: how, into } = {}) => {
    const st = state();
    if (how === 'move') for (const s of st.stars) { if (same(s.planet, planetId)) s.planet = into; }
    else st.stars = st.stars.filter((s) => !same(s.planet, planetId));
    st.planets = st.planets.filter((p) => !same(p.id, planetId));
    commit(st);
    return later({ ok: true });
  },

  character: () => later(state().character ?? { kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' }),
  saveCharacter: (look = {}) => {
    const st = state();
    st.character = { kind: look.kind, suit: look.suit, accent: look.accent, flame: look.flame };
    commit(st);
    return later(st.character);
  },

  stars: ({ from, to, planet_id, limit } = {}) => {
    let list = state().stars.filter((s) => inRange(s.at, from, to) && (!planet_id || same(s.planet, planet_id)));
    list = list.sort((a, b) => (a.at < b.at ? 1 : -1));
    if (limit) list = list.slice(0, Number(limit));
    return later(list.map(toStar));
  },
  star: (starId) => {
    const s = findStar(state(), starId);
    return s ? later(toStar(s)) : notFound();
  },
  patchStar: (starId, patch = {}) => {
    const st = state();
    const s = findStar(st, starId);
    if (!s) return notFound();
    if (patch.title !== undefined) s.title = patch.title;
    if (patch.body !== undefined && s.kind !== 'csv') s.body = patch.body ?? '';
    if (patch.memo !== undefined) s.memo = patch.memo ?? '';
    if (patch.planet_id !== undefined) s.planet = patch.planet_id;
    commit(st);
    return later(toStar(s));
  },
  deleteStar: (starId) => {
    const st = state();
    if (!findStar(st, starId)) return notFound();
    st.stars = st.stars.filter((s) => !same(s.id, starId));
    commit(st);
    return later(null);
  },

  /** 기록하기. 파일은 이름만 남기고(보관함이 없다), 링크는 링크 첨부로 */
  async createStar({ planet_id, title, body, links, files } = {}, onProgress, { signal, onUploaded } = {}) {
    if (signal?.aborted) throw new ApiError(0, 'aborted');
    const list = Array.from(files ?? []);
    if (list.length) {
      onProgress?.(100);
      onUploaded?.();
    }
    await wait(150);
    const st = state();
    st.seq = (st.seq ?? 100) + 1;
    const text = String(body ?? '');
    const attachments = [
      ...list.map((f, i) => ({ id: `a${st.seq}-${i}`, kind: /^image\//.test(f.type) ? 'image' : 'file', file_name: f.name, file_ext: f.name.split('.').pop(), file_size: f.size, url: null, link_title: null, has_thumb: false })),
      ...Array.from(links ?? []).map((u, i) => ({ id: `l${st.seq}-${i}`, kind: 'link', file_name: null, file_ext: null, file_size: null, url: String(u), link_title: String(u), has_thumb: false })),
    ];
    const name = String(title ?? '').trim() || text.split('\n')[0].slice(0, 40) || attachments[0]?.file_name || attachments[0]?.url || '제목 없음';
    const s = { id: `s${st.seq}`, title: name, kind: 'text', size: `${[...text].length}자`, planet: String(planet_id), fav: false, at: nowIso(), body: text, memo: '', notes: [], attachments };
    st.stars.push(s);
    commit(st);
    return structuredClone({ star: toStar(s), skipped: [] });
  },

  // 보관함이 없다: 열지 않고 알린다
  openAttachment: () => {
    toast('테스트용 화면이라 파일은 열리지 않아요');
    return later({ action: 'none' });
  },
  revealAttachment: () => {
    toast('테스트용 화면이라 폴더는 열리지 않아요');
    return later({ action: 'none' });
  },
  attachmentFileUrl: () => 'data:,',
  attachmentThumbUrl: () => 'data:,',

  /* ---------- 챗봇 ---------- */
  chatStatus: () => later({ rag: { state: 'ready' }, key: true }),
  chatSettings: () => later({ ...SETTINGS, index: { ...SETTINGS.index, total: state().stars.length, done: state().stars.length } }),
  saveChatSettings: (patch) => {
    Object.assign(SETTINGS, patch ?? {});
    return api.chatSettings();
  },
  reindex: () => api.chatSettings().then((s) => ({ index: s.index })),
  conversations: () => later(convList()),
  createConversation: () => {
    const c = { id: `c${++chat.seq}`, title: '새 대화', created_at: nowIso(), updated_at: nowIso() };
    chat.convs.push(c);
    chat.msgs.set(c.id, []);
    return later({ conversation: { ...c, unread: false, running: false, last: null }, messages: [] });
  },
  conversation: (convId) => {
    const c = chat.convs.find((x) => same(x.id, convId));
    if (!c) return notFound();
    return later({ conversation: convList().find((x) => same(x.id, convId)), messages: chat.msgs.get(c.id) ?? [] });
  },
  deleteConversation: (convId) => {
    chat.convs = chat.convs.filter((x) => !same(x.id, convId));
    chat.msgs.delete(String(convId));
    return later(null);
  },
  ask: (convId, { question } = {}) => {
    const c = chat.convs.find((x) => same(x.id, convId));
    if (!c) return notFound();
    const st = state();
    const a = T.answerFor(String(question ?? ''), st);
    const user = { id: `m${++chat.seq}`, role: 'user', content: String(question ?? ''), created_at: nowIso() };
    const bot = { id: `m${++chat.seq}`, role: 'assistant', content: '', status: 'running', sources: [], error: null, saved_star: null, created_at: nowIso() };
    chat.msgs.get(c.id).push(user, bot);
    chat.pending.set(bot.id, { text: a.text, sources: a.sources.map((id) => sourceOf(st, id)), not_found: Boolean(a.notFound) });
    if (c.title === '새 대화') c.title = String(question ?? '').slice(0, 30);
    c.updated_at = nowIso();
    SETTINGS.usage.requests += 1;
    return later({ user_message: user, assistant_message: bot });
  },
  /** 답을 글자 몇 개씩 흘려 보낸다(실제 앱처럼 써 내려가는 모습) */
  streamAnswer(messageId, { onSnapshot, onToken, onSources, onDone } = {}) {
    let closed = false;
    const timers = [];
    const at = (ms, fn) => timers.push(setTimeout(() => !closed && fn(), ms));
    const p = chat.pending.get(String(messageId));
    const msg = [...chat.msgs.values()].flat().find((m) => same(m.id, messageId));
    if (!p || !msg) {
      at(0, () => onSnapshot?.({ content: msg?.content ?? '', sources: msg?.sources ?? [], status: msg?.status ?? 'done', error: null }));
      at(10, () => onDone?.({ status: msg?.status ?? 'done', not_found: Boolean(msg?.not_found) }));
      return () => { closed = true; timers.forEach(clearTimeout); };
    }
    at(0, () => onSnapshot?.({ content: '', sources: [], status: 'running', error: null }));
    const chunks = p.text.match(/[\s\S]{1,3}/g) ?? [];
    let t = 600; // "찾는 중"처럼 잠깐 기다린다
    for (const ch of chunks) {
      t += 22;
      at(t, () => { msg.content += ch; onToken?.(ch); });
    }
    at(t + 50, () => {
      msg.sources = p.sources;
      onSources?.(p.sources);
      msg.status = 'done';
      msg.not_found = p.not_found;
      chat.pending.delete(String(messageId));
      onDone?.({ status: 'done', not_found: p.not_found });
    });
    return () => { closed = true; timers.forEach(clearTimeout); };
  },
  stopAnswer: (messageId) => {
    const msg = [...chat.msgs.values()].flat().find((m) => same(m.id, messageId));
    if (!msg || msg.status !== 'running') return Promise.reject(new ApiError(409, 'not_running'));
    msg.status = 'stopped';
    chat.pending.delete(String(messageId));
    return later({ message: msg });
  },
  linkSavedStar: (messageId, starId) => {
    const msg = [...chat.msgs.values()].flat().find((m) => same(m.id, messageId));
    const s = findStar(state(), starId);
    if (!msg || !s) return notFound();
    msg.saved_star = { id: s.id, planet_id: s.planet, created_at: s.at };
    return later({ message: msg });
  },
  unread: () => later({ count: 0 }),
};
