// 행성 꾸미기 창(#planetForm, 스펙 6-6). 새 행성을 만들 때와 있는 행성을 고칠 때 같은 창을 쓴다.
// 여는 곳: W-00 · W-01의 "+ 새 행성"('newPlanet' 이벤트, main.js), W-02 메뉴 · 머리의 ✎(panel.js).
// Esc는 escape.js의 70번 자리(확인 창 다음, 저장 창 앞). 열려 있는 동안 비행 키를 받지 않는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { setInputBlocked } from '../three/controls.js';
import { DECO_NAMES, PLANET_COLORS, esc, ico } from '../util.js';
import { registerEscape } from './escape.js';
import {
  canSubmitPlanet,
  cleanText,
  counterText,
  moveIndex,
  planetFieldError,
  planetGone,
  planetNameHint,
  planetSaveError,
  planetSavedToast,
  textLength,
} from './planetLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const COLOR_IDS = Object.keys(PLANET_COLORS).map(Number);
const DECO_IDS = Object.keys(DECO_NAMES);
const COLOR_COLS = 8;
const TEXT_MAX = 20;
const FIELDS = ['pfName', 'pfDesc']; // 글자 수를 세는 칸. 세는 글은 그 칸 바로 아래 줄(.under)의 .cnt

let current = null; // { finish(value), planet, look, touched, autoLook, busy }
let wired = false;

/* ---------- 두 창(꾸미기 · 삭제)이 함께 쓰는 것 ---------- */

// Tab으로 닿는 자리: 지금 보이고 잠기지 않은 것. 라디오 묶음은 한 자리(고른 것, 없으면 첫째)다.
function tabStops(root) {
  const all = [...root.querySelectorAll('input, select, textarea, button, [tabindex]')].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0,
  );
  const isRadio = (el) => el instanceof HTMLInputElement && el.type === 'radio' && el.name;
  return all.filter((el) => {
    if (!isRadio(el)) return true;
    const group = all.filter((o) => isRadio(o) && o.name === el.name);
    return el === (group.find((o) => o.checked) ?? group[0]);
  });
}

/** 창 자체(role="dialog")에 초점을 둔다. 안에 초점을 받을 것이 없을 때(저장 중 등) 쓴다. */
export function focusDialog(root) {
  const dialog = root.querySelector('[role="dialog"], [role="alertdialog"]') ?? root;
  if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
  dialog.focus({ preventScroll: true });
}

/** 초점이 창 밖에 있거나 잠긴 버튼에 남았으면 창 자체로 옮긴다(버튼을 잠근 직후에 부른다). */
export function keepFocusIn(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active) || active.disabled) focusDialog(root);
}

/** Tab이 창 밖으로 나가지 않게 돈다. keydown에서 부른다. 자리는 누를 때마다 다시 센다. */
export function trapTab(root, e) {
  if (e.key !== 'Tab') return;
  const list = tabStops(root);
  if (!list.length) {
    e.preventDefault();
    focusDialog(root);
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (!active || !root.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!list.includes(active)) {
    // 자리가 아닌 곳(창 자체 · 방금 잠긴 버튼 · 고르지 않은 라디오): 문서 순서로 앞뒤의 자리로 간다
    e.preventDefault();
    const after = (el) => Boolean(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const before = (el) => Boolean(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) && !el.contains(active);
    const next = e.shiftKey ? ([...list].reverse().find(before) ?? last) : (list.find(after) ?? first);
    next.focus();
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
  // maxlength는 UTF-16 단위로 세어 서버(코드 포인트)와 어긋난다. 떼고 직접 센다
  for (const id of FIELDS) {
    const input = $(id);
    input.removeAttribute('maxlength');
    // 칸 아래 한 줄: 왼쪽은 안내(이름 칸만), 오른쪽은 글자 수
    const under = document.createElement('span');
    under.className = 'under';
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.setAttribute('aria-hidden', 'true'); // 넘으면 #pfErr(role="alert")가 알린다
    under.append(cnt);
    input.after(under);
  }
  // 이름이 비어 있을 때의 흐린 안내(만들기가 잠긴 까닭). 화면 읽기 프로그램은 이름 칸의 설명으로 읽는다
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.id = 'pfNameHint';
  $('pfName').nextElementSibling.prepend(hint);
  $('pfName').setAttribute('aria-describedby', 'pfNameHint');
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

const values = () => ({ name: $('pfName').value, description: $('pfDesc').value });

// 칸마다 "n/20". 20자를 넘으면 붉게 하고 칸에 aria-invalid를 건다
function paintCounts() {
  for (const id of FIELDS) {
    const input = $(id);
    const over = textLength(input.value) > TEXT_MAX;
    const cnt = input.nextElementSibling.querySelector('.cnt');
    cnt.textContent = counterText(input.value, TEXT_MAX);
    cnt.classList.toggle('over', over);
    if (over) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function onTyped() {
  paintCounts();
  $('pfNameHint').textContent = current ? planetNameHint($('pfName').value, Boolean(current.planet)) : '';
  showError(planetFieldError(values()));
  paintSubmit();
}

function paintSubmit() {
  if (!current) return;
  const yes = $('pfYes');
  yes.disabled = current.busy || !canSubmitPlanet(values());
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
  const name = cleanText($('pfName').value);
  const description = cleanText($('pfDesc').value);
  if (!canSubmitPlanet({ name, description })) {
    showError(planetFieldError({ name, description }));
    return;
  }
  const fields = { name, description };
  // 자동 배정 값을 받지 못했고 손도 대지 않았으면 모습은 서버가 정하게 둔다
  if (c.planet || c.autoLook || c.touched) Object.assign(fields, c.look);
  c.busy = true;
  showError('');
  paintSubmit();
  keepFocusIn($('planetForm')); // 누른 버튼이 잠겼다: 초점을 창 안에 둔다
  let saved;
  try {
    saved = c.planet ? await api.patchPlanet(c.planet.id, fields) : await api.createPlanet(fields);
  } catch (err) {
    // 창이 그사이 닫혔어도(우주에서 나감) 결과는 알린다
    const open = current === c;
    if (planetGone(err, c.planet)) {
      if (open) c.finish(null);
      toast('그 행성은 지워졌어요');
      store.reload().catch(() => {});
      return;
    }
    if (!open) {
      toast(planetSaveError(err));
      return;
    }
    c.busy = false;
    showError(planetSaveError(err));
    paintSubmit();
    $('pfYes').focus();
    return;
  }
  if (current === c) c.finish(saved);
  toast(planetSavedToast({ created: !c.planet, name: saved?.name ?? name }));
  // 3D · 목록 · 패널 · 홈은 'data'를 듣고 다시 그린다. 연결이 끊겼으면 연결 실패 카드가 알린다.
  // 저장하는 사이 우주에서 나갔어도 홈이 새 값을 보이게 다시 받는다
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
  for (const id of FIELDS) $(id).addEventListener('input', onTyped);
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
  box.hidden = false;
  onTyped(); // 글자 수 · 확정 버튼(고치는 행성의 이름이 이미 길 수도 있다)
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
