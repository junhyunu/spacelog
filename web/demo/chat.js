// 체험판의 가짜 챗봇. OpenAI 를 부르지 않는다: 준비된 질문(추천 질문 칩 전부 + 대표 질문 몇 개)에만
// 방문자의 지금 데이터로 답을 만들어, 실제 서버처럼 토큰 단위로 흘려 보낸다(api.streamAnswer 콜백 그대로).
// 그 밖의 질문은 FALLBACK_INTRO + 추천 질문 3개.
//
// 응답 모양 · 오류 코드 · 상태 흐름은 server/rag/chat.js · answers.js 와 같다:
//   ask → 202 { user_message, assistant_message(running) } → 답 작업이 바로 돈다(한 번에 하나, 아니면 409 busy)
//   streamAnswer: 붙을 때마다 snapshot, 그다음 token… → sources → done { status, not_found } (실패는 error { status, code })
//   stopAnswer: 하던 답을 그 자리까지 두고 status 'stopped'
//   아무도 보고 있지 않을 때 끝난 답은 그 대화를 읽지 않음으로. 새로 고침으로 끊긴 running 답은 열 때 failed / interrupted.
import { firstLine } from '../src/util.js';
import { normText } from '../src/ui/searchMatch.js';
import { UNSORTED_ID, fail, uuid } from './rules.js';

export const FALLBACK_INTRO = '체험판에서는 준비된 질문에만 답해요. 아래 같은 질문을 해 보세요:';
export const NOT_FOUND_TEXT = '기록에서 찾지 못했어요.'; // 서버(rag/answer.py NOT_FOUND)와 같은 글
/** 그 밖의 질문에 권하는 질문(추천 질문 칩과 겹치지 않게 대표 질문에서). */
export const SUGGESTIONS = [
  'RAG가 뭐야?',
  '독서 노트 요약해 줘',
  '운동 기록 알려 줘',
  '미분류에 뭐 있어?',
  '발표 준비 기록 찾아 줘',
  '일 아이디어 뭐 있었지?',
  '제주 준비물 뭐 적어 뒀어?',
  '교토 여행 링크 있어?',
];

const QUESTION_MAX = 2_000;
const TITLE_MAX = 30;
const PREVIEW_MAX = 80;
const CONTEXT_KEYS = ['planet_id', 'planet_name', 'star_id'];
const CONTEXT_VALUE_MAX = 200;
const TZ_MAX = 14 * 60;
const LIST_MAX = 8; // 답에 늘어놓는 별 · 출처 카드 수

const chars = (s) => [...String(s ?? '')];
const cut = (s, n) => chars(s).slice(0, n).join('');

/** 비교용 질문: NFC · 소문자 · 띄어쓰기와 문장부호 무시. */
export function normalizeQuestion(q) {
  return normText(q).replace(/[\s?!.,~'"`‘’“”·…]/g, '');
}

const hasAny = (text, words) => words.some((w) => text.includes(w));

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function localMeta(ms) {
  const offset = -new Date(ms).getTimezoneOffset();
  return { today: new Date(ms + offset * 60_000).toISOString().slice(0, 10), tz_offset_min: offset };
}

/* ---------- 답 만들기(순수: 상태 → { content, sources, not_found }) ---------- */

/** 상태와 질문 시점 정보로 답을 고르는 도구 모음. */
function view(state, { today, tz }) {
  const excluded = new Set(Array.isArray(state.chat?.excluded_planets) ? state.chat.excluded_planets : []);
  const planets = state.planets ?? [];
  const planetOf = (id) => planets.find((p) => p.id === id) ?? null;
  const stars = (state.stars ?? []).filter((s) => !excluded.has(s.planet_id) && planetOf(s.planet_id));
  const dayOf = (iso) => new Date(Date.parse(iso) + tz * 60_000).toISOString().slice(0, 10);
  const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
  const newest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (b.row ?? 0) - (a.row ?? 0));
  const atts = (starId) => (state.attachments ?? []).filter((a) => a.star_id === starId).sort((a, b) => a.position - b.position);
  const md = (iso) => {
    const d = dayOf(iso);
    return `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}`;
  };
  const src = (s, { file = false } = {}) => {
    const a = file ? atts(s.id).find((x) => x.kind !== 'link') : null;
    return { star_id: s.id, attachment_id: a?.id ?? null, file_name: a?.file_name ?? null };
  };
  // 이름(띄어쓰기 · 대소문자 무시)으로 행성 찾기
  const planetByName = (name) => {
    const n = normalizeQuestion(name);
    return planets.find((p) => normalizeQuestion(p.name) === n) ?? null;
  };
  // 미리 넣은 별을 제목으로 찾는다(지웠거나 빼 둔 행성이면 없다)
  const byTitle = (title) => {
    const n = normText(title);
    return stars.filter((s) => normText(s.title) === n).sort(newest)[0] ?? null;
  };
  return { state, excluded, planets, planetOf, stars, dayOf, dayMs, today, tz, newest, atts, md, src, planetByName, byTitle };
}

const answer = (content, sources = [], notFound = false) => ({ content, sources, not_found: notFound });
const nothing = () => answer(NOT_FOUND_TEXT, [], true);

function planetCounts(v, list) {
  const counts = new Map();
  for (const s of list) counts.set(s.planet_id, (counts.get(s.planet_id) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ planet: v.planetOf(id), n }));
}

