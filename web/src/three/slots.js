// 행성 자리와 조망 거리. three.js를 쓰지 않는 순수 계산이라 node에서 테스트한다.

/** 우주의 가운데. 조망 카메라가 보는 점이자 바깥 고리의 중심. */
export const CENTER = Object.freeze([0, 2, -6]);

/** 기본 조망 거리(시안의 OV). */
export const BASE_OVERVIEW = 62;

// 0~3: 시안 예시 행성의 자리, 4~9: 시안 SLOTS 6곳.
// 시안과 다른 곳은 자리 8 하나: 시안의 [48, -4, -38]은 조망(yaw 0, pitch 0.5)에서 자리 1 [36, 7, -10]의
// 바로 뒤에 놓여 화면에서 거의 통째로 가려진다. 다른 자리를 건드리지 않고 겹침이 풀리는 가장 가까운
// 곳(오른쪽으로 12, 위로 4, 앞으로 4)으로 옮겼다. 조망 거리는 그대로다. 나머지 9곳과 바깥 고리는
// 조망에서 서로 겹치지 않는다(slots.test.js가 1~40개에 대해 확인한다).
const FIXED = [
  [0, 0, -34],
  [36, 7, -10],
  [-34, -5, -8],
  [-6, 11, 26],
  [30, -10, 28],
  [-38, 12, -36],
  [16, 16, -52],
  [-30, -14, 30],
  [60, 0, -34],
  [4, -18, 6],
];

/** 미분류 행성의 slot 값(서버와 같다). 줄 세우는 자리가 아니라 고정 자리를 뜻한다. */
export const UNSORTED_SLOT = -1;

/** 미분류 행성의 고정 좌표. 다른 자리와 조망에서 겹치지 않는다(slots.test.js). */
export const UNSORTED_POSITION = Object.freeze([14, 3, 0]);

const RING_SIZE = 8; // 고리 하나에 놓는 행성 수
const RING_RADIUS = 80; // 첫 고리 반지름
const RING_STEP = 28; // 고리마다 늘어나는 반지름
const RING_LIFT = 8; // 번갈아 위아래로 띄우는 높이

const OVERVIEW_SAFETY = 1.04; // 딱 맞는 거리에 더하는 여유

/**
 * n번째 자리의 좌표 [x, y, z]. n은 0부터, 상한이 없다. UNSORTED_SLOT(-1)은 미분류의 고정 좌표,
 * 그 밖의 음수는 0번으로 본다.
 * 10 이상은 가운데를 도는 고리 위: 8개씩, 고리가 차면 반지름을 28 늘리고 π/8 돌려서 다음 고리.
 */
export function slotPosition(n) {
  if (n === UNSORTED_SLOT) return [...UNSORTED_POSITION];
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
 * 모든 행성이 화면 안에 들어오는 가장 가까운 카메라 거리(여유 없이). 행성이 없으면 0.
 *
 * 카메라는 controls.js와 같은 방식으로 CENTER를 돈다:
 *   자리 = CENTER + d * (sin yaw * cos pitch, sin pitch, cos yaw * cos pitch), CENTER를 본다.
 * 행성마다 반지름 margin인 공으로 보고, 시야의 네 옆면 안쪽에 공이 통째로 들어와야 한다.
 * 카메라 축이 정해지면 조건은 d에 대한 일차식이라 바로 풀린다:
 *   d >= 깊이 + (|옆으로 벗어난 거리| + margin * sqrt(1 + tan²)) / tan
 */
export function overviewFit(positions = [], { aspect = 16 / 9, fovDeg = 58, pitch = 0.5, yaw = 0, margin = 9 } = {}) {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  if (!(tanV > 0) || !(tanH > 0)) return 0;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  // 카메라 쪽(back) · 오른쪽(right) · 위(up) 단위 벡터
  const back = [sy * cp, sp, cy * cp];
  const right = [cy, 0, -sy];
  const up = [-sy * sp, cp, -cy * sp];
  const slackH = margin * Math.hypot(1, tanH);
  const slackV = margin * Math.hypot(1, tanV);
  let need = 0;
  for (const p of positions) {
    const x = p[0] - CENTER[0];
    const y = p[1] - CENTER[1];
    const z = p[2] - CENTER[2];
    const depth = x * back[0] + y * back[1] + z * back[2];
    const side = Math.abs(x * right[0] + y * right[1] + z * right[2]);
    const rise = Math.abs(x * up[0] + y * up[1] + z * up[2]);
    const d = depth + Math.max((side + slackH) / tanH, (rise + slackV) / tanV);
    if (d > need) need = d;
  }
  return need;
}

/**
 * 조망 카메라 거리: 모든 행성(반지름 margin인 공)이 화면 안에 들어오는 거리에 여유 4%를 더한 값,
 * 적어도 62(시안의 조망 거리). 시안 예시 행성 4개도 16:9에서 62로는 넷째 행성(자리 3)이
 * 위로 잘리므로 62보다 멀어진다.
 * 휠로 물러날 수 있는 최대 거리는 max(80, 이 값 + 18)로 쓴다.
 */
export function overviewDistance(positions = [], options) {
  return Math.max(BASE_OVERVIEW, overviewFit(positions, options) * OVERVIEW_SAFETY);
}
