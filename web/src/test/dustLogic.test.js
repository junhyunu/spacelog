import { describe, expect, it } from 'vitest';
import { BAND_TILT, DUST_ORBIT, DUST_PER_PLANET, DUST_SIZE, pickDrawn } from '../three/dustLogic.js';

describe('dustLogic', () => {
  it('먼지 상수', () => {
    expect(DUST_SIZE).toBe(1.3);
    expect(DUST_PER_PLANET).toBe(300);
    expect(DUST_ORBIT).toEqual([6.0, 8.6]);
    expect(BAND_TILT).toEqual([0.42, 0, -0.22]);
  });

  it('pickDrawn: 행성마다 상한까지, 최근 것부터 고른다', () => {
    const list = [...Array(320)]
      .map((_, i) => ({ id: `u${i}`, planet_id: 'unsorted' }))
      .concat([...Array(60)].map((_, i) => ({ id: `a${i}`, planet_id: 'a' })));
    const m = pickDrawn(list, new Set(['unsorted', 'a']), { perPlanet: 50, perUnsorted: 300 });
    expect([...m.values()].filter((p) => p === 'unsorted')).toHaveLength(300);
    expect([...m.values()].filter((p) => p === 'a')).toHaveLength(50);
    expect(m.has('u0')).toBe(true);
    expect(m.has('u300')).toBe(false); // 최근 것부터
    expect(m.has('a49')).toBe(true);
    expect(m.has('a50')).toBe(false);
  });

  it('pickDrawn: 없는 행성의 별은 고르지 않는다', () => {
    expect(pickDrawn([{ id: 'x', planet_id: 'gone' }], new Set(['a']), { perPlanet: 50, perUnsorted: 300 }).size).toBe(0);
  });

  it('pickDrawn: id는 문자열 키로 바꾼다', () => {
    const m = pickDrawn([{ id: 7, planet_id: 3 }], new Set(['3']), { perPlanet: 50, perUnsorted: 300 });
    expect(m.get('7')).toBe('3');
  });
});