function todayAnswer(v) {
  const list = v.stars.filter((s) => v.dayOf(s.created_at) === v.today).sort(v.newest);
  if (!list.length) return answer('오늘 띄운 별은 아직 없어요. 기록하기로 하나 띄워 보세요.', [], true);
  const by = planetCounts(v, list).map(({ planet, n }) => `${planet.name} ${n}개`).join(', ');
  const lines = list.slice(0, LIST_MAX).map((s) => {
    const body = firstLine(s.body, 40);
    return `- ${s.title}${body && body !== s.title ? `: ${body}` : ''}`;
  });
  const more = list.length > LIST_MAX ? `\n그 밖에 ${list.length - LIST_MAX}개가 더 있어요.` : '';
  return answer(`오늘은 별을 ${list.length}개 띄우셨어요. 행성별로는 ${by}예요.\n${lines.join('\n')}${more}`, list.slice(0, LIST_MAX).map((s) => v.src(s)));
}

function weekAnswer(v) {
  const from = v.dayMs(v.today) - 6 * 86_400_000;
  const list = v.stars.filter((s) => {
    const d = v.dayMs(v.dayOf(s.created_at));
    return d >= from && d <= v.dayMs(v.today);
  }).sort(v.newest);
  if (!list.length) return answer('이번 주(오늘까지 7일)에 띄운 별은 아직 없어요.', [], true);
  const groups = planetCounts(v, list).map(({ planet, n }) => {
    const titles = list.filter((s) => s.planet_id === planet.id).slice(0, 3).map((s) => s.title);
    return `- ${planet.name} ${n}개: ${titles.join(', ')}${n > 3 ? ' 등' : ''}`;
  });
  const favs = list.filter((s) => s.fav);
  const favLine = favs.length ? `\n자주 찾음으로 표시한 별은 ${favs.map((s) => s.title).join(', ')}이에요.` : '';
  const picked = [...favs, ...list.filter((s) => !s.fav)].slice(0, LIST_MAX);
  return answer(`이번 주(오늘까지 7일)에는 별을 ${list.length}개 띄우셨어요. 행성별로 보면 이래요.\n${groups.join('\n')}${favLine}`, picked.map((s) => v.src(s)));
}

function linkLines(v, list) {
  const out = [];
  for (const s of list) {
    for (const a of v.atts(s.id)) if (a.kind === 'link') out.push(`- ${a.link_title || a.url}\n  ${a.url}`);
  }
  return out;
}

function monthLinksAnswer(v) {
  const month = v.today.slice(0, 7);
  const list = v.stars
    .filter((s) => v.dayOf(s.created_at).slice(0, 7) === month && v.atts(s.id).some((a) => a.kind === 'link'))
    .sort(v.newest);
  if (!list.length) return answer('이번 달 기록에는 저장한 링크가 없어요.', [], true);
  const lines = linkLines(v, list.slice(0, LIST_MAX));
  const total = list.reduce((n, s) => n + v.atts(s.id).filter((a) => a.kind === 'link').length, 0);
  const more = list.length > LIST_MAX ? `\n그 밖에 별 ${list.length - LIST_MAX}개에 링크가 더 있어요.` : '';
  return answer(`이번 달 기록에서 링크를 ${total}개 찾았어요.\n${lines.join('\n')}${more}`, list.slice(0, LIST_MAX).map((s) => v.src(s)));
}

