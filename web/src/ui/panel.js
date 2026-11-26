// W-02 행성 패널(#panel): 머리 · 메뉴 · 이 기간 별 목록. 별 상세(W-03)는 detail.js가 같은 패널에 그린다.
// 시안 671~713행(openPanel · closePanel · renderPanel · renderList · thumb)을 옮겼다.
// 체크박스와 발(싣기 버튼)은 없다(탐사선 제외). 아래 여백 84px는 app.css에 그대로 있다.
//
// store에서 듣는 것:
//   'land'            planetId               그 행성의 목록을 연다
//   'openStar'        { planetId, starId }   그 행성을 열고 그 별의 상세로
//   'leftPanelPlanet'                        멀어졌다 → 닫는다(조망으로 돌아가지 않는다)
//   'leavingWorld' · 'leaveWorld'            닫는다
//   'planetDeleted'   planetId               그 행성 패널이면 닫고 조망으로
//   'data'                                   다시 그린다. 행성이 사라졌으면 닫고 조망으로,
//                                            상세의 별이 지워졌으면 목록으로 돌아간다
// store.state.panelPlanetId · detailStarId를 맞춘다(controls.js · hud.js가 읽는다).
// 새 별 강조: 목록 항목은 <button class="rec" data-id="별 id">다. 저장 뒤(Task 11)에는
// flashStars([id, …])를 부르면 그 항목이 1.2초 핑크가 된다('data'로 다시 그려진 뒤에도 남는다).
import { api } from '../api.js';
import { store } from '../store.js';
import { enterOverview } from '../three/controls.js';
import { setSelectedStar } from '../three/planets.js';
import { planetDeep, planetFace, esc, ico, shortDate } from '../util.js';
import { ask } from './confirm.js';
import { flushMemo, renderDetail } from './detail.js';
import { registerEscape } from './escape.js';
import { clearGuestStar } from './hud.js';
import { confirmDeletePlanet } from './planetDelete.js';
import { openPlanetForm } from './planetForm.js';
import { detailKey, keepPicked, mergeDesc, mergeErrorText, mergeFailure, moveTargets, panelStars, pickAllHtml, pickAllState, pickBarHtml, pickButtonHtml, panelCountText, planetLocked, thumbKind, toggleAll, togglePickedId } from './planetLogic.js';
import { openRowMenu } from './rowMenu.js';
import { deletePickedStars, deleteStar, movePickedStars, moveStar } from './starActions.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const FLASH_MS = 1200;

let ready = false;
let planetId = null; // 열려 있는 행성. 닫혀 있으면 null
let view = 'list'; // 'list' | 'detail'
let detailStar = null; // 상세에 그려진 별
let shownKey = ''; // 상세를 마지막으로 그린 내용(detailKey). 같으면 renderDetail을 부르지 않는다
let menuOpen = false;
let openSeq = 0;
// 여러 개 골라 옮기기: 고르는 중인지 · 고른 별 id. 행성을 바꾸거나 패널을 닫으면 둘 다 비운다
let picking = false;
let pickedIds = new Set();
const flashing = new Map(); // 별 id → 강조가 끝나는 시각

const panelEl = () => $('panel');
const planetOf = (id = planetId) => store.state.planets.find((p) => same(p.id, id)) ?? null;

/* ---------- 목록 ---------- */

function thumb(star) {
  const kind = thumbKind(star);
  if (kind === 'thumb') {
    return `<span class="th" aria-hidden="true"><img src="${esc(api.attachmentThumbUrl(star.thumb_attachment_id))}" alt="" loading="lazy" decoding="async" data-fallback="image"></span>`;
  }
  return `<span class="th" aria-hidden="true">${ico(kind, 17)}</span>`;
}

// 첨부가 2개 이상이면 제목 옆에 작은 클립과 개수(스펙 6-9)
function clip(star) {
  const n = Number(star.attachment_count) || 0;
  if (n < 2) return '';
  return `<span class="clip" title="첨부 ${num(n)}개"><span class="sr">, 첨부 ${num(n)}개</span>${ico('paperclip', 13)}<span aria-hidden="true">${num(n)}</span></span>`;
}

