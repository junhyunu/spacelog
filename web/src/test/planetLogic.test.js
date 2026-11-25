import { describe, expect, test, vi } from 'vitest';
import { createEscapeStack } from '../ui/escape.js';
import {
  canSubmitPlanet,
  cleanText,
  counterText,
  deleteErrorText,
  deleteFailure,
  detailKey,
  mergeErrorText,
  mergeFailure,
  planetFieldError,
  planetGone,
  textLength,
  deleteMode,
  deleteRequest,
  deleteTitle,
  deleteToast,
  deleteWarning,
  mergeDesc,
  moveIndex,
  moveLabel,
  panelStars,
  planetSaveError,
  planetSavedToast,
  removeLabel,
  thumbKind,
} from '../ui/planetLogic.js';

describe('deleteMode', () => {
  test('no stars → empty, whatever else exists', () => {
    expect(deleteMode({ countTotal: 0, otherCount: 0 })).toBe('empty');
    expect(deleteMode({ countTotal: 0, otherCount: 3 })).toBe('empty');
  });
  test('stars and another planet → choose', () => {
    expect(deleteMode({ countTotal: 2, otherCount: 1 })).toBe('choose');
  });
  test('stars and no other planet → only', () => {
    expect(deleteMode({ countTotal: 2, otherCount: 0 })).toBe('only');
  });
  test('missing or odd values count as zero', () => {
    expect(deleteMode({})).toBe('empty');
    expect(deleteMode({ countTotal: '3', otherCount: undefined })).toBe('only');
  });
});

describe('delete copy', () => {
  test('title', () => {
    expect(deleteTitle('공부')).toBe("행성 '공부'을(를) 지울까요?");
  });
  test('warning formats the count', () => {
    expect(deleteWarning(3)).toBe('별 3개의 기록과 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.');
    expect(deleteWarning(1234)).toBe('별 1,234개의 기록과 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.');
  });
  test('radio labels', () => {
    expect(moveLabel(1234)).toBe('별 1,234개를 다른 행성으로 옮기고 지우기');
    expect(removeLabel(2)).toBe('별 2개도 함께 지우기');
  });
  test('toast: deleted', () => {
    expect(deleteToast({ name: '공부', choice: 'delete', count: 4 })).toBe("행성 '공부'을(를) 지웠어요");
    expect(deleteToast({ name: '공부', choice: 'empty', count: 0 })).toBe("행성 '공부'을(를) 지웠어요");
  });
  test('toast: moved', () => {
    expect(deleteToast({ name: '공부', choice: 'move', count: 1200, intoName: '여행' })).toBe("별 1,200개를 '여행'(으)로 옮기고 지웠어요");
  });
});

describe('deleteRequest', () => {
  test('empty planet sends no options', () => {
    expect(deleteRequest({ mode: 'empty' })).toEqual({});
  });
  test('only planet with stars deletes them', () => {
    expect(deleteRequest({ mode: 'only' })).toEqual({ stars: 'delete' });
  });
  test('choose: move needs a target', () => {
    expect(deleteRequest({ mode: 'choose', choice: 'move', into: 'b' })).toEqual({ stars: 'move', into: 'b' });
    expect(deleteRequest({ mode: 'choose', choice: 'move', into: '' })).toBeNull();
  });
  test('choose: delete', () => {
    expect(deleteRequest({ mode: 'choose', choice: 'delete', into: 'b' })).toEqual({ stars: 'delete' });
  });
});

