// 캐릭터 꾸미기 창(#charForm, 스펙 6-10). 행성 꾸미기 창(planetForm.js)과 같은 모양 · 같은 키보드 규칙이다.
// 여는 곳: W-01 왼쪽 패널의 "캐릭터 꾸미기"(#wCharacter), W-00 상단의 "캐릭터"(#hCharacter) → 'openCharacter'(main.js).
// 저장: api.saveCharacter → store.state.character → setCharacterLook(우주의 캐릭터가 그 자리에서 바뀐다) → 토스트.
// 미리보기는 이 창만의 작은 렌더러에 그린다. 본 장면을 아직 만들지 않았어도(홈에서 열었을 때) 동작하고,
// 창을 닫으면 렌더러와 WebGL 컨텍스트를 돌려준다(여닫기를 되풀이해도 컨텍스트가 쌓이지 않는다).
// Esc는 escape.js의 70번 자리. 열려 있는 동안 비행 키를 받지 않는다.
import * as THREE from 'three';
import { api } from '../api.js';
import { store } from '../store.js';
import { animateCharacterPreview, buildCharacterPreview, setCharacterLook } from '../three/character.js';
import { setInputBlocked } from '../three/controls.js';
import { esc, ico } from '../util.js';
import {
  CHARACTER_KINDS,
  CHARACTER_SAVED_TOAST,
  COLOR_IDS,
  FLAMES,
  FLAME_IDS,
  KIND_NAMES,
  characterSaveError,
  colorLabel,
  normalizeLook,
  swatchColor,
} from './characterLogic.js';
import { registerEscape } from './escape.js';
import { keepFocusIn, trapTab, wireBackdrop } from './planetForm.js';
import { moveIndex } from './planetLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
// 묶음 → 고른 값이 들어가는 칸(look의 열쇠)과 그 값을 적는 data 속성
const GROUPS = {
  cfKinds: { field: 'kind', attr: 'kind' },
  cfSuits: { field: 'suit', attr: 'color', number: true },
  cfAccents: { field: 'accent', attr: 'color', number: true },
  cfFlames: { field: 'flame', attr: 'flame' },
};
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let current = null; // { look, busy, finish(value) }
let wired = false;
let preview = null; // { set(look), dispose() }

/* ---------- 미리보기 ---------- */

// 이 창만의 렌더러 · 장면 · 카메라. 빛은 본 장면(scene.js)과 같게 둔다. WebGL을 못 쓰면 null.
function startPreview(host, look) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  const still = reducedMotion();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || 200, host.clientHeight || 200, false);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xcfd6ff, 0x3a2a6a, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.95);
  sun.position.set(40, 60, 30);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0.75, 7.3);
  camera.lookAt(0, 0.58, 0);

  const turn = new THREE.Group(); // 돌리는 것은 이 그룹, 캐릭터의 대기 움직임은 그 안에서
  scene.add(turn);
  let group = null;
  let raf = 0;
  let last = performance.now();
  let t = 1;
  let gone = false;

  const draw = () => {
    if (!gone) renderer.render(scene, camera);
  };
  function frame(now) {
    if (gone) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;
    turn.rotation.y += dt * 0.7; // 한 바퀴 약 9초
    animateCharacterPreview(group, dt, t, 0);
    draw();
  }
  function set(next) {
    if (gone) return;
    if (group) {
      turn.remove(group);
      group.userData.dispose();
    }
    group = buildCharacterPreview(next);
    turn.add(group);
    animateCharacterPreview(group, 0, still ? 1 : t, 0);
    if (still) draw(); // 모션 줄이기: 돌지 않는다. 고를 때마다 한 번만 그린다
  }
  function dispose() {
    if (gone) return;
    gone = true;
    cancelAnimationFrame(raf);
    if (group) group.userData.dispose();
    renderer.dispose();
    renderer.forceContextLoss(); // 컨텍스트를 바로 돌려준다(브라우저는 16개쯤까지만 둔다)
    renderer.domElement.remove();
  }

  if (still) turn.rotation.y = 0.45; // 비스듬히 선 한 장면
  set(look);
  if (!still) raf = requestAnimationFrame(frame);
  return { set, dispose };
}

