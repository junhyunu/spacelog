// 블랙홀 전환(W-00 → W-01, DESIGN.md 9-1)과 돌아가기(9-2).
// 시안 989~1043행(wait · tween · hole · enter · leave)을 옮겼다(시간 · 곡선 그대로).
//
// store로 알리는 것:
//   'enterWorld'   { planetId, starId }   전환과 조작 UI 페이드 인이 끝난 뒤(자동 비행 시작 전). 없으면 null
//   'leavingWorld'                        돌아가기를 시작할 때(패널 닫기 · 메모 저장 등 정리할 틈)
//   'leaveWorld'                          홈이 다시 나타난 뒤
//   'guestStar'    star                   들어온 별이 지금 기간 밖일 때, 날아가기 직전(Task 8이 그 별만 핑크로 보여 준다)
//   'land'         planetId               행성을 눌러 들어와 도착했을 때
//   'openStar'     { planetId, starId }   별(최근 별)을 눌러 들어와 도착했을 때
//   'offline'                             4단계에서 연결이 끊겨 홈으로 되돌아갔을 때(연결 실패 카드를 홈에 띄우게)
// store.state.inWorld는 잉크 막 뒤에서(4단계 시작 · 돌아가기의 구멍이 닫힌 뒤) 바뀐다.
// 4단계의 store.reload()가 내는 'data'는 inWorld가 이미 true인 채로 온다.
import { api } from '../api.js';
import { store } from '../store.js';
import { setCharacterLook } from '../three/character.js';
import { enterOverview, flyTo, setInputBlocked, startLoop, stopFlight } from '../three/controls.js';
import { initScene } from '../three/scene.js';
import { renderHome, resumeEmblem, setEmblemSpin } from './home.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
// 터치 기기(폰 · 태블릿): WASD도 없고 왼쪽 패널도 접혀 있어 첫 비행 안내("WASD로 날아보거나…")를 띄우지 않는다
const touchMq = typeof matchMedia === 'function' ? matchMedia('(hover: none), (pointer: coarse)') : { matches: false };

// 들어오면 보이는 조작 UI. #left(왼쪽 패널 · 접힌 로고 버튼)와 #period(기간 바 + 띠 배너)는 스펙 6-8 배치.
// #worldMsg · #near · #wHint(빈 우주 말풍선) · #panel은 주인(hud.js · main.js · controls.js · panel.js)이 켜고 끈다.
const WORLD_UI = ['left', 'period', 'wLog'];
const WORLD_UI_ALL = [...WORLD_UI, 'worldMsg', 'near', 'wHint'];
const ENTERING = 'world-entering'; // body에 붙어 있는 동안 조작 UI가 투명하다(app.css)

const OPEN_TIMEOUT = 8000; // 4단계(3D 준비 + 데이터)를 기다려 주는 한도
const FAIL_MSG = '우주를 열지 못했어요. 다시 눌러 주세요';

let busy = false; // 전환 중
let isLeaving = false; // 돌아가기 진행 중
let epoch = 0; // 4단계의 세대. 중단하면 올려서 늦게 끝난 준비가 화면을 바꾸지 못하게 한다
let skippable = false; // 1 ~ 3단계
let skip = false;
let wakeSkip = null;
const openHooks = new Set();

/** 전환(들어가기 · 돌아가기)이 진행 중인지. */
export const isTransitioning = () => busy;

/**
 * 4단계(잉크 막 뒤)에서 데이터를 받은 직후, 우주가 열리기 전에 기다려 줄 일을 더한다.
 * fn({ planetId, starId })이 Promise를 돌려주면 끝날 때까지 구멍을 열지 않는다(예: 기간 넓히고 다시 받기).
 * 돌려주는 함수를 부르면 뺀다.
 */
export function onBeforeWorldOpens(fn) {
  if (typeof fn !== 'function') return () => {};
  openHooks.add(fn);
  return () => openHooks.delete(fn);
}

