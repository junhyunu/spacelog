// W-03 별 상세: 미리보기 · 정보 · 원본 열기 / 폴더에서 보기 · 메모 자동 저장 · 행성 옮기기 · 지우기.
// 시안 715~759행(renderDetail · 메모 · moveRec · removeRec)을 옮겼다. 발(싣기 버튼)은 없다(탐사선 제외).
// panel.js가 부르는 모양:
//   renderDetail(container, star, planet, { onBack, onClose })  container(#panel)의 내용을 통째로 그린다
//   flushMemo() → Promise                                       대기 중인 메모 저장을 바로 끝낸다(던지지 않는다)
//
// 같은 별을 다시 그리라고 하면('data'가 왔을 때) 바뀐 조각만 갈아 끼운다. 메모 칸은 건드리지 않는다
// (쓰던 글 · 초점 · 한글 조합을 지킨다).
// 메모 저장기는 별마다 하나다. 저장하지 못한 채 상세를 떠난 별의 저장기는 남겨 두었다가,
// 그 별을 다시 열면 쓰던 글과 실패 문구를 그대로 보인다.
import { Vector3 } from 'three';
import { api } from '../api.js';
import { store } from '../store.js';
import { flyStarIn, starMesh } from '../three/planets.js';
import { PLANET_COLORS, esc, fullDate, ico } from '../util.js';
import { ask } from './confirm.js';
import {
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
} from './detailLogic.js';
import { clearGuestStar } from './hud.js';
import { toast } from './toast.js';

const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
let current = null; // 지금 그려진 상세
const savers = new Map(); // 별 id → 메모 저장기(그려져 있거나, 아직 저장하지 못한 것)
const ledger = createMemoLedger(); // 별 id → 마지막으로 저장한 메모(늦게 온 다시 받기의 옛 메모를 고친다)
let syncs = 0; // 지금까지 온 'data' 수

const live = (ctx) => current === ctx && ctx.memoEl.isConnected;

/* ---------- 메모 저장 ---------- */

// 저장된 메모를 화면이 쥔 별에도 적어 둔다(목록에 갔다가 다시 열어도 새 메모가 보이게)
function remember(id, memo) {
  ledger.record(id, memo);
  const inStore = store.state.stars.find((s) => same(s.id, id));
  if (inStore) inStore.memo = memo;
  if (current && current.id === id) current.star.memo = memo;
}

