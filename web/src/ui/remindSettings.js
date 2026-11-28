// "잠든 별 블랙홀" 설정 칸. 두 곳이 같은 부품을 쓴다(한 번에 한 곳만 열린다):
//   계정 설정 창(account.js → openRemindSettings) · 잠든 별 화면의 설정 카드(remind.js → openRemindSettingsIn).
//   기간: 7일 · 14일 · 30일 · 끄기(버튼 4개). 계정 설정에서는 창의 [저장하기]에서 저장하고(설명 글은 고르는 대로 바뀐다),
//   잠든 별 화면에서는 저장 버튼이 없어 누르는 즉시 저장한다(host.onDays 가 저장 · 다시 받기 · 끄기 확인을 맡는다).
//   알림 끈 별: 5개까지 바로 펼치고, 6개부터 최근 3개 + [전체 n개 보기]. 전체 보기는 같은 창 안의 목록 화면
//   (← 로 돌아가기 · 제목으로 찾기 · 여러 개 고르기 · [고른 별 다시 알림 받기]). [다시 알림 받기]는 누르는 즉시 바뀐다.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, ico, planetFace } from '../util.js';
import { refreshRemind } from './remind.js';
import { REMIND_OPTIONS, filterKept, keptPreview, remindHelp } from './remindLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const S = { saved: 14, picked: 14, kept: [], listing: false, query: '', sel: new Set(), note: '' };

// 지금 그리는 곳. box = 기간 · 알림 끈 별 칸, all = 전체 목록 칸, wrap = 전체 목록일 때 .rs-listing 을 붙일 곳,
// backLabel = 전체 목록 ← 의 이름, onDays(days) → Promise<boolean> 이 있으면 기간을 누르는 즉시 그것에 맡긴다,
// say(text) = 실패 알림(잠든 별 화면은 앱 알림을 숨기므로 자기 알림을 넘긴다)
let H = null;
const accountHost = () => ({ box: $('acRemind'), all: $('acRemindAll'), wrap: $('acForm'), backLabel: '계정 설정으로 돌아가기' });
const say = (text) => (H?.say ?? toast)(text);

function planetOf(star) {
  return (store.state.planets ?? []).find((p) => String(p.id) === String(star.planet_id));
}

function row(star, withButton) {
  const p = planetOf(star);
  return (
    `<li><span class="dot" style="background:${planetFace(p)}"></span><span class="tt">${esc(star.title || '제목 없음')}</span>` +
    (withButton ? `<button type="button" class="btn ghost sm" data-rs="on" data-id="${esc(star.id)}">다시 알림 받기</button>` : '') +
    '</li>'
  );
}

function paintMain() {
  const box = H.box;
  const help = remindHelp(S.picked).map(esc).join('<br>');
  const { shown, more } = keptPreview(S.kept);
  const n = S.kept.length;
  box.innerHTML =
    '<span class="lbl" id="acRemindLbl">잠든 별 블랙홀</span>' +
    `<div class="rs-seg" role="radiogroup" aria-labelledby="acRemindLbl">${REMIND_OPTIONS.map(
      (o) => `<button type="button" role="radio" aria-checked="${o.days === S.picked}" data-rs="days" data-days="${o.days}">${o.label}</button>`,
    ).join('')}</div>` +
    `<p class="rs-help">${help}</p>` +
    (n
      ? `<div class="rs-kh"><span>알림 끈 별 ${n.toLocaleString('ko-KR')}개</span><small>${more ? '최근 3개' : '블랙홀에 모으지 않는 별'}</small></div>` +
        `<ul class="rs-list">${shown.map((s) => row(s, true)).join('')}</ul>` +
        (more ? `<button type="button" class="rs-more" data-rs="all">전체 ${more.toLocaleString('ko-KR')}개 보기 ›</button>` : '')
      : '') +
    (S.note ? `<p class="rs-note" role="status">${esc(S.note)}</p>` : '');
}

function paintList() {
  const panel = H.all;
  const shown = filterKept(S.kept, S.query);
  const allOn = shown.length > 0 && shown.every((s) => S.sel.has(String(s.id)));
  panel.innerHTML =
    `<header><button type="button" class="btn ghost x" data-rs="back" aria-label="${esc(H.backLabel)}">${ico('arrow-left')}</button>` +
    `<h3>알림 끈 별 ${S.kept.length.toLocaleString('ko-KR')}개</h3></header>` +
    `<label class="rs-search"><span class="sr">제목으로 찾기</span><input type="search" id="acRemindQ" placeholder="제목으로 찾기" value="${esc(S.query)}" autocomplete="off"></label>` +
    `<div class="rs-bar"><label><input type="checkbox" data-rs="pickall"${allOn ? ' checked' : ''}> 모두 고르기</label><span>${S.sel.size.toLocaleString('ko-KR')}개 고름</span></div>` +
    `<ul class="rs-list rs-scroll">${
      shown
        .map((s) => {
          const on = S.sel.has(String(s.id));
          return `<li class="pick${on ? ' on' : ''}"><label><input type="checkbox" data-rs="pick" data-id="${esc(s.id)}"${on ? ' checked' : ''}><span class="dot" style="background:${planetFace(planetOf(s))}"></span><span class="tt">${esc(s.title || '제목 없음')}</span></label></li>`;
        })
        .join('') || '<li class="none">찾는 별이 없어요</li>'
    }</ul>` +
    (S.note ? `<p class="rs-note" role="status">${esc(S.note)}</p>` : '') +
    `<div class="row"><button type="button" class="btn" data-rs="bulk"${S.sel.size ? '' : ' disabled'}>고른 별 다시 알림 받기${S.sel.size ? ` (${S.sel.size.toLocaleString('ko-KR')})` : ''}</button></div>`;
  const q = panel.querySelector('#acRemindQ');
  // 계정 설정 form 안이라 Enter 가 [저장하기]를 누르지 않게 한다
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  q.addEventListener('input', () => {
    S.query = q.value;
    const pos = q.selectionStart;
    paintList();
    const nq = H.all.querySelector('#acRemindQ');
    nq.focus();
    nq.setSelectionRange(pos, pos);
  });
}

