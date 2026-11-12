// 키 · 카메라 모드 · 자동 비행 · 클릭 고르기 · 프레임 루프.
// 시안 526~569행(입력 · 카메라 · pick · flyTo)과 857~932행(루프)을 옮겼다(수치 그대로).
//
// store로 알리는 것:
//   'land'            planetId   E(행성 근처) · "E" 안내 버튼 · 행성 클릭(날아가 도착한 뒤)
//   'pickStar'        starId     별 클릭(패널이 그 행성이면 바로, 아니면 날아가 도착한 뒤)
//   'near'            planetId | null   가까운 행성이 바뀔 때(표면에서 8 안)
//   'leftPanelPlanet'            store.state.panelPlanetId 행성의 표면 + 14 밖으로 나갔을 때,
//                                다른 행성으로 자동 비행을 시작할 때, 또는 그 행성이 사라졌을 때(한 번만)
//   'manualMove'                 이동 키를 눌렀을 때(자동 비행이 멈춘다)
//
// Esc는 여기서 다루지 않는다. 확인 창 → 꾸미기 창 → 저장 창 → 전환 건너뛰기 → 상세 → 패널
// 순서는 그 창들을 가진 뒤 태스크가 정한다. 비행 키를 막을 때는 setInputBlocked()를 쓴다.
import * as THREE from 'three';
import { store } from '../store.js';
import { toast } from '../ui/toast.js';
import { esc } from '../util.js';
import { initCharacter, player, resetCharacter, updateCharacter } from './character.js';
import { eachPlanet, hasPlanet, layoutVersion, pickTargets, planetInfo, planetPositions, updateUniverse } from './planets.js';
import { camera, initScene, renderer, scene } from './scene.js';
import { BASE_OVERVIEW, CENTER as CENTER_XYZ, overviewDistance } from './slots.js';

const V3 = THREE.Vector3;
const CENTER = new V3(...CENTER_XYZ);
const MAX_SPEED = 15;
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight'];

const keys = {};
const OV_YAW = 0; // 조망 자세
const OV_PITCH = 0.5;
let camYaw = OV_YAW;
let camPitch = OV_PITCH;
let OV = BASE_OVERVIEW; // 조망 거리. 행성 자리 · 창 크기가 바뀌면 다시 계산한다
let ovVersion = -1;
let ovAspect = 0;
let ovFov = 0;
let camDist = OV;
let camDistTarget = OV;
let mode = 'overview'; // 'overview' | 'fly'
let autopilot = null; // { planetId, t, from, target, resolve }
let arriving = null; // 도착 뒤 0.2초를 기다리는 중: { planetId, timer, resolve }
let nearId = null;
let nearHtml = '';
let leftSent = null; // 'leftPanelPlanet'을 이미 알린 행성
let t = 0;
let ready = false;
let running = false;

const vel = new V3();
const clock = new THREE.Clock();
const camTarget = new V3();
const tmp = new V3();
const fwd = new V3();
const right = new V3();
const inp = new V3();
const ray = new THREE.Raycaster();
const panelInfo = {}; // 프레임마다 다시 쓰는 planetInfo() 결과
const blockers = new Set();

const wheelMax = () => Math.max(80, OV + 18);
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || Boolean(e.target?.isContentEditable);
// 방금 누른 HUD 버튼 · 링크에 초점이 남아 있으면 Space가 그것을 다시 누른다. 이동 키를 받을 때 초점을 뺀다.
function blurFocusedButton() {
  const el = document.activeElement;
  if (el && (el.tagName === 'BUTTON' || el.tagName === 'A') && !el.isContentEditable) el.blur();
}
const clearKeys = () => {
  for (const k in keys) keys[k] = false;
};

/**
 * 비행 키를 막을 조건을 더한다. fn()이 true인 동안 키를 받지 않는다(창이 열려 있을 때 등).
 * 여러 번 부르면 조건이 쌓이고, 하나라도 true면 막힌다. 돌려주는 함수를 부르면 그 조건을 뺀다.
 * 확인 창(#confirm)이 열려 있을 때는 따로 등록하지 않아도 막힌다.
 */
export function setInputBlocked(fn) {
  if (typeof fn !== 'function') return () => {};
  blockers.add(fn);
  return () => blockers.delete(fn);
}

function isBlocked() {
  const confirm = document.getElementById('confirm');
  if (confirm && !confirm.hidden) return true;
  for (const fn of blockers) {
    try {
      if (fn()) return true;
    } catch (err) {
      console.error('[controls] 입력 차단 조건 오류', err);
    }
  }
  return false;
}

