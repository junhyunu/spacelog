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

/** keepalive 요청 본문의 한도(바이트). 브라우저는 64KiB(65,536)를 넘으면 거절한다. 조금 남겨 둔다. */
export const KEEPALIVE_BYTES = 64000;

/** 본문이 keepalive로 보낼 수 있는 크기인지. 한글 20,000자 메모({"memo":"…"})는 60,011바이트다. */
export function fitsKeepalive(bytes) {
  return bytes <= KEEPALIVE_BYTES;
}

/**
 * 조각을 다시 그린 뒤 초점을 돌려줄 선택자. data-d · data-a · id · tabindex 순으로 찾는다.
 * 아무것도 없으면 null(초점을 돌려주지 않는다).
 */
export function focusKeyOf(el) {
  if (!el) return null;
  if (el.dataset?.d) return `[data-d="${el.dataset.d}"]`;
  if (el.dataset?.a) return `[data-a="${el.dataset.a}"]`;
  if (el.id) return `#${el.id}`;
  const tab = el.getAttribute?.('tabindex');
  return tab === null || tab === undefined ? null : `[tabindex="${tab}"]`;
}

/**
 * 별마다 "마지막으로 저장한 메모"를 적어 두는 장부.
 * 저장보다 먼저 떠난 다시 받기가 저장 뒤에 도착하면 옛 메모를 들고 온다. 그때 이쪽 것을 쓴다.
 * 겹친 다시 받기는 마지막 것만 반영되므로(store.reload), 저장 뒤 첫 번째 동기화만 옛것일 수 있다.
 * 두 번째부터는 저장 뒤에 떠난 것이라 서버 값을 믿는다.
 */
export function createMemoLedger() {
  const saved = new Map(); // 별 id → { memo, at: 저장할 때까지 온 동기화 수 }
  let syncs = 0;
  return {
    /** 저장이 확인됐을 때 */
    record(id, memo) {
      saved.set(String(id), { memo, at: syncs });
    },
    /** 다시 받기가 반영될 때마다('data') */
    synced() {
      syncs += 1;
      for (const [id, entry] of saved) if (syncs - entry.at >= 2) saved.delete(id);
    },
    /** 서버가 준 메모와 견주어 보여 줄 메모 */
    resolve(id, serverMemo) {
      const entry = saved.get(String(id));
      return entry ? entry.memo : serverMemo;
    },
    /** 별들의 memo를 그 자리에서 고친다. 고친 것이 있으면 true */
    apply(stars) {
      let changed = false;
      if (saved.size === 0) return changed;
      for (const star of stars ?? []) {
        const entry = saved.get(String(star?.id));
        if (entry && star.memo !== entry.memo) {
          star.memo = entry.memo;
          changed = true;
        }
      }
      return changed;
    },
    has: (id) => saved.has(String(id)),
    forget(id) {
      saved.delete(String(id));
    },
  };
}

/**
 * 저장하지 못한 저장기를 모두 다시 보낸다(연결이 돌아왔을 때 · 탭이 가려질 때).
 * 열려 있지 않은 별의 것도 보낸다. → Promise<[id, 저장됐는지][]>. 던지지 않는다.
 * @param {Map<string, ReturnType<typeof createMemoSaver>>} savers
 */
export function flushDirty(savers) {
  const jobs = [];
  for (const [id, saver] of [...savers]) {
    if (saver.isDirty()) jobs.push(saver.flush().then((ok) => [id, ok]));
  }
  return Promise.all(jobs);
}