describe('planet form', () => {
  test('canSubmitPlanet: name must have something after trim', () => {
    expect(canSubmitPlanet({ name: '' })).toBe(false);
    expect(canSubmitPlanet({ name: '   ' })).toBe(false);
    expect(canSubmitPlanet({})).toBe(false);
    expect(canSubmitPlanet({ name: ' 공부 ' })).toBe(true);
  });
  test('canSubmitPlanet: at most 20 characters', () => {
    expect(canSubmitPlanet({ name: '가'.repeat(20) })).toBe(true);
    expect(canSubmitPlanet({ name: '가'.repeat(21) })).toBe(false);
  });
  test('canSubmitPlanet: description at most 20 characters', () => {
    expect(canSubmitPlanet({ name: '공부', description: '가'.repeat(20) })).toBe(true);
    expect(canSubmitPlanet({ name: '공부', description: '가'.repeat(21) })).toBe(false);
  });
  test('counts like the server: an emoji is one character', () => {
    expect('🚀'.repeat(20).length).toBe(40);
    expect(textLength('🚀'.repeat(20))).toBe(20);
    expect(canSubmitPlanet({ name: '🚀'.repeat(20) })).toBe(true);
    expect(canSubmitPlanet({ name: '🚀'.repeat(21) })).toBe(false);
    expect(counterText('🚀🚀')).toBe('2/20');
  });
  test('counts like the server: decomposed Hangul is composed first', () => {
    const nfd = '행성'.normalize('NFD');
    expect(nfd.length).toBe(6);
    expect(textLength(nfd)).toBe(2);
    expect(cleanText(nfd)).toBe('행성');
    expect(canSubmitPlanet({ name: '가'.repeat(20).normalize('NFD') })).toBe(true);
  });
  test('a name of only invisible characters is empty', () => {
    expect(cleanText('​‌‍⁠﻿')).toBe('');
    expect(canSubmitPlanet({ name: '​​' })).toBe(false);
    expect(canSubmitPlanet({ name: ' ​\t ' })).toBe(false);
    expect(textLength('공​부\n')).toBe(2);
    expect(counterText(' ​ ')).toBe('0/20');
  });
  test('planetFieldError: only when over the limit', () => {
    expect(planetFieldError({ name: '', description: '' })).toBe('');
    expect(planetFieldError({ name: '가'.repeat(21) })).toBe('이름은 20자까지 쓸 수 있어요');
    expect(planetFieldError({ name: '공부', description: '가'.repeat(21) })).toBe('설명은 20자까지 쓸 수 있어요');
  });
  test('planetSaveError', () => {
    expect(planetSaveError({ status: 400, code: 'invalid_name' })).toBe('이름은 1~20자로 써 주세요');
    expect(planetSaveError({ status: 400, code: 'invalid_description' })).toBe('설명은 20자까지 쓸 수 있어요');
    expect(planetSaveError({ status: 400, code: 'invalid_look' })).toBe('색이나 장식을 다시 골라 주세요');
    expect(planetSaveError({ status: 0, code: 'offline' })).toBe('서버와 연결이 끊겨서 저장하지 못했어요');
    expect(planetSaveError({ status: 500, code: 'internal' })).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(planetSaveError(undefined)).toBe('저장하지 못했어요. 다시 눌러 주세요');
  });
  test('planetGone: a 404 while editing', () => {
    expect(planetGone({ status: 404, code: 'not_found' }, true)).toBe(true);
    expect(planetGone({ status: 404, code: 'not_found' }, false)).toBe(false);
    expect(planetGone({ status: 400, code: 'invalid_name' }, true)).toBe(false);
  });
  test('planetSavedToast', () => {
    expect(planetSavedToast({ created: true, name: '공부' })).toBe("행성 '공부'을(를) 만들었어요");
    expect(planetSavedToast({ created: false, name: '공부' })).toBe('행성을 꾸몄어요');
  });
  test('mergeDesc', () => {
    expect(mergeDesc(1500, '여행')).toBe("별 1,500개가 '여행'(으)로 옮겨가고 이 행성은 사라져요. 되돌릴 수 없어요.");
  });
});

