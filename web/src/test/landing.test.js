import { describe, expect, test } from 'vitest';
import { LANDING_CHARS, LANDING_PLANETS, nextLandingId } from '../ui/landing.js';

describe('nextLandingId (로그인 전 첫 화면에서 누르면 바뀌는 다음 것)', () => {
  test('planet: the next topic, skipping ones already on screen', () => {
    const ids = Object.keys(LANDING_PLANETS);
    expect(nextLandingId('planet', ids[0], new Set([ids[0]]))).toBe(ids[1]);
    expect(nextLandingId('planet', ids[0], new Set([ids[0], ids[1], ids[2]]))).toBe(ids[3]);
    // 끝에서는 처음으로 돈다
    expect(nextLandingId('planet', ids.at(-1), new Set([ids.at(-1)]))).toBe(ids[0]);
  });

  test('char: jumps to a different kind (3 steps), never the same one', () => {
    const next = nextLandingId('char', 'astronaut-0', new Set(['astronaut-0', 'human-0']));
    expect(LANDING_CHARS).toContain(next);
    expect(next.split('-')[0]).not.toBe('astronaut');
    expect(next).not.toBe('human-0');
  });

  test('every topic and character has its picture', () => {
    expect(Object.keys(LANDING_PLANETS)).toHaveLength(10);
    expect(LANDING_CHARS).toHaveLength(12);
  });
});