function listHtml(planet, stars) {
  const face = planetFace(planet);
  const only = store.state.planets.length < 2;
  const locked = planetLocked(planet);
  const now = Date.now();
  // 고르기 버튼: 별이 2개 이상이면(행성이 하나뿐이어도 지우기는 된다). 고르는 중에는 같은 자리가 "취소"
  const pickBtn = pickButtonHtml({ picking, canPick: stars.length >= 2, focusAttr: 'data-focus' });
  const items = stars
    .map((s) => {
      const fresh = (flashing.get(String(s.id)) ?? 0) > now;
      const title = s.title || '제목 없음';
      if (picking) {
        // 고르는 중: 행 전체가 체크칸 하나(누르면 고르기 · 풀기). ⋯ 메뉴는 없다
        const on = pickedIds.has(String(s.id));
        return (
          '<div class="recw pick">' +
          `<button type="button" class="rec${on ? ' on' : ''}" role="checkbox" aria-checked="${on}" data-pick="${esc(s.id)}" data-focus="pick:${esc(s.id)}">` +
          `<span class="cb" aria-hidden="true"></span>${thumb(s)}<span class="t">${esc(title)}</span>${clip(s)}<span class="d">${esc(shortDate(s.created_at))}</span></button></div>`
        );
      }
      return (
        // 한 행 = 상세 열기 버튼 + ⋯ 버튼. ⋯은 마우스를 올리거나 키보드로 오면 날짜 자리에 나타난다(터치는 늘)
        '<div class="recw">' +
        `<button type="button" class="rec${fresh ? ' new' : ''}" data-id="${esc(s.id)}" data-focus="star:${esc(s.id)}">` +
        `${thumb(s)}<span class="t">${esc(s.title || '제목 없음')}</span>${clip(s)}<span class="d">${esc(shortDate(s.created_at))}</span></button>` +
        `<button type="button" class="more" data-more-star="${esc(s.id)}" data-focus="more:${esc(s.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`'${s.title || '제목 없음'}' 별 메뉴`)}" title="별 메뉴">${ico('ellipsis', 18)}</button></div>`
      );
    })
    .join('');
  return (
    `<header><div class="planet-ico" style="background:${face}" aria-hidden="true"></div>` +
    `<div class="hd"><h2><span class="pn">${esc(planet.name)}</span> ` +
    (locked ? '' : `<button type="button" class="ic" data-act="edit" data-focus="edit" aria-label="행성 꾸미기" title="행성 꾸미기">${ico('pencil', 16)}</button>`) +
    '</h2>' +
    `<div class="sub">${esc(panelCountText({ period: store.state.period, inPeriod: stars.length, total: planet.count_total, range: store.state.range }))}</div></div>` +
    (locked ? '' : `<button type="button" class="btn x ghost" data-act="menu" data-focus="menu" aria-label="행성 메뉴" aria-expanded="${menuOpen}" aria-controls="pMenu">${ico('ellipsis')}</button>`) +
    `<button type="button" class="btn x" data-act="close" data-focus="close" aria-label="닫기">${ico('x')}</button></header>` +
    (menuOpen && !locked
      ? '<div class="menu" id="pMenu">' +
        '<button type="button" data-m="edit" data-focus="m:edit">행성 꾸미기</button>' +
        `<button type="button" data-m="merge" data-focus="m:merge"${only ? ' disabled' : ''}>다른 행성과 합치기</button>` +
        '<button type="button" data-m="del" data-focus="m:del">행성 삭제</button></div>'
      : '') +
    '<div class="body">' +
    (locked ? '<div class="lockline">기본 행성이라 이름을 바꾸거나 지울 수 없어요</div>' : '') +
    // 고르는 중: 라벨 왼쪽에 전체 선택 체크칸(보이는 별 = 이 목록), 오른쪽은 "취소"
    `<div class="lblrow">${picking ? `<div class="lblpick">${pickAllHtml({ state: pickAllState(pickedIds, stars.map((s) => s.id)), focusAttr: 'data-focus' })}<div class="lbl">이 행성을 도는 별들</div></div>` : '<div class="lbl">이 행성을 도는 별들</div>'}${pickBtn}</div>` +
    (stars.length
      ? `<div class="recs">${items}</div>`
      : store.state.period === 'all'
        ? '<div class="empty">이 행성에는 아직 별이 없어요.</div>'
        : '<div class="empty">이 기간에는 이 행성에 별이 없어요.<br>위쪽에서 기간을 넓혀 보세요.</div>') +
    '</div>' +
    // "행성 옮기기"는 옮길 행성이 없으면(행성이 이것 하나뿐) 잠긴다. "지우기"는 고른 것이 있으면 늘 된다
    (picking ? pickBarHtml({ count: pickedIds.size, canMove: moveTargets(stars.filter((s) => pickedIds.has(String(s.id))), store.state.planets).length > 0, focusAttr: 'data-focus' }) : '')
  );
}

