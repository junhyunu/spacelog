import { describe, expect, test, vi } from 'vitest';
import { createEscapeStack } from '../ui/escape.js';
import {
  canSubmitPlanet,
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
  test('planetSaveError', () => {
    expect(planetSaveError({ status: 400, code: 'invalid_name' })).toBe('이름은 1~20자로 써 주세요');
    expect(planetSaveError({ status: 400, code: 'invalid_description' })).toBe('한 줄 설명은 20자까지 쓸 수 있어요');
    expect(planetSaveError({ status: 0, code: 'offline' })).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(planetSaveError(undefined)).toBe('저장하지 못했어요. 다시 눌러 주세요');
  });
  test('planetSavedToast', () => {
    expect(planetSavedToast({ created: true, name: '공부' })).toBe("행성 '공부'을(를) 만들었어요");
    expect(planetSavedToast({ created: false, name: '공부' })).toBe('행성을 꾸몄어요');
  });
  test('mergeDesc', () => {
    expect(mergeDesc(1500, '여행')).toBe("별 1,500개가 '여행'(으)로 옮겨가고 이 행성은 사라져요. 되돌릴 수 없어요.");
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
    expect(thumbKind({ type: 'image', has_thumb: true })).toBe('thumb');
  });
  test('image without a thumbnail → image icon', () => {
    expect(thumbKind({ type: 'image', has_thumb: false })).toBe('image');
  });
  test('other types → their icon', () => {
    expect(thumbKind({ type: 'link' })).toBe('link');
    expect(thumbKind({ type: 'file', has_thumb: true })).toBe('file-text');
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