/* ---------- 시안의 도우미 ---------- */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// 건너뛸 수 있는 기다림: 건너뛰기가 눌리면 바로 끝난다
const wait = (ms) =>
  new Promise((res) => {
    if (skip) return res();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (wakeSkip === done) wakeSkip = null;
      res();
    }
    wakeSkip = done;
  });
const tween = (ms, fn, ease) =>
  new Promise((res) => {
    const t0 = performance.now();
    (function f() {
      const p = Math.min((performance.now() - t0) / ms, 1);
      fn(ease ? ease(p) : p);
      if (p < 1) requestAnimationFrame(f);
      else res();
    })();
  });
const outExpo = (p) => 1 - Math.pow(1 - p, 3.2);
const diag = () => Math.hypot(innerWidth, innerHeight) / 2 + 30;
const hole = (R) => {
  $('veil').style.background = `radial-gradient(circle at 50% 50%, transparent ${R}px, #1a1430 ${R + 3}px)`;
};
function resetVeil() {
  const s = $('veil').style;
  s.background = '';
  s.opacity = '';
  s.clipPath = '';
}

function requestSkip() {
  if (!busy || !skippable || skip) return;
  skip = true;
  wakeSkip?.();
}

function cancelHomeAnimations() {
  $('home')
    .querySelectorAll('*')
    .forEach((el) => el.getAnimations?.().forEach((a) => a.cancel()));
}

function hideWorldUi() {
  for (const id of [...WORLD_UI_ALL, 'panel']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  document.body.classList.remove(ENTERING);
}

// 6단계: 조작 UI 200ms 페이드 인 + 위로 8px. 요소의 transform(가운데 정렬)은 건드리지 않게 translate를 쓴다.
async function fadeInWorldUi(reduce) {
  document.body.classList.remove(ENTERING);
  const from = reduce ? { opacity: 0 } : { opacity: 0, translate: '0 8px' };
  const to = reduce ? { opacity: 1 } : { opacity: 1, translate: '0 0' };
  for (const id of WORLD_UI_ALL) {
    const el = $(id);
    if (el && !el.hidden) el.animate?.([from, to], { duration: 200, easing: 'ease-out' });
  }
  await sleep(200);
}

// 4단계에서 실패했을 때: 잉크 막이 남지 않게 홈으로 되돌린다
async function abortToHome(err) {
  const veil = $('veil');
  const home = $('home');
  veil.classList.remove('waiting');
  store.state.inWorld = false;
  hideWorldUi();
  home.hidden = false;
  home.inert = false;
  resumeEmblem();
  if (err?.code === 'offline') {
    store.emit('offline'); // inWorld가 false가 된 뒤 다시 알려 연결 실패 카드를 홈에 띄운다
  } else {
    console.error('[transition] 우주에 들어가지 못했어요', err);
    toast(
      err?.code === 'timeout'
        ? FAIL_MSG
        : err?.name === 'ApiError'
          ? '우주를 불러오지 못했어요. 다시 눌러 주세요'
          : '3D 화면을 열지 못했어요. 브라우저를 확인하고 다시 눌러 주세요',
    );
  }
  veil.style.background = '';
  veil.style.clipPath = '';
  await tween(250, (p) => (veil.style.opacity = 1 - p));
  veil.hidden = true;
  resetVeil();
  busy = false;
}

// 전환 도중 예상하지 못한 오류: 애니메이션 없이 바로 홈으로 되돌린다.
// 한 단계가 실패해도 나머지는 끝까지 한다(막이 남거나 홈이 잠긴 채로 두지 않는다).
function recoverHome(err) {
  console.error('[transition] 전환 중 오류', err);
  const safely = (fn) => {
    try {
      fn();
    } catch (e) {
      console.error('[transition] 되돌리는 중 오류', e);
    }
  };
  epoch++; // 아직 돌고 있는 4단계 준비를 버린다
  skippable = false;
  safely(stopFlight);
  store.state.inWorld = false;
  store.state.panelPlanetId = null;
  store.state.detailStarId = null;
  safely(hideWorldUi);
  safely(cancelHomeAnimations);
  safely(() => {
    const veil = $('veil');
    veil.classList.remove('waiting');
    veil.hidden = true;
    resetVeil();
  });
  safely(() => {
    const home = $('home');
    home.hidden = false;
    home.inert = false;
    home.querySelector('.home-stars').style.transformOrigin = '';
  });
  safely(() => setEmblemSpin(0.22));
  safely(resumeEmblem);
  busy = false;
  isLeaving = false;
  safely(() => toast(FAIL_MSG));
  renderHome(); // 던지지 않는다
}

// 4단계: 3D 준비 + 데이터 받기(최소 380ms) + 열기 전 할 일. 들어갈 별({ star, starGone })을 돌려준다.
// 기다리는 사이 중단됐으면(token이 지난 세대) 더 진행하지 않고 던진다.
async function prepareWorld(token, { planetId, starId }) {
  const alive = () => {
    if (token !== epoch) throw Object.assign(new Error('stale'), { code: 'stale' });
  };
  initScene($('stage')); // 처음 들어올 때만 만든다. WebGL을 못 쓰면 여기서 던진다
  setCharacterLook(store.state.character); // 고른 모습으로 만든다(스펙 6-10). 같은 모습이면 아무 일도 없다
  startLoop();
  enterOverview();
  let starGone = false;
  const starReq =
    starId === null
      ? null
      : api.star(starId).catch((err) => {
          starGone = err?.status === 404; // 지워진 별. 그 밖의 실패는 행성만 연다
          return null;
        });
  const [, , star] = await Promise.all([sleep(380), store.reload(), starReq]);
  alive();
  for (const fn of [...openHooks]) {
    await fn({ planetId, starId });
    alive();
  }
  // 첫 장면이 그려질 틈(탭이 숨겨져 있으면 기다리지 않는다)
  await Promise.race([new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))), sleep(200)]);
  alive();
  return { star, starGone };
}