function openPreview() {
  const host = $('cfPreview');
  host.replaceChildren();
  preview = startPreview(host, current.look);
  if (!preview) {
    const p = document.createElement('p');
    p.className = 'none';
    p.textContent = '미리보기를 그릴 수 없어요';
    host.appendChild(p);
  }
}

function closePreview() {
  preview?.dispose();
  preview = null;
  $('cfPreview').replaceChildren();
}

/* ---------- 그리기 ---------- */

const chip = (attr, value, label) =>
  `<button type="button" class="chip" role="radio" aria-checked="false" tabindex="-1" data-${attr}="${esc(value)}">${esc(label)}</button>`;
const swatch = (slot, i) =>
  `<button type="button" class="sw" role="radio" aria-checked="false" tabindex="-1" data-color="${i}" aria-label="${esc(colorLabel(i))}" title="${esc(colorLabel(i))}"><span style="background:${swatchColor(slot, i)}"></span></button>`;

function buildChoices() {
  $('cfX').innerHTML = ico('x');
  $('cfKinds').innerHTML = CHARACTER_KINDS.map((k) => chip('kind', k, KIND_NAMES[k])).join('');
  $('cfSuits').innerHTML = COLOR_IDS.map((i) => swatch('suit', i)).join('');
  $('cfAccents').innerHTML = COLOR_IDS.map((i) => swatch('accent', i)).join('');
  $('cfFlames').innerHTML = FLAME_IDS.map((f) => chip('flame', f, FLAMES[f].name)).join('');
}

// 고른 것 하나만 Tab으로 닿는다(roving tabindex)
function paintLook() {
  if (!current) return;
  for (const [id, g] of Object.entries(GROUPS)) {
    const value = String(current.look[g.field]);
    for (const el of $(id).querySelectorAll('[role="radio"]')) {
      const on = el.dataset[g.attr] === value;
      el.setAttribute('aria-checked', String(on));
      el.tabIndex = on ? 0 : -1;
    }
  }
  const { kind, suit, accent, flame } = current.look;
  $('cfPreview').setAttribute(
    'aria-label',
    `미리보기: ${KIND_NAMES[kind]}, 몸 색 ${colorLabel(suit)}, 포인트 색 ${colorLabel(accent)}, 불꽃 ${FLAMES[flame].name}`,
  );
}

function paintBusy() {
  if (!current) return;
  const yes = $('cfYes');
  yes.disabled = current.busy;
  yes.textContent = current.busy ? '저장 중…' : '저장하기';
  yes.setAttribute('aria-busy', String(current.busy));
  $('cfForm').setAttribute('aria-busy', String(current.busy));
  $('cfNo').disabled = current.busy;
  $('cfX').disabled = current.busy;
}

function showError(message) {
  const el = $('cfErr');
  el.textContent = message || '';
  el.hidden = !message;
}

/* ---------- 누르기 · 키 ---------- */

function onGroupClick(e) {
  const el = e.target instanceof Element ? e.target.closest('[role="radio"]') : null;
  const g = GROUPS[e.currentTarget.id];
  if (!el || !g || !current || current.busy) return;
  const raw = el.dataset[g.attr];
  const next = normalizeLook({ ...current.look, [g.field]: g.number ? Number(raw) : raw });
  if (next[g.field] === current.look[g.field]) return;
  current.look = next;
  current.touched = true;
  paintLook();
  preview?.set(next); // 고를 때마다 바로 바뀐다
}

// 지금 그려진 줄의 칸 수(색 원은 화면 폭에 따라 9칸 또는 6칸)
function columnsOf(group) {
  if (!group.classList.contains('swatches')) return undefined;
  const cols = getComputedStyle(group).gridTemplateColumns.split(' ').filter(Boolean).length;
  return cols > 0 ? cols : undefined;
}

// 묶음 안에서는 화살표로 옮겨 다니고(초점만), Space · Enter로 고른다(버튼의 기본 동작 = click)
function onGroupKeydown(e) {
  const el = e.target instanceof Element ? e.target.closest('[role="radio"]') : null;
  if (!el) return;
  const items = [...e.currentTarget.querySelectorAll('[role="radio"]')];
  const next = moveIndex(items.indexOf(el), e.key, items.length, columnsOf(e.currentTarget));
  if (next === null) return;
  e.preventDefault();
  for (const it of items) it.tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
}

