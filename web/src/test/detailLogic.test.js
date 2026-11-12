import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  KEEPALIVE_BYTES,
  MEMO_MAX,
  MEMO_STATUS,
  actionsFor,
  createMemoLedger,
  createMemoSaver,
  deleteCopy,
  fileMeta,
  fitsKeepalive,
  flushDirty,
  focusKeyOf,
  kindLabel,
  openFailToast,
  previewKind,
  safeHttpUrl,
} from '../ui/detailLogic.js';

describe('kindLabel', () => {
  test('four kinds', () => {
    expect(kindLabel('text')).toBe('텍스트');
    expect(kindLabel('image')).toBe('이미지');
    expect(kindLabel('file')).toBe('파일');
    expect(kindLabel('link')).toBe('링크');
  });
  test('unknown kind → 미확인', () => {
    expect(kindLabel('zzz')).toBe('미확인');
    expect(kindLabel(undefined)).toBe('미확인');
    expect(kindLabel('constructor')).toBe('미확인');
  });
});

describe('fileMeta', () => {
  test('ext and size', () => {
    expect(fileMeta({ file_ext: 'PDF', file_size: 1258291 })).toEqual({ ext: 'PDF', size: '1.2MB', text: 'PDF · 1.2MB', unknown: false });
  });
  test('empty ext → 파일', () => {
    expect(fileMeta({ file_ext: '', file_size: 10 }).text).toBe('파일 · 10B');
    expect(fileMeta({ file_ext: null, file_size: 10 }).ext).toBe('파일');
  });
  test('size null → 크기 미확인, unknown', () => {
    expect(fileMeta({ file_ext: 'ZIP', file_size: null })).toEqual({ ext: 'ZIP', size: '크기 미확인', text: 'ZIP · 크기 미확인', unknown: true });
    expect(fileMeta({}).unknown).toBe(true);
  });
  test('0 bytes is known', () => {
    expect(fileMeta({ file_ext: 'TXT', file_size: 0 })).toMatchObject({ size: '0B', unknown: false });
  });
});

describe('previewKind', () => {
  test('by type', () => {
    expect(previewKind({ type: 'image' })).toBe('image');
    expect(previewKind({ type: 'file' })).toBe('file');
    expect(previewKind({ type: 'link' })).toBe('link');
    expect(previewKind({ type: 'text' })).toBe('text');
  });
  test('unknown type falls back to text', () => {
    expect(previewKind({ type: 'x' })).toBe('text');
    expect(previewKind(null)).toBe('text');
  });
});

describe('safeHttpUrl', () => {
  test('http and https pass', () => {
    expect(safeHttpUrl('https://a.com/x?y=1')).toBe('https://a.com/x?y=1');
    expect(safeHttpUrl(' HTTP://a.com ')).toBe('http://a.com/');
  });
  test('other schemes and junk → null', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('  javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(safeHttpUrl('file:///c:/x')).toBeNull();
    expect(safeHttpUrl('naver.com')).toBeNull();
    expect(safeHttpUrl('https://')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(12)).toBeNull();
  });
  test('control characters inside the scheme do not sneak through', () => {
    expect(safeHttpUrl('java\tscript:alert(1)')).toBeNull();
    expect(safeHttpUrl('\u0001javascript:alert(1)')).toBeNull();
  });
});

describe('actionsFor', () => {
  test('text: none', () => {
    expect(actionsFor({ type: 'text' })).toEqual({ open: null, reveal: false });
  });
  test('link: new tab only, and only for http(s)', () => {
    expect(actionsFor({ type: 'link', url: 'https://a.com' })).toEqual({ open: 'tab', reveal: false });
    expect(actionsFor({ type: 'link', url: 'javascript:alert(1)' })).toEqual({ open: null, reveal: false });
    expect(actionsFor({ type: 'link', url: null })).toEqual({ open: null, reveal: false });
  });
  test('image and file: server open + reveal', () => {
    expect(actionsFor({ type: 'image' })).toEqual({ open: 'server', reveal: true });
    expect(actionsFor({ type: 'file' })).toEqual({ open: 'server', reveal: true });
  });
});