function planetAnswer(v, planet, askedName) {
  if (!planet) return answer(`'${askedName}' 행성을 찾지 못했어요. 행성 이름을 확인해 주세요.`, [], true);
  if (v.excluded.has(planet.id)) {
    return answer(`'${planet.name}' 행성은 챗봇이 읽지 않도록 빼 두셨어요. 설정에서 다시 넣으면 답할 수 있어요.`, [], true);
  }
  const list = v.stars.filter((s) => s.planet_id === planet.id).sort(v.newest);
  if (!list.length) return answer(`'${planet.name}' 행성은 아직 비어 있어요.`, [], true);
  const favs = list.filter((s) => s.fav).length;
  const desc = planet.description ? ` (${planet.description})` : '';
  const lines = list.slice(0, 5).map((s) => {
    const body = firstLine(s.body, 36);
    return `- ${s.title} · ${v.md(s.created_at)}${body && body !== s.title ? `: ${body}` : ''}`;
  });
  const favLine = favs ? `, 그중 자주 찾음은 ${favs}개` : '';
  return answer(
    `'${planet.name}' 행성${desc}에는 별이 ${list.length}개 있어요${favLine}. 최근에 띄운 별은 이래요.\n${lines.join('\n')}`,
    list.slice(0, 5).map((s) => v.src(s)),
  );
}

// 주제 기록 모음: terms 가 제목 · 글에 있거나 planetName 행성에 있는 별
function topicAnswer(v, { intro, terms = [], planetName, lineMax = 40 }) {
  const planet = planetName ? v.planetByName(planetName) : null;
  const list = v.stars
    .filter((s) => (planet && s.planet_id === planet.id) || terms.some((t) => normText(`${s.title}\n${s.body ?? ''}`).includes(normText(t))))
    .sort(v.newest);
  if (!list.length) return nothing();
  const lines = list.slice(0, LIST_MAX).map((s) => {
    const body = firstLine(s.body, lineMax);
    return `- ${s.title} · ${v.md(s.created_at)}${body && body !== s.title ? `: ${body}` : ''}`;
  });
  const more = list.length > LIST_MAX ? `\n그 밖에 ${list.length - LIST_MAX}개가 더 있어요.` : '';
  return answer(`${intro(list.length)}\n${lines.join('\n')}${more}`, list.slice(0, LIST_MAX).map((s) => v.src(s, { file: true })));
}

function ragAnswer(v) {
  const refs = [
    { star: v.byTitle('RAG 파이프라인 노트'), file: true },
    { star: v.byTitle('RAG 실습 3일차') },
    { star: v.byTitle('Retrieval-augmented generation 위키') },
  ].filter((r) => r.star);
  if (!refs.length) return nothing();
  const text =
    'RAG(Retrieval-Augmented Generation)는 질문과 비슷한 기록 조각을 먼저 찾아서, 그 내용을 근거로 답을 만드는 방식이에요. 노트에는 이렇게 정리해 두셨어요.\n' +
    '1. 읽기: PDF · 메모 · 웹 문서를 글로 바꾸기\n' +
    '2. 자르기: 500자, 겹침 50자\n' +
    '3. 임베딩: text-embedding-3-small(1536차원)\n' +
    '4. 찾기: 코사인 유사도 상위 4개\n' +
    '5. 답하기: 찾은 조각만 보고 답하고, 없으면 모른다고 말하기\n' +
    '실습 3일차에는 조각이 너무 길면 엉뚱한 문단이 같이 딸려 오고, 출처를 함께 보여 주면 답을 믿기 쉬워진다고 적어 두셨어요.';
  return answer(text, refs.map((r) => v.src(r.star, { file: r.file })));
}