function setListing(on) {
  S.listing = on;
  S.note = '';
  H.wrap.classList.toggle('rs-listing', on);
  H.all.hidden = !on;
  if (on) {
    S.sel = new Set();
    S.query = '';
    paintList();
    H.all.querySelector('[data-rs="back"]').focus({ preventScroll: true });
  } else {
    paintMain();
    H.box.querySelector('[data-rs="all"], [data-rs="days"]')?.focus({ preventScroll: true });
  }
}

async function turnOn(ids) {
  try {
    await api.setRemindOff(ids, false);
  } catch {
    say('바꾸지 못했어요. 다시 해 주세요');
    return false;
  }
  const gone = new Set(ids.map(String));
  S.kept = S.kept.filter((s) => !gone.has(String(s.id)));
  for (const id of gone) S.sel.delete(id);
  S.note = ids.length === 1 ? '이 별은 다시 날짜를 세요' : `${ids.length.toLocaleString('ko-KR')}개는 다시 날짜를 세요`;
  refreshRemind();
  return true;
}

async function onClick(e) {
  const el = e.target.closest('[data-rs]');
  if (!el || !H) return;
  const k = el.dataset.rs;
  if (k === 'days') {
    const days = Number(el.dataset.days);
    if (H.onDays) {
      // 누르는 즉시 저장하는 곳: 저장됐을 때만 고른 값으로 바꾼다(끄기를 취소했거나 실패하면 그대로)
      if (days === S.saved) return;
      const host = H;
      if (!(await host.onDays(days)) || H !== host) return;
      S.saved = days;
    }
    S.picked = days;
    S.note = '';
    paintMain();
    H.box.querySelector(`[data-days="${S.picked}"]`)?.focus({ preventScroll: true });
  } else if (k === 'on') {
    if (await turnOn([el.dataset.id])) {
      if (!S.listing && S.kept.length > 5) S.note = '이 별은 다시 날짜를 세요';
      paintMain();
    }
  } else if (k === 'all') setListing(true);
  else if (k === 'back') setListing(false);
  else if (k === 'pick') {
    const id = String(el.dataset.id);
    if (el.checked) S.sel.add(id);
    else S.sel.delete(id);
    paintList();
  } else if (k === 'pickall') {
    const shown = filterKept(S.kept, S.query);
    const allOn = shown.every((s) => S.sel.has(String(s.id)));
    for (const s of shown) {
      if (allOn) S.sel.delete(String(s.id));
      else S.sel.add(String(s.id));
    }
    paintList();
  } else if (k === 'bulk') {
    if (S.sel.size && (await turnOn([...S.sel]))) {
      if (S.kept.length) paintList();
      else setListing(false);
    }
  }
}

const wired = new WeakSet();

/** 설정 칸을 host 에 연다: 지금 기간과 알림 끈 별을 받아 그린다. host 는 위 H 설명을 본다. */
export async function openRemindSettingsIn(host) {
  H = host;
  for (const el of [host.box, host.all]) {
    if (wired.has(el)) continue;
    wired.add(el);
    el.addEventListener('click', onClick);
  }
  S.note = '';
  S.kept = [];
  host.wrap.classList.remove('rs-listing');
  host.all.hidden = true;
  S.listing = false;
  paintMain();
  try {
    const [set, off] = await Promise.all([api.remindSettings(), api.remindOff()]);
    if (H !== host) return; // 받는 사이 다른 곳이 열렸다
    S.saved = set.days;
    S.picked = set.days;
    S.kept = off.stars;
  } catch {
    /* 못 받으면 기본값(14일)으로 보인다 */
  }
  if (H === host && !S.listing) paintMain();
}

/** 계정 설정 창이 열릴 때. */
export function openRemindSettings() {
  return openRemindSettingsIn(accountHost());
}

/** 설정 칸을 닫는다(잠든 별 화면의 설정 카드를 접을 때). 그 뒤의 누름은 받지 않는다. */
export function closeRemindSettings(host) {
  if (H === host) H = null;
}

/** [저장하기]: 기간이 바뀌었으면 저장하고 잠든 별 수를 다시 센다. */
export async function saveRemindSettingsChoice() {
  if (!H || H.onDays || S.picked === S.saved) return;
  try {
    const res = await api.saveRemindSettings(S.picked);
    S.saved = res.days;
    refreshRemind({ now: true });
  } catch {
    toast('잠든 별 기간을 저장하지 못했어요');
  }
}

/** Esc: 전체 목록이면 계정 설정으로 돌아간다(처리했으면 true). */
export function remindSettingsBack() {
  if (!H || !S.listing) return false;
  setListing(false);
  return true;
}
