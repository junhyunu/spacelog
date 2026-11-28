import { describe, expect, test } from 'vitest';
import {
  ageLabel,
  daysSince,
  filterKept,
  holeScale,
  homeRemindText,
  insertAt,
  keptPreview,
  remindHelp,
  removeAt,
  stepIndex,
  swipeDir,
} from '../ui/remindLogic.js';

const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const ago = (d, h = 0) => new Date(NOW - d * 86400000 - h * 3600000).toISOString();

describe('잠든 별 블랙홀 계산', () => {
  test('블랙홀 크기: 0개면 없음, 많을수록 커지고 20개에서 멈춘다', () => {
    expect(holeScale(0)).toBe(0);
    expect(holeScale(1)).toBeCloseTo(0.805);
    expect(holeScale(10)).toBeGreaterThan(holeScale(5));
    expect(holeScale(20)).toBeCloseTo(1.28);
    expect(holeScale(300)).toBe(holeScale(20));
  });

  test('며칠째 안 봤는지: 내림, 미래 · 깨진 값은 0', () => {
    expect(daysSince(ago(14, 1), NOW)).toBe(14);
    expect(daysSince(ago(0, 23), NOW)).toBe(0);
    expect(daysSince(new Date(NOW + 5000).toISOString(), NOW)).toBe(0);
    expect(daysSince('x', NOW)).toBe(0);
    expect(ageLabel(ago(40), NOW)).toBe('40일째 안 봤어요');
  });

  test('설정 설명은 문장마다 한 줄', () => {
    expect(remindHelp(14)).toEqual(['14일 동안 열어 보지 않은 별을 블랙홀에 모아요.', '별을 열어 보면 처음부터 다시 세요.']);
    expect(remindHelp(0)).toEqual(['블랙홀을 만들지 않아요.', '홈 표시도 사라져요.']);
  });

  test('고르면 빠지고 다음 별, 마지막이었으면 앞 별. 되돌리면 원래 자리에', () => {
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual({ queue: ['a', 'c'], index: 1 });
    expect(removeAt(['a', 'b', 'c'], 2)).toEqual({ queue: ['a', 'b'], index: 1 });
    expect(removeAt(['a'], 0)).toEqual({ queue: [], index: 0 });
    expect(insertAt(['a', 'c'], 1, 'b')).toEqual({ queue: ['a', 'b', 'c'], index: 1 });
    expect(insertAt(['a'], 5, 'b')).toEqual({ queue: ['a', 'b'], index: 1 });
    expect(insertAt([], 0, 'a')).toEqual({ queue: ['a'], index: 0 });
  });

  test('넘기기와 밀기', () => {
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(swipeDir(-80, 10)).toBe(-1);
    expect(swipeDir(90, -5)).toBe(1);
    expect(swipeDir(-50, 0)).toBe(0); // 짧다
    expect(swipeDir(-80, 120)).toBe(0); // 세로가 더 많다(내려 보기)
  });

  test('설정의 알림 끈 별: 5개까지 펼치고, 6개부터 최근 3개 + 전체 보기. 찾기는 제목으로', () => {
    const list = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), title: `별 ${i}` }));
    expect(keptPreview(list(5))).toEqual({ shown: list(5), more: 0 });
    const many = keptPreview(list(24));
    expect(many.shown.map((s) => s.id)).toEqual(['0', '1', '2']);
    expect(many.more).toBe(24);
    expect(filterKept([{ title: 'Flask 메모' }, { title: '독서' }], ' flask ').map((s) => s.title)).toEqual(['Flask 메모']);
    expect(filterKept(list(3), '')).toHaveLength(3);
  });

  test('홈 안내: 잠든 별이 있을 때만', () => {
    expect(homeRemindText(0)).toBeNull();
    expect(homeRemindText(1234)).toEqual({ count: '1,234' });
  });
});