function renderList(planet) {
  const el = panelEl();
  // 다시 그려도 초점과 스크롤 자리가 남게 한다
  const focusKey = el.contains(document.activeElement) ? document.activeElement.dataset?.focus : undefined;
  const scroll = el.querySelector('.body')?.scrollTop ?? 0;
  const stars = panelStars(store.state.stars, planet.id);
  pickedIds = keepPicked(pickedIds, stars); // 목록에서 사라진 별(옮김 · 지움 · 기간)은 선택에서도 뺀다
  el.innerHTML = listHtml(planet, stars);
  const body = el.querySelector('.body');
  if (body) body.scrollTop = scroll;
  if (focusKey) {
    [...el.querySelectorAll('[data-focus]')].find((n) => n.dataset.focus === focusKey && !n.disabled)?.focus({ preventScroll: true });
  }
}

/* ---------- 상세 ---------- */

function showDetail(planet) {
  // 같은 내용이면 그대로 둔다. 열쇠에 메모는 없다: 메모만 바뀐 'data'(자동 저장 뒤)로는 상세를 건드리지 않는다.
  // 행성은 모두(이름 · 색) 본다: 이 별의 행성 머리와 옮기기 목록에 보인다
  const next = detailKey(detailStar, store.state.planets);
  if (next === shownKey && panelEl().firstChild) return;
  shownKey = next;
  renderDetail(panelEl(), detailStar, planet, { onBack: backToList, onClose: () => closePanel({ overview: true, keepPosition: true }) });
}

function setDetail(star) {
  endPick();
  view = 'detail';
  detailStar = star;
  shownKey = '';
  menuOpen = false;
  store.state.detailStarId = String(star.id);
  // 손님 별(기간 밖)이 아닌 다른 별을 열었으면 손님 별은 숨는다
  if (!same(store.state.guestStarId, star.id)) clearGuestStar();
  setSelectedStar(star.id);
}

function leaveDetail() {
  if (view === 'detail') flushMemo().catch(() => {});
  view = 'list';
  detailStar = null;
  shownKey = '';
  store.state.detailStarId = null;
}

function backToList() {
  if (planetId === null || view !== 'detail') return;
  leaveDetail();
  clearGuestStar();
  setSelectedStar(null);
  renderPanel();
  panelEl().querySelector('.rec, [data-act="close"]')?.focus({ preventScroll: true });
}

/* ---------- 밖에서 부르는 것 ---------- */

/** 지금 상태대로 패널을 다시 그린다. 행성이 사라졌으면 닫는다. 닫혀 있으면 아무 일도 없다. */
export function renderPanel() {
  if (planetId === null) return;
  const planet = planetOf();
  if (!planet) {
    closePanel({ overview: true }); // 다른 곳에서 지워진 행성
    return;
  }
  panelEl().style.setProperty('--accent', planetDeep(planet));
  if (view === 'detail' && detailStar) {
    // 다시 받은 목록에 그 별이 있으면 새 값으로 바꾼다. 없으면(기간 밖 손님 별 등) 가진 것을 그대로 쓴다
    const fresh = store.state.stars.find((s) => same(s.id, detailStar.id));
    if (fresh) detailStar = fresh;
    if (same(detailStar.planet_id, planet.id)) {
      showDetail(planet);
      return;
    }
    leaveDetail(); // 다른 행성으로 옮겨진 별
    setSelectedStar(null);
  }
  renderList(planet);
}

