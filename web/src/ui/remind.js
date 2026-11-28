// 잠든 별 블랙홀(리마인드) 화면. 오래 안 본 별을 깜깜한 화면에서 한 장씩 보여 주고, 사용자가 고른다.
//   [나중에 다시] 본 때를 지금으로(14일 뒤 다시 모인다) · [알림 끄기] 다시 모으지 않는다(별이 되어 하늘에 박힌다) · 지우기
//   셋 다 5초 동안 [되돌리기]. 지우기는 그 5초가 지나야(또는 화면을 나가면) 실제로 지운다.
//   카드는 처음부터 상세(우주 상세 패널과 같은 칸, 읽기 전용). 이 화면에서 본 것은 "봤음"이 아니다(고르기 전까지 그대로).
//   PC: 카드 양옆 ‹ › · 키보드 ← →. 좁은 화면: 카드 아래 ‹ n / m › · 카드를 옆으로 밀기(넘기기만).
//   오른쪽 위 톱니 = 설정 카드(계정 설정의 "잠든 별 블랙홀" 칸과 같은 부품, remindSettings.js). 기간은 누르는 즉시 저장하고
//   새 기간으로 다시 받는다. "끄기"는 확인 줄을 거쳐 화면을 닫는다.
//   여는 곳은 둘: 우주의 블랙홀(from 'world') · 홈의 잠든 별 안내(from 'home', 우주를 거치지 않는다). 닫으면 온 곳으로 돌아간다.
// 잠든 별 수(store.state.remind = { days, total })도 여기서 센다: 우주의 블랙홀 · 홈 안내가 'remind' 를 듣는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { setInputBlocked } from '../three/controls.js';
import { esc, ico, planetFace } from '../util.js';
import { drawBlackHole, drawKeptStar, drawSky } from './blackholeArt.js';
import { renderReadOnlyDetail } from './detail.js';
import { registerEscape } from './escape.js';
import {
  REMIND_BATCH,
  UNDO_MS,
  ageLabel,
  insertAt,
  remindSub,
  removeAt,
  stepIndex,
  swipeDir,
} from './remindLogic.js';
import { closeRemindSettings, openRemindSettingsIn, remindSettingsBack } from './remindSettings.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const narrow = () => matchMedia('(max-width: 760px)').matches;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const D = (ms) => (reduced() ? 1 : ms);
const CHEV = (d) => `<svg class="i" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const PREV = CHEV('m15 18-6-6 6-6');
const NEXT = CHEV('m9 18 6-6-6-6');

/* ---------- 잠든 별 수 ---------- */

store.state.remind = store.state.remind ?? { days: 14, total: 0 };
let countTimer = 0;
let countSeq = 0;

/** 잠든 별 수를 다시 센다(잠깐 모아서 한 번). 실패하면 그대로 둔다. */
export function refreshRemind({ now = false } = {}) {
  clearTimeout(countTimer);
  const run = async () => {
    const seq = ++countSeq;
    try {
      const res = await api.remind({ limit: 1 });
      if (seq !== countSeq) return;
      store.state.remind = { days: res.days, total: res.total };
      store.emit('remind', store.state.remind);
    } catch {
      /* 다음에 다시 센다 */
    }
  };
  if (now) return run();
  countTimer = setTimeout(run, 250);
  return undefined;
}

/* ---------- 화면 ---------- */

let S = null; // 열려 있는 동안의 상태
let opening = false; // 데이터를 받는 중(두 번 열지 않게)

export const isRemindOpen = () => S !== null;

// 화면 위쪽 가운데의 블랙홀 자리(#remind 안 좌표). remind.css 의 카드 자리와 맞춘다
function holePoint() {
  const w = $('remind').clientWidth;
  return narrow() ? { x: w / 2, y: 142, r: 18 } : { x: w / 2, y: 112, r: 34 };
}

function shell() {
  return (
    '<canvas class="rm-sky" aria-hidden="true"></canvas>' +
    '<div class="rm-head"><p class="rm-eb">잠든 별 블랙홀</p><h2 class="rm-h" id="rmTitle">잠든 별 <b class="rm-n">0</b>개</h2><p class="rm-sub"></p></div>' +
    `<div class="rm-acts"><button type="button" class="btn ghost" data-r="offall">모두 알림 끄기</button>` +
    `<button type="button" class="btn x" data-r="set" aria-label="잠든 별 블랙홀 설정" aria-expanded="false" aria-controls="rmSet">${ico('settings')}</button>` +
    `<button type="button" class="btn x" data-r="exit" aria-label="잠든 별 블랙홀 닫기">${ico('x')}</button></div>` +
    '<div class="rm-confirm card" role="alertdialog" aria-label="모두 알림 끄기 확인" hidden><span>남은 <b class="rm-n">0</b>개 모두 알림을 끌까요?</span>' +
    '<span class="row"><button type="button" class="btn ghost" data-r="offall-no">취소</button><button type="button" class="btn" data-r="offall-yes">모두 알림 끄기</button></span></div>' +
    // 설정 카드: 기간 · 알림 끈 별(remindSettings.js 가 채운다). "끄기"를 고르면 맨 아래에 확인 줄
    '<div class="rm-set card" id="rmSet" role="dialog" aria-label="잠든 별 블랙홀 설정" hidden>' +
    '<div class="rs" data-set="box"></div><div class="rs-all" data-set="all" hidden></div>' +
    '<div class="rm-setoff" role="alertdialog" aria-label="블랙홀 끄기 확인" hidden><span>블랙홀을 끌까요?<br>계정 설정에서 다시 켤 수 있어요.</span>' +
    '<span class="row"><button type="button" class="btn ghost" data-r="setoff-no">취소</button><button type="button" class="btn" data-r="setoff-yes">끄기</button></span></div>' +
    '</div>' +
    '<div class="rm-body">' +
    `<div class="rm-stage"><button type="button" class="btn x rm-nav l" data-r="prev" aria-label="이전 별">${PREV}</button>` +
    '<div class="rm-slot"></div>' +
    `<button type="button" class="btn x rm-nav r" data-r="next" aria-label="다음 별">${NEXT}</button></div>` +
    `<div class="rm-pager"><button type="button" class="btn ghost rm-pg" data-r="prev" aria-label="이전 별">${PREV}</button>` +
    '<span class="rm-dots" aria-hidden="true"></span><span class="rm-pos" aria-live="polite"></span>' +
    `<button type="button" class="btn ghost rm-pg" data-r="next" aria-label="다음 별">${NEXT}</button></div>` +
    '<div class="rm-btns"><button type="button" class="btn" data-r="later">나중에 다시</button><button type="button" class="btn ghost" data-r="off">알림 끄기</button>' +
    '<button type="button" class="linkdel" data-r="del">지우기</button></div>' +
    '<p class="rm-help">나중에 다시 = 14일 뒤 다시 모여요 · 알림 끄기 = 다시 모으지 않아요</p>' +
    '</div>' +
    '<div class="rm-done" hidden><h3>잠든 별을 모두 정리했어요</h3><p>블랙홀이 사라졌어요.<br>오래 안 본 별이 생기면 다시 나타나요.</p>' +
    '<button type="button" class="btn" data-r="exit">우주로 돌아가기</button></div>' +
    '<div class="rm-toast" role="status" aria-live="polite" hidden></div>'
  );
}

const q = (sel) => $('remind').querySelector(sel);
const cardEl = () => q('.rm-slot .rm-card');

function paint() {
  const n = S.queue.length;
  for (const el of $('remind').querySelectorAll('.rm-n')) el.textContent = S.total.toLocaleString('ko-KR');
  q('.rm-sub').textContent = remindSub(S.days);
  q('.rm-help').textContent = `나중에 다시 = ${S.days}일 뒤 다시 모여요 · 알림 끄기 = 다시 모으지 않아요`;
  q('.rm-dots').innerHTML = Array.from({ length: Math.min(n, 10) }, (_, k) => `<i${k === Math.min(S.index, 9) ? ' class="on"' : ''}></i>`).join('');
  q('.rm-pos').textContent = n ? `${S.index + 1} / ${n}` : '';
  q('.rm-done .btn').textContent = S.from === 'home' ? '홈으로 돌아가기' : '우주로 돌아가기';
  for (const b of $('remind').querySelectorAll('[data-r="prev"]')) b.disabled = S.index <= 0;
  for (const b of $('remind').querySelectorAll('[data-r="next"]')) b.disabled = S.index >= n - 1;
}

function cardHtml(star) {
  const planet = store.state.planets.find((p) => String(p.id) === String(star.planet_id));
  return (
    '<article class="rm-card card" aria-roledescription="잠든 별"><div class="rm-in">' +
    `<div class="rm-top"><span class="pname"><span class="dot" style="background:${planetFace(planet)}"></span><span class="t">${esc(planet?.name ?? '')}</span></span>` +
    `<span class="rm-age">${esc(ageLabel(star.seen_at))}</span></div>` +
    `<h3 class="rm-title">${esc(star.title || '제목 없음')}</h3>` +
    '<div class="rdt"></div></div></article>'
  );
}

// 카드 가운데에서 블랙홀까지(카드 좌표)
function toHole(el) {
  const r = el.getBoundingClientRect();
  const root = $('remind').getBoundingClientRect();
  const h = holePoint();
  return { dx: root.left + h.x - (r.left + r.width / 2), dy: root.top + h.y - (r.top + r.height / 2) };
}

/** 지금 별을 그린다. from: 'hole'(블랙홀에서 떠오른다) | 'next' | 'prev'(옆에서 들어온다) | null */
function draw(from = null) {
  if (!S.queue.length) return;
  const star = S.queue[S.index];
  const slot = q('.rm-slot');
  slot.innerHTML = cardHtml(star);
  const last = new Date(star.seen_at);
  const lastText = Number.isNaN(last.getTime()) ? '' : `<dt>마지막으로 본 날</dt><dd>${esc(ageLabel(star.seen_at).replace('째 안 봤어요', ' 전'))}</dd>`;
  renderReadOnlyDetail(slot.querySelector('.rdt'), star, lastText);
  paint();
  const c = cardEl();
  if (from === 'hole') {
    const { dx, dy } = toHole(c);
    c.animate(
      [{ transform: `translate(${dx}px,${dy}px) scale(.08)`, opacity: 0, filter: 'blur(6px)' }, { transform: 'none', opacity: 1, filter: 'none' }],
      { duration: D(560), easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  } else if (from) {
    c.animate([{ transform: `translateX(${from === 'next' ? 60 : -60}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], {
      duration: D(240),
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
  }
}

