// 캐릭터 꾸미기(스펙 6-10)의 순수 함수(DOM · three 없음). 3D(three/character.js)와 꾸미기 창(characterForm.js)이 함께 쓴다.
import { PLANET_COLORS } from '../util.js';

export const CHARACTER_KINDS = Object.freeze(['astronaut', 'robot', 'cat', 'alien', 'bear', 'human']);
export const KIND_NAMES = Object.freeze({
  astronaut: '우주인',
  robot: '로봇',
  cat: '고양이',
  alien: '외계인',
  bear: '곰돌이',
  human: '사람',
});

/** 불꽃 색: 바깥 · 안쪽 두 톤. */
export const FLAMES = Object.freeze({
  orange: Object.freeze({ name: '주황', outer: '#ff8a2a', inner: '#fff1a0' }),
  blue: Object.freeze({ name: '파랑', outer: '#4f8dff', inner: '#d6f0ff' }),
  green: Object.freeze({ name: '초록', outer: '#5fd35f', inner: '#eaffb0' }),
  pink: Object.freeze({ name: '핑크', outer: '#ff6fb5', inner: '#ffe0f0' }),
});
export const FLAME_IDS = Object.freeze(Object.keys(FLAMES));

/** 몸 색 · 포인트 색의 고르기: 0 = 기본, 1~16 = 행성 색. */
export const COLOR_IDS = Object.freeze([0, ...Object.keys(PLANET_COLORS).map(Number)]);
const COLOR_MAX = COLOR_IDS.length - 1;
const BASE = Object.freeze({ suit: '#f3f1ff', accent: '#ff5d8f' });

/** 기본값 = 지금까지의 모습(우주인, 흰 슈트, 핑크 포인트, 주황 불꽃). */
export const DEFAULT_LOOK = Object.freeze({ kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' });

const kindOk = (v) => typeof v === 'string' && CHARACTER_KINDS.includes(v);
const flameOk = (v) => typeof v === 'string' && FLAME_IDS.includes(v);
const colorOk = (v) => Number.isInteger(v) && v >= 0 && v <= COLOR_MAX;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 서버(server/character.js)와 같은 검사. */
export function isValidLook(look) {
  return isObject(look) && kindOk(look.kind) && colorOk(look.suit) && colorOk(look.accent) && flameOk(look.flame);
}

/** 네 칸만 담은 새 객체. 틀린 칸은 그 칸만 기본값으로 바꾼다. */
export function normalizeLook(look) {
  const o = isObject(look) ? look : {};
  return {
    kind: kindOk(o.kind) ? o.kind : DEFAULT_LOOK.kind,
    suit: colorOk(o.suit) ? o.suit : DEFAULT_LOOK.suit,
    accent: colorOk(o.accent) ? o.accent : DEFAULT_LOOK.accent,
    flame: flameOk(o.flame) ? o.flame : DEFAULT_LOOK.flame,
  };
}

/** 색 원 하나의 색. slot은 'suit' | 'accent'. 0이면 그 자리의 기본색. */
export function swatchColor(slot, index) {
  if (colorOk(index) && index > 0) return PLANET_COLORS[index].face;
  return slot === 'accent' ? BASE.accent : BASE.suit;
}

/** 색 원의 이름(aria-label). */
export const colorLabel = (index) => (colorOk(index) && index > 0 ? PLANET_COLORS[index].name : '기본');

/** 고른 모습을 3D가 쓸 색으로 푼다. → { suit, accent, flameOuter, flameInner } ('#rrggbb') */
export function resolveLook(look) {
  const l = normalizeLook(look);
  const flame = FLAMES[l.flame];
  return {
    suit: swatchColor('suit', l.suit),
    accent: swatchColor('accent', l.accent),
    flameOuter: flame.outer,
    flameInner: flame.inner,
  };
}

export function sameLook(a, b) {
  return isObject(a) && isObject(b) && a.kind === b.kind && a.suit === b.suit && a.accent === b.accent && a.flame === b.flame;
}

/** 저장 실패 때 창 안에 보일 글. */
export function characterSaveError(err) {
  if (err?.code === 'offline') return '서버와 연결이 끊겨서 저장하지 못했어요';
  return '저장하지 못했어요. 다시 눌러 주세요';
}

export const CHARACTER_SAVED_TOAST = '캐릭터를 꾸몄어요';
