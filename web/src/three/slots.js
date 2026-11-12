// 행성 자리와 조망 거리. three.js를 쓰지 않는 순수 계산이라 node에서 테스트한다.

/** 우주의 가운데. 조망 카메라가 보는 점이자 바깥 고리의 중심. */
export const CENTER = Object.freeze([0, 2, -6]);

/** 기본 조망 거리(시안의 OV). */
export const BASE_OVERVIEW = 62;

// 0~3: 시안 예시 행성의 자리, 4~9: 시안 SLOTS 6곳
const FIXED = [
  [0, 0, -34],
  [36, 7, -10],
  [-34, -5, -8],
  [-6, 11, 26],
  [30, -10, 28],
  [-38, 12, -36],
  [16, 16, -52],
  [-30, -14, 30],
  [48, -4, -38],
  [4, -18, 6],
];

const RING_SIZE = 8; // 고리 하나에 놓는 행성 수
const RING_RADIUS = 80; // 첫 고리 반지름
const RING_STEP = 28; // 고리마다 늘어나는 반지름
const RING_LIFT = 8; // 번갈아 위아래로 띄우는 높이

// 계획의 계수는 1.1이었지만, 시안 자리 [48,-4,-38]이 가운데에서 정확히 58 떨어져 있어
// 58 * 1.1 = 63.8 > 62가 된다. "처음 10개는 62"가 지켜지는 값(62 / 58 = 1.0689…)
// 을 넘지 않으면서 소수 둘째 자리까지 쓴 가장 큰 값인 1.06으로 낮췄다.
const OVERVIEW_FACTOR = 1.06;

/**
 * n번째 자리의 좌표 [x, y, z]. n은 0부터, 상한이 없다.
 * 10 이상은 가운데를 도는 고리 위: 8개씩, 고리가 차면 반지름을 28 늘리고 π/8 돌려서 다음 고리.
 */
export function slotPosition(n) {
  const i0 = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (i0 < FIXED.length) return [...FIXED[i0]];
  const k = Math.floor((i0 - FIXED.length) / RING_SIZE);
  const i = (i0 - FIXED.length) % RING_SIZE;
  const radius = RING_RADIUS + RING_STEP * k;
  const angle = (i / RING_SIZE) * Math.PI * 2 + (k * Math.PI) / 8;
  return [
    CENTER[0] + Math.cos(angle) * radius,
    CENTER[1] + (i % 2 ? RING_LIFT : -RING_LIFT),
    CENTER[2] + Math.sin(angle) * radius,
  ];
}

/**
 * 조망 카메라 거리. 가운데에서 가장 먼 행성까지의 거리 R에 대해 max(62, R * 계수).
 * 휠로 물러날 수 있는 최대 거리는 max(80, 이 값 + 18)로 쓴다.
 */
export function overviewDistance(positions = []) {
  let far = 0;
  for (const p of positions) {
    const d = Math.hypot(p[0] - CENTER[0], p[1] - CENTER[1], p[2] - CENTER[2]);
    if (d > far) far = d;
  }
  return Math.max(BASE_OVERVIEW, far * OVERVIEW_FACTOR);
}