/**
 * 행성 패널을 연다. starId를 주면 그 별의 상세로, 없으면 목록으로.
 * 별이 지금 기간 목록에 없으면(챗봇 출처 카드로 온 기간 밖 별) 서버에서 받아 온다. 못 받으면 목록을 보인다.
 */
export function openPanel(id, starId) {
  const planet = planetOf(id);
  if (!planet || !store.state.inWorld) return;
  const seq = ++openSeq;
  const wasOpen = planetId !== null;
  if (view === 'detail' && !same(detailStar?.id, starId)) {
    leaveDetail();
    setSelectedStar(null);
  }
  if (!same(planetId, planet.id)) {
    menuOpen = false;
    endPick();
  }
  planetId = String(planet.id);
  store.state.panelPlanetId = planetId;

  const hasStar = starId !== null && starId !== undefined;
  const known = hasStar ? store.state.stars.find((s) => same(s.id, starId)) : null;
  if (known && same(known.planet_id, planet.id)) setDetail(known);
  else if (!hasStar) {
    menuOpen = wasOpen ? menuOpen : false;
    clearGuestStar(); // 목록에서는 손님 별을 보이지 않는다
  }

  // 그리기 전에 먼저 보이게 한다: 숨은 채로 그리면 상세의 메모 칸이 글 높이를 재지 못해 3줄로만 열린다(detail.js growMemo)
  const el = panelEl();
  el.hidden = false;
  renderPanel();
  $('near').hidden = true;
  store.emit('panelOpened', planetId); // 챗봇 창이 자리를 나눌지 정한다(chatPanel.js)

  if (hasStar && !known) {
    api.star(starId).then(
      (star) => {
        if (seq !== openSeq || !same(planetId, planet.id) || !star || !same(star.planet_id, planet.id)) return;
        setDetail(star);
        renderPanel();
      },
      (err) => {
        if (seq === openSeq && err?.code !== 'offline') toast('그 별을 찾지 못했어요');
      },
    );
  }
}

/**
 * 패널을 닫는다. overview가 true면 손님 별을 숨기고, keepPosition이 아니면 조망으로 돌아간다.
 * ✕ · Esc로 닫을 때는 keepPosition: 캐릭터는 그 행성 앞에 그대로 남는다(사용자 결정).
 * 행성이 지워져 닫힐 때만 조망으로 돌아간다. 멀리 날아가서 닫힐 때는 비행을 건드리지 않는다.
 */
export function closePanel({ overview = false, keepPosition = false } = {}) {
  openSeq += 1; // 받던 별(api.star)이 뒤늦게 와도 다시 열지 않는다
  if (planetId === null) return;
  leaveDetail();
  planetId = null;
  menuOpen = false;
  endPick();
  store.state.panelPlanetId = null;
  const el = panelEl();
  // 초점이 패널 안에 남아 있으면 뺀다(숨은 버튼에 남은 초점이 Space · Enter를 받지 않게)
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.hidden = true;
  el.textContent = '';
  setSelectedStar(null);
  store.emit('panelClosed'); // 위쪽 막대가 다시 내려올지 정한다(topbar.js)
  if (overview) {
    clearGuestStar();
    if (store.state.inWorld && !keepPosition) enterOverview();
  }
}

/**
 * 방금 생긴 별의 목록 항목을 1.2초 동안 핑크로 강조한다(DESIGN.md 9-3 "새 항목").
 * 패널이 그 행성으로 열려 있지 않으면 아무 일도 없다. 모션 줄이기에서는 CSS가 끈다.
 */
