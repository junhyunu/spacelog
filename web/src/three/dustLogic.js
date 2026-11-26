// 미분류 행성의 먼지 띠: 수치와 그릴 별 고르기. three.js를 쓰지 않는 순수 부분이라 node에서 테스트한다.
import { isUnsorted } from '../util.js';

/** 먼지 한 알의 크기(월드 단위). */
export const DUST_SIZE = 1.3;
/** 미분류 행성에 그리는 먼지의 최대 개수(최근 것부터). */
export const DUST_PER_PLANET = 300;
/** 먼지 궤도 반지름 [안, 밖](행성 중심에서). */
export const DUST_ORBIT = [6.0, 8.6];
/** 먼지 띠의 기울기(pivot.rotation x, y, z). */
export const BAND_TILT = [0.42, 0, -0.22];

/**
 * 최신순 별 목록에서 행성마다 상한까지 고른다. 미분류는 perUnsorted, 그 밖은 perPlanet.
 * planetIds에 없는 행성의 별은 건너뛴다. 돌려주는 Map은 별 id → 행성 id(둘 다 문자열).
 */
export function pickDrawn(starList, planetIds, { perPlanet, perUnsorted }) {
  const wanted = new Map();
  const drawn = new Map();
  for (const s of starList) {
    const pid = String(s.planet_id);
    if (!planetIds.has(pid)) continue;
    const n = drawn.get(pid) || 0;
    if (n >= (isUnsorted(pid) ? perUnsorted : perPlanet)) continue;
    drawn.set(pid, n + 1);
    wanted.set(String(s.id), pid);
  }
  return wanted;
}

/**
 * 글자에서 씨앗을 얻는 난수. 같은 글자면 늘 같은 순서가 나온다(새로고침해도 모습이 같다).
 * 돌려주는 함수 rand(lo, hi)는 lo 이상 hi 미만.
 */
export function seededRand(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (lo, hi) => lo + next() * (hi - lo);
}
