// 우주 → 잠든 별 블랙홀 화면으로 빨려 들어가기(시안 S1), 나올 때는 거꾸로.
// 우주 화면을 한 장 찍어(WebGL 캔버스) 그 위에 그린다: 화면이 블랙홀 쪽으로 줄어들며 안쪽으로 줄무늬 잔상(줌 블러)을 남기고,
// 블랙홀이 커져 화면을 덮은 뒤 잠든 별 화면이 열린다. 위의 조작 UI 는 찍은 장면이 덮으며 흐려진다.
// "동작 줄이기"면 짧게 흐려지기만 한다.
// 홈의 잠든 별 안내로 올 때는 우주를 거치지 않는다: 안내 자리에서 어두운 원이 퍼져 화면을 덮고 잠든 별 화면이 열린다.
// 닫으면 홈으로 돌아온다(openFromHome).
import { store } from '../store.js';
import { settleBlackHole, blackHoleOnScreen } from '../three/blackhole.js';
import { stopFlight } from '../three/controls.js';
import { camera, renderer, scene } from '../three/scene.js';
import { drawBlackHole } from './blackholeArt.js';
import { closeRemind, isRemindOpen, openRemind, refreshRemind } from './remind.js';
import { toast } from './toast.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let busy = false;

// 지금 우주 화면을 2D 캔버스로 찍는다(그린 직후 같은 차례에 복사해야 비어 있지 않다)
function snapshot() {
  if (!renderer || !scene || !camera) return null;
  const src = renderer.domElement;
  const w = src.clientWidth;
  const h = src.clientHeight;
  if (!w || !h) return null;
  settleBlackHole();
  renderer.render(scene, camera);
  const shot = document.createElement('canvas');
  shot.width = src.width;
  shot.height = src.height;
  shot.getContext('2d').drawImage(src, 0, 0);
  const hole = blackHoleOnScreen(camera, w, h) ?? { x: w * 0.8, y: h * 0.4, r: 20, gone: true };
  return { shot, w, h, hole };
}

function overlay() {
  const cv = document.createElement('canvas');
  cv.id = 'remindDive';
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:40;pointer-events:auto;opacity:0;transition:opacity .2s';
  document.body.append(cv);
  return cv;
}