export function flashStars(starIds = []) {
  const until = Date.now() + FLASH_MS;
  for (const id of starIds) flashing.set(String(id), until);
  setTimeout(() => {
    const now = Date.now();
    for (const [id, t] of flashing) if (t <= now) flashing.delete(id);
    for (const el of panelEl().querySelectorAll('.rec.new')) {
      if (!flashing.has(el.dataset.id)) el.classList.remove('new');
    }
  }, FLASH_MS + 20);
  if (planetId !== null && view === 'list') renderPanel();
}

/* ---------- 메뉴 ---------- */

async function merge(planet) {
  const others = store.state.planets.filter((p) => !same(p.id, planet.id));
  if (!others.length) return;
  const nameOf = (id) => others.find((p) => same(p.id, id))?.name ?? '';
  const answer = ask({
    title: `행성 '${planet.name}'을(를) 다른 행성과 합칠까요?`,
    desc: mergeDesc(planet.count_total, others[0].name),
    confirmLabel: '합치기',
    confirmKind: 'pink',
    select: { options: others.map((p) => ({ value: p.id, label: p.name })), value: others[0].id, label: '합칠 행성' },
  });
  // 고른 행성에 맞춰 설명의 이름을 바꾼다(textContent라 esc가 필요 없다)
  const sel = document.querySelector('#cExtra select');
  sel?.addEventListener('change', () => {
    $('cBody').textContent = mergeDesc(planet.count_total, nameOf(sel.value));
  });
  const into = await answer;
  if (!into) return;
  try {
    await api.mergePlanet(planet.id, into);
  } catch (err) {
    const why = mergeFailure(err);
    if (why === 'stale') {
      // 두 행성 중 하나가 그사이 사라졌다: 다시 받고, 이 행성이 없어졌으면 패널을 닫는다
      try {
        await store.reload();
      } catch {
        /* 연결 실패 카드는 api.js가 띄운다 */
      }
      if (same(planetId, planet.id) && !planetOf()) closePanel({ overview: true });
    }
    toast(mergeErrorText(why));
    return;
  }
  if (same(planetId, planet.id)) closePanel({ overview: true });
  toast(`'${nameOf(into)}'(으)로 합쳤어요`);
  store.reload().catch(() => {});
}

const menuButton = () => panelEl().querySelector('[data-act="menu"]');

// 메뉴를 접는다. 목록을 다시 그리지 않고 메뉴만 뗀다(누르던 항목이 바뀌지 않게).
// focus가 true이거나 초점이 메뉴 안에 있었으면 ⋯ 버튼으로 옮긴다
function closeMenu({ focus = false } = {}) {
  if (!menuOpen) return;
  menuOpen = false;
  const menu = panelEl().querySelector('#pMenu');
  const btn = menuButton();
  const inside = Boolean(menu?.contains(document.activeElement));
  menu?.remove();
  btn?.setAttribute('aria-expanded', 'false');
  if (btn && (focus || inside)) btn.focus({ preventScroll: true });
}

// 메뉴 밖을 누르면 접는다(⋯ 버튼은 스스로 여닫는다)
function onPointerDownOutside(e) {
  if (!menuOpen) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && (t.closest('#pMenu') || t.closest('#panel [data-act="menu"]'))) return;
  closeMenu();
}

function menuAct(act, planet) {
  // 창을 열기 전에 초점을 ⋯ 버튼에 둔다: 창이 닫히면 거기로 돌아온다(메뉴 항목은 사라진다)
  closeMenu({ focus: true });
  if (menuButton() !== document.activeElement) menuButton()?.focus({ preventScroll: true });
  if (act === 'edit') openPlanetForm({ planet });
  else if (act === 'merge') merge(planet);
  else if (act === 'del') {
    confirmDeletePlanet(
      planet,
      store.state.planets.filter((p) => !same(p.id, planet.id)),
    );
  }
}

/* ---------- 여러 개 골라 옮기기 ---------- */