describe('stale delete and merge', () => {
  test('deleteFailure', () => {
    expect(deleteFailure({ status: 404, code: 'not_found' })).toBe('gone');
    expect(deleteFailure({ status: 409, code: 'not_empty' })).toBe('stale');
    expect(deleteFailure({ status: 400, code: 'invalid_target' })).toBe('stale');
    expect(deleteFailure({ status: 0, code: 'offline' })).toBe('offline');
    expect(deleteFailure({ status: 500, code: 'internal' })).toBe('error');
    expect(deleteFailure(undefined)).toBe('error');
  });
  test('deleteErrorText', () => {
    expect(deleteErrorText('offline')).toBe('서버와 연결이 끊겨서 지우지 못했어요');
    expect(deleteErrorText('error')).toBe('지우지 못했어요. 다시 눌러 주세요');
  });
  test('mergeFailure', () => {
    expect(mergeFailure({ status: 404, code: 'not_found' })).toBe('stale');
    expect(mergeFailure({ status: 400, code: 'invalid_target' })).toBe('stale');
    expect(mergeFailure({ status: 0, code: 'offline' })).toBe('offline');
    expect(mergeFailure({ status: 500, code: 'internal' })).toBe('error');
  });
  test('mergeErrorText', () => {
    expect(mergeErrorText('stale')).toBe('그사이 내용이 바뀌었어요. 다시 확인해 주세요');
    expect(mergeErrorText('offline')).toBe('서버와 연결이 끊겨서 합치지 못했어요');
    expect(mergeErrorText('error')).toBe('합치지 못했어요. 다시 눌러 주세요');
  });
});

describe('detailKey', () => {
  const planets = [
    { id: 'p1', name: '공부', color_index: 1 },
    { id: 'p2', name: '여행', color_index: 2 },
  ];
  const star = { id: 's1', planet_id: 'p1', title: '제목', memo: '처음' };
  test('a memo change alone does not change the key', () => {
    expect(detailKey({ ...star, memo: '고친 메모' }, planets)).toBe(detailKey(star, planets));
  });
  // 메모 칸이 본문을 고친다: 쓰는 중에 저장돼도 상세를 다시 그리지 않는다(쓰던 글 · 한글 조합을 지킨다)
  test('a body text change alone does not change the key', () => {
    expect(detailKey({ ...star, body: '고친 글' }, planets)).toBe(detailKey({ ...star, body: '처음 글' }, planets));
  });
  test('a body appearing or disappearing does (the 종류 label changes)', () => {
    expect(detailKey({ ...star, body: '글' }, planets)).not.toBe(detailKey({ ...star, body: null }, planets));
    expect(detailKey({ ...star, body: '  ' }, planets)).toBe(detailKey({ ...star, body: null }, planets));
    expect(detailKey({ ...star, body: '' }, planets)).toBe(detailKey(star, planets));
  });
  test('a title change does', () => {
    expect(detailKey({ ...star, title: '새 제목' }, planets)).not.toBe(detailKey(star, planets));
  });
  test('renaming or recolouring any planet does, with the same count', () => {
    const renamed = [planets[0], { ...planets[1], name: '휴가' }];
    const recoloured = [{ ...planets[0], color_index: 5 }, planets[1]];
    expect(detailKey(star, renamed)).not.toBe(detailKey(star, planets));
    expect(detailKey(star, recoloured)).not.toBe(detailKey(star, planets));
  });
  test('no star or planets', () => {
    expect(() => detailKey(null, undefined)).not.toThrow();
  });
});

describe('moveIndex (roving focus)', () => {
  test('left and right wrap around', () => {
    expect(moveIndex(0, 'ArrowRight', 16, 8)).toBe(1);
    expect(moveIndex(15, 'ArrowRight', 16, 8)).toBe(0);
    expect(moveIndex(0, 'ArrowLeft', 16, 8)).toBe(15);
  });
  test('up and down move by a row and stay put at the edge', () => {
    expect(moveIndex(2, 'ArrowDown', 16, 8)).toBe(10);
    expect(moveIndex(10, 'ArrowUp', 16, 8)).toBe(2);
    expect(moveIndex(10, 'ArrowDown', 16, 8)).toBe(10);
    expect(moveIndex(2, 'ArrowUp', 16, 8)).toBe(2);
  });
  test('without columns up/down act like left/right', () => {
    expect(moveIndex(3, 'ArrowDown', 10)).toBe(4);
    expect(moveIndex(0, 'ArrowUp', 10)).toBe(9);
  });
  test('Home and End', () => {
    expect(moveIndex(5, 'Home', 10)).toBe(0);
    expect(moveIndex(5, 'End', 10)).toBe(9);
  });
  test('other keys → null', () => {
    expect(moveIndex(5, 'Tab', 10)).toBeNull();
    expect(moveIndex(5, 'a', 10)).toBeNull();
  });
});

