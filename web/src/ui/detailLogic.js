// W-03 별 상세의 순수 함수. DOM · 네트워크를 건드리지 않는다(테스트는 node 환경).
import { fileSize } from '../util.js';

/** 메모 글자 수 한도. 서버의 파일 올리기 한도(server/files.js MEMO_MAX)와 같다. */
export const MEMO_MAX = 20000;
export const MEMO_DELAY = 600;

/** 메모 아래 상태 글(DESIGN.md W-03 "메모"). */
export const MEMO_STATUS = Object.freeze({
  idle: '입력을 멈추면 저장돼요',
  typing: '입력을 멈추면 저장돼요',
  saving: '저장 중…',
  saved: '저장됨',
  error: '저장하지 못했어요. 다시 입력해 주세요',
  toolong: '메모가 너무 길어요',
});

const KINDS = { text: '텍스트', image: '이미지', file: '파일', link: '링크' };

/** 정보 칸의 종류 이름. 모르는 값이면 '미확인'. */
export function kindLabel(type) {
  return Object.hasOwn(KINDS, type) ? KINDS[type] : '미확인';
}

/**
 * 파일 미리보기의 "PDF · 1.2MB".
 * @returns {{ ext: string, size: string, text: string, unknown: boolean }} unknown이면 크기를 회색으로 쓴다
 */
export function fileMeta(star) {
  const ext = typeof star?.file_ext === 'string' && star.file_ext.trim() !== '' ? star.file_ext.trim() : '파일';
  const n = star?.file_size;
  const unknown = typeof n !== 'number' || !Number.isFinite(n) || n < 0;
  const size = fileSize(unknown ? null : n);
  return { ext, size, text: `${ext} · ${size}`, unknown };
}

/** 미리보기 모양: 'image' | 'file' | 'link' | 'text'. 모르는 종류는 글로 본다. */
export function previewKind(star) {
  const type = star?.type;
  return type === 'image' || type === 'file' || type === 'link' ? type : 'text';
}