/* ---------- 조망 거리 ---------- */
// 행성 자리(syncUniverse 뒤) · 창 크기 · 시야각이 바뀌면 다시 계산한다. 프레임마다 불러도 된다.
// 조망 거리 그대로 보고 있었다면 새 거리로 부드럽게 따라간다(camDist는 건드리지 않는다).
function refreshOverview(force) {
  const v = layoutVersion();
  const aspect = camera && camera.aspect > 0 ? camera.aspect : 16 / 9;
  const fovDeg = camera && camera.fov > 0 ? camera.fov : 58;
  if (!force && v === ovVersion && aspect === ovAspect && fovDeg === ovFov) return;
  ovVersion = v;
  ovAspect = aspect;
  ovFov = fovDeg;
  const next = overviewDistance(planetPositions(), { aspect, fovDeg, pitch: OV_PITCH, yaw: OV_YAW });
  const followed = mode === 'overview' && camDistTarget === OV; // 조망 거리 그대로 보고 있었다
  OV = next;
  if (followed) camDistTarget = OV;
  else camDistTarget = Math.min(camDistTarget, wheelMax());
}

/* ---------- 자동 비행 ---------- */
function stopFlight() {
  if (autopilot) {
    const a = autopilot;
    autopilot = null;
    a.resolve(false);
  }
  if (arriving) {
    const a = arriving;
    arriving = null;
    clearTimeout(a.timer);
    a.resolve(false);
  }
}

/**
 * 행성으로 자동 비행한다(거리와 상관없이 1.2초, 천천히 출발해 천천히 멈춘다).
 * 도착하고 0.2초 뒤 true로 끝난다. 이동 키(도착 뒤 0.2초 사이에도) · 다른 flyTo · 우주에서 나가기 ·
 * 그 행성이 사라짐으로 끊기면 false로 끝난다.
 * 던지지 않는다. starId는 재발견 별(guest)이면 "비행 중" 토스트를 생략하는 데만 쓴다.
 */
export function flyTo(planetId, starId) {
  ensureReady();
  const P = planetInfo(planetId);
  if (!P) return Promise.resolve(false);
  stopFlight();
  const dir = player.position.clone().sub(P.position);
  dir.y = Math.max(dir.y, 0);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
  dir.normalize();
  const target = P.position.clone().add(dir.multiplyScalar(P.radius + 4.5)).add(new V3(0, 1.2, 0));
  mode = 'fly';
  camDistTarget = 9;
  const panelId = store.state.panelPlanetId;
  if (panelId !== null && panelId !== undefined && String(panelId) !== P.id) store.emit('leftPanelPlanet');
  const guest = store.state.guestStarId;
  const isGuest = starId !== null && starId !== undefined && guest !== null && guest !== undefined && String(guest) === String(starId);
  if (!isGuest) toast(`'${P.name}'(으)로 비행 중…`);
  return new Promise((resolve) => {
    autopilot = { planetId: P.id, t: 0, from: player.position.clone(), target, resolve };
  });
}

/** 우주에 들어올 때의 자세: 캐릭터 (0,0,10), 조망 카메라가 조망 거리의 80%에서 100%로 물러난다. */
export function enterOverview() {
  ensureReady();
  stopFlight();
  clearKeys();
  resetCharacter();
  player.position.set(0, 0, 10);
  vel.set(0, 0, 0);
  mode = 'overview';
  camYaw = OV_YAW;
  camPitch = OV_PITCH;
  refreshOverview(true);
  camDist = OV * 0.8;
  camDistTarget = OV;
  camTarget.copy(CENTER);
}

/* ---------- 입력 ---------- */
function onKeyDown(e) {
  if (e.key === 'Escape') return; // Esc 순서는 뒤 태스크가 정한다
  if (typing(e) || !store.state.inWorld || e.ctrlKey || e.metaKey || e.altKey || isBlocked()) return;
  keys[e.code] = true;
  if (MOVE_KEYS.includes(e.code)) {
    stopFlight(); // 자동 비행과 도착 뒤 0.2초 기다림을 모두 끊는다
    blurFocusedButton();
    if (mode === 'overview') {
      mode = 'fly';
      camDistTarget = 9;
    }
    document.getElementById('help')?.classList.remove('big');
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (!e.repeat) store.emit('manualMove');
  }
  if (e.code === 'KeyE' && !e.repeat && nearId) store.emit('land', nearId);
}

