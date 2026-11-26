// W-00 홈의 별 목록(homeList.js)이 쓰는 순수 함수(DOM 없음): 거르기 · 순서 · 검색 강조 · 개수 제목 · 더 보기 · 빈 상태.
// 비교 테스트 화면(docs/research/ab-test/spacelog-home.html)에서 먼저 써 본 규칙을 옮겼다.
import { queryTerms, matchesText, markHtml as markHtmlShared, snipAround } from './searchMatch.js';

/** 목록을 한 번에 이만큼 보이고 "더 보기"로 이만큼씩 늘린다. */
export const PAGE = 50;

const str = (v) => (typeof v === 'string' ? v : '');
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');

/** 검색어가 제목 · 메모(본문 body, 옛 memo)에 있는지. 대소문자 · 띄어쓰기 · 낱말 순서는 가리지 않는다(searchMatch). 검색어가 비면 모두 맞다. */
export function matches(star, q) {
  return matchesTerms(star, queryTerms(q));
}

/** matches와 같지만 낱말을 미리 나눠 받는다(여러 별을 거를 때 낱말 나누기를 한 번만). */
export function matchesTerms(star, terms) {
  return matchesText([str(star?.title), str(star?.body), str(star?.memo)], terms);
}

/**
 * 고른 행성 · 자주 찾음 · 검색어로 거른다(순서는 그대로).
 * keep: "자주 찾음만" 보는 중에 방금 ☆를 끈 별의 id 모음. 바로 빼지 않고 남긴다(잘못 눌렀으면 다시 켜면 된다).
 */
export function filterStars(stars, { planetId, fav, q, keep } = {}) {
  const every = planetId === null || planetId === undefined || planetId === '' || planetId === 'all';
  const terms = queryTerms(q);
  return Array.from(stars ?? []).filter(
    (s) => (every || same(s.planet_id, planetId)) && (!fav || s.fav || Boolean(keep?.has(String(s.id)))) && matchesTerms(s, terms),
  );
}

/**
 * 목록에 보이는 순서: 최신순. "행성별로 묶기"가 켜져 있고 행성을 고르지 않았으면 행성 순서 → 그 안에서 최신순.
 * 상세의 "n / N"도 이 순서를 쓴다. 받은 배열은 건드리지 않는다.
 */
export function orderStars(list, { group, planets, planetId } = {}) {
  const sorted = [...(list ?? [])].sort((a, b) => (str(a.created_at) < str(b.created_at) ? 1 : str(a.created_at) > str(b.created_at) ? -1 : 0));
  const every = planetId === null || planetId === undefined || planetId === '' || planetId === 'all';
  if (!group || !every) return sorted;
  return Array.from(planets ?? []).flatMap((p) => sorted.filter((s) => same(s.planet_id, p.id)));
}

/**
 * 상세의 "n / N"과 이전 · 다음: 목록에 보이는 순서(orderStars)에서 그 별의 자리.
 * @returns {{ index: number, total: number, prevId: string|null, nextId: string|null }} 목록에 없으면 index는 -1
 */
export function neighbors(list, id) {
  const all = Array.from(list ?? []);
  const index = all.findIndex((s) => same(s.id, id));
  const idAt = (i) => (index >= 0 && i >= 0 && i < all.length ? String(all[i].id) : null);
  return { index, total: all.length, prevId: idAt(index - 1), nextId: idAt(index + 1) };
}

/** 찾은 낱말을 <mark>로 감싼 HTML(나머지는 esc). 검색어가 비면 esc만. 규칙은 searchMatch와 같다. */
export const markHtml = markHtmlShared;

/**
 * 글에서 검색어를 찾았으면 그 낱말 둘레의 한 줄(HTML). 줄바꿈 · 여러 칸은 한 칸으로, 낱말이 보이게 앞은 12자만 남기고 "…".
 * 못 찾았거나 검색어가 비면 null. 제목에 없는데 왜 나왔는지 알려 주는 데 쓴다.
 */
export const snipHtml = (text, q) => snipAround(text, q, 12);

/** 글의 비어 있지 않은 첫 줄(목록의 메모 칸). */
export function firstLine(text) {
  return (
    str(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  );
}

/** 목록 카드 맨 위 제목: "별 11개" · "제품 기획 · 별 2개" · "‘달리기’ 찾은 별 1개". */
export function countTitle({ shown = 0, planetName = '', q = '' } = {}) {
  const where = planetName ? `${planetName} · ` : '';
  const query = str(q).trim();
  return query ? `${where}‘${query}’ 찾은 별 ${num(shown)}개` : `${where}별 ${num(shown)}개`;
}

/** 앞에서 limit개와 남은 개수. */
export function pageOf(list, limit = PAGE) {
  const all = Array.from(list ?? []);
  const rows = all.slice(0, Math.max(0, limit));
  return { rows, rest: all.length - rows.length };
}

/**
 * 목록이 비었을 때 보일 안내의 종류. 비지 않았으면 null.
 * 'search-elsewhere' 찾는 말이 다른 행성 · 기간에는 있다 / 'search-none' 어디에도 없다 /
 * 'fav' 자주 찾음으로 표시한 별이 없다 / 'period' 이 기간(· 행성)에 별이 없다
 */
export function emptyState({ shown = 0, q = '', fav = false, elsewhere = 0 } = {}) {
  if (shown > 0) return null;
  if (str(q).trim()) return elsewhere > 0 ? 'search-elsewhere' : 'search-none';
  return fav ? 'fav' : 'period';
}
