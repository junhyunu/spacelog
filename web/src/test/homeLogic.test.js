import { describe, expect, test } from 'vitest';
import {
  PAGE,
  countTitle,
  emptyState,
  filterStars,
  firstLine,
  markHtml,
  matches,
  orderStars,
  pageOf,
  snipHtml,
} from '../ui/homeLogic.js';

const star = (id, o = {}) => ({ id, title: `별 ${id}`, body: null, memo: '', fav: false, planet_id: 'p1', created_at: `2026-11-${String(id).padStart(2, '0')}T00:00:00.000Z`, ...o });

describe('matches', () => {
  test('finds the query in title, body or the old memo, ignoring case; an empty query matches everything', () => {
    const s = star(1, { title: 'PRD 2차 의견', body: '알림은 하루 한 번', memo: '옛 메모' });
    expect(matches(s, 'prd')).toBe(true);
    expect(matches(s, '하루')).toBe(true);
    expect(matches(s, '옛')).toBe(true);
    expect(matches(s, '없는말')).toBe(false);
    expect(matches(s, '')).toBe(true);
    expect(matches(s, '   ')).toBe(true);
    expect(matches(star(2, { title: null, body: null }), 'x')).toBe(false);
  });
});

describe('filterStars', () => {
  const list = [star(3, { fav: true }), star(2, { planet_id: 'p2', body: '달리기' }), star(1)];
  test('by planet, favourites and query, keeping the order', () => {
    expect(filterStars(list, {}).map((s) => s.id)).toEqual([3, 2, 1]);
    expect(filterStars(list, { planetId: 'p1' }).map((s) => s.id)).toEqual([3, 1]);
    expect(filterStars(list, { fav: true }).map((s) => s.id)).toEqual([3]);
    expect(filterStars(list, { q: '달리기' }).map((s) => s.id)).toEqual([2]);
    expect(filterStars(list, { planetId: 'p2', fav: true })).toEqual([]);
  });
  test('planet ids compare as strings; "all" and empty mean every planet', () => {
    expect(filterStars([star(1, { planet_id: 7 })], { planetId: '7' })).toHaveLength(1);
    expect(filterStars(list, { planetId: 'all' })).toHaveLength(3);
    expect(filterStars(list, { planetId: null })).toHaveLength(3);
  });
  test('while showing favourites only, a star just un-starred stays (keep) so a slip can be undone', () => {
    expect(filterStars(list, { fav: true, keep: new Set(['1']) }).map((s) => s.id)).toEqual([3, 1]);
  });
});

describe('orderStars', () => {
  const planets = [{ id: 'p2' }, { id: 'p1' }];
  const list = [star(3), star(2, { planet_id: 'p2' }), star(1)];
  test('newest first; grouped → planet order first, newest first inside (only when no planet is picked)', () => {
    expect(orderStars([list[2], list[0], list[1]], {}).map((s) => s.id)).toEqual([3, 2, 1]);
    expect(orderStars(list, { group: true, planets }).map((s) => s.id)).toEqual([2, 3, 1]);
    expect(orderStars(list, { group: true, planets, planetId: 'p1' }).map((s) => s.id)).toEqual([3, 2, 1]);
  });
  test('does not change the array it was given', () => {
    const input = [list[2], list[0]];
    orderStars(input, {});
    expect(input.map((s) => s.id)).toEqual([1, 3]);
  });
});

describe('markHtml / snipHtml / firstLine', () => {
  test('markHtml wraps every hit in <mark> and escapes the rest', () => {
    expect(markHtml('PRD prd <b>', 'prd')).toBe('<mark>PRD</mark> <mark>prd</mark> &lt;b&gt;');
    expect(markHtml('<a>', '')).toBe('&lt;a&gt;');
    expect(markHtml(null, 'x')).toBe('');
  });
  test('snipHtml: one line around the first hit, trimmed in front so the word shows; null when not found', () => {
    expect(snipHtml('짧은 글', '글')).toBe('짧은 <mark>글</mark>');
    expect(snipHtml('가나다라마바사아자차카타파하 열두 글자 넘게 앞에 있는 찾을말 뒤', '찾을말')).toBe('…글자 넘게 앞에 있는 <mark>찾을말</mark> 뒤');
    expect(snipHtml('줄\n바꿈  여러   칸 찾기', '찾기')).toBe('줄 바꿈 여러 칸 <mark>찾기</mark>');
    expect(snipHtml('없다', '찾기')).toBeNull();
    expect(snipHtml('무엇이든', '')).toBeNull();
  });
  test('firstLine: first non-empty line, trimmed', () => {
    expect(firstLine('\n  첫 줄  \n둘째')).toBe('첫 줄');
    expect(firstLine(null)).toBe('');
  });
});

describe('countTitle', () => {
  test('"별 N개", with the planet name in front and the query when searching', () => {
    expect(countTitle({ shown: 11 })).toBe('별 11개');
    expect(countTitle({ shown: 2, planetName: '제품 기획' })).toBe('제품 기획 · 별 2개');
    expect(countTitle({ shown: 1, q: ' 달리기 ' })).toBe('‘달리기’ 찾은 별 1개');
    expect(countTitle({ shown: 0, planetName: '운동', q: 'x' })).toBe('운동 · ‘x’ 찾은 별 0개');
    expect(countTitle({ shown: 1234 })).toBe('별 1,234개');
  });
});

describe('pageOf', () => {
  test(`shows ${PAGE} at a time and says how many are left`, () => {
    const many = Array.from({ length: 120 }, (_, i) => i);
    expect(PAGE).toBe(50);
    expect(pageOf(many, 50)).toEqual({ rows: many.slice(0, 50), rest: 70 });
    expect(pageOf(many, 100).rest).toBe(20);
    expect(pageOf(many, 150)).toEqual({ rows: many, rest: 0 });
    expect(pageOf([], 50)).toEqual({ rows: [], rest: 0 });
  });
});

describe('emptyState', () => {
  test('which empty message to show, in order: search → favourites → period', () => {
    expect(emptyState({ shown: 3 })).toBeNull();
    expect(emptyState({ shown: 0, q: '달리기', elsewhere: 2 })).toBe('search-elsewhere');
    expect(emptyState({ shown: 0, q: '달리기', elsewhere: 0 })).toBe('search-none');
    expect(emptyState({ shown: 0, fav: true })).toBe('fav');
    expect(emptyState({ shown: 0 })).toBe('period');
  });
});