/**
 * 홈에서 블랙홀을 지나 우주로 들어간다(DESIGN.md 9-1의 5단계 + 조작 UI 200ms 페이드 인).
 * planetId가 있으면 끝난 뒤 그 행성으로 자동 비행하고, 도착하면 'land'(별이 있으면 'openStar')를 알린다.
 * 그 행성(별)이 그 사이 지워졌으면 날아가지 않고 토스트로 알린다.
 * 들어갔으면 true, 이미 전환 중 · 우주 안 · 연결 끊김이거나 4단계에서 실패 · 8초를 넘겨 홈으로 되돌아갔으면 false.
 * 어디서 오류가 나도 홈으로 되돌리고 false. 던지지 않는다.
 */
export async function enterWorld(target = {}) {
  if (busy || store.state.inWorld || store.state.offline) return false;
  busy = true;
  try {
    return await runEnter(target || {});
  } catch (err) {
    recoverHome(err);
    return false;
  }
}

async function runEnter({ planetId, starId }) {
  skip = false;
  skippable = true;
  const home = $('home');
  const veil = $('veil');
  const enterBtn = $('enterBtn');
  const reduce = reduceMq.matches;
  const hasPlanet = planetId !== undefined && planetId !== null && planetId !== '';
  const hasStar = hasPlanet && starId !== undefined && starId !== null && starId !== '';
  home.inert = true; // 전환 중에는 홈의 다른 버튼이 눌리지 않는다
  resetVeil();

  if (reduce) {
    // 모션 줄이기: 블랙홀 · 흡입 없이 200ms 잉크 페이드
    veil.style.opacity = '0';
    veil.hidden = false;
    await tween(200, (p) => (veil.style.opacity = p));
  } else {
    const br = enterBtn.getBoundingClientRect();
    const cx = br.left + br.width / 2;
    const cy = br.top + br.height / 2;
    // 1. 열림: 블랙홀이 커지고 고리가 빨라진다
    setEmblemSpin(1.6);
    $('bhCanvas').animate([{ transform: 'scale(1)' }, { transform: 'scale(2.5)' }], { duration: 300, easing: 'ease-in', fill: 'forwards' });
    await wait(180);
    // 2. 흡입: 가까운 것부터 버튼 쪽으로
    if (!skip) {
      const els = [...home.querySelectorAll('[data-suck], #hState'), enterBtn]
        .filter((el) => el.getClientRects().length)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, dx: cx - (r.left + r.width / 2), dy: cy - (r.top + r.height / 2) };
        })
        .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
      els.forEach(({ el, dx, dy }, i) =>
        el.animate(
          [
            { transform: 'none', opacity: 1 },
            { transform: `translate(${dx}px,${dy}px) scale(0) rotate(${i % 2 ? 30 : -30}deg)`, opacity: 0 },
          ],
          { duration: 520, delay: i * 30, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' },
        ),
      );
      const st = home.querySelector('.home-stars');
      st.style.transformOrigin = `${cx}px ${cy + home.scrollTop}px`;
      st.animate(
        [
          { transform: 'none', opacity: 1 },
          { transform: 'rotate(140deg) scale(0)', opacity: 0 },
        ],
        { duration: 700, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' },
      );
      await wait(560);
    }
    // 3. 닫힘: 버튼 자리에서 잉크색 원이 퍼진다(건너뛰면 120ms)
    veil.style.clipPath = `circle(0px at ${cx}px ${cy}px)`;
    veil.hidden = false;
    await tween(skip ? 120 : 300, (p) => (veil.style.clipPath = `circle(${p * p * diag() * 2.2}px at ${cx}px ${cy}px)`));
    veil.style.clipPath = '';
  }
  skippable = false;

  // 막 뒤에서 화면을 바꾼다
  home.hidden = true;
  setEmblemSpin(0.22);
  cancelHomeAnimations();
  home.querySelector('.home-stars').style.transformOrigin = '';
  document.body.classList.add(ENTERING);
  for (const id of WORLD_UI) $(id).hidden = false;
  store.state.inWorld = true;

  // 4. 기다림: 3D 준비 + 데이터 받기(최소 380ms). 가운데 무지개 고리가 돈다
  // 8초 안에 끝나지 않으면 홈으로 되돌아간다.
  veil.classList.add('waiting');
  const token = ++epoch;
  let star = null;
  let starGone = false;
  let timer = 0;
  try {
    const prep = prepareWorld(token, { planetId: hasPlanet ? planetId : null, starId: hasStar ? starId : null });
    prep.catch(() => {}); // 한도를 넘긴 뒤 늦게 실패해도 조용히 버린다
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), OPEN_TIMEOUT);
    });
    ({ star, starGone } = await Promise.race([prep, timeout]));
  } catch (err) {
    clearTimeout(timer);
    epoch++; // 늦게 끝난 reload · 훅이 우주를 열지 못하게 한다
    await abortToHome(err);
    return false;
  }
  clearTimeout(timer);
  veil.classList.remove('waiting');

  // 5. 열림: 가운데 구멍으로 우주가 열린다. 카메라는 조망 거리의 80%에서 100%로 물러난다
  enterOverview();
  if (reduce) {
    await tween(200, (p) => (veil.style.opacity = 1 - p));
  } else {
    const D = diag();
    await tween(650, (p) => hole(p * D), outExpo);
  }
  veil.hidden = true;
  resetVeil();

  // 6. 조작 UI 페이드 인
  await fadeInWorldUi(reduce);
  home.inert = false;
  busy = false;
  store.emit('enterWorld', { planetId: hasPlanet ? String(planetId) : null, starId: hasStar ? String(starId) : null });

  // 여기부터는 우주가 이미 열려 있다. 오류가 나도 홈으로 되돌리지 않는다.
  try {
    if (hasPlanet && store.state.inWorld && !isLeaving) {
      // 행성 · 별을 눌러 들어온 경우: 그 행성으로 자동 비행.
      // 별이 그 사이 다른 행성으로 옮겨졌으면 별이 있는 행성으로 간다.
      const targetPlanet = String(star ? star.planet_id : planetId);
      const targetStar = star ? String(star.id) : null;
      if (hasStar && starGone) {
        toast('그 별을 찾지 못했어요'); // 그 사이 지워진 별
      } else if (!store.state.planets.some((p) => String(p.id) === targetPlanet)) {
        toast('그 행성을 찾지 못했어요'); // 그 사이 지워진 행성
      } else {
        if (star && !store.state.stars.some((s) => String(s.id) === targetStar)) {
          store.emit('guestStar', star); // 지금 기간 밖의 별: 이 별만 잠시 보여 달라고 알린다
        }
        const arrived = await flyTo(targetPlanet, targetStar ?? undefined);
        // 날아가는 사이 돌아가기를 눌렀으면(flyTo가 false) 알리지 않는다
        if (arrived && store.state.inWorld && !isLeaving) {
          if (targetStar) store.emit('openStar', { planetId: targetPlanet, starId: targetStar });
          else store.emit('land', targetPlanet);
        }
      }
    } else if (!hasPlanet && store.state.planets.length && !touchMq.matches) {
      toast('WASD로 날아보거나, 왼쪽 행성을 눌러 바로 이동해 보세요');
    }
  } catch (err) {
    console.error('[transition] 자동 비행 중 오류', err);
  }
  return true;
}

