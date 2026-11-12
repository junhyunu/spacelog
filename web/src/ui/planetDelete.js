// 행성 삭제 확인 창(#planetDel, 스펙 6-7). 확인 창(#confirm)과 같은 모양이고, 고르기(라디오 + 선택 상자)가 더 있다.
// 기본 포커스는 취소, Esc · 바깥 클릭 = 취소. Esc는 escape.js의 70번 자리. 열려 있는 동안 비행 키를 받지 않는다.
//
// store로 알리는 것:
//   'planetDeleted'  planetId   서버에서 지운 직후(다시 받기 전). panel.js가 패널을 닫고 조망으로 돌아간다
import { api } from '../api.js';
import { store } from '../store.js';
import { setInputBlocked } from '../three/controls.js';
import { esc } from '../util.js';
import { registerEscape } from './escape.js';
import { trapTab, wireBackdrop } from './planetForm.js';
import { deleteMode, deleteRequest, deleteTitle, deleteToast, deleteWarning, moveLabel, removeLabel } from './planetLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

let current = null; // { finish(value), busy, planet, others, mode }
let wired = false;

const choiceOf = () => (current?.mode === 'choose' ? ($('pdMove')?.checked ? 'move' : 'delete') : current?.mode);

function showError(message) {
  const el = $('pdErr');
  el.textContent = message || '';
  el.hidden = !message;
}

function paintBusy() {
  if (!current) return;
  const yes = $('pdYes');
  yes.disabled = current.busy;
  yes.textContent = current.busy ? '지우는 중…' : '지우기';
  yes.setAttribute('aria-busy', String(current.busy));
  $('pdNo').disabled = current.busy;
}

// 고르기에 따라 선택 상자와 경고 글을 맞춘다
function paintChoice() {
  if (current?.mode !== 'choose') return;
  const move = $('pdMove').checked;
  $('pdInto').disabled = !move;
  $('pdWarn').hidden = move;
}

function paintBody() {
  const { planet, others, mode } = current;
  const n = planet.count_total;
  const body = $('pdBody');
  if (mode === 'empty') {
    body.innerHTML = '<p>되돌릴 수 없어요.</p>';
  } else if (mode === 'only') {
    body.innerHTML = `<p>${esc(deleteWarning(n))}</p>`;
  } else {
    body.innerHTML =
      '<div class="opts" role="radiogroup" aria-label="별을 어떻게 할지">' +
      `<label class="opt"><input type="radio" name="pdStars" id="pdMove" value="move" checked><span>${esc(moveLabel(n))}</span></label>` +
      `<select id="pdInto" aria-label="별을 옮길 행성">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>` +
      `<label class="opt"><input type="radio" name="pdStars" id="pdDel" value="delete"><span>${esc(removeLabel(n))}</span></label>` +
      `<p id="pdWarn" hidden>${esc(deleteWarning(n))}</p>` +
      '</div>';
    paintChoice();
  }
}

async function confirm() {
  const c = current;
  if (!c || c.busy) return;
  const choice = choiceOf();
  const into = c.mode === 'choose' ? $('pdInto').value : undefined;
  const request = deleteRequest({ mode: c.mode, choice, into });
  if (!request) {
    showError('옮길 행성을 골라 주세요');
    return;
  }
  c.busy = true;
  showError('');
  paintBusy();
  let gone = false; // 그 사이 이미 지워진 행성
  try {
    await api.deletePlanet(c.planet.id, request);
  } catch (err) {
    if (current !== c) return;
    if (err?.status === 404) gone = true;
    else {
      c.busy = false;
      showError('지우지 못했어요. 다시 눌러 주세요');
      paintBusy();
      $('pdYes').focus();
      return;
    }
  }
  if (current !== c) return;
  const intoName = c.others.find((p) => String(p.id) === String(into))?.name ?? '';
  c.finish(!gone);
  store.emit('planetDeleted', c.planet.id);
  toast(gone ? '이미 지워진 행성이에요' : deleteToast({ name: c.planet.name, choice, count: c.planet.count_total, intoName }));
  store.reload().catch(() => {});
}

function cancel() {
  if (current && !current.busy) current.finish(false);
}

function wire() {
  if (wired) return;
  wired = true;
  const box = $('planetDel');
  wireBackdrop(box, cancel);
  box.addEventListener('keydown', (e) => trapTab(box, e));
  $('pdBody').addEventListener('change', () => {
    showError('');
    paintChoice();
  });
  $('pdNo').addEventListener('click', cancel);
  $('pdYes').addEventListener('click', confirm);
}

/** 행성 삭제 창이 떠 있는지. */
export function isPlanetDeleteOpen() {
  return current !== null;
}

/** 떠 있는 창을 취소로 닫는다(우주에서 나갈 때 등). */
export function closePlanetDelete() {
  current?.finish(false);
}

/**
 * 행성을 지울지 묻고, 확정하면 api.deletePlanet을 부른다.
 * 별 0개면 바로, 별이 있고 다른 행성이 있으면 "옮기고 지우기"(기본) · "함께 지우기"를 고르게 하고,
 * 행성이 이것 하나뿐이면 함께 지워진다는 설명만 보인다.
 * 지웠으면 'planetDeleted'를 알리고 토스트를 띄운 뒤 store.reload().
 * @param {object} planet          지울 행성(count_total = 기간과 상관없는 전체 별 수)
 * @param {object[]} otherPlanets  그 밖의 행성(옮길 곳)
 * @returns {Promise<boolean>} 지웠으면 true
 */
export function confirmDeletePlanet(planet, otherPlanets = []) {
  wire();
  if (current) current.finish(false);
  if (!planet) return Promise.resolve(false);

  const box = $('planetDel');
  const prevFocus = document.activeElement;
  const others = (otherPlanets ?? []).filter((p) => String(p.id) !== String(planet.id));
  const mine = {
    planet,
    others,
    mode: deleteMode({ countTotal: planet.count_total, otherCount: others.length }),
    busy: false,
    finish: null,
  };
  current = mine;

  $('pdTitle').textContent = deleteTitle(planet.name);
  showError('');
  paintBody();
  paintBusy();
  box.hidden = false;
  $('pdNo').focus();

  return new Promise((resolve) => {
    mine.finish = (value) => {
      if (current !== mine) return;
      current = null;
      box.hidden = true;
      $('pdBody').textContent = '';
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
      resolve(value);
    };
  });
}

registerEscape(70, () => {
  if (!current) return false;
  cancel();
  return true;
});
setInputBlocked(isPlanetDeleteOpen);
