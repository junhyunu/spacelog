// 우주 → 잠든 별 블랙홀 화면으로 빨려 들어가기(시안 S1), 나올 때는 거꾸로.
// 우주 화면을 한 장 찍어(WebGL 캔버스) 그 위에 그린다: 화면이 블랙홀 쪽으로 줄어들며 안쪽으로 줄무늬 잔상(줌 블러)을 남기고,
// 블랙홀이 커져 화면을 덮은 뒤 잠든 별 화면이 열린다. 위의 조작 UI 는 찍은 장면이 덮으며 흐려진다.
// "동작 줄이기"면 짧게 흐려지기만 한다.
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

/**
 * 'blackHole'(우주의 블랙홀을 누름) → 빨려 들어간다.
 * 'remindFromHome'(홈 안내를 누름) → 우주로 들어가 블랙홀을 잠깐 보인 뒤 빨려 들어간다.
 * 우주에서 나가면(홈으로) 열려 있던 잠든 별 화면도 닫는다.
 * enter: transition.js 의 enterWorld(서로 불러오지 않도록 main.js 가 넘겨준다)
 */
export function initRemindTransition({ enter } = {}) {
  store.on('blackHole', () => diveIntoRemind());
  store.on('remindFromHome', async () => {
    if (store.state.inWorld) return diveIntoRemind();
    if (typeof enter !== 'function' || !(await enter({}))) return false;
    await new Promise((r) => setTimeout(r, reduced() ? 0 : 700));
    return diveIntoRemind();
  });
  store.on('leaveWorld', () => {
    if (isRemindOpen()) closeRemind();
  });
}