function jejuPackAnswer(v) {
  const s = v.byTitle('제주 준비물');
  if (!s) return nothing();
  const items = String(s.body ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return answer(`제주 준비물로 적어 두신 건 이래요.\n${items.map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')}`, [v.src(s)]);
}

function flightAnswer(v) {
  const s = v.byTitle('항공권 비교');
  if (!s) return nothing();
  return answer(
    '항공권 비교표에서는 티웨이가 왕복 76,500원으로 가장 쌌어요. 금요일 08:05 출발, 일요일 21:10 도착이에요. 그다음은 제주항공 89,000원, 대한항공 132,000원 순이에요.',
    [v.src(s, { file: true })],
  );
}

function tripLinksAnswer(v, norm) {
  const trip = v.planetByName('여행 계획') ?? v.planets.find((p) => normText(p.name).includes('여행')) ?? null;
  const parts = [];
  const sources = [];
  if (norm.includes('교토')) {
    const kyoto = v.stars.filter((s) => normText(`${s.title}\n${s.body ?? ''}`).includes('교토')).sort(v.newest);
    const kyotoLinks = linkLines(v, kyoto);
    if (kyotoLinks.length) {
      parts.push(`교토가 들어간 기록의 링크는 이래요.\n${kyotoLinks.join('\n')}`);
    } else if (kyoto.length) {
      parts.push(`교토는 '${kyoto[0].title}'에 가고 싶은 곳으로만 적어 두셨고, 교토 링크는 저장해 두지 않으셨어요.`);
    } else {
      parts.push('교토에 대한 기록은 찾지 못했어요.');
    }
    sources.push(...kyoto.slice(0, 3).map((s) => v.src(s)));
  }
  if (trip && !v.excluded.has(trip.id)) {
    const list = v.stars.filter((s) => s.planet_id === trip.id && v.atts(s.id).some((a) => a.kind === 'link')).sort(v.newest);
    if (list.length) {
      parts.push(`'${trip.name}' 행성에 저장된 링크는 이래요.\n${linkLines(v, list.slice(0, LIST_MAX)).join('\n')}`);
      sources.push(...list.slice(0, LIST_MAX).map((s) => v.src(s)));
    } else {
      parts.push(`'${trip.name}' 행성에는 저장한 링크가 없어요.`);
    }
  }
  if (!sources.length) return nothing();
  return answer(parts.join('\n'), sources.slice(0, LIST_MAX));
}

/**
 * 준비된 질문들. match(norm, raw, v) → 답을 만드는 함수 | null. 앞의 것부터 본다.
 * 추천 질문 칩(chatLogic.quickQuestions): '오늘 띄운 별 요약해 줘' · '이번 주 기록 정리해 줘' ·
 * '이번 달 기록에서 링크 찾아 줘' · "'<행성 이름>' 행성 요약해 줘"(행성 패널이 열려 있을 때, 어떤 행성이든).
 */
export const PREPARED = [
  {
    id: 'planet-chip',
    match: (norm, raw, v) => {
      const m = /^'(.+)'\s*행성\s*요약해\s*줘\s*$/u.exec(raw);
      if (!m) return null;
      const name = m[1];
      return () => planetAnswer(v, v.planetByName(name), name);
    },
  },
  { id: 'today', match: (n) => (n.includes('오늘') && hasAny(n, ['요약', '정리', '띄운', '기록', '별', '했']) ? todayAnswer : null) },
  {
    id: 'week',
    match: (n) => (hasAny(n, ['이번주', '일주일', '최근7일', '이번한주']) && hasAny(n, ['요약', '정리', '뭐', '띄운', '기록', '별']) ? weekAnswer : null),
  },
  { id: 'trip-links', match: (n) => (n.includes('링크') && hasAny(n, ['교토', '여행', '제주', '부산']) ? (v) => tripLinksAnswer(v, n) : null) },
  { id: 'month-links', match: (n) => (n.includes('링크') ? monthLinksAnswer : null) },
  { id: 'rag', match: (n, raw) => (/(^|[^a-z])rag([^a-z]|$)/i.test(raw) || hasAny(n, ['래그', '검색증강']) ? ragAnswer : null) },
  { id: 'jeju-pack', match: (n) => (hasAny(n, ['준비물', '챙길', '챙겨']) ? jejuPackAnswer : null) },
  { id: 'flight', match: (n) => (hasAny(n, ['항공권', '비행기', '항공편']) ? flightAnswer : null) },
  {
    id: 'talk',
    match: (n) =>
      n.includes('발표')
        ? (v) => topicAnswer(v, { intro: (k) => `발표 준비와 관련된 기록은 ${k}개예요.`, terms: ['발표'] })
        : null,
  },
  {
    id: 'books',
    match: (n) =>
      hasAny(n, ['독서', '책', '읽은', '밑줄'])
        ? (v) => topicAnswer(v, { intro: (k) => `독서 기록은 ${k}개예요. 최근 것부터 정리하면 이래요.`, planetName: '독서 노트', terms: ['『'] })
        : null,
  },
  {
    id: 'workout',
    match: (n) =>
      hasAny(n, ['운동', '러닝', '헬스', '달리기', '스쿼트'])
        ? (v) => topicAnswer(v, { intro: (k) => `운동 기록은 ${k}개예요.`, planetName: '운동', terms: ['러닝', '헬스', '스쿼트'] })
        : null,
  },
  {
    id: 'ideas',
    match: (n) =>
      n.includes('아이디어')
        ? (v) => topicAnswer(v, { intro: (k) => `아이디어로 적어 두신 기록은 ${k}개예요.`, planetName: '일 아이디어', terms: ['아이디어'] })
        : null,
  },
  {
    // "미분류에 뭐 있어" · "여행 계획 정리해 줘" 처럼 행성 이름 + 요약 말
    id: 'planet-name',
    match: (n, raw, v) => {
      if (!hasAny(n, ['요약', '정리', '뭐', '알려', '있어', '보여'])) return null;
      const hit = [...v.planets]
        .sort((a, b) => chars(b.name).length - chars(a.name).length)
        .find((p) => {
          const name = normalizeQuestion(p.name);
          return name.length >= 2 && n.includes(name);
        });
      return hit ? () => planetAnswer(v, hit, hit.name) : null;
    },
  },
];

/** 그 밖의 질문: 안내 + 추천 질문 3개(질문마다 조금씩 다르게). */
export function fallbackAnswer(question) {
  const n = normalizeQuestion(question);
  let h = 0;
  for (const c of n) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const start = h % SUGGESTIONS.length;
  const picks = [0, 1, 2].map((i) => SUGGESTIONS[(start + i * 3) % SUGGESTIONS.length]);
  return answer(`${FALLBACK_INTRO}\n${picks.map((q) => `- ${q}`).join('\n')}`, [], true);
}

/** 준비된 질문 중 맞는 것의 id(없으면 null). 테스트용. */
export function matchId(state, question, { today, tz_offset_min = 0 } = {}) {
  const v = view(state, { today: today ?? localMeta(Date.now()).today, tz: tz_offset_min });
  const raw = String(question ?? '').normalize('NFC').trim();
  const n = normalizeQuestion(raw);
  for (const p of PREPARED) if (p.match(n, raw, v)) return p.id;
  return null;
}

/** 질문 → { content, sources: [{ star_id, attachment_id, file_name }], not_found }. */
export function buildAnswer(state, question, { today, tz_offset_min = 0 } = {}) {
  const v = view(state, { today: today ?? localMeta(Date.now()).today, tz: tz_offset_min });
  const raw = String(question ?? '').normalize('NFC').trim();
  const n = normalizeQuestion(raw);
  for (const p of PREPARED) {
    const make = p.match(n, raw, v);
    if (make) return make(v);
  }
  return fallbackAnswer(raw);
}

/** 답 글을 2~4글자씩 자른다(실제 모델의 토큰처럼 고르지 않게). */
export function tokenize(text) {
  const cs = chars(text);
  const out = [];
  const sizes = [2, 3, 2, 4, 3];
  for (let i = 0, k = 0; i < cs.length; k++) {
    const n = sizes[k % sizes.length];
    out.push(cs.slice(i, i + n).join(''));
    i += n;
  }
  return out;
}

/* ---------- 상태 위의 대화 · 메시지 · 답 작업 ---------- */

/**
 * 챗봇 메서드를 만든다(mockApi.js 가 api 에 붙인다).
 * @param {object} o
 * @param {(fn: Function) => Function} o.route  가게를 기다리고 응답을 복사하는 래퍼(mockApi.js)
 * @param {() => Promise<object>} o.ready
 * @param {number} [o.tokenMs]  토큰 사이 간격
 * @param {number} [o.thinkMs]  첫 토큰 전 "생각하는" 시간
 * @param {number} [o.persistMs]  흘리는 동안 저장하는 간격
 * @param {() => number} [o.now]
 */
export function createChat({ route, ready, tokenMs = 25, thinkMs = 400, persistMs = 500, now = Date.now }) {
  let job = null; // { messageId, conversationId, tokens, i, sources, notFound, subscribers, finished, timer, lastSave }
  const iso = () => new Date(now()).toISOString();

  const findConv = (s, id) => s.state.conversations.find((c) => c.id === String(id)) ?? null;
  const findMsg = (s, id) => s.state.messages.find((m) => m.id === String(id)) ?? null;
  const findStar = (s, id) => s.state.stars.find((x) => x.id === id) ?? null;
  const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

  function settingsRaw(s) {
    const c = s.state.chat ?? {};
    const ids = Array.isArray(c.excluded_planets) ? c.excluded_planets.filter((x) => typeof x === 'string') : [];
    return {
      enabled: c.enabled === true,
      consented: c.consented === true,
      excluded_planets: [...new Set(ids)].filter((id) => s.state.planets.some((p) => p.id === id)),
    };
  }

  function usage(s) {
    const month = iso().slice(0, 7);
    const u = s.state.chat_usage;
    return u && u.month === month && Number.isInteger(u.requests) ? { month, requests: u.requests } : { month, requests: 0 };
  }

  // 색인은 없지만 "다 읽은" 모습: 빼 둔 행성의 별은 skipped
  function settingsJson(s) {
    const c = settingsRaw(s);
    const ex = new Set(c.excluded_planets);
    const total = s.state.stars.length;
    const skipped = s.state.stars.filter((x) => ex.has(x.planet_id)).length;
    const latest = s.state.stars.reduce((m, x) => (x.created_at > m ? x.created_at : m), s.state.chat_indexed_at ?? s.state.anchor ?? '');
    return {
      ...c,
      key: c.consented ? true : null,
      rag: { state: 'ready', reason: null },
      index: { total, done: total - skipped, failed: 0, pending: 0, skipped, indexing: false, last_indexed_at: latest || null },
      usage: usage(s),
    };
  }

  function sourcesView(s, list) {
    return (Array.isArray(list) ? list : []).map((x) => {
      const star = findStar(s, x.star_id);
      return {
        star_id: x.star_id,
        attachment_id: x.attachment_id ?? null,
        file_name: x.file_name ?? null,
        exists: Boolean(star),
        title: star?.title ?? null,
        planet_id: star?.planet_id ?? null,
        created_at: star?.created_at ?? null,
      };
    });
  }

  function messageJson(s, m) {
    const saved = m.saved_star_id ? findStar(s, m.saved_star_id) : null;
    return {
      id: m.id,
      conversation_id: m.conversation_id,
      role: m.role,
      content: m.content,
      sources: sourcesView(s, m.sources),
      status: m.status,
      error: m.error ?? null,
      created_at: m.created_at,
      saved_star: saved ? { id: saved.id, planet_id: saved.planet_id, created_at: saved.created_at } : null,
    };
  }

  const conversationJson = (c) => ({ id: c.id, title: c.title, created_at: c.created_at, updated_at: c.updated_at, unread: c.unread === true });

  function messagesOf(s, convId) {
    return s.state.messages.filter((m) => m.conversation_id === convId).sort(byTime);
  }

  const send = (fn, v) => {
    if (typeof fn !== 'function') return;
    try {
      fn(v);
    } catch (err) {
      console.error('[chat] 흘려 받기 처리 중 오류', err);
    }
  };
  function broadcast(j, type, v) {
    for (const sub of [...j.subscribers]) send(sub[type], v);
  }

  // status: 'done' | 'stopped' | 'failed'
  function finish(s, j, status, { error = null } = {}) {
    if (j.finished) return;
    j.finished = true;
    clearTimeout(j.timer);
    const m = findMsg(s, j.messageId);
    const watched = j.subscribers.size > 0 || status === 'stopped';
    if (m) {
      m.status = status;
      m.error = error;
    }
    const c = findConv(s, j.conversationId);
    if (c) {
      c.updated_at = iso();
      if (!watched) c.unread = true;
    }
    if (job === j) job = null;
    void s.commit();
    const subs = [...j.subscribers];
    j.subscribers.clear();
    for (const sub of subs) {
      if (status === 'failed') send(sub.onError, { status, code: error });
      else send(sub.onDone, { status, not_found: status === 'done' && j.notFound === true });
    }
  }

  function step(s, j) {
    if (j.finished) return;
    const m = findMsg(s, j.messageId);
    if (!m) {
      finish(s, j, 'failed', { error: 'internal' });
      return;
    }
    if (j.i < j.tokens.length) {
      const text = j.tokens[j.i++];
      m.content += text;
      broadcast(j, 'onToken', text);
      if (now() - j.lastSave >= persistMs) {
        j.lastSave = now();
        void s.commit();
      }
      j.timer = setTimeout(() => step(s, j), tokenMs);
      return;
    }
    // 다 흘렸다: 출처(그사이 지워졌거나 빼 둔 행성의 별은 버린다) → done
    const ex = new Set(settingsRaw(s).excluded_planets);
    m.sources = j.sources.filter((x) => {
      const star = findStar(s, x.star_id);
      return star && !ex.has(star.planet_id);
    });
    broadcast(j, 'onSources', sourcesView(s, m.sources));
    finish(s, j, 'done');
  }

  function start(s, m, built) {
    const j = {
      messageId: m.id,
      conversationId: m.conversation_id,
      tokens: tokenize(built.content),
      i: 0,
      sources: built.sources,
      notFound: built.not_found,
      subscribers: new Set(),
      finished: false,
      timer: null,
      lastSave: now(),
    };
    job = j;
    j.timer = setTimeout(() => step(s, j), thinkMs);
    return j;
  }

  /** 가게를 처음 열 때(새로 고침): 끝나지 못한 답은 failed / interrupted(서버를 켤 때와 같다). */
  function recover(s) {
    let changed = false;
    for (const m of s.state.messages ?? []) {
      if (m.status === 'running') {
        m.status = 'failed';
        m.error = 'interrupted';
        changed = true;
      }
    }
    if (changed) void s.commit();
  }

  const methods = {
    chatStatus: route((s) => ({ rag: { state: 'ready', reason: null }, key: true })),
    chatSettings: route((s) => settingsJson(s)),
    saveChatSettings: route(async (s, patch) => {
      const body = patch === undefined ? undefined : JSON.parse(JSON.stringify(patch));
      const KEYS = new Set(['enabled', 'consented', 'excluded_planets']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !KEYS.has(k))) throw fail(400, 'invalid_settings');
      for (const k of ['enabled', 'consented']) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw fail(400, 'invalid_settings');
      let excluded;
      if (body.excluded_planets !== undefined) {
        if (!Array.isArray(body.excluded_planets) || body.excluded_planets.some((x) => typeof x !== 'string')) throw fail(400, 'invalid_settings');
        excluded = [...new Set(body.excluded_planets)];
        if (excluded.some((id) => !s.state.planets.some((p) => p.id === id))) throw fail(400, 'unknown_planet');
      }
      const next = { ...settingsRaw(s) };
      if (body.consented !== undefined) next.consented = body.consented;
      if (body.enabled !== undefined) next.enabled = body.enabled;
      else if (body.consented === false) next.enabled = false; // 동의를 거두면 끈다
      if (excluded) next.excluded_planets = excluded;
      if (next.enabled && !next.consented) throw fail(400, 'consent_required');
      s.state.chat = next;
      await s.commit();
      return settingsJson(s);
    }),
    // 색인이 없으니 "다시 읽기"는 바로 끝난다(마지막으로 읽은 시각만 지금으로)
    reindex: route(async (s, scope) => {
      if (scope !== 'failed' && scope !== 'all') throw fail(400, 'invalid_scope');
      if (!settingsRaw(s).enabled) throw fail(409, 'chat_off');
      s.state.chat_indexed_at = iso();
      await s.commit();
      return { index: settingsJson(s).index };
    }),
    conversations: route((s) =>
      [...s.state.conversations]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
        .map((c) => {
          const list = messagesOf(s, c.id);
          const last = list[list.length - 1];
          return {
            ...conversationJson(c),
            running: Boolean(job && !job.finished && job.conversationId === c.id),
            last: last
              ? { role: last.role, status: last.status, preview: cut(String(last.content ?? '').replace(/\s+/g, ' ').trim(), PREVIEW_MAX) }
              : null,
          };
        }),
    ),
    createConversation: route(async (s) => {
      const t = iso();
      const c = { id: uuid(), title: '새 대화', created_at: t, updated_at: t, unread: false };
      s.state.conversations.push(c);
      await s.commit();
      return { conversation: conversationJson(c), messages: [] };
    }),
    conversation: route(async (s, convId) => {
      const c = findConv(s, convId);
      if (!c) throw fail(404, 'not_found');
      if (c.unread) {
        c.unread = false;
        await s.commit();
      }
      return { conversation: conversationJson(c), messages: messagesOf(s, c.id).map((m) => messageJson(s, m)) };
    }),
    deleteConversation: route(async (s, convId) => {
      const c = findConv(s, convId);
      if (!c) throw fail(404, 'not_found');
      if (job && job.conversationId === c.id) finish(s, job, 'stopped');
      s.state.conversations = s.state.conversations.filter((x) => x.id !== c.id);
      s.state.messages = s.state.messages.filter((m) => m.conversation_id !== c.id);
      await s.commit();
      return null; // 204
    }),
    unread: route((s) => ({ count: s.state.conversations.filter((c) => c.unread).length })),
    ask: route(async (s, convId, { question, context, today, tz_offset_min } = {}) => {
      const c = findConv(s, convId);
      if (!c) throw fail(404, 'not_found');
      const q = typeof question === 'string' ? question.trim() : '';
      const n = chars(q).length;
      if (n < 1 || n > QUESTION_MAX) throw fail(400, 'invalid_question');
      const ctx = context ?? {};
      if (typeof ctx !== 'object' || Array.isArray(ctx)) throw fail(400, 'invalid_context');
      for (const k of CONTEXT_KEYS) {
        const val = ctx[k];
        if (val === undefined || val === null || val === '') continue;
        if (typeof val !== 'string' || val.length > CONTEXT_VALUE_MAX) throw fail(400, 'invalid_context');
      }
      const local = localMeta(now());
      const day = today ?? local.today;
      if (!validDate(day)) throw fail(400, 'invalid_today');
      const tz = tz_offset_min ?? local.tz_offset_min;
      if (!Number.isInteger(tz) || Math.abs(tz) > TZ_MAX) throw fail(400, 'invalid_tz_offset');
      if (!settingsRaw(s).enabled) throw fail(409, 'chat_off');
      if (job && !job.finished) throw fail(409, 'busy');

      const t = iso();
      if (!messagesOf(s, c.id).length) c.title = cut(q.replace(/\s+/g, ' '), TITLE_MAX).trim();
      c.updated_at = t;
      const user = { id: uuid(), conversation_id: c.id, role: 'user', content: q, sources: [], status: 'done', error: null, created_at: t, saved_star_id: null };
      const bot = { id: uuid(), conversation_id: c.id, role: 'assistant', content: '', sources: [], status: 'running', error: null, created_at: t, saved_star_id: null };
      s.state.messages.push(user, bot);
      const u = usage(s);
      s.state.chat_usage = { month: u.month, requests: u.requests + 1 };
      await s.commit();
      start(s, bot, buildAnswer(s.state, q, { today: day, tz_offset_min: tz }));
      return { user_message: messageJson(s, user), assistant_message: messageJson(s, bot) };
    }),
    stopAnswer: route(async (s, messageId) => {
      const m = findMsg(s, messageId);
      if (!m) throw fail(404, 'not_found');
      if (!job || job.finished || job.messageId !== m.id) throw fail(409, 'not_running');
      finish(s, job, 'stopped');
      return { message: messageJson(s, m) };
    }),
    linkSavedStar: route(async (s, messageId, starId) => {
      const m = findMsg(s, messageId);
      if (!m) throw fail(404, 'not_found');
      if (m.role !== 'assistant') throw fail(400, 'not_an_answer');
      if (typeof starId !== 'string' || !starId) throw fail(400, 'invalid_star_id');
      if (!findStar(s, starId)) throw fail(400, 'unknown_star');
      m.saved_star_id = starId;
      await s.commit();
      return { message: messageJson(s, m) };
    }),
    /** 실제 api.streamAnswer 와 같은 콜백 · 같은 순서. → close() */
    streamAnswer(messageId, handlers = {}) {
      let closed = false;
      let sub = null;
      const call = (name, v) => {
        if (!closed) send(handlers[name], v);
      };
      const close = () => {
        closed = true;
        if (sub) job?.subscribers.delete(sub);
        sub = null;
      };
      ready().then((s) => {
        if (closed) return;
        const m = findMsg(s, messageId);
        if (!m || m.role !== 'assistant') {
          call('onError', { status: 'failed', code: 'not_found' });
          closed = true;
          return;
        }
        const j = job && !job.finished && job.messageId === m.id ? job : null;
        if (j) {
          call('onSnapshot', { content: m.content, sources: sourcesView(s, m.sources), status: 'running', error: null });
          // 끝나면 구독을 닫는다(실제 api 는 done · error 를 받으면 닫는다)
          sub = {
            onToken: (v) => call('onToken', v),
            onSources: (v) => call('onSources', v),
            onDone: (v) => {
              call('onDone', v);
              closed = true;
            },
            onError: (v) => {
              call('onError', v);
              closed = true;
            },
          };
          j.subscribers.add(sub);
          return;
        }
        const status = m.status === 'running' ? 'failed' : m.status;
        const error = m.status === 'running' ? 'interrupted' : (m.error ?? null);
        call('onSnapshot', { content: m.content, sources: sourcesView(s, m.sources), status, error });
        if (status === 'failed') call('onError', { status, code: error ?? 'internal' });
        else call('onDone', { status });
        closed = true;
      });
      return close;
    },
  };

  return { methods, recover, settingsJson, current: () => job };
}