function onKeyUp(e) {
  keys[e.code] = false;
  // 초점이 남은 버튼이 Space를 뗄 때 눌리지 않게 한다
  if (e.code === 'Space' && !typing(e) && store.state.inWorld && !e.ctrlKey && !e.metaKey && !e.altKey && !isBlocked()) e.preventDefault();
}

function pick(e) {
  if (e.button !== 0) return; // 주 버튼(왼쪽 · 터치)만
  if (!store.state.inWorld || isBlocked()) return;
  const rect = renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const m = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(m, camera);
  const hit = ray.intersectObjects(pickTargets(), false)[0];
  if (!hit) return;
  const { starId, planetId } = hit.object.userData;
  const panelId = store.state.panelPlanetId;
  const onPanelPlanet = panelId !== null && panelId !== undefined && String(panelId) === planetId;
  if (starId) {
    if (onPanelPlanet) store.emit('pickStar', starId);
    else flyTo(planetId, starId).then((ok) => ok && store.emit('pickStar', starId));
  } else if (planetId && !onPanelPlanet) {
    flyTo(planetId).then((ok) => ok && store.emit('land', planetId));
  }
}

function bindInput() {
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', clearKeys);
  // scene.js의 resize(카메라 비율 갱신)가 먼저 등록돼 있어 그 뒤에 돈다. 순서가 바뀌어도
  // 프레임마다 도는 refreshOverview(false)가 바뀐 비율을 알아챈다.
  addEventListener('resize', () => refreshOverview(false));

  const cv = renderer.domElement;
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    camYaw -= (e.clientX - drag.x) * 0.006;
    camPitch = Math.max(-1.1, Math.min(1.25, camPitch + (e.clientY - drag.y) * 0.005));
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  cv.addEventListener('pointerup', (e) => {
    if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) pick(e);
    drag = null;
  });
  cv.addEventListener('pointercancel', () => {
    drag = null;
  });
  cv.addEventListener(
    'wheel',
    (e) => {
      camDistTarget = Math.max(5, Math.min(wheelMax(), camDistTarget + e.deltaY * 0.02));
      e.preventDefault();
    },
    { passive: false },
  );

  // "E 'OO' 행성 열기" 안내 버튼
  document.getElementById('near')?.addEventListener('click', () => {
    if (nearId && store.state.inWorld) store.emit('land', nearId);
  });
}

function ensureReady() {
  if (ready) return;
  if (!renderer) initScene(document.getElementById('stage'));
  initCharacter(scene);
  camTarget.copy(player.position);
  bindInput();
  ready = true;
}

/* ---------- 루프 ---------- */
function showNearHint(id, name) {
  const nb = document.getElementById('near');
  if (!nb) return;
  const panelId = store.state.panelPlanetId;
  const msg = document.getElementById('worldMsg');
  const show = id && !autopilot && (panelId === null || panelId === undefined || String(panelId) !== id) && (!msg || msg.hidden);
  if (!show) {
    if (!nb.hidden) nb.hidden = true;
    return;
  }
  const html = `<kbd>E</kbd>'${esc(name)}' 행성 열기`;
  if (html !== nearHtml) {
    nb.innerHTML = html;
    nearHtml = html;
  }
  if (nb.hidden) nb.hidden = false;
}

