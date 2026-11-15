import { describe, expect, test } from 'vitest';
import {
  defaultCustom,
  emptyHint,
  guestMoved,
  guestVerdict,
  initialSideCollapsed,
  isOutsidePeriod,
  nextCustom,
  revertTarget,
  shouldWiden,
  shouldWidenToAll,
  widenToast,
  worldStateOf,
} from '../ui/hudLogic.js';
import { periodCountLabel, periodRange } from '../util.js';

describe('worldStateOf', () => {
  test('stars in the period → normal', () => {
    expect(worldStateOf({ total: 12, inPeriod: 3, planets: 2, period: 'today' })).toEqual({ kind: 'normal', todayButton: false });
  });
  test('no stars in the period but some elsewhere → still normal', () => {
    expect(worldStateOf({ total: 12, inPeriod: 0, planets: 2, period: 'today' }).kind).toBe('normal');
  });
  test('no stars and no planets → empty', () => {
    expect(worldStateOf({ total: 0, inPeriod: 0, planets: 0, period: 'today' })).toEqual({ kind: 'empty', todayButton: false });
  });
  test('no stars but planets exist → emptyPlanets (planets stay visible)', () => {
    expect(worldStateOf({ total: 0, inPeriod: 0, planets: 3, period: 'week' })).toEqual({ kind: 'emptyPlanets', todayButton: false });
  });
  test('exactly 2,000 stars in the period is still normal', () => {
    expect(worldStateOf({ total: 5000, inPeriod: 2000, planets: 4, period: 'week' }).kind).toBe('normal');
  });
  test('more than 2,000 stars in the period → cap, with the "today" button', () => {
    expect(worldStateOf({ total: 5000, inPeriod: 2001, planets: 4, period: 'week' })).toEqual({ kind: 'cap', todayButton: true });
    expect(worldStateOf({ total: 5000, inPeriod: 2001, planets: 4, period: 'custom' })).toEqual({ kind: 'cap', todayButton: true });
  });
  test('cap while the period is already today → no button', () => {
    expect(worldStateOf({ total: 5000, inPeriod: 2001, planets: 4, period: 'today' })).toEqual({ kind: 'cap', todayButton: false });
  });
  test('the cap can be overridden', () => {
    expect(worldStateOf({ total: 9, inPeriod: 4, planets: 1, period: 'week', cap: 3 }).kind).toBe('cap');
  });
  test('missing or odd numbers count as zero', () => {
    expect(worldStateOf({}).kind).toBe('empty');
    expect(worldStateOf({ total: 'x', inPeriod: null, planets: undefined, period: 'today' }).kind).toBe('empty');
  });
});

describe('shouldWiden', () => {
  test('today with no stars today but some overall → widen', () => {
    expect(shouldWiden({ period: 'today', inPeriod: 0, total: 1 })).toBe(true);
  });
  test('today has stars → no', () => expect(shouldWiden({ period: 'today', inPeriod: 2, total: 9 })).toBe(false));
  test('nothing at all → no (the empty state shows instead)', () => {
    expect(shouldWiden({ period: 'today', inPeriod: 0, total: 0 })).toBe(false);
  });
  test('other periods are never widened', () => {
    expect(shouldWiden({ period: 'week', inPeriod: 0, total: 5 })).toBe(false);
    expect(shouldWiden({ period: 'custom', inPeriod: 0, total: 5 })).toBe(false);
  });
});

describe('isOutsidePeriod (guest star decision)', () => {
  const now = new Date(2026, 10, 11, 15, 30);
  const today = periodRange('today', null, now);
  const week = periodRange('week', null, now);
  const at = (y, m, d, hh = 12) => ({ id: 's', planet_id: 'p', created_at: new Date(y, m - 1, d, hh).toISOString() });

  test('a star from today is inside today', () => expect(isOutsidePeriod(at(2026, 11, 11), today)).toBe(false));
  test('a star from 8 days ago is outside today and outside this week', () => {
    expect(isOutsidePeriod(at(2026, 11, 3), today)).toBe(true);
    expect(isOutsidePeriod(at(2026, 11, 3), week)).toBe(true);
  });
  test('a star from 6 days ago is inside this week but outside today', () => {
    expect(isOutsidePeriod(at(2026, 11, 5), week)).toBe(false);
    expect(isOutsidePeriod(at(2026, 11, 5), today)).toBe(true);
  });
  test('from is inclusive, to is exclusive', () => {
    expect(isOutsidePeriod({ created_at: today.from }, today)).toBe(false);
    expect(isOutsidePeriod({ created_at: today.to }, today)).toBe(true);
  });
  test('an open-ended range only checks the side it has', () => {
    expect(isOutsidePeriod(at(2020, 1, 1), { to: today.to })).toBe(false);
    expect(isOutsidePeriod(at(2020, 1, 1), { from: today.from })).toBe(true);
    expect(isOutsidePeriod(at(2020, 1, 1), null)).toBe(false);
  });
  test('no star or an unreadable date → not a guest', () => {
    expect(isOutsidePeriod(null, today)).toBe(false);
    expect(isOutsidePeriod({ created_at: 'nope' }, today)).toBe(false);
  });
});