// 한 장면: p = 0(우주 그대로) → 1(블랙홀이 화면을 덮음)
function frame(cv, snap, p, t, withHole) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const { w, h, hole, shot } = snap;
  if (cv.width !== Math.round(w * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05030d';
  ctx.fillRect(0, 0, w, h);
  // 화면이 블랙홀로 줄어들며 안쪽으로 잔상
  const base = Math.max(0.002, 1 - p ** 1.25);
  for (let j = 0; j <= 14; j += 1) {
    const sc = base * (1 - j * 0.06 * p);
    if (sc <= 0.002) break;
    ctx.save();
    ctx.globalAlpha = j ? 0.55 * (1 - j / 15) * Math.min(1, p * 3) : 1;
    ctx.translate(hole.x, hole.y);
    ctx.scale(sc, sc * (1 - 0.3 * p));
    ctx.translate(-hole.x, -hole.y);
    ctx.drawImage(shot, 0, 0, w, h);
    ctx.restore();
  }
  // 빛이 번진다
  const reach = Math.hypot(w, h);
  const g = ctx.createRadialGradient(hole.x, hole.y, 0, hole.x, hole.y, reach * 0.6);
  g.addColorStop(0, `rgba(255,170,90,${(0.35 * p).toFixed(3)})`);
  g.addColorStop(1, 'rgba(255,120,50,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  if (withHole) {
    const grow = (reach / hole.r) * 0.55;
    drawBlackHole(ctx, hole.x, hole.y, hole.r * (1 + p ** 2.4 * grow), t);
  }
}

function run(cv, snap, from, to, ms, ease, withHole) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const dur = reduced() ? 1 : ms;
    const step = (now) => {
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      frame(cv, snap, from + (to - from) * ease(k), now / 1000, withHole);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** 블랙홀로 빨려 들어가 잠든 별 화면을 연다. 우주 안에서만. 던지지 않는다. */
export async function diveIntoRemind() {
  if (busy || isRemindOpen() || !store.state.inWorld) return false;
  busy = true;
  try {
    stopFlight();
    const snap = snapshot();
    if (!snap) {
      const ok = await openRemind({ onClose: () => {} });
      if (!ok) toast('잠든 별을 불러오지 못했어요');
      return ok;
    }
    const cv = overlay();
    frame(cv, snap, 0, performance.now() / 1000, !snap.hole.gone);
    requestAnimationFrame(() => {
      cv.style.opacity = '1';
    });
    // 받는 동안 빨려 들고, 빨려 든 뒤에 잠든 별 화면이 보인다
    const sucking = run(cv, snap, 0, 1, reduced() ? 200 : 1800, (k) => k ** 1.7, !snap.hole.gone);
    const ok = await openRemind({
      after: sucking,
      onHide: () => {
        cv.style.visibility = 'visible'; // 닫히는 순간 마지막 장면(블랙홀이 덮은 화면)으로 이어 준다
      },
      onClose: () => surface(cv),
    });
    await sucking;
    if (!ok) {
      toast('잠든 별을 불러오지 못했어요');
      await run(cv, snap, 1, 0, 600, (k) => 1 - (1 - k) ** 3, !snap.hole.gone);
      cv.remove();
      return false;
    }
    cv.style.visibility = 'hidden'; // 잠든 별 화면이 덮는다(나올 때 다시 쓴다)
    return true;
  } finally {
    busy = false;
  }
}

// 잠든 별 화면을 닫았다: 지금 우주를 다시 찍어(정리했으면 블랙홀이 없다) 거꾸로 풀어낸다
async function surface(cv) {
  busy = true;
  try {
    await refreshRemind({ now: true });
    const snap = snapshot();
    if (!snap) {
      cv.remove();
      return;
    }
    await run(cv, snap, 1, 0, reduced() ? 200 : 1000, (k) => 1 - (1 - k) ** 3, !snap.hole.gone);
    cv.style.opacity = '0';
    setTimeout(() => cv.remove(), 220);
  } finally {
    busy = false;
  }
}

// 홈 위를 덮는 어두운 막. 잠든 별 화면(#remind, z 41)과 같은 색이라 막이 다 퍼진 뒤 화면이 열려도 이어져 보인다
function veil() {
  const el = document.createElement('div');
  el.id = 'remindDive'; // 떠 있는 동안 앱 알림을 숨긴다(remind.css)
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;inset:0;z-index:40;background:#05030d;pointer-events:auto';
  document.body.append(el);
  return el;
}

// 막을 (x, y)에서 원으로 펼치거나(open) 그 자리로 오므린다. 동작 줄이기면 흐려지기만 한다
function sweep(el, x, y, open, ms) {
  const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 8;
  const at = `at ${x}px ${y}px`;
  const frames = reduced()
    ? [{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }]
    : [{ clipPath: `circle(${open ? 0 : far}px ${at})` }, { clipPath: `circle(${open ? far : 0}px ${at})` }];
  return el.animate(frames, { duration: reduced() ? 200 : ms, easing: open ? 'cubic-bezier(.5,0,.9,.5)' : 'cubic-bezier(.1,.5,.3,1)', fill: 'forwards' }).finished;
}

/** 홈의 잠든 별 안내에서 바로 잠든 별 화면을 연다(우주를 거치지 않는다). 닫으면 홈으로 돌아온다. 던지지 않는다. */
export async function openRemindFromHome() {
  if (busy || isRemindOpen() || store.state.inWorld) return false;
  busy = true;
  try {
    // 안내 알약의 가운데에서 퍼진다(없으면 화면 가운데)
    const r = document.getElementById('hRemind')?.getBoundingClientRect();
    const x = r && r.width ? r.left + r.width / 2 : innerWidth / 2;
    const y = r && r.height ? r.top + r.height / 2 : innerHeight / 2;
    const el = veil();
    const covering = sweep(el, x, y, true, 320);
    const ok = await openRemind({
      from: 'home',
      after: covering,
      onHide: () => {
        el.style.visibility = 'visible'; // 닫히는 순간 막으로 이어 준다
      },
      onClose: async () => {
        await sweep(el, x, y, false, 380);
        el.remove();
      },
    });
    await covering;
    if (!ok) {
      await sweep(el, x, y, false, 300);
      el.remove();
      toast('잠든 별을 불러오지 못했어요');
      return false;
    }
    el.style.visibility = 'hidden'; // 잠든 별 화면이 덮는다(나올 때 다시 쓴다)
    return true;
  } finally {
    busy = false;
  }
}

/**
 * 'blackHole'(우주의 블랙홀을 누름) → 빨려 들어간다.
 * 'remindFromHome'(홈 안내를 누름) → 우주를 거치지 않고 바로 잠든 별 화면을 연다.
 * 우주에서 나가면(홈으로) 열려 있던 잠든 별 화면도 닫는다.
 */
export function initRemindTransition() {
  store.on('blackHole', () => diveIntoRemind());
  store.on('remindFromHome', () => (store.state.inWorld ? diveIntoRemind() : openRemindFromHome()));
  store.on('leaveWorld', () => {
    if (isRemindOpen()) closeRemind();
  });
}