async function patchMemo(id, memo, keepalive) {
  if (!keepalive) {
    await api.patchStar(id, { memo });
    return;
  }
  // 화면이 사라지는 중: 응답을 기다릴 수 없으니 keepalive로 보낸다(sendBeacon은 PATCH를 못 보낸다)
  const body = JSON.stringify({ memo });
  const res = await fetch(`/api/stars/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    // 너무 큰 본문은 keepalive로 못 보낸다. 그런 메모는 탭이 가려질 때 미리 저장해 둔다(아래 visibilitychange)
    keepalive: fitsKeepalive(new Blob([body]).size),
  });
  if (!res.ok) throw Object.assign(new Error(`memo ${res.status}`), { status: res.status });
}

// 그 별의 저장기. id를 여기서 쥐므로 별을 빠르게 바꿔도 다른 별에 쓰이지 않는다
function saverFor(id, memo) {
  let saver = savers.get(id);
  if (!saver) {
    let sends = 0;
    let landed = 0;
    saver = createMemoSaver({
      initial: memo,
      save: async (value, opts) => {
        const n = ++sends;
        await patchMemo(id, value, Boolean(opts?.keepalive));
        if (n < landed) return; // 더 새 저장이 먼저 끝났다: 옛 글을 적어 두지 않는다
        landed = n;
        remember(id, value);
      },
      // 지워진 별(행성째 지운 경우 등): 저장기를 치운다
      onGone: () => {
        if (savers.get(id) === saver) savers.delete(id);
        ledger.forget(id);
      },
    });
    savers.set(id, saver);
  }
  return saver;
}

// 다 저장됐고 그려져 있지도 않은 저장기는 치운다
function tidy(id) {
  const saver = savers.get(id);
  if (saver && !saver.isDirty() && current?.id !== id) savers.delete(id);
}

function leave(ctx) {
  if (current === ctx) current = null;
  ctx.saver.setListener(null);
  return ctx.saver.flush().then((ok) => {
    tidy(ctx.id);
    return ok;
  });
}

/** 대기 중인 메모 저장을 바로 끝낸다. 상세를 떠나거나 패널을 닫을 때 panel.js가 부른다. */
export function flushMemo() {
  const ctx = current;
  if (!ctx) return Promise.resolve();
  return ctx.saver.flush().then(() => {
    // 그사이 상세가 화면에서 사라졌으면(목록으로 · 닫기) 정리한다
    if (current === ctx && !ctx.memoEl.isConnected) {
      current = null;
      ctx.saver.setListener(null);
    }
    tidy(ctx.id);
  });
}

function flushAllNow() {
  for (const saver of savers.values()) saver.flushUrgent();
}

// 저장하지 못한 메모를 모두(열려 있지 않은 별의 것도) 보통 저장으로 보낸다
function saveAllDirty() {
  flushDirty(savers)
    .then((done) => {
      for (const [id] of done) tidy(id);
    })
    .catch(() => {});
}

if (typeof window !== 'undefined') {
  // 새로고침 · 창 닫기: 미뤄 둔 메모를 놓치지 않는다
  window.addEventListener('pagehide', flushAllNow);
  window.addEventListener('beforeunload', (e) => {
    flushAllNow();
    // 서버와 끊긴 동안에는 위의 저장도 닿지 않는다. 저장 못 한 메모가 있으면 떠나기 전에 묻는다.
    if (store.state.offline && [...savers.values()].some((s) => s.isDirty())) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // 탭이 가려질 때 미리 저장한다. keepalive로 못 보내는 큰 메모도 대개 창이 닫히기 전에 저장된다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveAllDirty();
  });
}

// 끊겼던 연결이 돌아오면 실패했던 저장을 다시 보낸다
store.on('online', saveAllDirty);
store.on('reachable', saveAllDirty);

// 저장보다 먼저 떠난 다시 받기가 옛 메모를 들고 왔으면 저장한 메모로 고친다.
// 이 모듈은 panel.js보다 먼저 듣기 시작하므로, 패널이 다시 그리기 전에 고쳐진다
store.on('data', () => {
  syncs += 1;
  ledger.synced();
  ledger.apply(store.state.stars);
});

/* ---------- 조각 HTML ---------- */

function headHtml(star, planet) {
  const face = PLANET_COLORS[planet?.color_index]?.face ?? '#7a6cff';
  const name = planet?.name ?? '';
  return (
    `<button type="button" class="btn x ghost" data-d="back" aria-label="'${esc(name)}' 목록으로">${ico('arrow-left')}</button>` +
    `<div class="hd"><div class="sub pname"><span class="dot" style="background:${face}"></span><span class="t">${esc(name)}</span></div>` +
    `<h2 class="h2s">${esc(star.title || '제목 없음')}</h2></div>` +
    `<button type="button" class="btn x" data-d="close" aria-label="닫기">${ico('x')}</button>`
  );
}

// 확장자 아이콘. 확장자가 없거나 길면 종류 아이콘을 쓴다
function extIcon(star, fallbackIcon) {
  const ext = typeof star.file_ext === 'string' ? star.file_ext.trim() : '';
  const inner = ext && [...ext].length <= 4 ? esc(ext) : ico(fallbackIcon, 22);
  return `<span class="fi" aria-hidden="true">${inner}</span>`;
}

function previewHtml(ctx, star) {
  const kind = previewKind(star);
  const fileName = star.file_name || star.title || '이름 없는 파일';
  if (kind === 'image' && !ctx.imgNote) {
    return (
      `<div class="pv img"><img src="${esc(api.fileUrl(star.id))}" alt="${esc(star.title || fileName)}" decoding="async">` +
      `<span>${esc(fileName)}</span></div>`
    );
  }
  if (kind === 'image') {
    // 이미지를 못 받았다: 파일 모양으로 바꿔 보인다
    return (
      `<div class="pv file">${extIcon({ file_ext: '' }, 'image')}<div><b>${esc(fileName)}</b>` +
      `<small><span class="na">${esc(ctx.imgNote)}</span></small></div></div>`
    );
  }
  if (kind === 'file') {
    const meta = fileMeta(star);
    return (
      `<div class="pv file">${extIcon(star, 'file-text')}<div><b>${esc(fileName)}</b>` +
      `<small>${esc(meta.ext)} · ${meta.unknown ? `<span class="na">${esc(meta.size)}</span>` : esc(meta.size)}</small></div></div>`
    );
  }
  if (kind === 'link') {
    const url = star.url || '';
    return `<div class="pv link"><b>${esc(star.link_title || url || '주소 미확인')}</b><small>${esc(url)}</small></div>`;
  }
  // 글: 본문 그대로. 길면 상자 안에서 스크롤한다(키보드로도 내릴 수 있게 tabindex)
  return `<div class="detail" tabindex="0" role="group" aria-label="본문">${esc(star.body ?? '')}</div>`;
}

function topHtml(ctx, star) {
  const kind = kindLabel(star.type);
  const date = fullDate(star.created_at);
  const na = (text, unknown) => (unknown ? `<span class="na">${esc(text)}</span>` : esc(text));
  const acts = actionsFor(star);
  return (
    previewHtml(ctx, star) +
    `<dl class="meta"><dt>종류</dt><dd>${na(kind, kind === '미확인')}</dd>` +
    `<dt>넣은 날짜</dt><dd class="mono">${na(date, date.includes('미확인'))}</dd></dl>` +
    (acts.open || acts.reveal
      ? '<div class="acts">' +
        (acts.open ? '<button type="button" class="btn ghost sm" data-a="open">원본 열기</button>' : '') +
        (acts.reveal ? '<button type="button" class="btn ghost sm" data-a="reveal">폴더에서 보기</button>' : '') +
        '</div>'
      : '')
  );
}

function bottomHtml(star) {
  const planets = store.state.planets;
  const move =
    planets.length > 1
      ? '<div class="mv"><label for="aMove">행성 옮기기</label><select id="aMove" data-a="move">' +
        planets
          .map((p) => `<option value="${esc(p.id)}"${same(p.id, star.planet_id) ? ' selected' : ''}>${esc(p.name)}</option>`)
          .join('') +
        '</select></div>'
      : '';
  return `${move}<button type="button" class="linkdel" data-a="del">이 별 지우기</button>`;
}

/* ---------- 행동 ---------- */

function setBusy(ctx) {
  for (const b of ctx.container.querySelectorAll('.acts [data-a]')) b.disabled = ctx.busy;
}

async function openOrReveal(ctx, kind, button) {
  if (ctx.busy) return;
  if (kind === 'open' && actionsFor(ctx.star).open === 'tab') {
    const url = safeHttpUrl(ctx.star.url);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  ctx.busy = true;
  setBusy(ctx);
  try {
    const res = kind === 'open' ? await api.open(ctx.id) : await api.reveal(ctx.id);
    if (kind === 'open' && res?.action === 'revealed') toast('이 종류는 바로 열지 않고 폴더에서 보여드렸어요');
  } catch (err) {
    toast(openFailToast(err, kind));
  } finally {
    ctx.busy = false;
    if (live(ctx)) {
      setBusy(ctx);
      // 잠근 동안 버튼이 초점을 잃었으면 돌려준다
      if (button.isConnected && (document.activeElement === document.body || !document.activeElement)) {
        button.focus({ preventScroll: true });
      }
    }
  }
}

async function move(ctx, select) {
  const origin = String(ctx.star.planet_id);
  const target = select.value;
  if (ctx.moving || !target || target === origin) return;
  const name = store.state.planets.find((p) => same(p.id, target))?.name ?? '';
  ctx.moving = true;
  select.disabled = true;
  // 별이 지금 있는 자리(다시 받기 전에 잡아 둔다). 그려져 있지 않으면 날아오지 않는다
  const from = starMesh(ctx.id)?.getWorldPosition(new Vector3()) ?? null;
  await ctx.saver.flush(); // 쓰던 메모부터
  try {
    await api.patchStar(ctx.id, { planet_id: target });
  } catch {
    ctx.moving = false;
    if (live(ctx)) {
      const sel = ctx.container.querySelector('#aMove');
      if (sel) {
        sel.value = origin;
        sel.disabled = false;
        sel.focus({ preventScroll: true });
      }
    }
    toast('옮기지 못했어요');
    return;
  }
  ctx.moving = false;
  const inStore = store.state.stars.find((s) => same(s.id, ctx.id));
  if (inStore) inStore.planet_id = target; // 다시 받기 전에도 원래 행성 목록에서 빠지게
  if (live(ctx)) {
    clearGuestStar();
    ctx.handlers.onBack?.(); // 원래 행성의 목록으로
  }
  // 3D가 별의 새 행성을 알게 된 뒤에(다시 받기가 반영된 뒤에) 날린다
  const fly = () => {
    const star = store.state.stars.find((s) => same(s.id, ctx.id));
    if (!star || same(star.planet_id, target)) flyStarIn(ctx.id, from);
  };
  const seen = syncs;
  let reloaded = true;
  try {
    await store.reload();
  } catch {
    reloaded = false; // 연결 실패 카드는 api.js가 띄운다
  }
  toast(`'${name}'(으)로 옮겼어요`); // 옮기기는 서버에서 이미 끝났다
  if (!reloaded) return; // 다음 'data'가 별을 새 행성에 놓는다
  if (syncs !== seen) {
    fly();
    return;
  }
  // 더 새 다시 받기에 밀려 아직 반영되지 않았다: 그것이 끝나면 날린다
  const off = store.on('data', () => {
    off();
    fly();
  });
}

async function remove(ctx) {
  if (ctx.deleting) return;
  const ok = await ask(deleteCopy(ctx.star));
  if (!ok || ctx.deleting) return;
  ctx.deleting = true;
  try {
    await api.deleteStar(ctx.id);
  } catch (err) {
    // 이미 지워진 별(404)은 지운 것으로 본다
    if (err?.status !== 404) {
      ctx.deleting = false;
      toast('지우지 못했어요. 다시 눌러 주세요');
      return;
    }
  }
  ctx.saver.dispose(); // 지운 별에 메모를 쓰지 않는다
  savers.delete(ctx.id);
  ledger.forget(ctx.id);
  store.state.stars = store.state.stars.filter((s) => !same(s.id, ctx.id));
  if (live(ctx)) {
    clearGuestStar();
    ctx.handlers.onBack?.();
  }
  store.reload().catch(() => {});
  toast('지웠어요');
}

// 이미지를 못 받았을 때: 사본이 없는지(404), 브라우저가 못 그리는 형식인지 알아본다
async function onImageError(ctx) {
  if (ctx.imgNote) return;
  ctx.imgNote = '파일을 찾지 못했어요';
  renderPart(ctx, 'top');
  try {
    const res = await fetch(api.fileUrl(ctx.id), { headers: { Range: 'bytes=0-0' } });
    if (res.ok) ctx.imgNote = '이 이미지는 미리 볼 수 없어요';
  } catch {
    return;
  }
  if (live(ctx)) renderPart(ctx, 'top');
}

/* ---------- 그리기 ---------- */

function partHtml(ctx, part) {
  if (part === 'head') return headHtml(ctx.star, ctx.planet);
  if (part === 'top') return topHtml(ctx, ctx.star);
  return bottomHtml(ctx.star);
}

function bindPart(ctx, part, el) {
  if (part === 'head') {
    el.querySelector('[data-d="back"]').addEventListener('click', () => ctx.handlers.onBack?.());
    el.querySelector('[data-d="close"]').addEventListener('click', () => ctx.handlers.onClose?.());
  } else if (part === 'top') {
    el.querySelector('.pv.img img')?.addEventListener('error', () => onImageError(ctx));
    for (const b of el.querySelectorAll('.acts [data-a]')) {
      b.disabled = ctx.busy;
      b.addEventListener('click', () => openOrReveal(ctx, b.dataset.a, b));
    }
  } else {
    const sel = el.querySelector('#aMove');
    if (sel) {
      sel.disabled = ctx.moving;
      sel.addEventListener('change', () => move(ctx, sel));
    }
    el.querySelector('[data-a="del"]').addEventListener('click', () => remove(ctx));
  }
}

// 조각 하나를 다시 그린다. 내용이 같으면 그대로 둔다(이미지를 다시 받지 않고 초점도 남는다)
function renderPart(ctx, part) {
  const el = ctx.container.querySelector(`[data-part="${part}"]`);
  if (!el) return;
  const html = partHtml(ctx, part);
  if (ctx.html[part] === html) return;
  ctx.html[part] = html;
  // data-a가 없는 것(글 미리보기 상자)도 초점을 돌려받는다
  const focusKey = el.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null;
  el.innerHTML = html;
  bindPart(ctx, part, el);
  if (focusKey) el.querySelector(focusKey)?.focus({ preventScroll: true });
}

function showStatus(ctx, state) {
  ctx.statusEl.textContent = MEMO_STATUS[state] ?? MEMO_STATUS.idle;
  ctx.statusEl.classList.toggle('bad', state === 'error' || state === 'toolong');
}

/**
 * 별 상세를 그린다.
 * @param {HTMLElement} container  #panel. 머리까지 통째로 바꾼다
 * @param {object} star            별(서버가 준 모양)
 * @param {object} planet          그 별의 행성
 * @param {{ onBack?: () => void, onClose?: () => void }} handlers  ← 목록으로 / ✕ 패널 닫기
 */
export function renderDetail(container, star, planet, { onBack, onClose } = {}) {
  const id = String(star.id);
  // 늦게 온 다시 받기가 옛 메모를 들고 왔으면 방금 저장한 메모를 쓴다(화면이 쥔 별도 그 자리에서 고친다)
  if (ledger.apply([star])) ledger.apply(store.state.stars);

  // 같은 별이 그려져 있으면 바뀐 조각만 바꾼다
  if (current && current.id === id && current.container === container && current.memoEl.isConnected) {
    current.star = star;
    current.planet = planet;
    current.handlers = { onBack, onClose };
    for (const part of ['head', 'top', 'bottom']) renderPart(current, part);
    return;
  }
  if (current) leave(current).catch(() => {});

  const saver = saverFor(id, star.memo ?? '');
  const ctx = {
    id,
    star,
    planet,
    container,
    saver,
    handlers: { onBack, onClose },
    html: {},
    busy: false,
    moving: false,
    deleting: false,
    imgNote: '',
    memoEl: null,
    statusEl: null,
  };
  container.innerHTML =
    '<header data-part="head"></header>' +
    '<div class="body">' +
    '<div class="dsec" data-part="top"></div>' +
    '<label class="lbl" for="memo">메모</label>' +
    '<textarea id="memo" rows="3" placeholder="이 별에 덧붙일 말" autocomplete="off"></textarea>' +
    '<small class="st" id="memoSt"></small>' +
    '<div class="dsec" data-part="bottom"></div>' +
    '</div>';
  ctx.memoEl = container.querySelector('#memo');
  ctx.statusEl = container.querySelector('#memoSt');
  ctx.memoEl.value = saver.value(); // 저장하지 못하고 떠났던 별이면 쓰던 글이 그대로 있다
  current = ctx;
  for (const part of ['head', 'top', 'bottom']) renderPart(ctx, part);

  showStatus(ctx, saver.state());
  saver.setListener((state) => showStatus(ctx, state));
  // 조합 중인 한글도 input으로 온다. 저장은 화면을 다시 그리지 않으므로 조합을 끊지 않는다
  const typed = () => saver.input(ctx.memoEl.value);
  ctx.memoEl.addEventListener('input', typed);
  ctx.memoEl.addEventListener('compositionend', typed);
  ctx.memoEl.addEventListener('blur', () => {
    if (saver.isDirty()) saver.flush();
  });
}