function endPick() {
  // 우주 패널 고르기는 body.picking(물어보기 숨김)을 켜지 않는다. 홈 목록 고르기에서만 켠다.
  picking = false;
  pickedIds = new Set();
}

// 고르기를 켜고 끈다. 끄면 고른 것도 비운다. 초점은 같은 자리의 버튼(여러 개 고르기 ↔ 취소)에 남는다
function togglePick() {
  if (picking) endPick();
  else {
    picking = true;
    pickedIds = new Set();
    menuOpen = false;
    // (setPickingUi 안 부름: 패널 고르기 중에도 물어보기 버튼은 그대로)
  }
  renderPanel();
  panelEl().querySelector('[data-act="pick"]')?.focus({ preventScroll: true });
}

function togglePicked(id) {
  pickedIds = togglePickedId(pickedIds, id);
  renderPanel();
}

// 옮기기 · 지우기가 끝난 뒤. result = movePickedStars · deletePickedStars의 값, pid = 누를 때의 행성, act = 누른 바 버튼
function afterPickAction(result, pid, act) {
  if (result === null || result === undefined || !same(planetId, pid)) return;
  if (result.partial) {
    if (!picking) return;
    // 앞 묶음만 처리됐다: 처리된 별은 선택에서 빼고 바로 다시 그린다. 고르기는 이어 간다(남은 것을 다시 누를 수 있게)
    const done = new Set(result.doneIds);
    pickedIds = new Set([...pickedIds].filter((id) => !done.has(id)));
    renderPanel();
    const el = panelEl();
    (el.querySelector(`.pickbar [data-act="${act}"]:not(:disabled)`) ?? el.querySelector('.pickall, [data-act="pick"], [data-act="close"]'))?.focus({ preventScroll: true });
    return;
  }
  endPick();
  renderPanel();
  panelEl().querySelector('[data-act="pick"], .rec, [data-act="close"]')?.focus({ preventScroll: true });
}

async function movePicked() {
  const pid = planetId;
  afterPickAction(await movePickedStars(pickedIds), pid, 'movePicked');
}

// 머리의 전체 선택: 이 목록(보이는 별)을 모두 고르거나 비운다. 초점은 체크칸에 남는다(renderList가 data-focus로 되찾는다)
function togglePickAll() {
  const planet = planetOf();
  if (!planet) return;
  pickedIds = toggleAll(pickedIds, panelStars(store.state.stars, planet.id).map((s) => s.id));
  renderPanel();
}

async function deletePicked() {
  const pid = planetId;
  afterPickAction(await deletePickedStars(pickedIds), pid, 'pickdel');
}

/* ---------- 누르기 ---------- */

function onClick(e) {
  if (planetId === null || view !== 'list' || !(e.target instanceof Element)) return;
  const planet = planetOf();
  if (!planet) return;
  const m = e.target.closest('.menu [data-m]');
  if (m) {
    if (!m.disabled) menuAct(m.dataset.m, planet);
    return;
  }
  const actEl = e.target.closest('[data-act]');
  const act = actEl?.dataset.act;
  if (act === 'pick') {
    togglePick();
    return;
  }
  if (act === 'movePicked') {
    if (!actEl.disabled) movePicked();
    return;
  }
  if (act === 'pickdel') {
    if (!actEl.disabled) deletePicked();
    return;
  }
  if (act === 'pickall') {
    if (picking) togglePickAll();
    return;
  }
  const pickEl = e.target.closest('[data-pick]');
  if (pickEl) {
    if (picking) togglePicked(pickEl.dataset.pick);
    return;
  }
  if (act === 'close') closePanel({ overview: true, keepPosition: true });
  else if (act === 'edit') {
    actEl.focus({ preventScroll: true }); // 창이 닫히면 ✎로 돌아오게(누른 버튼에 초점이 가지 않는 브라우저도 있다)
    openPlanetForm({ planet });
  } else if (act === 'menu') {
    if (menuOpen) closeMenu({ focus: true });
    else {
      menuOpen = true;
      renderPanel();
      panelEl().querySelector('.menu button:not(:disabled)')?.focus({ preventScroll: true });
    }
    return;
  }
  const more = e.target.closest('[data-more-star]');
  if (more) {
    openStarMenu(more, planet);
    return;
  }
  const row = e.target.closest('.rec[data-id]');
  if (row) {
    const star = store.state.stars.find((s) => same(s.id, row.dataset.id));
    if (!star) return;
    setDetail(star);
    renderPanel();
    panelEl().querySelector('[data-d="back"], button')?.focus({ preventScroll: true });
  }
}

