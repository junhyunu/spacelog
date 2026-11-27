// 챗봇 화면의 순수 함수(테스트 대상). DOM을 건드리지 않는다.
import { listDate, planetFace, shortDate } from '../util.js';

export const QUESTION_MAX = 2000; // 서버(chat.js QUESTION_MAX)와 같다. 코드 포인트로 센다
export const COUNTER_FROM = 1800; // 이만큼부터 글자 수를 보여 준다
const TITLE_MAX = 30; // 서버(chat.js TITLE_MAX)와 같다
const MUTE = '#5b5480';

const num = (v) => (Number(v) || 0).toLocaleString('en-US');
const pad2 = (n) => String(n).padStart(2, '0');
const has = (v) => v !== null && v !== undefined && v !== '';
const same = (a, b) => has(a) && has(b) && String(a) === String(b);
const chars = (s) => Array.from(String(s ?? ''));

/** 질문과 함께 보낼 지금 화면의 맥락. 우주에서 열린 행성 패널 · 상세만 본다. */
export function contextFor(state) {
  if (!state?.inWorld || !has(state.panelPlanetId)) return {};
  const planet = (state.planets ?? []).find((p) => same(p.id, state.panelPlanetId));
  if (!planet) return {};
  const ctx = { planet_id: String(planet.id), planet_name: String(planet.name ?? '') };
  if (has(state.detailStarId)) ctx.star_id = String(state.detailStarId);
  return ctx;
}

/** 홈 탭의 바로 묻는 질문 3개. 행성 패널이 열려 있으면 세 번째가 그 행성 요약이다. */
export function quickQuestions(state) {
  const ctx = contextFor(state);
  const third = ctx.planet_name ? `'${ctx.planet_name}' 행성 요약해 줘` : '이번 달 기록에서 링크 찾아 줘';
  return ['오늘 띄운 별 요약해 줘', '이번 주 기록 정리해 줘', third];
}

// '오후 3:20' (오늘이 아니면 '11.12 오후 3:20')
function clock(iso, now) {
  const d = new Date(iso);
  if (!has(iso) || Number.isNaN(d.getTime())) return '미확인';
  const h = d.getHours();
  const t = `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${pad2(d.getMinutes())}`;
  const today = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? t : `${shortDate(iso)} ${t}`;
}

/** 설정 탭의 색인 상태 한 줄(스펙 7장). 빼 둔 행성의 별은 세지 않는다. */
export function indexLine(index, now = new Date()) {
  if (!index || typeof index !== 'object') return '챗봇이 읽은 기록: 미확인';
  const total = Math.max(0, (Number(index.total) || 0) - (Number(index.skipped) || 0));
  const done = Number(index.done) || 0;
  if (index.indexing) return `읽는 중… ${num(done)} / ${num(total)}`;
  return `챗봇이 읽은 기록: 별 ${num(total)}개 중 ${num(done)}개 · 마지막으로 읽은 시각 ${clock(index.last_indexed_at, now)}`;
}

/** 읽지 못한 별이 있으면 그 줄, 없으면 ''. */
export function failedLine(index) {
  const n = Number(index?.failed) || 0;
  return n > 0 ? `읽지 못한 별 ${num(n)}개` : '';
}

/** 출처 카드에 그릴 것. gone이면 흐리게, 누를 수 없다. */
export function sourceCardModel(source, planets = [], now = new Date()) {
  const gone = source?.exists !== true;
  const planet = gone ? null : planets.find((p) => same(p.id, source.planet_id));
  const title = gone ? '지워진 별' : String(source.title ?? '').trim() || '제목 없음';
  return {
    title,
    color: planetFace(planet, MUTE),
    date: gone || !has(source.created_at) ? '' : listDate(source.created_at, now),
    file: has(source?.file_name) ? String(source.file_name) : '',
    gone,
  };
}

