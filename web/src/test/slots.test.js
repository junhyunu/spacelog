import { expect, test } from 'vitest';
import { overviewDistance, slotPosition } from '../three/slots.js';

test('first four slots are the prototype sample positions', () => {
  expect(slotPosition(0)).toEqual([0, 0, -34]);
  expect(slotPosition(1)).toEqual([36, 7, -10]);
  expect(slotPosition(2)).toEqual([-34, -5, -8]);
  expect(slotPosition(3)).toEqual([-6, 11, 26]);
});

test('slots 4-9 are the prototype SLOTS', () => {
  expect(slotPosition(4)).toEqual([30, -10, 28]);
  expect(slotPosition(5)).toEqual([-38, 12, -36]);
  expect(slotPosition(6)).toEqual([16, 16, -52]);
  expect(slotPosition(7)).toEqual([-30, -14, 30]);
  expect(slotPosition(8)).toEqual([48, -4, -38]);
  expect(slotPosition(9)).toEqual([4, -18, 6]);
});

test('slot 10+ sits on a ring of radius 80 around (0,2,-6)', () => {
  for (let n = 10; n < 18; n++) {
    const [x, y, z] = slotPosition(n);
    expect(Math.hypot(x, z + 6)).toBeCloseTo(80, 5);
    expect(y).toBe(2 + ((n - 10) % 2 ? 8 : -8));
  }
});

test('second ring is radius 108', () => {
  const [x, , z] = slotPosition(18);
  expect(Math.hypot(x, z + 6)).toBeCloseTo(108, 5);
});

test('second ring is turned by pi/8 against the first', () => {
  const [x0, , z0] = slotPosition(10);
  const [x1, , z1] = slotPosition(18);
  const turn = Math.atan2(z1 + 6, x1) - Math.atan2(z0 + 6, x0);
  expect(turn).toBeCloseTo(Math.PI / 8, 5);
});

test('no two of the first 40 slots are closer than 14', () => {
  const all = [...Array(40)].map((_, i) => slotPosition(i));
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      const d = Math.hypot(all[a][0] - all[b][0], all[a][1] - all[b][1], all[a][2] - all[b][2]);
      expect(d, `slot ${a} vs ${b}`).toBeGreaterThanOrEqual(14);
    }
  }
});

test('slotPosition returns a fresh array each time', () => {
  const a = slotPosition(0);
  a[0] = 999;
  expect(slotPosition(0)).toEqual([0, 0, -34]);
});

test('slotPosition tolerates a missing or broken slot', () => {
  expect(slotPosition(undefined)).toEqual([0, 0, -34]);
  expect(slotPosition(-3)).toEqual([0, 0, -34]);
  expect(slotPosition(4.9)).toEqual([30, -10, 28]);
});

/* ---------- overviewDistance: every planet inside the view frustum ---------- */

const COUNTS = [1, 4, 10, 12, 18, 30];
const ASPECTS = [16 / 9, 4 / 3, 1, 9 / 16];
const MARGIN = 9;
const FOV = 58;
const slots = (n) => [...Array(n)].map((_, i) => slotPosition(i));