async function submit() {
  const c = current;
  if (!c || c.busy) return;
  const look = { ...c.look };
  c.busy = true;
  showError('');
  paintBusy();
  keepFocusIn($('charForm')); // 누른 버튼이 잠겼다: 초점을 창 안에 둔다
  let saved;
  try {
    saved = await api.saveCharacter(look);
  } catch (err) {
    if (current !== c) {
      toast(characterSaveError(err)); // 창이 그사이 닫혔어도 결과는 알린다
      return;
    }
    c.busy = false;
    showError(characterSaveError(err));
    paintBusy();
    $('cfYes').focus();
    return;
  }
  const applied = normalizeLook(saved ?? look);
  store.state.character = applied;
  store.state.characterLoaded = true;
  try {
    setCharacterLook(applied); // 우주를 아직 만들지 않았으면 적어만 둔다. 만들 때 이 모습으로 만든다
  } catch (err) {
    console.error(err); // 저장은 됐다. 다시 들어오면 새 모습으로 만들어진다
  } finally {
    if (current === c) c.finish(applied);
  }
  toast(CHARACTER_SAVED_TOAST);
}

function cancel() {
  if (current && !current.busy) current.finish(null);
}

function wire() {
  if (wired) return;
  wired = true;
  const box = $('charForm');
  buildChoices();
  wireBackdrop(box, cancel);
  box.addEventListener('keydown', (e) => trapTab(box, e));
  $('cfForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  for (const id of Object.keys(GROUPS)) {
    $(id).addEventListener('click', onGroupClick);
    $(id).addEventListener('keydown', onGroupKeydown);
  }
  $('cfNo').addEventListener('click', cancel);
  $('cfX').addEventListener('click', cancel);
}

/** 캐릭터 꾸미기 창이 떠 있는지. */
export function isCharacterFormOpen() {
  return current !== null;
}

/** 떠 있는 창을 취소로 닫는다(우주에서 나갈 때 등). 저장 중이어도 닫는다. */
export function closeCharacterForm() {
  current?.finish(null);
}

/**
 * 캐릭터 꾸미기 창을 연다. 지금 모습(store.state.character)이 골라져 있다.
 * @returns {Promise<object | null>} 저장한 모습 { kind, suit, accent, flame }. 취소면 null
 */
export function openCharacterForm() {
  wire();
  if (current) current.finish(null); // 겹쳐 열면 앞의 것은 취소로 끝낸다

  const box = $('charForm');
  const prevFocus = document.activeElement;
  const mine = { look: normalizeLook(store.state.character), busy: false, finish: null };
  current = mine;

  showError('');
  paintLook();
  paintBusy();
  box.hidden = false;
  box.querySelector('.card').scrollTop = 0;
  openPreview(); // 창이 보인 뒤에: 미리보기 칸의 크기를 재서 만든다
  ($('cfKinds').querySelector('[aria-checked="true"]') ?? $('cfX')).focus({ preventScroll: true });

  // 저장된 모습을 아직 못 받았으면(시작 직후이거나 받다가 실패) 지금 받아서 보여 준다.
  // 그대로 두면 기본 모습이 보이고, 저장하면 저장돼 있던 모습을 덮어쓴다. 그사이 고른 것이 있으면 건드리지 않는다.
  if (!store.state.characterLoaded) {
    api
      .character()
      .then((look) => {
        if (store.state.characterLoaded) return;
        const loaded = normalizeLook(look);
        store.state.character = loaded;
        store.state.characterLoaded = true;
        setCharacterLook(loaded);
        if (current !== mine || mine.busy || mine.touched) return;
        mine.look = loaded;
        paintLook();
        preview?.set(loaded);
      })
      .catch(() => {}); // 연결 끊김은 api.js가 알린다
  }

  return new Promise((resolve) => {
    mine.finish = (value) => {
      if (current !== mine) return;
      current = null;
      box.hidden = true;
      closePreview();
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
      resolve(value);
    };
  });
}

// Esc = 취소(저장 중에는 키만 삼킨다). 열려 있는 동안 비행 키를 막는다.
registerEscape(70, () => {
  if (!current) return false;
  cancel();
  return true;
});
setInputBlocked(isCharacterFormOpen);