/**
 * 챗봇을 쓸 수 없는 이유(없으면 ''). status = { rag: { state, reason }, key }.
 * key는 파이썬이 ready일 때만 true/false, 모르면 null(그때는 막지 않는다).
 */
export function unavailableMessage(status) {
  const state = status?.rag?.state;
  const reason = status?.rag?.reason;
  if (state === 'ready') return status?.key === false ? 'OpenAI 키가 없어요. .env 파일에 키를 넣고 서버를 다시 켜 주세요' : '';
  if (state === 'missing') return '챗봇을 준비하지 못했어요. README의 챗봇 설치 순서를 따라 주세요';
  if (state === 'starting') return '챗봇을 준비하는 중이에요. 잠시 뒤에 다시 열어 주세요';
  if (state === 'crashed') {
    if (reason === 'port_in_use') return '챗봇 서버 포트를 다른 프로그램이 쓰고 있어요. 다른 spaceLog가 켜져 있으면 닫아 주세요';
    if (reason === 'too_many_restarts') return '챗봇 서버가 계속 멈춰요. spaceLog 서버를 다시 켜 주세요';
    return '챗봇 서버가 멈춰서 다시 켜는 중이에요. 잠시 뒤에 다시 열어 주세요';
  }
  if (state === 'off') return '챗봇 서버가 꺼져 있어요. spaceLog 서버를 다시 켜 주세요';
  return '챗봇 상태를 확인하지 못했어요. 잠시 뒤에 다시 열어 주세요';
}

/** 묻기를 눌러도 되는지. 한글 조합 중 · 다른 답을 만드는 중 · 꺼짐이면 안 된다. */
export function canSend({ text, composing, busy, enabled } = {}) {
  if (composing || busy || !enabled) return false;
  const t = String(text ?? '').trim();
  const n = chars(t).length;
  return n >= 1 && n <= QUESTION_MAX;
}

/** 입력칸 옆 글자 수. 한도에 가까울 때만. */
export function counterText(text) {
  const n = chars(text).length;
  return n >= COUNTER_FROM ? `${num(n)}/${num(QUESTION_MAX)}` : '';
}

/** 첫 질문으로 만든 대화 제목(서버와 같은 규칙: 공백을 하나로, 앞 30자). */
export function titleFrom(question) {
  const t = chars(String(question ?? '').replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX).join('').trim();
  return t || '새 대화';
}