describe('thumbKind', () => {
  test('image with a thumbnail → thumb', () => {
    expect(thumbKind({ type: 'image', thumb_attachment_id: 'a1' })).toBe('thumb');
    // 글 · 파일이 먼저여도 이미지 첨부의 축소본이 있으면 그것을 쓴다
    expect(thumbKind({ type: 'file', thumb_attachment_id: 'a2' })).toBe('thumb');
  });
  test('image without a thumbnail → image icon', () => {
    expect(thumbKind({ type: 'image', thumb_attachment_id: null })).toBe('image');
  });
  test('other types → their icon', () => {
    expect(thumbKind({ type: 'link' })).toBe('link');
    expect(thumbKind({ type: 'file', thumb_attachment_id: null })).toBe('file-text');
    expect(thumbKind({ type: 'text' })).toBe('type');
    expect(thumbKind({})).toBe('type');
    expect(thumbKind(null)).toBe('type');
  });
});

describe('panelStars', () => {
  const stars = [
    { id: 'a', planet_id: 'p1', created_at: '2026-11-10T03:00:00.000Z' },
    { id: 'b', planet_id: 'p2', created_at: '2026-11-11T03:00:00.000Z' },
    { id: 'c', planet_id: 'p1', created_at: '2026-11-12T03:00:00.000Z' },
    { id: 'd', planet_id: 'p1', created_at: '2026-11-01T03:00:00.000Z' },
  ];
  test('only that planet, newest first', () => {
    expect(panelStars(stars, 'p1').map((s) => s.id)).toEqual(['c', 'a', 'd']);
  });
  test('ids compare as strings', () => {
    expect(panelStars([{ id: 1, planet_id: 7, created_at: '2026-11-10T03:00:00.000Z' }], '7')).toHaveLength(1);
  });
  test('range: from inclusive, to exclusive', () => {
    const range = { from: '2026-11-10T03:00:00.000Z', to: '2026-11-12T03:00:00.000Z' };
    expect(panelStars(stars, 'p1', range).map((s) => s.id)).toEqual(['a']);
  });
  test('does not change the list it was given', () => {
    const copy = stars.map((s) => s.id);
    panelStars(stars, 'p1');
    expect(stars.map((s) => s.id)).toEqual(copy);
  });
  test('nothing to show', () => {
    expect(panelStars(undefined, 'p1')).toEqual([]);
    expect(panelStars(stars, null)).toEqual([]);
  });
});

describe('escape stack', () => {
  test('highest priority first, first true consumes', () => {
    const stack = createEscapeStack();
    const calls = [];
    stack.register(20, () => (calls.push('panel'), true));
    stack.register(70, () => (calls.push('form'), false));
    stack.register(30, () => (calls.push('detail'), true));
    expect(stack.run()).toBe(true);
    expect(calls).toEqual(['form', 'detail']);
  });
  test('nothing consumes → false', () => {
    const stack = createEscapeStack();
    stack.register(20, () => false);
    expect(stack.run()).toBe(false);
  });
  test('unregister', () => {
    const stack = createEscapeStack();
    const fn = vi.fn(() => true);
    const off = stack.register(20, fn);
    off();
    expect(stack.run()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  test('an open confirm dialog owns the key', () => {
    const stack = createEscapeStack();
    const fn = vi.fn(() => true);
    stack.register(70, fn);
    stack.setGuards({ isAskOpen: () => true });
    expect(stack.run()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  test('during a transition only the dialogs above it run', () => {
    const stack = createEscapeStack();
    const low = vi.fn(() => true);
    const high = vi.fn(() => false);
    stack.register(30, low);
    stack.register(60, high);
    stack.setGuards({ isTransitioning: () => true });
    expect(stack.run()).toBe(false);
    expect(high).toHaveBeenCalled();
    expect(low).not.toHaveBeenCalled();
  });
  test('a throwing handler does not block the rest', () => {
    const stack = createEscapeStack();
    stack.register(70, () => {
      throw new Error('x');
    });
    stack.register(20, () => true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(stack.run()).toBe(true);
    spy.mockRestore();
  });
});