describe('deleteCopy', () => {
  test('file and image mention the vault copy', () => {
    for (const type of ['file', 'image']) {
      expect(deleteCopy({ type, title: '과제' })).toEqual({
        title: "별 '과제'을(를) 지울까요?",
        desc: '기록과 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.',
        confirmLabel: '지우기',
        confirmKind: 'pink',
      });
    }
  });
  test('text and link have no copy to mention', () => {
    for (const type of ['text', 'link']) {
      expect(deleteCopy({ type, title: '메모' }).desc).toBe('기록이 지워져요. 되돌릴 수 없어요.');
    }
  });
  test('empty title', () => {
    expect(deleteCopy({ type: 'text', title: '' }).title).toBe("별 '제목 없음'을(를) 지울까요?");
  });
});

describe('openFailToast', () => {
  test('missing file', () => {
    expect(openFailToast({ status: 404, code: 'file_missing' })).toBe('파일을 찾지 못했어요');
    expect(openFailToast({ status: 404, code: 'not_found' })).toBe('파일을 찾지 못했어요');
    expect(openFailToast({ status: 400, code: 'no_file' })).toBe('파일을 찾지 못했어요');
  });
  test('open failed', () => {
    expect(openFailToast({ status: 500, code: 'open_failed' })).toBe('열지 못했어요. 폴더에서 직접 열어 주세요');
  });
  test('reveal failed', () => {
    expect(openFailToast({ status: 500, code: 'open_failed' }, 'reveal')).toBe('폴더를 열지 못했어요. 다시 눌러 주세요');
    expect(openFailToast({ status: 404, code: 'file_missing' }, 'reveal')).toBe('파일을 찾지 못했어요');
  });
  test('anything else (offline …)', () => {
    expect(openFailToast({ status: 0, code: 'offline' })).toBe('열지 못했어요. 다시 눌러 주세요');
    expect(openFailToast(undefined)).toBe('열지 못했어요. 다시 눌러 주세요');
  });
});

describe('keepalive', () => {
  const bytes = (memo) => new TextEncoder().encode(JSON.stringify({ memo })).length;
  test('a full-length Korean memo still fits', () => {
    const size = bytes('가'.repeat(MEMO_MAX));
    expect(size).toBe(60011);
    expect(fitsKeepalive(size)).toBe(true);
  });
  test('stays under the 64KiB browser cap', () => {
    expect(KEEPALIVE_BYTES).toBe(64000);
    expect(KEEPALIVE_BYTES).toBeLessThan(64 * 1024);
    expect(fitsKeepalive(64000)).toBe(true);
    expect(fitsKeepalive(64001)).toBe(false);
    expect(fitsKeepalive(bytes('😀'.repeat(MEMO_MAX)))).toBe(false); // 80,011바이트
  });
});

describe('createMemoLedger', () => {
  test('no local save: the server memo is used', () => {
    const ledger = createMemoLedger();
    expect(ledger.resolve('s1', '서버')).toBe('서버');
    expect(ledger.has('s1')).toBe(false);
  });
  test('a reload that was already on its way brings an older memo: the local one wins', () => {
    const ledger = createMemoLedger();
    ledger.record('s1', '새 메모');
    expect(ledger.resolve('s1', '새 메모')).toBe('새 메모');
    ledger.synced(); // 저장보다 먼저 떠난 다시 받기가 도착했다
    expect(ledger.resolve('s1', '옛 메모')).toBe('새 메모');
    expect(ledger.resolve(1, '옛 메모')).toBe('옛 메모'); // 다른 별
  });
  test('from the second sync after the save the server is trusted again', () => {
    const ledger = createMemoLedger();
    ledger.record('s1', '새 메모');
    ledger.synced();
    ledger.synced(); // 저장 뒤에 떠난 다시 받기
    expect(ledger.has('s1')).toBe(false);
    expect(ledger.resolve('s1', '다른 창에서 고친 메모')).toBe('다른 창에서 고친 메모');
  });
  test('a newer save replaces the older one and restarts the count', () => {
    const ledger = createMemoLedger();
    ledger.record('s1', 'a');
    ledger.synced();
    ledger.record('s1', 'ab');
    ledger.synced();
    expect(ledger.resolve('s1', 'a')).toBe('ab');
    ledger.synced();
    expect(ledger.resolve('s1', 'a')).toBe('a');
  });
  test('ids are compared as strings; forget drops one star', () => {
    const ledger = createMemoLedger();
    ledger.record(7, '메모');
    ledger.synced();
    expect(ledger.resolve('7', '')).toBe('메모');
    ledger.forget('7');
    expect(ledger.resolve(7, '')).toBe('');
  });
  test('apply patches the stars in place and reports whether anything changed', () => {
    const ledger = createMemoLedger();
    ledger.record('s1', '새 메모');
    ledger.synced();
    const stars = [
      { id: 's1', memo: '옛 메모' },
      { id: 's2', memo: '그대로' },
    ];
    expect(ledger.apply(stars)).toBe(true);
    expect(stars).toEqual([
      { id: 's1', memo: '새 메모' },
      { id: 's2', memo: '그대로' },
    ]);
    expect(ledger.apply(stars)).toBe(false);
  });
});