/** 대화 목록의 마지막 시각. */
export function relativeTime(iso, now = new Date()) {
  const d = new Date(iso);
  if (!has(iso) || Number.isNaN(d.getTime())) return '미확인';
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return '방금';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}분 전`;
  const day = (x) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days <= 0) return `${Math.floor(diff / 3600_000)}시간 전`;
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  if (d.getFullYear() !== now.getFullYear()) return `${String(d.getFullYear()).slice(-2)}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`; // 별 목록(listDate)과 같은 '25.11.11'
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

const ERRORS = {
  rag_unavailable: '챗봇 서버와 연결되지 않았어요. 잠시 뒤에 다시 물어 주세요',
  key_missing: 'OpenAI 키가 없어요. .env 파일에 키를 넣고 서버를 다시 켜 주세요',
  openai_error: 'OpenAI에서 답을 받지 못했어요. 잠시 뒤에 다시 물어 주세요',
  too_broad: '범위가 너무 넓어요. 기간이나 행성을 좁혀 주세요',
  bad_request: '질문을 읽지 못했어요. 조금 바꿔서 다시 물어 주세요',
  interrupted: '답을 끝내지 못했어요. 다시 물어 주세요',
  internal: '답을 만들지 못했어요. 다시 물어 주세요',
  busy: '앞의 답을 만드는 중이에요',
  chat_off: '챗봇이 꺼져 있어요. 설정에서 켜 주세요',
  invalid_question: '질문은 2,000자까지 쓸 수 있어요',
  not_found: '그 대화를 찾지 못했어요',
};

/** 답 실패 · 묻기 실패 코드 → 한 줄 문구. */
export function errorMessage(code) {
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS.internal;
}

/** 질문과 함께 보내는 현지 날짜 · 시차. */
export function askMeta(now = new Date()) {
  return {
    today: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    tz_offset_min: -now.getTimezoneOffset(),
  };
}

/**
 * 챗봇 창이 보여 줄 것. 동의 전이면 'consent'(켜기 확인), 꺼져 있으면 'off'(탭은 그대로, 대화는 읽기만),
 * 켜져 있지만 쓸 수 없으면 'unavailable', 아니면 'ready'.
 */
export function panelMode({ consented, enabled, rag, key } = {}) {
  if (!consented) return 'consent';
  if (!enabled) return 'off';
  return unavailableMessage({ rag, key }) ? 'unavailable' : 'ready';
}

/** 읽지 않음을 물어도 되는지: 켜져 있고 쓸 수 있을 때, 탭이 보이고 연결돼 있을 때만. */
export function shouldPollUnread({ settings, hidden, offline } = {}) {
  return Boolean(settings) && !hidden && !offline && panelMode(settings) === 'ready';
}

const RETRY_DELAYS = [3_000, 10_000, 30_000];
/** 실패를 n번 거듭한 뒤 다시 보기까지 기다릴 시간(0번 = 보통 간격 3초). 3초 → 10초 → 30초에서 멈춘다. */
export function nextRetryDelay(failures) {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  return RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)];
}

/** 챗봇 버튼의 접근 가능한 이름. */
export function chatButtonLabel({ open, behind, unread } = {}) {
  if (open && behind) return '챗봇 앞으로 가져오기';
  if (open) return '챗봇 닫기';
  return unread ? '챗봇 열기, 읽지 않은 답 있음' : '챗봇 열기';
}

/** 버튼에 보이는 글자. 닫을 수 있을 때(열려 있고 앞에 있을 때)만 "닫기". */
export function chatButtonText({ open, behind } = {}) {
  return open && !behind ? '닫기' : '물어보기';
}

/**
 * 버튼 위의 처음 한 번 말풍선("기록에게 물어보세요")을 보일지.
 * 우주 안에서, 별이 하나라도 있고(빈 우주에는 기록하기 말풍선이 뜬다), 챗봇 창이 닫혀 있고,
 * 아직 ✕로 끄거나 챗봇을 열어 본 적이 없을 때(dismissed)만.
 */
export function chatHintVisible({ inWorld, total, open, dismissed, offline } = {}) {
  return Boolean(inWorld) && Number(total) > 0 && !open && !dismissed && !offline;
}

/**
 * "별로 저장"으로 띄운 별(m.saved_star)을 출처 카드처럼 날아갈 수 있는 모양으로. 없거나(아직 안 띄움 · 그 별을 지움) 행성을 모르면 null.
 * → { exists: true, star_id, planet_id, created_at } (chatPanel.js onSource가 받는 모양)
 */
export function savedStarSource(m) {
  const s = m?.saved_star;
  if (!s || !s.id || !s.planet_id) return null;
  return { exists: true, star_id: s.id, planet_id: s.planet_id, created_at: s.created_at ?? null };
}

export const ANNOUNCE_MAX = 200;
/** 답이 끝났을 때 화면 읽기 프로그램에 한 번 읽어 줄 문구. m = { status, content, error } */
export function answerAnnouncement(m = {}) {
  if (m.status === 'stopped') return '답을 멈췄어요';
  if (m.status === 'failed') return errorMessage(m.error);
  const t = chars(String(m.content ?? '').replace(/\s+/g, ' ').trim());
  if (!t.length) return '기록에서 찾지 못했어요.';
  return t.length > ANNOUNCE_MAX ? `${t.slice(0, ANNOUNCE_MAX).join('')}…` : t.join('');
}
