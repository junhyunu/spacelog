import { describe, expect, test } from 'vitest';
import {
  CHARACTER_KINDS,
  COLOR_IDS,
  DEFAULT_LOOK,
  FLAMES,
  FLAME_IDS,
  KIND_NAMES,
  characterSaveError,
  colorLabel,
  isValidLook,
  normalizeLook,
  resolveLook,
  sameLook,
  swatchColor,
} from '../ui/characterLogic.js';
import { PLANET_COLORS } from '../util.js';

describe('tables', () => {
  test('six kinds in spec order, each with a Korean name', () => {
    expect(CHARACTER_KINDS).toEqual(['astronaut', 'robot', 'cat', 'alien', 'bear', 'human']);
    expect(CHARACTER_KINDS.map((k) => KIND_NAMES[k])).toEqual(['우주인', '로봇', '고양이', '외계인', '곰돌이', '사람']);
  });

  test('four flames with two tones each', () => {
    expect(FLAME_IDS).toEqual(['orange', 'blue', 'green', 'pink']);
    expect(FLAMES.orange).toEqual({ name: '주황', outer: '#ff8a2a', inner: '#fff1a0' });
    expect(FLAMES.blue).toEqual({ name: '파랑', outer: '#4f8dff', inner: '#d6f0ff' });
    expect(FLAMES.green).toEqual({ name: '초록', outer: '#5fd35f', inner: '#eaffb0' });
    expect(FLAMES.pink).toEqual({ name: '핑크', outer: '#ff6fb5', inner: '#ffe0f0' });
  });

  test('17 colour choices: 0 (기본) then the 16 planet colours', () => {
    expect(COLOR_IDS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  test('the default look is the current astronaut', () => {
    expect(DEFAULT_LOOK).toEqual({ kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' });
    expect(Object.isFrozen(DEFAULT_LOOK)).toBe(true);
  });
});

describe('isValidLook', () => {
  const good = { kind: 'cat', suit: 3, accent: 16, flame: 'green' };

  test('accepts every kind, flame and colour 0..16', () => {
    expect(isValidLook(good)).toBe(true);
    for (const kind of CHARACTER_KINDS) expect(isValidLook({ ...good, kind })).toBe(true);
    for (const flame of FLAME_IDS) expect(isValidLook({ ...good, flame })).toBe(true);
    for (const n of COLOR_IDS) expect(isValidLook({ ...good, suit: n, accent: n })).toBe(true);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'cat'],
    ['an array', []],
    ['unknown kind', { ...good, kind: 'dog' }],
    ['kind from the prototype', { ...good, kind: 'constructor' }],
    ['suit 17', { ...good, suit: 17 }],
    ['suit -1', { ...good, suit: -1 }],
    ['suit text', { ...good, suit: '3' }],
    ['suit fractional', { ...good, suit: 2.5 }],
    ['accent 17', { ...good, accent: 17 }],
    ['accent missing', { kind: 'cat', suit: 0, flame: 'pink' }],
    ['unknown flame', { ...good, flame: 'red' }],
    ['flame from the prototype', { ...good, flame: 'toString' }],
  ])('rejects %s', (_name, value) => {
    expect(isValidLook(value)).toBe(false);
  });
});

describe('normalizeLook', () => {
  test('a valid look comes back as a fresh four-field object', () => {
    const look = { kind: 'bear', suit: 5, accent: 9, flame: 'blue', extra: 1 };
    const out = normalizeLook(look);
    expect(out).toEqual({ kind: 'bear', suit: 5, accent: 9, flame: 'blue' });
    expect(out).not.toBe(look);
  });

  test('anything that is not an object → the default look (a copy)', () => {
    for (const v of [null, undefined, 'x', 3, [], true]) {
      const out = normalizeLook(v);
      expect(out).toEqual(DEFAULT_LOOK);
      expect(out).not.toBe(DEFAULT_LOOK);
    }
  });

  test('each bad field falls back on its own, good fields stay', () => {
    expect(normalizeLook({ kind: 'dog', suit: 4, accent: 2, flame: 'pink' })).toEqual({ kind: 'astronaut', suit: 4, accent: 2, flame: 'pink' });
    expect(normalizeLook({ kind: 'robot', suit: 99, accent: 2, flame: 'pink' })).toEqual({ kind: 'robot', suit: 0, accent: 2, flame: 'pink' });
    expect(normalizeLook({ kind: 'robot', suit: 4, accent: '2', flame: 'pink' })).toEqual({ kind: 'robot', suit: 4, accent: 0, flame: 'pink' });
    expect(normalizeLook({ kind: 'robot', suit: 4, accent: 2, flame: 'red' })).toEqual({ kind: 'robot', suit: 4, accent: 2, flame: 'orange' });
    expect(normalizeLook({})).toEqual(DEFAULT_LOOK);
  });
});

describe('resolveLook', () => {
  test('defaults: white suit, pink accent, orange flame', () => {
    expect(resolveLook(DEFAULT_LOOK)).toEqual({ suit: '#f3f1ff', accent: '#ff5d8f', flameOuter: '#ff8a2a', flameInner: '#fff1a0' });
  });

  test('1..16 take the planet colour face', () => {
    for (let n = 1; n <= 16; n++) {
      const r = resolveLook({ kind: 'cat', suit: n, accent: 17 - n, flame: 'orange' });
      expect(r.suit).toBe(PLANET_COLORS[n].face);
      expect(r.accent).toBe(PLANET_COLORS[17 - n].face);
    }
  });

  test('flame picks outer and inner', () => {
    expect(resolveLook({ ...DEFAULT_LOOK, flame: 'blue' })).toMatchObject({ flameOuter: '#4f8dff', flameInner: '#d6f0ff' });
    expect(resolveLook({ ...DEFAULT_LOOK, flame: 'green' })).toMatchObject({ flameOuter: '#5fd35f', flameInner: '#eaffb0' });
    expect(resolveLook({ ...DEFAULT_LOOK, flame: 'pink' })).toMatchObject({ flameOuter: '#ff6fb5', flameInner: '#ffe0f0' });
  });

  test('a broken look resolves like the default', () => {
    expect(resolveLook(null)).toEqual(resolveLook(DEFAULT_LOOK));
    expect(resolveLook({ kind: 'x', suit: 40, accent: -2, flame: '?' })).toEqual(resolveLook(DEFAULT_LOOK));
  });

  test('kind does not change the colours', () => {
    for (const kind of CHARACTER_KINDS) {
      expect(resolveLook({ kind, suit: 2, accent: 5, flame: 'green' })).toEqual(resolveLook({ kind: 'astronaut', suit: 2, accent: 5, flame: 'green' }));
    }
  });
});

describe('swatches', () => {
  test('swatchColor: 0 is the default of that slot, else the palette face', () => {
    expect(swatchColor('suit', 0)).toBe('#f3f1ff');
    expect(swatchColor('accent', 0)).toBe('#ff5d8f');
    expect(swatchColor('suit', 6)).toBe(PLANET_COLORS[6].face);
    expect(swatchColor('accent', 6)).toBe(PLANET_COLORS[6].face);
  });

  test('colorLabel: "기본" then the colour names', () => {
    expect(colorLabel(0)).toBe('기본');
    expect(colorLabel(1)).toBe('주황');
    expect(colorLabel(16)).toBe('코코아');
  });
});

describe('sameLook', () => {
  test('compares the four fields', () => {
    expect(sameLook(DEFAULT_LOOK, { ...DEFAULT_LOOK })).toBe(true);
    expect(sameLook(DEFAULT_LOOK, { ...DEFAULT_LOOK, suit: 1 })).toBe(false);
    expect(sameLook(DEFAULT_LOOK, { ...DEFAULT_LOOK, kind: 'cat' })).toBe(false);
    expect(sameLook(DEFAULT_LOOK, null)).toBe(false);
  });
});

describe('characterSaveError', () => {
  test('offline has its own sentence', () => {
    expect(characterSaveError({ code: 'offline', status: 0 })).toBe('서버와 연결이 끊겨서 저장하지 못했어요');
  });

  test('anything else: try again', () => {
    expect(characterSaveError({ status: 400, code: 'invalid_character' })).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(characterSaveError({ status: 500, code: 'server_error' })).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(characterSaveError(undefined)).toBe('저장하지 못했어요. 다시 눌러 주세요');
  });

  test('copy rules: no exclamation mark', () => {
    for (const s of [characterSaveError({ code: 'offline' }), characterSaveError(null)]) expect(s).not.toMatch(/!/);
  });
});