// Independent check (angles, not plane distances): the camera orbits (0,2,-6) the way
// controls.js does, and a sphere is inside a pair of side planes when the angle to its
// centre plus its angular radius stays within the half field of view.
function outside(positions, distance, { aspect, fovDeg = FOV, pitch = 0.5, yaw = 0, margin = MARGIN }) {
  const center = [0, 2, -6];
  const cp = Math.cos(pitch);
  const cam = [
    center[0] + Math.sin(yaw) * cp * distance,
    center[1] + Math.sin(pitch) * distance,
    center[2] + Math.cos(yaw) * cp * distance,
  ];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((v) => v / Math.hypot(...a));
  const fwd = unit(sub(center, cam));
  const right = unit(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const out = [];
  positions.forEach((p, i) => {
    const rel = sub(p, cam);
    const depth = dot(rel, fwd);
    const fits = (side, half) => {
      const reach = Math.hypot(side, depth);
      if (depth <= 0 || reach <= margin) return false;
      return Math.atan2(Math.abs(side), depth) + Math.asin(margin / reach) <= half + 1e-9;
    };
    if (!fits(dot(rel, right), halfH) || !fits(dot(rel, up), halfV)) out.push(i);
  });
  return out;
}

test('overviewDistance of no planets is 62', () => {
  expect(overviewDistance([])).toBe(62);
  expect(overviewDistance()).toBe(62);
  expect(overviewDistance([], { aspect: 9 / 16 })).toBe(62);
});

test('overviewDistance never goes below 62', () => {
  expect(overviewDistance([[0, 2, -6]])).toBe(62);
});

// The prototype's 62 does not hold its own four sample planets with margin 9: slot 3
// (close to the camera, high up) is cut at the top. So the fit decides, not 62.
test('the four prototype planets need a little more than 62 on a 16:9 screen', () => {
  expect(outside(slots(4), 62, { aspect: 16 / 9 })).toEqual([3]);
  const d = overviewDistance(slots(4));
  expect(d).toBeGreaterThan(62);
  expect(d).toBeLessThan(70);
  expect(outside(slots(4), d, { aspect: 16 / 9 })).toEqual([]);
});

test('planets that fit at 62 keep the prototype distance', () => {
  expect(overviewDistance(slots(3))).toBe(62);
});

for (const n of COUNTS) {
  for (const aspect of ASPECTS) {
    test(`every planet is inside the view: ${n} planets, aspect ${aspect.toFixed(2)}`, () => {
      const positions = slots(n);
      const d = overviewDistance(positions, { aspect });
      expect(d).toBeGreaterThanOrEqual(62);
      expect(outside(positions, d, { aspect })).toEqual([]);
    });

    test(`distance is not wastefully large: ${n} planets, aspect ${aspect.toFixed(2)}`, () => {
      const positions = slots(n);
      const d = overviewDistance(positions, { aspect });
      if (d > 62) expect(outside(positions, d * 0.9, { aspect }).length).toBeGreaterThan(0);
    });
  }
}

test('overviewDistance defaults to a 16:9 screen, 58° fov, pitch 0.5, yaw 0, margin 9', () => {
  const positions = slots(12);
  expect(overviewDistance(positions)).toBe(
    overviewDistance(positions, { aspect: 16 / 9, fovDeg: 58, pitch: 0.5, yaw: 0, margin: 9 }),
  );
});

test('overviewDistance follows the given yaw, pitch and fov', () => {
  const positions = slots(12);
  for (const opts of [
    { aspect: 16 / 9, yaw: 1.2, pitch: 0.9 },
    { aspect: 4 / 3, yaw: -2.5, pitch: -0.4 },
    { aspect: 1, fovDeg: 40 },
  ]) {
    const d = overviewDistance(positions, opts);
    expect(outside(positions, d, opts)).toEqual([]);
    expect(outside(positions, d * 0.9, opts).length).toBeGreaterThan(0);
  }
});

test('adding planets never brings the camera closer', () => {
  for (const aspect of ASPECTS) {
    let prev = 62;
    for (let n = 0; n <= 40; n++) {
      const d = overviewDistance(slots(n), { aspect });
      expect(d, `${n} planets, aspect ${aspect}`).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  }
});

test('a narrower screen never brings the camera closer', () => {
  for (const n of COUNTS) {
    let prev = 0;
    for (const aspect of [21 / 9, ...ASPECTS, 0.4]) {
      const d = overviewDistance(slots(n), { aspect });
      expect(d, `${n} planets, aspect ${aspect}`).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  }
});

test('overviewDistance is deterministic', () => {
  const positions = slots(18);
  expect(overviewDistance(positions, { aspect: 4 / 3 })).toBe(overviewDistance(positions, { aspect: 4 / 3 }));
});