async function go(dir) {
  if (!S || S.busy) return;
  const to = stepIndex(S.index, dir, S.queue.length);
  if (to === S.index) return;
  S.busy = true;
  const c = cardEl();
  if (c) {
    await c.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${dir > 0 ? -60 : 60}px)`, opacity: 0 }], {
      duration: D(160),
      easing: 'ease-in',
      fill: 'forwards',
    }).finished;
  }
  S.index = to;
  S.busy = false;
  draw(dir > 0 ? 'next' : 'prev');
}

/* ---------- 알림(되돌리기) ---------- */

function showToast(text, undo) {
  const el = q('.rm-toast');
  clearTimeout(S.toastTimer);
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button" data-r="undo">되돌리기</button>' : ''}`;
  el.hidden = false;
  S.toastTimer = setTimeout(() => {
    el.hidden = true;
    expireUndo();
  }, undo ? UNDO_MS : 2600);
}

// 되돌리기 시간이 지났다: 미뤄 둔 지우기를 실제로 한다
function expireUndo() {
  if (!S) return;
  const u = S.undo;
  S.undo = null;
  if (u?.kind === 'del') commitDelete(u.star);
}

function commitDelete(star) {
  if (!S) return Promise.resolve();
  S.deleted = true;
  return api.deleteStar(star.id).catch((err) => {
    if (err?.status !== 404) showToast('지우지 못했어요. 다시 해 주세요', false);
  });
}