// 별 ⋯ 메뉴: 행성 옮기기 · 지우기. 옮기기는 옮길 행성을 고르는 확인 창, 지우기는 상세의 "이 별 지우기"와 같은 확인 창
function openStarMenu(button, planet) {
  const star = store.state.stars.find((s) => same(s.id, button.dataset.moreStar));
  if (!star) return;
  const others = store.state.planets.filter((p) => !same(p.id, planet.id));
  openRowMenu(button, `'${star.title || '제목 없음'}' 별 메뉴`, [
    // 옮기기 · 지우기는 홈의 별 목록과 같이 쓴다(starActions.js). 끝나면 이 패널만 다시 그린다
    { key: 'move', label: '행성 옮기기', disabled: others.length === 0, run: () => moveStar(star, others).then((moved) => moved && renderPanel()) },
    { key: 'del', label: '지우기', danger: true, run: () => deleteStar(star).then((gone) => gone && renderPanel()) },
  ]);
}

// 축소본을 못 받으면(보관함에서 사라짐 등) 종류 아이콘으로 바꾼다
function onImgError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const box = img.closest('.th');
  if (box) box.innerHTML = ico(img.dataset.fallback, 17);
}

// 상세에 열린 별이 다시 받은 목록에 없다: 기간 밖 손님 별일 수도, 다른 곳에서 지워졌을 수도 있다.
// 서버에 물어 지워졌으면(404) 목록으로 돌아간다
function checkDetailStar() {
  if (planetId === null || view !== 'detail' || !detailStar) return;
  const id = detailStar.id;
  if (store.state.stars.some((s) => same(s.id, id))) return;
  const still = () => planetId !== null && view === 'detail' && same(detailStar?.id, id);
  api.star(id).then(
    (star) => {
      if (!star || !still()) return;
      detailStar = star; // 다른 행성으로 옮겨졌으면 renderPanel이 목록으로 돌린다
      renderPanel();
    },
    (err) => {
      if (err?.status !== 404 || !still()) return;
      backToList();
      toast('그 별은 지워졌어요');
    },
  );
}

/** 패널을 준비한다(한 번만). */
export function initPanel() {
  if (ready) return;
  ready = true;
  const el = panelEl();
  el.addEventListener('click', onClick);
  el.addEventListener('error', onImgError, true);

  store.on('land', (id) => openPanel(id));
  store.on('openStar', (e) => e && openPanel(e.planetId, e.starId));
  store.on('leftPanelPlanet', () => closePanel());
  store.on('leavingWorld', () => closePanel());
  store.on('leaveWorld', () => closePanel());
  store.on('planetDeleted', (id) => {
    if (same(planetId, id)) closePanel({ overview: true });
  });
  store.on('data', () => {
    if (!store.state.inWorld) closePanel();
    else {
      renderPanel();
      checkDetailStar();
    }
  });
  document.addEventListener('pointerdown', onPointerDownOutside, true);

  // Esc: 상세에서 목록(30) → 패널 닫기(20, 메뉴가 열려 있으면 메뉴부터, 고르는 중이면 고르기부터 끝낸다)
  registerEscape(30, () => {
    if (planetId === null || view !== 'detail') return false;
    backToList();
    return true;
  });
  registerEscape(20, () => {
    if (planetId === null) return false;
    if (menuOpen) closeMenu({ focus: true });
    else if (picking && view === 'list') togglePick();
    else closePanel({ overview: true, keepPosition: true });
    return true;
  });
}
