import { describe, expect, test } from 'vitest';
import {
  DECO_NAMES,
  PLANET_COLORS,
  daysAgo,
  esc,
  fileSize,
  firstLine,
  fullDate,
  ico,
  periodRange,
  shortDate,
} from '../util.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 현지 시각으로 만든 기준 시각: 2026-11-11 15:30 (어느 시간대에서 돌려도 같은 달력 날짜)
const NOW = new Date(2026, 10, 11, 15, 30, 0);
const localIso = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();

describe('esc', () => {
  test('esc escapes & < > "', () => expect(esc('<b a="1">&')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;'));
  test('esc escapes single quotes', () => expect(esc("a'b")).toBe('a&#39;b'));
  test('esc turns null and numbers into text', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(12)).toBe('12');
  });
});

describe('ico', () => {
  test('returns an inline svg string of the given size', () => {
    const s = ico('plus', 16);
    expect(s.startsWith('<svg')).toBe(true);
    expect(s).toContain('width="16"');
    expect(s).toContain('stroke-width="2.5"');
    expect(s).toContain('aria-hidden="true"');
  });
  test('defaults to 18px and knows every icon the screens use', () => {
    expect(ico('x')).toContain('width="18"');
    for (const n of ['x', 'arrow-left', 'ellipsis', 'pencil', 'link', 'image', 'file-text', 'type', 'plus', 'upload', 'panel-left-close', 'panel-left-open', 'chevron-down']) {
      expect(ico(n)).toMatch(/<(path|circle|rect|polyline|line) /);
    }
  });
  test('unknown icon never prints "undefined"', () => expect(ico('nope')).not.toContain('undefined'));
  test('rocket (탐사선) is not ported', () => expect(ico('rocket')).not.toContain('<path'));
});