/* ---------- 고르기 ---------- */

// 알림 끄기(K1): 카드가 작은 별로 줄어 위로 떠올라 하늘에 박힌다
async function floatToSky(c) {
  const root = $('remind').getBoundingClientRect();
  const r = c.getBoundingClientRect();
  const cx = r.left + r.width / 2 - root.left;
  const cy = r.top + r.height / 2 - root.top;
  const h = holePoint();
  const w = root.width;
  const tx = narrow() ? 30 + Math.random() * (w - 60) : w * 0.18 + Math.random() * w * 0.64;
  const ty = h.y - (narrow() ? 40 : 70) + Math.random() * (narrow() ? 20 : 90);
  await c.animate(
    [
      { transform: 'none', opacity: 1, filter: 'none' },
      { transform: `translate(${(tx - cx) * 0.3}px,${(ty - cy) * 0.3}px) scale(.5)`, opacity: 0.9, filter: 'brightness(1.4)', offset: 0.45 },
      { transform: `translate(${tx - cx}px,${ty - cy}px) scale(.02)`, opacity: 0, filter: 'brightness(2)' },
    ],
    { duration: D(760), easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
  ).finished;
  S.kept.push({ x: tx, y: ty, t0: performance.now() / 1000 });
}

async function leaveCard(kind) {
  const c = cardEl();
  if (!c) return;
  if (kind === 'off') return floatToSky(c);
  const { dx, dy } = toHole(c);
  const frames =
    kind === 'later'
      ? [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.05) rotate(220deg)`, opacity: 0 }]
      : [{ transform: 'none', opacity: 1 }, { transform: 'translateY(140px) rotate(-8deg) scale(.92)', opacity: 0 }];
  await c.animate(frames, {
    duration: D(kind === 'del' ? 380 : 620),
    easing: kind === 'del' ? 'ease-in' : 'cubic-bezier(.55,0,.8,.4)',
    fill: 'forwards',
  }).finished;
}

const DONE_TEXT = { later: '', off: '이 별은 다시 알리지 않을게요', del: '' };

async function decide(kind) {
  if (!S || S.busy || !S.queue.length) return;
  S.busy = true;
  expireUndo(); // 앞의 되돌리기는 여기서 끝(미뤄 둔 지우기는 지금 지운다)
  const idx = S.index;
  const star = S.queue[idx];
  let revert = null;
  try {
    if (kind === 'later') {
      const prev = star.seen_at;
      await api.seenStar(star.id);
      revert = () => api.patchStar(star.id, { seen_at: prev });
    } else if (kind === 'off') {
      await api.setRemindOff([star.id], true);
      revert = () => api.patchStar(star.id, { remind_off: false });
    }
  } catch {
    S.busy = false;
    showToast('바꾸지 못했어요. 다시 눌러 주세요', false);
    return;
  }
  await leaveCard(kind);
  ({ queue: S.queue, index: S.index } = removeAt(S.queue, idx));
  S.total = Math.max(0, S.total - 1);
  S.changed = true;
  S.undo = { kind, star, idx, revert };
  const text =
    kind === 'later' ? `${S.days}일 뒤에 다시 알려 드릴게요` : kind === 'off' ? DONE_TEXT.off : `"${star.title || '제목 없음'}" 지웠어요`;
  showToast(text, true);
  S.busy = false;
  if (S.queue.length) draw('hole');
  else await nextBatch();
}

async function undo() {
  const u = S?.undo;
  if (!u || S.busy) return;
  S.undo = null;
  clearTimeout(S.toastTimer);
  q('.rm-toast').hidden = true;
  if (u.revert) {
    try {
      await u.revert();
    } catch {
      showToast('되돌리지 못했어요', false);
      return;
    }
  }
  if (u.kind === 'off') S.kept.pop();
  if (!q('.rm-done').hidden) unfinish();
  ({ queue: S.queue, index: S.index } = insertAt(S.queue, u.idx, u.star));
  S.total += 1;
  draw('hole');
}

// 받아 둔 20개를 다 정리했다: 더 있으면 다음 20개, 없으면 끝
async function nextBatch() {
  if (S.total > 0) {
    try {
      const res = await api.remind({ limit: REMIND_BATCH });
      const pending = S.undo?.kind === 'del' ? String(S.undo.star.id) : null;
      S.queue = res.stars.filter((s) => String(s.id) !== pending);
      S.total = res.total - (pending && res.stars.some((s) => String(s.id) === pending) ? 1 : 0);
      S.days = res.days;
      S.index = 0;
    } catch {
      S.queue = [];
    }
  }
  if (S.queue.length) draw('hole');
  else finish();
}

function finish({ focus = true } = {}) {
  q('.rm-body').hidden = true;
  q('.rm-acts [data-r="offall"]').hidden = true;
  const done = q('.rm-done');
  done.hidden = false;
  scaleHole(0, 900);
  done.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], {
    duration: D(500),
    delay: D(400),
    fill: 'backwards',
  });
  paint();
  if (focus) done.querySelector('.btn').focus({ preventScroll: true });
}

function unfinish() {
  q('.rm-body').hidden = false;
  q('.rm-done').hidden = true;
  q('.rm-acts [data-r="offall"]').hidden = false;
  scaleHole(1, 600);
}

async function offAll() {
  q('.rm-confirm').hidden = true;
  if (!S || S.busy) return;
  S.busy = true;
  expireUndo();
  let n = 0;
  try {
    let ids = S.queue.map((s) => s.id);
    for (let round = 0; ids.length && round < 50; round += 1) {
      n += (await api.setRemindOff(ids, true)).changed;
      const res = await api.remind({ limit: 100 });
      ids = res.stars.map((s) => s.id);
    }
  } catch {
    S.busy = false;
    showToast('알림을 끄지 못했어요. 다시 해 주세요', false);
    return;
  }
  S.queue = [];
  S.total = 0;
  S.changed = true;
  S.busy = false;
  q('.rm-slot').innerHTML = '';
  showToast(`${n.toLocaleString('ko-KR')}개 모두 알림을 껐어요`, false);
  finish();
}

/* ---------- 설정 카드 ---------- */

const setOpen = () => Boolean(S) && !q('.rm-set').hidden;

function settingsHost() {
  const card = q('.rm-set');
  return {
    box: card.querySelector('[data-set="box"]'),
    all: card.querySelector('[data-set="all"]'),
    wrap: card,
    backLabel: '설정으로 돌아가기',
    onDays: changeDays,
    say: (text) => showToast(text, false),
  };
}

function toggleSettings(open, { focus = true } = {}) {
  const card = q('.rm-set');
  const btn = q('[data-r="set"]');
  if (open === !card.hidden) return;
  card.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  q('.rm-setoff').hidden = true;
  if (open) {
    q('.rm-confirm').hidden = true;
    S.setHost = settingsHost();
    openRemindSettingsIn(S.setHost).then(() => {
      if (setOpen()) card.querySelector('[data-rs="days"][aria-checked="true"]')?.focus({ preventScroll: true });
    });
  } else {
    closeRemindSettings(S.setHost);
    S.setHost = null;
    if (focus) btn.focus({ preventScroll: true });
  }
}

// 기간을 눌렀다(설정 카드). 저장됐으면 true. "끄기"는 확인 줄에서 답을 받은 뒤에 정한다
function changeDays(days) {
  if (!S || S.busy) return Promise.resolve(false);
  if (days === 0) {
    const row = q('.rm-setoff');
    row.hidden = false;
    row.querySelector('[data-r="setoff-no"]').focus({ preventScroll: true });
    return Promise.resolve(false);
  }
  return applyDays(days);
}

// 새 기간을 저장하고 잠든 별을 그 기간으로 다시 받는다
async function applyDays(days) {
  S.busy = true;
  try {
    // 되돌리기는 여기서 끝낸다(미뤄 둔 지우기는 지금 지운다): 다시 받는 목록에 지운 별이 섞이지 않게
    clearTimeout(S.toastTimer);
    q('.rm-toast').hidden = true;
    const u = S.undo;
    S.undo = null;
    if (u?.kind === 'del') await commitDelete(u.star);
    await api.saveRemindSettings(days);
    const res = await api.remind({ limit: REMIND_BATCH });
    if (!S) return true;
    S.queue = res.stars;
    S.total = res.total;
    S.days = res.days;
    S.index = 0;
    S.changed = true;
  } catch {
    if (S) {
      S.busy = false;
      showToast('기간을 바꾸지 못했어요. 다시 눌러 주세요', false);
    }
    return false;
  }
  S.busy = false;
  if (S.queue.length) {
    if (!q('.rm-done').hidden) unfinish();
    draw('hole');
  } else {
    q('.rm-slot').innerHTML = '';
    if (q('.rm-done').hidden) finish({ focus: false });
    else paint();
  }
  showToast(`${days}일 넘게 열어 보지 않은 별을 모았어요`, false);
  return true;
}

// "끄기"를 확인했다: 저장하고 화면을 닫는다(블랙홀이 없어진다)
async function turnOffRemind() {
  if (!S || S.busy) return;
  S.busy = true;
  try {
    await api.saveRemindSettings(0);
  } catch {
    S.busy = false;
    showToast('끄지 못했어요. 다시 눌러 주세요', false);
    return;
  }
  S.busy = false;
  await closeRemind();
  toast('잠든 별 블랙홀을 껐어요. 계정 설정에서 다시 켤 수 있어요');
}

/* ---------- 하늘(블랙홀 · 알림 끈 별) ---------- */

function scaleHole(to, ms) {
  const from = S.hole;
  const t0 = performance.now();
  const step = (now) => {
    if (!S) return;
    const k = Math.max(0, Math.min(1, (now - t0) / D(ms)));
    S.hole = from + (to - from) * (1 - (1 - k) ** 3);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function skyLoop(now) {
  if (!S) return;
  const cv = q('.rm-sky');
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  const t = reduced() ? 3 : now / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawSky(ctx, w, h, t);
  const p = holePoint();
  if (S.hole > 0.01) drawBlackHole(ctx, p.x, p.y, p.r * S.hole, t);
  for (const k of S.kept) drawKeptStar(ctx, k.x, k.y, narrow() ? 5 : 7, now / 1000 - k.t0, t);
  S.raf = requestAnimationFrame(skyLoop);
}

/* ---------- 밀기(좁은 화면) ---------- */

function bindSwipe(stage) {
  let sx = null;
  let sy = 0;
  let dx = 0;
  let moved = false;
  stage.addEventListener('pointerdown', (e) => {
    if (!narrow()) return;
    sx = e.clientX;
    sy = e.clientY;
    dx = 0;
    moved = false;
  });
  stage.addEventListener('pointermove', (e) => {
    if (sx === null) return;
    dx = e.clientX - sx;
    if (Math.abs(dx) < 10 || Math.abs(e.clientY - sy) > Math.abs(dx)) return;
    moved = true;
    const c = cardEl();
    if (c) c.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
  });
  const end = (e) => {
    if (sx === null) return;
    const dir = swipeDir(dx, (e?.clientY ?? sy) - sy);
    sx = null;
    const c = cardEl();
    if (dir && stepIndex(S.index, -dir, S.queue.length) !== S.index) {
      if (c) c.style.transform = '';
      go(-dir);
    } else if (c) {
      c.style.transition = 'transform .2s';
      c.style.transform = '';
      setTimeout(() => {
        c.style.transition = '';
      }, 220);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  // 밀기로 바뀌면 손을 뗄 때의 누름(카드 안 버튼)은 버린다
  stage.addEventListener(
    'click',
    (e) => {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    },
    true,
  );
}

/* ---------- 열기 · 닫기 ---------- */

function onClick(e) {
  const r = e.target.closest('[data-r]')?.dataset.r;
  // 설정 카드 밖을 누르면 카드를 접는다(톱니 자신은 아래에서 여닫는다)
  if (setOpen() && r !== 'set' && !e.target.closest('.rm-set')) toggleSettings(false, { focus: false });
  if (!r) return;
  if (r === 'set') toggleSettings(q('.rm-set').hidden);
  else if (r === 'setoff-no') {
    q('.rm-setoff').hidden = true;
    q('.rm-set [data-rs="days"][aria-checked="true"]')?.focus({ preventScroll: true });
  } else if (r === 'setoff-yes') turnOffRemind();
  else if (r === 'prev') go(-1);
  else if (r === 'next') go(1);
  else if (r === 'later' || r === 'off' || r === 'del') decide(r);
  else if (r === 'undo') undo();
  else if (r === 'offall') {
    toggleSettings(false, { focus: false });
    q('.rm-confirm').hidden = false;
    q('.rm-confirm [data-r="offall-no"]').focus({ preventScroll: true });
  } else if (r === 'offall-no') q('.rm-confirm').hidden = true;
  else if (r === 'offall-yes') offAll();
  else if (r === 'exit') closeRemind();
}

function onKey(e) {
  if (!S || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
  if (setOpen()) return; // 설정 카드가 열려 있으면 별을 넘기지 않는다
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    go(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    go(-1);
  }
}

/**
 * 잠든 별 화면을 연다. 데이터를 받은 뒤(after 가 있으면 그것도 끝난 뒤) 보인다. 받지 못하면 열지 않고 false.
 * @param {{ from?: 'world' | 'home', after?: Promise, onHide?: () => void, onClose?: (info: { changed: boolean, deleted: boolean }) => void }} opts
 *   from: 온 곳(끝 화면의 돌아가기 버튼 이름) · onHide: 닫힐 때 화면을 숨기기 바로 전(같은 차례) ·
 *   onClose: 다 닫은 뒤(지우기 · 다시 세기까지 끝난 뒤)
 */
export async function openRemind({ from = 'world', after, onHide, onClose } = {}) {
  if (S || opening) return true;
  opening = true;
  let res;
  try {
    res = await api.remind({ limit: REMIND_BATCH });
    await after;
  } catch {
    return false;
  } finally {
    opening = false;
  }
  const root = $('remind');
  root.innerHTML = shell();
  S = {
    queue: res.stars,
    total: res.total,
    days: res.days,
    index: 0,
    busy: false,
    undo: null,
    toastTimer: 0,
    kept: [],
    hole: 1,
    raf: 0,
    changed: false,
    deleted: false,
    from,
    setHost: null,
    onHide,
    onClose,
    focusBack: document.activeElement,
  };
  root.hidden = false;
  root.addEventListener('click', onClick);
  addEventListener('keydown', onKey);
  bindSwipe(q('.rm-stage'));
  S.raf = requestAnimationFrame(skyLoop);
  if (S.queue.length) draw('hole');
  else finish();
  paint();
  q('[data-r="later"]')?.focus({ preventScroll: true });
  return true;
}

/** 닫는다. 미뤄 둔 지우기는 지금 지우고, 잠든 별 수를 다시 센다. */
export async function closeRemind() {
  if (!S) return;
  const s = S;
  clearTimeout(s.toastTimer);
  const pending = s.undo?.kind === 'del' ? s.undo.star : null;
  s.undo = null;
  const work = pending ? commitDelete(pending) : Promise.resolve();
  cancelAnimationFrame(s.raf);
  closeRemindSettings(s.setHost);
  S = null;
  const root = $('remind');
  root.removeEventListener('click', onClick);
  removeEventListener('keydown', onKey);
  s.onHide?.();
  root.hidden = true;
  root.innerHTML = '';
  await work;
  if (s.deleted || pending) store.reload();
  refreshRemind({ now: true });
  s.onClose?.({ changed: s.changed, deleted: s.deleted || Boolean(pending) });
  if (s.focusBack?.isConnected) s.focusBack.focus?.({ preventScroll: true });
}

/** 한 번만: 잠든 별 수를 세는 때를 건다. */
export function initRemind() {
  store.on('data', () => refreshRemind());
  store.on('seen', () => refreshRemind());
  refreshRemind({ now: true });
}

// Esc: 확인 줄이 떠 있으면 그것부터, 아니면 닫는다(행성 꾸미기 창 70 보다 위: 이 화면이 맨 위를 덮는다)
registerEscape(80, () => {
  if (!S) return false;
  const confirm = q('.rm-confirm');
  const setoff = q('.rm-setoff');
  if (confirm && !confirm.hidden) confirm.hidden = true;
  else if (setOpen()) {
    // 설정 카드: 끄기 확인 줄 → 알림 끈 별 전체 목록 → 카드 순으로 하나씩 접는다
    if (!setoff.hidden) setoff.hidden = true;
    else if (!remindSettingsBack()) toggleSettings(false);
  } else closeRemind();
  return true;
});

// 열려 있는 동안 비행 키를 막는다(← → 는 별 넘기기)
setInputBlocked(() => S !== null);
