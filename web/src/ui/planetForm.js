// 행성 꾸미기 창(#planetForm, 스펙 6-6). 새 행성을 만들 때와 있는 행성을 고칠 때 같은 창을 쓴다.
// 여는 곳: W-00 · W-01의 "+ 새 행성"('newPlanet' 이벤트, main.js), W-02 메뉴 · 머리의 ✎(panel.js).
// Esc는 escape.js의 70번 자리(확인 창 다음, 저장 창 앞). 열려 있는 동안 비행 키를 받지 않는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { setInputBlocked } from '../three/controls.js';
import { DECO_NAMES, PLANET_COLORS, esc, ico } from '../util.js';
import { registerEscape } from './escape.js';
import { canSubmitPlanet, moveIndex, planetSaveError, planetSavedToast } from './planetLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const COLOR_IDS = Object.keys(PLANET_COLORS).map(Number);
const DECO_IDS = Object.keys(DECO_NAMES);
const COLOR_COLS = 8;

let current = null; // { finish(value), planet, look, touched, autoLook, busy }
let wired = false;

/* ---------- 두 창(꾸미기 · 삭제)이 함께 쓰는 것 ---------- */

/** Tab이 창 밖으로 나가지 않게 돈다. keydown에서 부른다. */
export function trapTab(root, e) {
  if (e.key !== 'Tab') return;
  const list = [...root.querySelectorAll('input, select, textarea, button, [tabindex]')].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null,
  );
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (!root.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** 바깥(막) 클릭 = 취소. 막에서 누르고 막에서 뗐을 때만(창 안에서 끌다 밖에서 떼는 것은 아니다). */
export function wireBackdrop(root, onCancel) {
  let down = false;
  root.addEventListener('mousedown', (e) => {
    down = e.target === e.currentTarget;
  });
  root.addEventListener('click', (e) => {
    if (e.target === e.currentTarget && down) onCancel();
    down = false;
  });
}

/* ---------- 그리기 ---------- */

function buildChoices() {
  $('pfX').innerHTML = ico('x');
  $('pfColors').innerHTML = COLOR_IDS.map(
    (i) =>
      `<button type="button" class="sw" role="radio" aria-checked="false" tabindex="-1" data-color="${i}" aria-label="${esc(PLANET_COLORS[i].name)}" title="${esc(PLANET_COLORS[i].name)}"><span style="background:${PLANET_COLORS[i].face}"></span></button>`,
  ).join('');
  $('pfDecos').innerHTML = DECO_IDS.map(
    (d) => `<button type="button" class="chip" role="radio" aria-checked="false" tabindex="-1" data-deco="${esc(d)}">${esc(DECO_NAMES[d])}</button>`,
  ).join('');
}

// 고른 것 하나만 Tab으로 닿는다(roving tabindex). 고른 것이 없으면 첫째.
function paintGroup(group, attr, value) {
  const items = [...group.querySelectorAll('[role="radio"]')];
  let any = false;
  for (const el of items) {
    const on = el.dataset[attr] === String(value);
    el.setAttribute('aria-checked', String(on));
    el.tabIndex = on ? 0 : -1;
    any = any || on;
  }
  if (!any && items[0]) items[0].tabIndex = 0;
}

function paintLook() {
  if (!current) return;
  paintGroup($('pfColors'), 'color', current.look.color_index);
  paintGroup($('pfDecos'), 'deco', current.look.deco);
  $('pfRing').checked = Boolean(current.look.ring);
}

function paintSubmit() {
  if (!current) return;
  const yes = $('pfYes');
  yes.disabled = current.busy || !canSubmitPlanet({ name: $('pfName').value });
  yes.textContent = current.busy ? '저장 중…' : current.planet ? '저장하기' : '만들기';
  yes.setAttribute('aria-busy', String(current.busy));
  $('pfNo').disabled = current.busy;
  $('pfX').disabled = current.busy;
}

function showError(message) {
  const el = $('pfErr');
  el.textContent = message || '';
  el.hidden = !message;
}

/* ---------- 누르기 · 키 ---------- */

function choose(el) {
  if (!current || current.busy) return;
  if (el.dataset.color) current.look.color_index = Number(el.dataset.color);
  else if (el.dataset.deco) current.look.deco = el.dataset.deco;
  else return;
  current.touched = true;
  paintLook();
}

// 묶음 안에서는 화살표로 옮겨 다니고(초점만), Space · Enter로 고른다(버튼의 기본 동작 = click).
function onGroupKeydown(e) {
  const el = e.target instanceof Element ? e.target.closest('[role="radio"]') : null;
  if (!el) return;
  const items = [...e.currentTarget.querySelectorAll('[role="radio"]')];
  const next = moveIndex(items.indexOf(el), e.key, items.length, e.currentTarget.id === 'pfColors' ? COLOR_COLS : undefined);
  if (next === null) return;
  e.preventDefault();
  for (const it of items) it.tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
}

function onGroupClick(e) {
  const el = e.target instanceof Element ? e.target.closest('[role="radio"]') : null;
  if (el) choose(el);
}

async function submit() {
  const c = current;
  if (!c || c.busy) return;
  const name = $('pfName').value.trim();
  if (!canSubmitPlanet({ name })) return;
  const fields = { name, description: $('pfDesc').value.trim() };
  // 자동 배정 값을 받지 못했고 손도 대지 않았으면 모습은 서버가 정하게 둔다
  if (c.planet || c.autoLook || c.touched) Object.assign(fields, c.look);
  c.busy = true;
  showError('');
  paintSubmit();
  let saved;
  try {
    saved = c.planet ? await api.patchPlanet(c.planet.id, fields) : await api.createPlanet(fields);
  } catch (err) {
    if (current !== c) return;
    c.busy = false;
    showError(planetSaveError(err));
    paintSubmit();
    $('pfYes').focus();
    return;
  }
  if (current !== c) return;
  c.finish(saved);
  toast(planetSavedToast({ created: !c.planet, name: saved?.name ?? name }));
  // 3D · 목록 · 패널 · 홈은 'data'를 듣고 다시 그린다. 연결이 끊겼으면 연결 실패 카드가 알린다
  store.reload().catch(() => {});
}

function cancel() {
  if (current && !current.busy) current.finish(null);
}

function wire() {
  if (wired) return;
  wired = true;
  const box = $('planetForm');
  buildChoices();
  wireBackdrop(box, cancel);
  box.addEventListener('keydown', (e) => trapTab(box, e));
  $('pfForm').addEventListener('submit', (e) => {
    e.preventDefault(); // 이름 칸 · 설명 칸에서 Enter = 확정
    submit();
  });
  $('pfName').addEventListener('input', () => {
    showError('');
    paintSubmit();
  });
  $('pfColors').addEventListener('click', onGroupClick);
  $('pfDecos').addEventListener('click', onGroupClick);
  $('pfColors').addEventListener('keydown', onGroupKeydown);
  $('pfDecos').addEventListener('keydown', onGroupKeydown);
  $('pfRing').addEventListener('change', () => {
    if (!current) return;
    current.look.ring = $('pfRing').checked;
    current.touched = true;
  });
  $('pfNo').addEventListener('click', cancel);
  $('pfX').addEventListener('click', cancel);
}

/** 행성 꾸미기 창이 떠 있는지. */
export function isPlanetFormOpen() {
  return current !== null;
}

/** 떠 있는 창을 취소로 닫는다(우주에서 나갈 때 등). 저장 중이어도 닫는다. */
export function closePlanetForm() {
  current?.finish(null);
}

/**
 * 행성 꾸미기 창을 연다.
 * planet이 없으면 만들기(색 · 장식 · 고리는 api.nextLook()의 자동 배정 값이 미리 골라져 있다),
 * 있으면 꾸미기(그 행성의 값). 저장하면 store.reload() 뒤 토스트를 띄운다.
 * @param {{ planet?: object }} [o]
 * @returns {Promise<object | null>} 저장한 행성. 취소면 null
 */
export function openPlanetForm({ planet } = {}) {
  wire();
  if (current) current.finish(null); // 겹쳐 열면 앞의 것은 취소로 끝낸다

  const box = $('planetForm');
  const prevFocus = document.activeElement;
  const editing = Boolean(planet);
  const mine = {
    planet: editing ? planet : null,
    look: editing
      ? { color_index: Number(planet.color_index) || 1, deco: planet.deco, ring: Boolean(planet.ring) }
      : { color_index: 1, deco: DECO_IDS[0], ring: false },
    touched: false,
    autoLook: false,
    busy: false,
    finish: null,
  };
  current = mine;

  $('pfTitle').textContent = editing ? '행성 꾸미기' : '새 행성 만들기';
  $('pfName').value = editing ? (planet.name ?? '') : '';
  $('pfDesc').value = editing ? (planet.description ?? '') : '';
  showError('');
  paintLook();
  paintSubmit();
  box.hidden = false;
  box.querySelector('.card').scrollTop = 0;
  $('pfName').focus();
  if (editing) $('pfName').select();

  if (!editing) {
    // 자동 배정 값: 받는 사이에 사용자가 직접 골랐으면 그대로 둔다
    api.nextLook().then(
      (look) => {
        if (current !== mine || mine.touched || !look) return;
        mine.look = { color_index: Number(look.color_index) || 1, deco: look.deco, ring: Boolean(look.ring) };
        mine.autoLook = true;
        paintLook();
      },
      () => {},
    );
  }

  return new Promise((resolve) => {
    mine.finish = (value) => {
      if (current !== mine) return;
      current = null;
      box.hidden = true;
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
setInputBlocked(isPlanetFormOpen);