/**
 * 우주에서 홈으로 돌아간다(DESIGN.md 9-2): 잉크 막의 구멍이 400ms 동안 닫히고, 홈이 250ms 페이드로 나타난다.
 * 홈은 최신 데이터로 다시 그린다. 돌아갔으면 true. 도중에 오류가 나도 홈으로 되돌린다. 던지지 않는다.
 */
export async function leaveWorld() {
  if (busy || !store.state.inWorld) return false;
  stopFlight(); // 날아가던 중이면 끊는다: 기다리던 flyTo가 false로 끝나 'land' · 'openStar'가 나가지 않는다
  busy = true;
  isLeaving = true;
  try {
    await runLeave();
  } catch (err) {
    recoverHome(err);
    store.emit('leaveWorld'); // 듣는 쪽이 우주 화면을 정리하게
  } finally {
    isLeaving = false;
  }
  return true;
}

async function runLeave() {
  const home = $('home');
  const veil = $('veil');
  store.emit('leavingWorld');
  for (const id of ['panel', 'near']) $(id).hidden = true;

  const D = diag();
  resetVeil();
  hole(D);
  veil.hidden = false;
  await tween(reduceMq.matches ? 150 : 400, (p) => hole((1 - p) * D), (p) => p * p);
  veil.style.background = '';

  store.state.inWorld = false; // 프레임 루프가 남은 비행 · 키를 정리한다
  store.state.panelPlanetId = null;
  store.state.detailStarId = null;
  hideWorldUi();
  home.hidden = false;
  home.inert = false;
  home.scrollTop = 0;
  resumeEmblem();
  await Promise.race([renderHome(), sleep(600)]); // 숫자가 바뀐 채로 나타나게(느리면 기다리지 않는다)

  await tween(250, (p) => (veil.style.opacity = 1 - p));
  veil.hidden = true;
  resetVeil();
  busy = false;
  isLeaving = false;
  $('enterBtn').focus({ preventScroll: true });
  store.emit('leaveWorld');
}

/* ---------- 입력 ---------- */
// 전환 중에는 비행 키 · 행성 클릭을 받지 않는다
setInputBlocked(() => busy);

if (typeof addEventListener === 'function') {
  // 건너뛰기: 1 ~ 3단계 중 클릭이나 Esc. 확인 창이 떠 있으면 Esc는 그 창의 것이다.
  addEventListener('pointerdown', requestSkip, true);
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const confirm = $('confirm');
    if (confirm && !confirm.hidden) return;
    requestSkip();
  });
}