describe('focusKeyOf', () => {
  const el = (dataset, extra = {}) => ({ dataset, id: '', ...extra });
  test('data-d, data-a, then id', () => {
    expect(focusKeyOf(el({ d: 'back' }))).toBe('[data-d="back"]');
    expect(focusKeyOf(el({ a: 'open' }))).toBe('[data-a="open"]');
    expect(focusKeyOf(el({ a: 'move' }, { id: 'aMove' }))).toBe('[data-a="move"]');
    expect(focusKeyOf(el({}, { id: 'aMove' }))).toBe('#aMove');
  });
  test('an element with neither (the text preview) falls back to its tabindex, never to "undefined"', () => {
    const key = focusKeyOf(el({}, { getAttribute: (n) => (n === 'tabindex' ? '0' : null) }));
    expect(key).toBe('[tabindex="0"]');
    expect(key).not.toContain('undefined');
    expect(focusKeyOf(el({}, { getAttribute: () => null }))).toBeNull();
    expect(focusKeyOf(null)).toBeNull();
  });
});

test('MEMO_STATUS has a line for every state', () => {
  expect(MEMO_STATUS.idle).toBe('입력을 멈추면 저장돼요');
  expect(MEMO_STATUS.typing).toBe('입력을 멈추면 저장돼요');
  expect(MEMO_STATUS.saving).toBe('저장 중…');
  expect(MEMO_STATUS.saved).toBe('저장됨');
  expect(MEMO_STATUS.error).toBe('저장하지 못했어요. 다시 입력해 주세요');
  expect(MEMO_STATUS.toolong).toBe('메모가 너무 길어요');
});