describe('periodRange', () => {
  test('periodRange today = local midnight to next midnight', () => {
    const { from, to } = periodRange('today', null, NOW);
    expect(from).toBe(localIso(2026, 11, 11));
    expect(to).toBe(localIso(2026, 11, 12));
    expect(Date.parse(to) - Date.parse(from)).toBe(DAY);
    expect(Date.parse(from)).toBeLessThanOrEqual(NOW.getTime());
    expect(NOW.getTime()).toBeLessThan(Date.parse(to));
  });
  test('periodRange week = 7 local days ending tomorrow midnight', () => {
    const { from, to } = periodRange('week', null, NOW);
    expect(to).toBe(localIso(2026, 11, 12));
    expect(from).toBe(localIso(2026, 11, 5));
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * DAY);
  });
  test('periodRange custom is inclusive of the end date', () => {
    const { from, to } = periodRange('custom', { from: '2026-11-01', to: '2026-11-03' }, NOW);
    expect(from).toBe(localIso(2026, 11, 1));
    expect(to).toBe(localIso(2026, 11, 4));
  });
  test('periodRange custom with reversed dates is put in order', () => {
    const r = periodRange('custom', { from: '2026-11-03', to: '2026-11-01' }, NOW);
    expect(r).toEqual({ from: localIso(2026, 11, 1), to: localIso(2026, 11, 4) });
  });
  test('periodRange custom with a missing or broken date falls back to today', () => {
    const today = periodRange('today', null, NOW);
    expect(periodRange('custom', { from: '', to: '2026-11-03' }, NOW)).toEqual(today);
    expect(periodRange('custom', null, NOW)).toEqual(today);
    expect(periodRange('custom', { from: '2026-13-40', to: 'x' }, NOW)).toEqual(today);
  });
  test('periodRange always returns ISO instants', () => {
    for (const p of ['today', 'week']) {
      const { from, to } = periodRange(p, null, NOW);
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});

describe('dates', () => {
  test('shortDate is the local month.day', () => {
    expect(shortDate(localIso(2026, 11, 11, 9, 5))).toBe('11.11');
    expect(shortDate(localIso(2026, 1, 3, 23, 59))).toBe('01.03');
  });
  test('daysAgo counts local calendar days', () => {
    const now = new Date(2026, 10, 11, 0, 1);
    expect(daysAgo(localIso(2026, 11, 10, 23, 59), now)).toBe(1);
    expect(daysAgo(localIso(2026, 11, 11, 0, 0), now)).toBe(0);
    expect(daysAgo(localIso(2026, 11, 4, 12, 0), now)).toBe(7);
  });
  test('daysAgo is never negative', () => {
    expect(daysAgo(localIso(2026, 11, 12, 1, 0), new Date(2026, 10, 11, 23, 0))).toBe(0);
  });
  test('fullDate joins the local date and the day count', () => {
    expect(fullDate(localIso(2026, 11, 11, 8, 0), NOW)).toBe('2026-11-11 · 0일 전');
    expect(fullDate(localIso(2026, 11, 1, 8, 0), NOW)).toBe('2026-11-01 · 10일 전');
  });
});

describe('text helpers', () => {
  test('fileSize', () => {
    expect(fileSize(1258291)).toBe('1.2MB');
    expect(fileSize(null)).toBe('크기 미확인');
    expect(fileSize(0)).toBe('0B');
  });
  test('fileSize units and unknown values', () => {
    expect(fileSize(undefined)).toBe('크기 미확인');
    expect(fileSize(-1)).toBe('크기 미확인');
    expect(fileSize(NaN)).toBe('크기 미확인');
    expect(fileSize(1023)).toBe('1,023B');
    expect(fileSize(1536)).toBe('1.5KB');
    expect(fileSize(2.4 * 1024 ** 3)).toBe('2.4GB');
    expect(fileSize(500 * 1024 * 1024)).toBe('500MB');
  });
  test('firstLine trims and cuts at 40', () => {
    expect(firstLine('  \n\n  첫 줄이에요  \n둘째 줄')).toBe('첫 줄이에요');
    const long = '가'.repeat(60);
    expect(firstLine(long)).toBe('가'.repeat(40));
    expect(firstLine(long, 10)).toBe('가'.repeat(10));
    expect(firstLine('')).toBe('');
    expect(firstLine(null)).toBe('');
    expect(firstLine('a\r\nb')).toBe('a');
  });
});

// WCAG 2.x 대비 계산
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('planet looks', () => {
  test('PLANET_COLORS has 16 entries', () => {
    expect(PLANET_COLORS[1]).toMatchObject({ face: '#ff7a59', deep: '#b23a1c' });
    expect(PLANET_COLORS[16]).toMatchObject({ name: '코코아', face: '#c98a5a', deep: '#7a4520' });
    for (let i = 1; i <= 16; i++) expect(PLANET_COLORS[i].name).toBeTruthy();
    expect(PLANET_COLORS[0]).toBeUndefined();
    expect(PLANET_COLORS[17]).toBeUndefined();
    expect(Object.keys(PLANET_COLORS)).toHaveLength(16);
  });
  test('PLANET_COLORS 1-8 follow DESIGN.md 3-1 and 9-16 follow spec 6-6', () => {
    const want = [
      ['주황', '#ff7a59', '#b23a1c'], ['하늘', '#5ec8ff', '#0f6aa8'], ['연두', '#8fdc5a', '#2f7a1e'], ['연보라', '#c29bff', '#6a3fc8'],
      ['호박', '#ffb13b', '#8f5a00'], ['분홍', '#ff6fb5', '#b0246f'], ['청록', '#4fd1c5', '#0d7068'], ['남보라', '#9aa7ff', '#3f4fc0'],
      ['빨강', '#ff5a5a', '#b3202a'], ['민트', '#7cf0b0', '#157a4a'], ['파랑', '#4f8dff', '#1f4fc0'], ['자주', '#d96bff', '#8a22b8'],
      ['라임', '#c6e84a', '#566e00'], ['살구', '#ffc9a3', '#9a4a1c'], ['은회색', '#b9c6e0', '#48587a'], ['코코아', '#c98a5a', '#7a4520'],
    ];
    want.forEach(([name, face, deep], i) => expect(PLANET_COLORS[i + 1]).toEqual({ name, face, deep }));
    expect(new Set(want.map((w) => w[0])).size).toBe(16);
  });
  test('every deep colour has contrast >= 4.8 on white and on #f4f2ff', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5); // 계산식 자체 확인
    for (let i = 1; i <= 16; i++) {
      const { deep, name } = PLANET_COLORS[i];
      expect(deep).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(deep, '#ffffff'), `${i} ${name} on white`).toBeGreaterThanOrEqual(4.8);
      expect(contrast(deep, '#f4f2ff'), `${i} ${name} on panel`).toBeGreaterThanOrEqual(4.8);
    }
  });
  test('DECO_NAMES covers the ten decos', () => {
    expect(Object.keys(DECO_NAMES)).toHaveLength(10);
    expect(Object.keys(DECO_NAMES)).toEqual(['town', 'crystal', 'forest', 'rock', 'ice', 'volcano', 'mushroom', 'cactus', 'flower', 'cloud']);
    expect(DECO_NAMES).toMatchObject({ town: '마을', cloud: '구름', cactus: '선인장' });
  });
});