describe('guestVerdict (guest star on re-render)', () => {
  const guest = { id: '7', planet_id: '2' };
  const planets = [{ id: 1 }, { id: 2 }];
  test('no guest → none', () => expect(guestVerdict({ guest: null, planets, stars: [] })).toBe('none'));
  test('planet still there and star still out of the period → keep', () => {
    expect(guestVerdict({ guest, planets, stars: [{ id: 3 }] })).toBe('keep');
  });
  test('its planet is gone → gone', () => {
    expect(guestVerdict({ guest, planets: [{ id: 1 }], stars: [] })).toBe('gone');
    expect(guestVerdict({ guest })).toBe('gone');
  });
  test('the period now contains the star → inPeriod (ids compare as strings)', () => {
    expect(guestVerdict({ guest, planets, stars: [{ id: 3 }, { id: 7 }] })).toBe('inPeriod');
  });
});

describe('guestMoved (guest star re-validated against the server)', () => {
  const guest = { id: '7', planet_id: '2' };
  test('same planet → stays', () => expect(guestMoved(guest, { id: 7, planet_id: 2 })).toBe(false));
  test('deleted (404 → null) → drop', () => expect(guestMoved(guest, null)).toBe(true));
  test('moved to another planet → drop', () => expect(guestMoved(guest, { id: 7, planet_id: 5 })).toBe(true));
  test('no guest → nothing to drop', () => expect(guestMoved(null, null)).toBe(false));
});

describe('revertTarget (failed period change)', () => {
  const loaded = { period: 'today', range: { from: 'a', to: 'b' } };
  test('goes back to the last period that actually loaded, not the one clicked before', () => {
    // 오늘(받음) → 이번 주(받는 중) → 직접 지정(실패): 오늘로
    expect(revertTarget({ isLatest: true, offline: false, loaded })).toBe(loaded);
  });
  test('a newer change is in flight → leave it alone', () => {
    expect(revertTarget({ isLatest: false, offline: false, loaded })).toBeNull();
  });
  test('offline → keep the chosen period for the reconnect', () => {
    expect(revertTarget({ isLatest: true, offline: true, loaded })).toBeNull();
  });
  test('nothing loaded yet → no revert', () => {
    expect(revertTarget({ isLatest: true, offline: false, loaded: null })).toBeNull();
    expect(revertTarget()).toBeNull();
  });
});

describe('custom range', () => {
  test('defaultCustom: the last 30 days, ending today (local dates)', () => {
    expect(defaultCustom(new Date(2026, 10, 11, 23, 59))).toEqual({ from: '2026-10-13', to: '2026-11-11' });
    expect(defaultCustom(new Date(2026, 0, 5, 0, 0))).toEqual({ from: '2025-12-07', to: '2026-01-05' });
  });
  test('nextCustom: takes a valid new day', () => {
    expect(nextCustom({ from: '2026-11-01', to: '2026-11-11' }, { from: '2026-11-05' })).toEqual({ from: '2026-11-05', to: '2026-11-11' });
    expect(nextCustom({ from: '2026-11-01', to: '2026-11-11' }, { to: '2026-11-08' })).toEqual({ from: '2026-11-01', to: '2026-11-08' });
  });
  test('nextCustom: an empty or impossible day keeps the previous one', () => {
    const prev = { from: '2026-11-01', to: '2026-11-11' };
    expect(nextCustom(prev, { from: '' })).toEqual(prev);
    expect(nextCustom(prev, { to: '2026-02-31' })).toEqual(prev);
    expect(nextCustom(prev, { to: 'abc' })).toEqual(prev);
    expect(nextCustom(prev, {})).toEqual(prev);
  });
  test('nextCustom: a start after the end is swapped', () => {
    expect(nextCustom({ from: '2026-11-01', to: '2026-11-11' }, { from: '2026-11-20' })).toEqual({ from: '2026-11-11', to: '2026-11-20' });
  });
  test('nextCustom output always gives periodRange a real range', () => {
    const c = nextCustom({ from: '2026-11-01', to: '2026-11-11' }, { to: '2026-10-01' });
    const r = periodRange('custom', c, new Date(2026, 10, 11));
    expect(r.from).toBe(new Date(2026, 9, 1).toISOString());
    expect(r.to).toBe(new Date(2026, 10, 2).toISOString());
  });
});