/** http · https 주소면 정리한 주소를, 아니면 null. href · window.open에 넣기 전에 거친다. */
export function safeHttpUrl(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * 행동 버튼(스펙 5장 "사본이 없는 별").
 * open: 'server'(보관함 사본을 서버가 연다) | 'tab'(새 탭) | null(버튼 없음), reveal: 폴더에서 보기 버튼
 */
export function actionsFor(star) {
  const type = star?.type;
  if (type === 'image' || type === 'file') return { open: 'server', reveal: true };
  if (type === 'link' && safeHttpUrl(star.url)) return { open: 'tab', reveal: false };
  return { open: null, reveal: false };
}

/** "이 별 지우기" 확인 창의 글. ask()에 그대로 넘긴다. */
export function deleteCopy(star) {
  const hasCopy = star?.type === 'file' || star?.type === 'image';
  return {
    title: `별 '${star?.title || '제목 없음'}'을(를) 지울까요?`,
    desc: hasCopy ? '기록과 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.' : '기록이 지워져요. 되돌릴 수 없어요.',
    confirmLabel: '지우기',
    confirmKind: 'pink',
  };
}

/** 원본 열기('open') · 폴더에서 보기('reveal')가 실패했을 때의 토스트. */
export function openFailToast(err, kind = 'open') {
  const code = err?.code;
  if (code === 'file_missing' || code === 'no_file' || err?.status === 404) return '파일을 찾지 못했어요';
  if (kind === 'reveal') return '폴더를 열지 못했어요. 다시 눌러 주세요';
  if (code === 'open_failed') return '열지 못했어요. 폴더에서 직접 열어 주세요';
  return '열지 못했어요. 다시 눌러 주세요';
}

// 글자 수(코드 포인트)가 max를 넘는지. 짧은 글은 세지 않는다
function longerThan(text, max) {
  if (text.length <= max) return false;
  let n = 0;
  for (const _ of text) {
    n += 1;
    if (n > max) return true;
  }
  return false;
}

/**
 * 메모 자동 저장기. 별 하나에 하나씩 만든다(save가 그 별의 id를 쥐고 있어 다른 별에 쓰이지 않는다).
 * 요청은 한 번에 하나만 보낸다: 저장 중에 더 쓴 글은 앞의 저장이 끝난 뒤 이어서 보낸다.
 *
 * @param {object} o
 * @param {(value: string, opts: { keepalive?: boolean }) => Promise<unknown>} o.save
 * @param {number} [o.delay=600]      입력을 멈추고 저장하기까지(ms)
 * @param {(state: 'idle'|'typing'|'saving'|'saved'|'error'|'toolong') => void} [o.onState]
 * @param {string} [o.initial='']     이미 저장되어 있는 글
 * @param {number} [o.maxLength=20000]
 */
export function createMemoSaver({ save, delay = MEMO_DELAY, onState, initial = '', maxLength = MEMO_MAX } = {}) {
  let value = String(initial ?? '');
  let saved = value; // 서버에 저장된 것이 확인된 글
  let sent = value; // 마지막으로 보낸 글(끝났든 아니든)
  let timer = null;
  let inflight = null;
  let urgent = 0; // 끝나지 않은 flushUrgent 요청 수
  let state = 'idle';
  let disposed = false;
  let listener = onState;

  const set = (next) => {
    state = next;
    if (!disposed) listener?.(next);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const tooLong = () => longerThan(value, maxLength);

  function start() {
    if (inflight) return inflight;
    const sending = value;
    sent = sending;
    set('saving');
    inflight = (async () => {
      let ok = true;
      try {
        await save(sending, {});
        saved = sending;
      } catch {
        ok = false;
      }
      inflight = null;
      if (disposed) return ok;
      if (value === saved) {
        if (timer === null) set('saved');
        return true;
      }
      // 저장하는 사이 더 쓴 글이 있다(또는 실패했다)
      if (timer !== null) return ok; // 입력을 멈추면 그때 다시 보낸다
      if (tooLong()) {
        set('toolong');
        return false;
      }
      if (!ok && value === sending) {
        set('error'); // 같은 글을 혼자 되풀이해 보내지 않는다. 다시 입력하거나 flush()하면 보낸다
        return false;
      }
      return start();
    })();
    return inflight;
  }

  return {
    /** 글이 바뀔 때마다 부른다(조합 중인 한글도 그대로). */
    input(next) {
      if (disposed) return;
      value = String(next ?? '');
      stopTimer();
      if (tooLong()) {
        set('toolong');
        return;
      }
      if (value === saved && !inflight) {
        set('idle');
        return;
      }
      set(inflight ? 'saving' : 'typing');
      timer = setTimeout(() => {
        timer = null;
        start();
      }, delay);
    },

    /** 미뤄 둔 저장을 바로 끝낸다. → Promise<boolean> 저장할 것이 없거나 저장됐으면 true. 던지지 않는다. */
    flush() {
      if (disposed) return Promise.resolve(true);
      stopTimer();
      if (tooLong()) {
        set('toolong');
        return (inflight ?? Promise.resolve()).then(() => false);
      }
      if (!inflight && value === saved) return Promise.resolve(true);
      return start();
    },

    /** 화면이 사라지는 순간(pagehide)에 쓴다: 기다리지 않고 지금 글을 keepalive로 보낸다. */
    flushUrgent() {
      if (disposed) return;
      stopTimer();
      if (tooLong() || value === saved || ((inflight || urgent > 0) && value === sent)) return;
      const sending = value;
      sent = sending;
      let request;
      urgent += 1;
      try {
        request = save(sending, { keepalive: true }); // 미루지 않고 이 자리에서 보낸다
      } catch {
        urgent -= 1;
        return;
      }
      Promise.resolve(request).then(
        () => {
          urgent -= 1;
          saved = sending;
          if (!disposed && !inflight && timer === null && value === saved) set('saved');
        },
        () => {
          urgent -= 1;
        },
      );
    },

    /** 그만 쓴다(별을 지웠을 때). 미뤄 둔 저장은 버리고 상태도 더 알리지 않는다. */
    dispose() {
      disposed = true;
      stopTimer();
    },

    setListener(fn) {
      listener = fn;
    },
    value: () => value,
    state: () => state,
    /** 저장되지 않은 글이 있거나 저장 중이면 true. */
    isDirty: () => !disposed && (inflight !== null || value !== saved),
  };
}
