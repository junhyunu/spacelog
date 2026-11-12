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

test('overviewDistance is 62 for the first ten, grows beyond', () => {
  expect(overviewDistance([...Array(10)].map((_, i) => slotPosition(i)))).toBe(62);
  expect(overviewDistance([slotPosition(10)])).toBeGreaterThan(62);
});

test('overviewDistance keeps growing with each outer ring', () => {
  const d1 = overviewDistance([slotPosition(10)]);
  const d2 = overviewDistance([slotPosition(18)]);
  expect(d2).toBeGreaterThan(d1);
});

test('overviewDistance of no planets is 62', () => {
  expect(overviewDistance([])).toBe(62);
  expect(overviewDistance()).toBe(62);
});