describe('emptyHint (W-01 빈 우주 말풍선, 스펙 6-8)', () => {
  const BODY = '기록하기를 누르거나 파일을 끌어다 놓아 보세요';
  const BODY_NO_PLANET = '+ 새 행성으로 첫 행성을 만들거나 기록하기를 눌러 보세요';
  test('no stars, some planets → the standard two lines', () => {
    expect(emptyHint({ total: 0, planets: 2, dismissed: false })).toEqual({ title: '아직 별이 없어요', body: BODY });
  });
  test('no stars and no planets → the second line points at + 새 행성', () => {
    expect(emptyHint({ total: 0, planets: 0, dismissed: false })).toEqual({ title: '아직 별이 없어요', body: BODY_NO_PLANET });
  });
  test('any star → no bubble', () => {
    expect(emptyHint({ total: 1, planets: 1, dismissed: false })).toBeNull();
    expect(emptyHint({ total: 3000, planets: 0, dismissed: false })).toBeNull();
  });
  test('dismissed with ✕ → never again', () => {
    expect(emptyHint({ total: 0, planets: 0, dismissed: true })).toBeNull();
    expect(emptyHint({ total: 0, planets: 4, dismissed: true })).toBeNull();
  });
  test('offline → no bubble (the offline card speaks instead)', () => {
    expect(emptyHint({ total: 0, planets: 1, dismissed: false, offline: true })).toBeNull();
  });
  test('missing or odd numbers count as zero', () => {
    expect(emptyHint({}).body).toBe(BODY_NO_PLANET);
    expect(emptyHint({ total: 'x', planets: null }).title).toBe('아직 별이 없어요');
    expect(emptyHint()).not.toBeNull();
  });
  test('copy follows 13장: 해요체, no exclamation mark', () => {
    for (const h of [emptyHint({ planets: 1 }), emptyHint({ planets: 0 })]) {
      expect(h.title + h.body).not.toMatch(/!/);
      expect(h.title.endsWith('요')).toBe(true);
      expect(h.body.endsWith('요')).toBe(true);
    }
  });
});

describe('initialSideCollapsed (왼쪽 패널 처음 상태, 스펙 6-8)', () => {
  test('nothing stored on a wide screen → open', () => {
    expect(initialSideCollapsed({ stored: null, narrow: false })).toBe(false);
  });
  test('the remembered state wins on a wide screen', () => {
    expect(initialSideCollapsed({ stored: 'closed', narrow: false })).toBe(true);
    expect(initialSideCollapsed({ stored: 'open', narrow: false })).toBe(false);
  });
  test('760px or less → collapsed, even if open was remembered', () => {
    expect(initialSideCollapsed({ stored: 'open', narrow: true })).toBe(true);
    expect(initialSideCollapsed({ stored: null, narrow: true })).toBe(true);
    expect(initialSideCollapsed({ stored: 'closed', narrow: true })).toBe(true);
  });
  test('an unknown stored value counts as nothing stored', () => {
    expect(initialSideCollapsed({ stored: 'banana', narrow: false })).toBe(false);
    expect(initialSideCollapsed({})).toBe(false);
    expect(initialSideCollapsed()).toBe(false);
  });
});

describe('전체 기간', () => {
  test('periodRange all → 빈 범위', () => expect(periodRange('all')).toEqual({ from: '', to: '' }));
  test('말머리', () => {
    expect(periodCountLabel('all')).toBe('전체 별');
    expect(periodCountLabel('today')).toBe('이 기간 별');
    expect(periodCountLabel('custom')).toBe('이 기간 별');
  });
  test('isOutsidePeriod: 전체에서는 어떤 별도 밖이 아니다', () => {
    expect(isOutsidePeriod({ created_at: '2001-01-01T00:00:00.000Z' }, periodRange('all'))).toBe(false);
  });
  test('worldStateOf: 전체에서 상한을 넘으면 오늘만 보기 버튼', () => {
    expect(worldStateOf({ total: 2500, inPeriod: 2500, planets: 1, period: 'all' })).toEqual({ kind: 'cap', todayButton: true });
  });
});

describe('shouldWidenToAll', () => {
  test('이번 주도 비었고 전체는 있다 → 전체로', () => expect(shouldWidenToAll({ period: 'week', inPeriod: 0, total: 3 })).toBe(true));
  test('이번 주에 별이 있다 → 아니다', () => expect(shouldWidenToAll({ period: 'week', inPeriod: 1, total: 3 })).toBe(false));
  test('별이 하나도 없다 → 아니다', () => expect(shouldWidenToAll({ period: 'week', inPeriod: 0, total: 0 })).toBe(false));
  test('이번 주가 아니다 → 아니다', () => expect(shouldWidenToAll({ period: 'today', inPeriod: 0, total: 3 })).toBe(false));
  test('안내 문구', () => {
    expect(widenToast('week')).toBe('오늘 별이 없어 이번 주를 보여드려요');
    expect(widenToast('all')).toBe('최근 일주일에도 별이 없어 전체를 보여드려요');
  });
});