/**
 * 메모 자동 저장기. 별 하나에 하나씩 만든다(save가 그 별의 id를 쥐고 있어 다른 별에 쓰이지 않는다).
 * 보통 저장은 한 번에 하나만 보낸다: 저장 중에 더 쓴 글은 앞의 저장이 끝난 뒤 이어서 보낸다.
 * 급한 저장(flushUrgent)은 그와 겹칠 수 있어서, 요청마다 번호를 매기고 더 새 요청의 결과만 "저장됨"으로 삼는다.
 * save가 status 404로 실패하면(지워진 별) 저장기를 끝낸다: 오류 문구도, 다시 보내기도 없다.
 *
 * @param {object} o
 * @param {(value: string, opts: { keepalive?: boolean }) => Promise<unknown>} o.save
 * @param {number} [o.delay=600]      입력을 멈추고 저장하기까지(ms)
 * @param {(state: 'idle'|'typing'|'saving'|'saved'|'error'|'toolong') => void} [o.onState]
 * @param {() => void} [o.onGone]     별이 지워져 저장기가 끝났을 때
 * @param {string} [o.initial='']     이미 저장되어 있는 글
 * @param {number} [o.maxLength=20000]
 */
export function createMemoSaver({ save, delay = MEMO_DELAY, onState, onGone, initial = '', maxLength = MEMO_MAX } = {}) {
  let value = String(initial ?? '');
  let saved = value; // 서버에 저장된 것이 확인된 글
  let seq = 0; // 보낸 요청에 매기는 번호(늘기만 한다)
  let savedSeq = 0; // saved를 확인해 준 요청의 번호
  let doubt = 0; // 0이 아니면: 옛 요청이 더 새 요청보다 늦게 끝났다. 이 번호보다 뒤의 요청이 성공해야 풀린다
  let urgentSent = null; // 가고 있는 급한 저장의 글
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
  const clean = () => value === saved && doubt === 0;
  const isGone = (err) => err?.status === 404;
  const failState = (err) => (err?.code === 'invalid_memo' ? 'toolong' : 'error');

  // n번 요청이 성공했다
  function landed(n, sending) {
    if (n > savedSeq) {
      saved = sending;
      savedSeq = n;
      if (n > doubt) doubt = 0;
    } else if (sending !== saved) {
      doubt = seq; // 더 새 저장이 먼저 끝났다: 서버에는 이 옛 글이 남았을 수 있으니 지금 글을 다시 보낸다
    }
  }

  // 지워진 별: 조용히 끝낸다
  function drop() {
    stopTimer();
    set('idle');
    disposed = true;
    onGone?.();
  }

  function start() {
    if (inflight) return inflight;
    const sending = value;
    const n = ++seq;
    set('saving');
    inflight = (async () => {
      let ok = true;
      let failure = null;
      try {
        await save(sending, {});
        landed(n, sending);
      } catch (err) {
        ok = false;
        failure = err;
      }
      inflight = null;
      if (disposed) return ok;
      if (!ok && isGone(failure)) {
        drop();
        return true;
      }
      if (clean()) {
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
        set(failState(failure)); // 같은 글을 혼자 되풀이해 보내지 않는다. 다시 입력하거나 flush()하면 보낸다
        return false;
      }
      return start();
    })();
    return inflight;
  }

  // 급한 저장이 끝난 뒤: 남은 글이 있으면 보통 저장으로 잇는다
  function afterUrgent(ok, failure) {
    if (disposed) return;
    if (!ok && isGone(failure)) {
      drop();
      return;
    }
    if (inflight || timer !== null) return; // 그쪽이 끝나면서 알아서 잇는다
    if (clean()) {
      set('saved');
      return;
    }
    if (tooLong()) {
      set('toolong');
      return;
    }
    if (ok) start();
    else set(failState(failure));
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
      if (clean() && !inflight) {
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
      if (!inflight && clean()) return Promise.resolve(true);
      return start();
    },

    /**
     * 화면이 사라지는 순간(pagehide)에 쓴다: 기다리지 않고 지금 글을 keepalive로 보낸다.
     * 같은 글의 보통 저장이 가고 있어도 보낸다(그 요청은 화면이 사라지면 끊길 수 있다).
     */
    flushUrgent() {
      if (disposed) return;
      stopTimer();
      if (tooLong() || (clean() && !inflight) || (urgent > 0 && value === urgentSent)) return;
      const sending = value;
      const n = ++seq;
      urgentSent = sending;
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
          landed(n, sending);
          afterUrgent(true, null);
        },
        (err) => {
          urgent -= 1;
          afterUrgent(false, err);
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
    isDirty: () => !disposed && (inflight !== null || !clean()),
  };
}