describe('createMemoSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 부르는 쪽이 끝내는 저장: calls[i] = { value, opts, resolve, reject }
  function manual() {
    const calls = [];
    const save = vi.fn(
      (value, opts) =>
        new Promise((resolve, reject) => {
          calls.push({ value, opts, resolve, reject });
        }),
    );
    return { save, calls };
  }
  const tick = () => vi.advanceTimersByTimeAsync(0);

  test('saves once, 600ms after typing stops', async () => {
    const { save, calls } = manual();
    const states = [];
    const s = createMemoSaver({ save, delay: 600, onState: (st) => states.push(st) });
    s.input('a');
    await vi.advanceTimersByTimeAsync(500);
    s.input('ab');
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();
    expect(s.state()).toBe('typing');
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0].value).toBe('ab');
    expect(s.state()).toBe('saving');
    calls[0].resolve();
    await tick();
    expect(s.state()).toBe('saved');
    expect(s.isDirty()).toBe(false);
    expect(states).toEqual(['typing', 'typing', 'saving', 'saved']);
  });

  test('typing back to the saved text does not save', async () => {
    const { save } = manual();
    const s = createMemoSaver({ save, initial: 'hello' });
    s.input('hello!');
    s.input('hello');
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
    expect(s.isDirty()).toBe(false);
  });

  test('flush saves right away and resolves true', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('바로');
    const done = s.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0].value).toBe('바로');
    calls[0].resolve();
    await expect(done).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1); // 미뤄 둔 저장이 또 나가지 않는다
  });

  test('flush with nothing to save does nothing', async () => {
    const { save } = manual();
    const s = createMemoSaver({ save, initial: 'x' });
    await expect(s.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  test('flush while a save is in flight waits for it and then sends the newer text', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('1');
    await vi.advanceTimersByTimeAsync(600);
    s.input('12');
    const done = s.flush();
    expect(save).toHaveBeenCalledTimes(1); // 한 번에 하나만 보낸다
    calls[0].resolve();
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1].value).toBe('12');
    calls[1].resolve();
    await expect(done).resolves.toBe(true);
    expect(s.state()).toBe('saved');
  });

  test('failure: error state, text kept, still dirty, flush retries', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('남는 글');
    await vi.advanceTimersByTimeAsync(600);
    calls[0].reject(new Error('offline'));
    await tick();
    expect(s.state()).toBe('error');
    expect(s.value()).toBe('남는 글');
    expect(s.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1); // 혼자 되풀이하지 않는다
    const done = s.flush();
    expect(calls[1].value).toBe('남는 글');
    calls[1].resolve();
    await expect(done).resolves.toBe(true);
    expect(s.state()).toBe('saved');
  });

  test('flush resolves false when the save fails', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('x');
    const done = s.flush();
    calls[0].reject(new Error('nope'));
    await expect(done).resolves.toBe(false);
    expect(s.isDirty()).toBe(true);
  });

  test('an older save resolving never hides newer keystrokes', async () => {
    const { save, calls } = manual();
    const states = [];
    const s = createMemoSaver({ save, onState: (st) => states.push(st) });
    s.input('old');
    await vi.advanceTimersByTimeAsync(600); // 'old' 저장 시작
    s.input('old+new'); // 저장 중에 더 쓴다
    calls[0].resolve();
    await tick();
    expect(s.state()).not.toBe('saved'); // 아직 새 글이 남았다
    expect(s.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[1].value).toBe('old+new');
    calls[1].resolve();
    await tick();
    expect(s.state()).toBe('saved');
    expect(states.filter((st) => st === 'saved')).toHaveLength(1);
  });

  test('requests never overlap, so the server always ends with the newest text', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('a');
    await vi.advanceTimersByTimeAsync(600);
    s.input('ab');
    await vi.advanceTimersByTimeAsync(600); // 앞 저장이 아직 안 끝났다
    expect(save).toHaveBeenCalledTimes(1);
    s.input('abc');
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    calls[0].resolve();
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1].value).toBe('abc');
    calls[1].resolve();
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.isDirty()).toBe(false);
  });

  test('an older save failing still sends the newer text', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('a');
    await vi.advanceTimersByTimeAsync(600);
    s.input('ab');
    await vi.advanceTimersByTimeAsync(600);
    calls[0].reject(new Error('x'));
    await tick();
    expect(calls[1].value).toBe('ab');
    calls[1].resolve();
    await tick();
    expect(s.state()).toBe('saved');
  });

  test('switching stars: each saver keeps its own text and target', async () => {
    const saved = [];
    const saverFor = (id) =>
      createMemoSaver({
        save: async (value) => {
          saved.push([id, value]);
        },
      });
    const a = saverFor('A');
    a.input('A의 메모');
    const leaving = a.flush(); // A를 떠나며
    const b = saverFor('B');
    b.input('B의 메모');
    await leaving;
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toEqual([
      ['A', 'A의 메모'],
      ['B', 'B의 메모'],
    ]);
  });

  test('too long: not sent, state toolong, saved again once shortened', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save, maxLength: 5 });
    s.input('123456');
    expect(s.state()).toBe('toolong');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(s.flush()).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
    s.input('12345');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[0].value).toBe('12345');
  });

  test('length counts characters, not UTF-16 units', async () => {
    const { save } = manual();
    const s = createMemoSaver({ save, maxLength: 3 });
    s.input('😀😀😀');
    expect(s.state()).toBe('typing');
    s.input('😀😀😀😀');
    expect(s.state()).toBe('toolong');
  });

  test('default limit is 20000', () => {
    expect(MEMO_MAX).toBe(20000);
    const s = createMemoSaver({ save: async () => {} });
    s.input('가'.repeat(20000));
    expect(s.state()).toBe('typing');
    s.input('가'.repeat(20001));
    expect(s.state()).toBe('toolong');
  });

  test('dispose: pending save is dropped, no more state callbacks', async () => {
    const { save } = manual();
    const states = [];
    const s = createMemoSaver({ save, onState: (st) => states.push(st) });
    s.input('버릴 글');
    s.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(s.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(states).toEqual(['typing']);
  });

  test('flushUrgent sends the newest text at once with keepalive, without waiting', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('a');
    await vi.advanceTimersByTimeAsync(600); // 'a' 저장 중
    s.input('ab');
    s.flushUrgent();
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1].value).toBe('ab');
    expect(calls[1].opts).toEqual({ keepalive: true });
    s.flushUrgent(); // 같은 글을 또 보내지 않는다
    expect(save).toHaveBeenCalledTimes(2);
  });

  test('flushUrgent twice in a row (beforeunload + pagehide) sends once', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('떠나기 직전');
    s.flushUrgent();
    s.flushUrgent();
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ value: '떠나기 직전', opts: { keepalive: true } });
    calls[0].resolve();
    await tick();
    expect(s.isDirty()).toBe(false);
    expect(s.state()).toBe('saved');
  });

  test('flushUrgent with nothing new sends nothing', () => {
    const { save } = manual();
    const s = createMemoSaver({ save, initial: 'x' });
    s.flushUrgent();
    expect(save).not.toHaveBeenCalled();
  });

  test('flushUrgent still goes out when a normal save of the same text is in flight (it may be cancelled on unload)', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('x');
    const done = s.flush(); // 탭이 가려질 때의 보통 저장
    s.flushUrgent(); // 곧바로 pagehide
    s.flushUrgent();
    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1]).toMatchObject({ value: 'x', opts: { keepalive: true } });
    calls[1].resolve();
    await tick();
    calls[0].resolve(); // 같은 글이라 늦게 끝나도 다시 보내지 않는다
    await expect(done).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.state()).toBe('saved');
    expect(s.isDirty()).toBe(false);
  });

  test('an urgent save resolving after a newer normal save does not regress; the newest text is sent again', async () => {
    const { save, calls } = manual();
    let server = '';
    const land = async (i) => {
      server = calls[i].value; // 서버는 끝난 순서대로 덮어쓴다고 본다
      calls[i].resolve();
      await tick();
    };
    const s = createMemoSaver({ save });
    s.input('a');
    s.flushUrgent(); // 'a' 급한 저장이 가는 중
    s.input('ab'); // 더 쓴다
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[1]).toMatchObject({ value: 'ab', opts: {} });
    await land(1); // 보통 저장이 먼저 끝난다
    expect(s.state()).toBe('saved');
    await land(0); // 옛 글의 급한 저장이 뒤늦게 끝난다
    expect(s.value()).toBe('ab');
    expect(s.isDirty()).toBe(true); // 서버에 옛 글이 남았을 수 있다
    expect(save).toHaveBeenCalledTimes(3);
    expect(calls[2]).toMatchObject({ value: 'ab', opts: {} });
    await land(2);
    expect(server).toBe('ab');
    expect(s.state()).toBe('saved');
    expect(s.isDirty()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(3);
  });

  test('typing more while an urgent save is in flight: the newer text is saved after it resolves', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('a');
    s.flushUrgent();
    s.input('ab');
    calls[0].resolve();
    await tick();
    expect(s.isDirty()).toBe(true);
    expect(s.state()).not.toBe('saved');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[1].value).toBe('ab');
    calls[1].resolve();
    await tick();
    expect(s.state()).toBe('saved');
  });

  test('a failed urgent save leaves the text dirty and flush sends it again', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('x');
    s.flushUrgent();
    calls[0].reject(new Error('cancelled'));
    await tick();
    expect(s.state()).toBe('error');
    expect(s.isDirty()).toBe(true);
    const done = s.flush();
    expect(calls[1].value).toBe('x');
    calls[1].resolve();
    await expect(done).resolves.toBe(true);
  });

  test('dispose while a save is in flight: nothing more is sent or reported', async () => {
    const { save, calls } = manual();
    const states = [];
    const s = createMemoSaver({ save, onState: (st) => states.push(st) });
    s.input('a');
    const done = s.flush();
    s.input('ab'); // 저장 중에 더 썼다
    s.dispose();
    calls[0].resolve();
    await expect(done).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['typing', 'saving', 'saving']);
    expect(s.isDirty()).toBe(false);
    await expect(s.flush()).resolves.toBe(true);
    s.flushUrgent();
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('error → type again → saved again', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('x');
    await vi.advanceTimersByTimeAsync(600);
    calls[0].reject(new Error('offline'));
    await tick();
    expect(s.state()).toBe('error');
    s.input('xy');
    expect(s.state()).toBe('typing');
    await vi.advanceTimersByTimeAsync(600);
    expect(calls[1].value).toBe('xy');
    calls[1].resolve();
    await tick();
    expect(s.state()).toBe('saved');
    expect(s.isDirty()).toBe(false);
  });

  test('flush when over the limit with a save in flight: waits, resolves false, sends nothing more', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save, maxLength: 3 });
    s.input('abc');
    await vi.advanceTimersByTimeAsync(600); // 'abc' 저장 중
    s.input('abcd');
    expect(s.state()).toBe('toolong');
    let settled = false;
    const done = s.flush().then((ok) => {
      settled = true;
      return ok;
    });
    await tick();
    expect(settled).toBe(false); // 가고 있는 저장을 기다린다
    calls[0].resolve();
    await expect(done).resolves.toBe(false);
    expect(s.state()).toBe('toolong');
    expect(s.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('404 on save (the star is gone) is terminal: dropped, no error status, no retries', async () => {
    const { save, calls } = manual();
    const states = [];
    const onGone = vi.fn();
    const s = createMemoSaver({ save, onState: (st) => states.push(st), onGone });
    s.input('지워진 별의 메모');
    const done = s.flush();
    calls[0].reject(Object.assign(new Error('404'), { status: 404, code: 'not_found' }));
    await expect(done).resolves.toBe(true);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(states).not.toContain('error');
    expect(s.state()).toBe('idle');
    expect(s.isDirty()).toBe(false);
    s.input('더 써도');
    await vi.advanceTimersByTimeAsync(5000);
    await s.flush();
    s.flushUrgent();
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('404 on an urgent save is terminal too', async () => {
    const { save, calls } = manual();
    const onGone = vi.fn();
    const s = createMemoSaver({ save, onGone });
    s.input('x');
    s.flushUrgent();
    calls[0].reject({ status: 404 });
    await tick();
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(s.isDirty()).toBe(false);
    expect(s.state()).toBe('idle');
  });

  test('server says invalid_memo → toolong status, not the generic error', async () => {
    const { save, calls } = manual();
    const s = createMemoSaver({ save });
    s.input('x');
    await vi.advanceTimersByTimeAsync(600);
    calls[0].reject({ status: 400, code: 'invalid_memo' });
    await tick();
    expect(s.state()).toBe('toolong');
    expect(MEMO_STATUS[s.state()]).toBe('메모가 너무 길어요');
  });

  test('flushDirty: after the connection returns every unsaved saver is sent again, open or not', async () => {
    const a = manual();
    const b = manual();
    const c = manual();
    const savers = new Map([
      ['A', createMemoSaver({ save: a.save })], // 떠나온 별
      ['B', createMemoSaver({ save: b.save })], // 열려 있는 별
      ['C', createMemoSaver({ save: c.save, initial: '그대로' })], // 고친 것이 없는 별
    ]);
    savers.get('A').input('A 메모');
    savers.get('B').input('B 메모');
    await vi.advanceTimersByTimeAsync(600);
    a.calls[0].reject({ status: 0, code: 'offline' });
    b.calls[0].reject({ status: 0, code: 'offline' });
    await tick();
    expect(savers.get('A').state()).toBe('error');
    await vi.advanceTimersByTimeAsync(60000);
    expect(a.save).toHaveBeenCalledTimes(1); // 혼자서는 다시 보내지 않는다

    const done = flushDirty(savers); // 'online' · 'reachable'
    expect(a.calls[1].value).toBe('A 메모');
    expect(b.calls[1].value).toBe('B 메모');
    expect(c.save).not.toHaveBeenCalled();
    a.calls[1].resolve();
    b.calls[1].reject({ status: 0, code: 'offline' });
    await expect(done).resolves.toEqual([
      ['A', true],
      ['B', false],
    ]);
    expect(savers.get('A').isDirty()).toBe(false);
    expect(savers.get('B').isDirty()).toBe(true);
  });

  test('setListener moves state callbacks to a new place', async () => {
    const { save, calls } = manual();
    const first = [];
    const second = [];
    const s = createMemoSaver({ save, onState: (st) => first.push(st) });
    s.input('x');
    s.setListener((st) => second.push(st));
    await vi.advanceTimersByTimeAsync(600);
    calls[0].resolve();
    await tick();
    expect(first).toEqual(['typing']);
    expect(second).toEqual(['saving', 'saved']);
  });
});