function step() {
  requestAnimationFrame(step);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!store.state.inWorld) {
    // 우주 밖: 그리지 않는다. 남은 비행 · 키 · 안내는 정리한다
    if (autopilot || arriving) stopFlight();
    clearKeys();
    if (nearId !== null) {
      nearId = null;
      store.emit('near', null);
      showNearHint(null);
    }
    return;
  }
  // 날아가던(또는 막 도착한) 행성이 사라졌으면 비행을 끊는다(false, land · pickStar 없음)
  if ((autopilot && !hasPlanet(autopilot.planetId)) || (arriving && !hasPlanet(arriving.planetId))) stopFlight();
  t += dt;
  refreshOverview(false);
  if (isBlocked()) clearKeys();

  // 입력
  fwd.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  right.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
  inp.set(0, 0, 0);
  if (keys.KeyW || keys.ArrowUp) inp.add(fwd);
  if (keys.KeyS || keys.ArrowDown) inp.sub(fwd);
  if (keys.KeyD || keys.ArrowRight) inp.add(right);
  if (keys.KeyA || keys.ArrowLeft) inp.sub(right);
  if (keys.Space) inp.y += 1;
  if (keys.ShiftLeft || keys.ShiftRight || keys.KeyC) inp.y -= 1;

  if (autopilot) {
    const A = autopilot;
    A.t = Math.min(1, A.t + dt / 1.2);
    const ae = A.t < 0.5 ? 2 * A.t * A.t : 1 - Math.pow(-2 * A.t + 2, 2) / 2;
    tmp.copy(A.from).lerp(A.target, ae);
    vel.copy(tmp).sub(player.position).divideScalar(Math.max(dt, 1e-3));
    if (A.t >= 1) {
      autopilot = null;
      const wait = {
        planetId: A.planetId,
        resolve: A.resolve,
        timer: setTimeout(() => {
          if (arriving === wait) arriving = null;
          vel.set(0, 0, 0);
          A.resolve(Boolean(store.state.inWorld) && !autopilot && hasPlanet(A.planetId));
        }, 200),
      };
      arriving = wait;
    }
    const hy = Math.atan2(vel.x, vel.z) + Math.PI;
    let dy = hy - camYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    camYaw += dy * (1 - Math.exp(-1.2 * dt));
  } else {
    if (inp.lengthSq()) inp.normalize();
    vel.addScaledVector(inp, 32 * dt);
    vel.multiplyScalar(Math.exp(-2.4 * dt));
    if (vel.length() > MAX_SPEED) vel.setLength(MAX_SPEED);
  }
  player.position.addScaledVector(vel, dt);

  // 자전 · 크기 · 별 공전 · 날아가는 별
  updateUniverse(dt);

  // 행성 충돌(표면 + 1.6) · 가까운 행성(표면에서 8 안)
  let bestId = null;
  let bestName = '';
  let bd = 1e9;
  eachPlanet((id, pos, radius, name) => {
    tmp.copy(player.position).sub(pos);
    const d = tmp.length();
    const minD = radius + 1.6;
    if (d < minD) {
      if (d < 1e-6) tmp.set(0, 1, 0);
      else tmp.normalize();
      player.position.copy(pos).addScaledVector(tmp, minD);
      const vn = vel.dot(tmp);
      if (vn < 0) vel.addScaledVector(tmp, -vn * 1.4);
    }
    const near = d - radius;
    if (near < 8 && near < bd) {
      bd = near;
      bestId = id;
      bestName = name;
    }
  });
  if (bestId !== nearId) {
    nearId = bestId;
    store.emit('near', nearId);
  }
  showNearHint(bestId, bestName);

  // 패널 행성에서 멀어지거나(표면 + 14) 그 행성이 사라지면 한 번 알린다
  const panelId = store.state.panelPlanetId;
  if (panelId === null || panelId === undefined) {
    leftSent = null;
  } else {
    const pid = String(panelId);
    const panelP = planetInfo(pid, panelInfo);
    const left = !panelP || (nearId !== pid && !autopilot && player.position.distanceTo(panelP.position) > panelP.radius + 14);
    if (!left) leftSent = null;
    else if (leftSent !== pid) {
      leftSent = pid;
      store.emit('leftPanelPlanet');
    }
  }

  // 캐릭터
  updateCharacter(dt, t, vel, MAX_SPEED);

  // 카메라
  camDist += (camDistTarget - camDist) * (1 - Math.exp(-2.5 * dt));
  if (mode === 'overview') camTarget.lerp(CENTER, 1 - Math.exp(-3 * dt));
  else {
    tmp.copy(player.position);
    tmp.y += 1.3;
    camTarget.lerp(tmp, 1 - Math.exp(-8 * dt));
  }
  const cp = Math.cos(camPitch);
  camera.position.set(
    camTarget.x + Math.sin(camYaw) * cp * camDist,
    camTarget.y + Math.sin(camPitch) * camDist,
    camTarget.z + Math.cos(camYaw) * cp * camDist,
  );
  camera.lookAt(camTarget);
  renderer.render(scene, camera);
}

/** 프레임 루프를 켠다(한 번만). store.state.inWorld가 true인 동안만 움직이고 그린다. */
export function startLoop() {
  ensureReady();
  if (running) return;
  running = true;
  clock.getDelta();
  requestAnimationFrame(step);
}

/** 캐릭터의 월드 좌표(복사본). 새 별이 날아오를 자리를 잡을 때 쓴다. */
export function playerPosition() {
  return player.position.clone();
}
