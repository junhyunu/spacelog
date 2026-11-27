// W-01 조작 UI: 왼쪽 패널(로고 · 숫자 · 바로 날아가기 목록 · 조작 안내) · 기간 바 · 띠 배너 ·
// 빈 우주 말풍선 · 손님 별. 배치는 스펙 6-8(왼쪽 패널 · 오른쪽 위 기간 바 · 기록하기 위 말풍선).
// 시안 611~656행(renderDock · applyPeriod · pickRedis · renderRedis · worldState)과 guest · clearGuest를 옮겼다.
// 착륙 안내(#near)는 controls.js가 한다.
//
// store로 알리는 것:
//   'land'       planetId               목록에서 눌러 그 행성에 도착했을 때
//   'openStar'   { planetId, starId }   별로 날아가기(챗봇 출처 카드)로 그 별의 행성에 도착했을 때
//   'openSave'                          "기록하기"(#wLog · 빈 우주 카드)
//   'newPlanet'                         "+ 새 행성"(#wNewPlanet, 왼쪽 패널 목록 맨 위)
//   'openCharacter'                     "캐릭터"(#wCharacter, 왼쪽 패널 요약 둘째 줄, 홈과 사람 아이콘 사이)
//   'openAccount'                       사람 아이콘(#wMe) 메뉴의 "계정 설정"
//   'signOut'                           같은 메뉴의 "로그아웃"(main.js가 홈으로 나간다)
// store에서 듣는 것:
//   'data'             우주 안에 있을 때 전부 다시 그리고 3D를 맞춘다
//   'near'             planetId | null  목록의 노랑 표시
//   'guestStar'        star             transition.js: 기간 밖의 별로 들어옴 → showGuestStar
//   'manualMove'       패널이 닫혀 있거나 손님 별에 아직 도착하지 않았으면 손님 별을 숨긴다. 조작 안내 줄을 접는다
//   'flightCancelled'  (controls.js가 알리게 되면) 손님 별로 가던 길이 끊겼을 때 손님 별을 숨긴다
//   'leftPanelPlanet'  손님 별을 숨긴다
//   'land' · 'openStar'    손님 별이 아닌 곳으로 갔으면 숨긴다
//   'enterWorld'       기간을 넓혔으면 그 토스트
//   'leaveWorld'       손님 별 · 가까운 행성 표시를 지운다. 좁은 화면이면 왼쪽 서랍을 닫는다
//   'offline'          빈 우주 말풍선을 숨긴다(연결 실패 카드가 대신 말한다)
// 연결 실패 카드는 main.js(showOffline)가 #worldMsg에 그린다. #worldMsg는 이제 그 카드에만 쓴다(빈 우주 안내는 말풍선 #wHint).
// 좁은 화면(760px 이하)의 기간 바는 🕐(#wPeriodBtn, 지금 기간 이름이 붙는다)를 눌렀을 때만 아이콘 줄 아래에 펼쳐진다(body.period-open).
//   전체 · 오늘 · 이번 주를 고르거나 바깥 · Esc(34)로 접는다. 직접 지정은 날짜를 고르게 남긴다. 별 찾기(search.js)가 열리면 접는다.
// 화면 배치 변수(:root): --tr-bottom 기간 바 + 띠 배너의 아래 끝(W-02 패널 · 토스트가 그 아래에서 시작한다),
//   --hint-lift 화면 아래에서 말풍선 위 끝까지(좁은 화면의 착륙 안내가 그 위로 비킨다).
// 손님 별은 clearGuestStar()로 언제든(손님 별이 없을 때도) 숨길 수 있다: 패널 닫기 · 목록으로 · 삭제 · 이동.
import { api } from '../api.js';
import { store } from '../store.js';
import { flyTo, setInputBlocked } from '../three/controls.js';
import { STAR_CAP, setSelectedStar, syncUniverse } from '../three/planets.js';
import { planetFace, daysAgo, esc, periodCountLabel, periodName, periodRange } from '../util.js';
import { planetLocked } from './planetLogic.js';
import { registerEscape } from './escape.js';
import { confirmDeletePlanet } from './planetDelete.js';
import { openPlanetForm, trapTab } from './planetForm.js';
import { mergePlanet, mergeTargets } from './planetMerge.js';
import { openRowMenu } from './rowMenu.js';
import {
  defaultCustom,
  emptyHint,
  guestMoved,
  guestVerdict,
  initialSideCollapsed,
  isOutsidePeriod,
  nextCustom,
  revertTarget,
  shouldWiden,
  shouldWidenToAll,
  widenToast,
  worldStateOf,
} from './hudLogic.js';
import { toast } from './toast.js';
import { onBeforeWorldOpens } from './transition.js';

const $ = (id) => document.getElementById(id);
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const faceOf = (planet) => planetFace(planet);
const SIDE_KEY = 'spacelog.leftPanel'; // 'open' | 'closed'
const HINT_KEY = 'spacelog.emptyHintOff'; // '1'이면 ✕로 끈 말풍선을 다시 띄우지 않는다
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };
// 서랍이 펼쳐진 동안 inert로 잠그는 것(막 아래에 있는 우주 위 UI)
const DRAWER_INERT = ['stage', 'period', 'near', 'wHint', 'wLog', 'worldMsg', 'panel'];
// 저장소를 못 쓰는 환경(사생활 보호 창 등)에서도 화면은 그대로 동작한다
function readKey(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeKey(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 기억하지 못해도 된다 */
  }
}
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

let ready = false;
let custom = defaultCustom(); // "직접 지정"의 날짜 { from, to } 'YYYY-MM-DD'
let nearId = null;
let guest = null; // 손님 별 { id, planet_id }: 기간 밖인데 챗봇 출처 카드 등으로 들어와 잠시 보여 주는 별
let guestArrived = false; // 손님 별에 도착했는지('openStar'). 가는 길에 끊기면 손님 별을 숨긴다
let guestSeq = 0; // 손님 별 다시 확인(api.star)의 세대
let holdGuest = false; // 손님 별로 날아가기를 시작하는 순간의 'leftPanelPlanet'은 흘려보낸다
// 마지막으로 받는 데 성공한 기간. 기간 바꾸기가 실패하면 여기로 되돌린다
let loaded = { period: store.state.period, range: store.state.range, custom };
const MORE = '<svg class="i" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';
let periodSeq = 0;
let widenSeq = 0;
let widenPending = false; // 들어올 때 이번 주로 넓히는 reload가 아직 끝나지 않았다
let flightSeq = 0;
let widened = false; // 들어오며 넓힌 기간('week' | 'all'), 넓히지 않았으면 false
let sideCollapsed = false;
let hintDismissed = false; // 이번 탭에서 ✕를 눌렀다(저장소를 못 써도 이번 탭에서는 다시 뜨지 않는다)

/* ---------- 3D 맞추기 ---------- */
function sync() {
  if (!store.state.inWorld) return;
  syncUniverse({
    planets: store.state.planets,
    stars: store.state.stars,
    guestStarId: guest ? guest.id : null,
    guestStar: guest,
  });
}

/* ---------- 손님 별 ---------- */
/**
 * 기간 밖의 별 하나만 잠시 핑크로 보여 준다(DESIGN.md W-01 "기간 밖 별로 날아갈 때", 지금은 챗봇 출처 카드).
 * 기간 · 개수 · 다른 별은 그대로다. star = { id, planet_id, created_at }.
 */
export function showGuestStar(star) {
  if (!star || star.id === null || star.id === undefined || star.planet_id === null || star.planet_id === undefined) return;
  guest = { id: String(star.id), planet_id: String(star.planet_id) };
  guestArrived = false;
  guestSeq += 1;
  store.state.guestStarId = guest.id;
  sync();
  setSelectedStar(guest.id);
  toast(`${num(daysAgo(star.created_at))}일 전 별이라 이 별만 잠시 보여드려요`);
}

/** 손님 별을 다시 숨긴다. 언제 불러도 된다: 손님 별이 없으면 아무 일도 없다. */
export function clearGuestStar() {
  if (!guest) {
    store.state.guestStarId = null;
    return;
  }
  const id = guest.id;
  dropGuest();
  sync();
  // 다른 별의 상세가 열려 있으면 그 별의 핑크는 건드리지 않는다
  const detail = store.state.detailStarId;
  if (detail === null || detail === undefined || same(detail, id)) setSelectedStar(null);
}

// 화면은 건드리지 않고 손님 별 표시만 내린다(다시 그리는 쪽이 3D를 맞춘다)
function dropGuest() {
  guest = null;
  guestArrived = false;
  guestSeq += 1;
  store.state.guestStarId = null;
}

// 손님 별이 떠 있는 동안 'data'가 오면(삭제 · 이동 뒤) 그 별이 아직 그 행성에 있는지 확인한다.
// 지워졌거나(404) 다른 행성으로 옮겨졌으면 숨긴다. 그 밖의 실패는 그대로 둔다.
async function revalidateGuest() {
  if (!guest) return;
  const { id } = guest;
  const seq = ++guestSeq;
  let star = null;
  try {
    star = await api.star(id);
  } catch (err) {
    if (err?.status !== 404) return;
  }
  if (seq !== guestSeq || !guest || guest.id !== id) return;
  if (guestMoved(guest, star)) clearGuestStar();
}

// 별로 날아간다(챗봇 출처 카드 chatPanel.js). 기간 밖이면 손님 별로 보여 주고, 도착하면 'openStar'.
export function flyToStar(star) {
  const planetId = String(star.planet_id);
  const starId = String(star.id);
  if (isOutsidePeriod(star, store.state.range)) showGuestStar(star);
  else clearGuestStar();
  const token = ++flightSeq;
  holdGuest = true;
  const flight = flyTo(planetId, starId); // 손님 별이 아니면 "'OO'(으)로 비행 중…" 토스트는 flyTo가 띄운다
  holdGuest = false;
  flight.then((arrived) => {
    if (arrived) store.emit('openStar', { planetId, starId });
    else if (token === flightSeq && guest && guest.id === starId) clearGuestStar(); // 가는 길이 끊겼다
  });
}

/* ---------- 기간 ---------- */
function isPeriodOpen() {
  return typeof document !== 'undefined' && document.body.classList.contains('period-open');
}

/** 좁은 화면의 기간 바를 펼치거나 접는다(🕐). 넓은 화면에서는 기간 바가 늘 보여 아무 영향이 없다. */
export function setPeriodOpen(on, { focus = false } = {}) {
  on = Boolean(on);
  if (isPeriodOpen() === on) return;
  document.body.classList.toggle('period-open', on);
  $('wPeriodBtn').setAttribute('aria-expanded', String(on));
  updateLayoutVars(); // 기간 바 높이만큼 패널 · 토스트 자리가 바뀐다
  if (!on && focus) $('wPeriodBtn').focus({ preventScroll: true });
}

function paintPeriod() {
  const period = store.state.period;
  for (const b of document.querySelectorAll('#period .seg button')) {
    const on = b.dataset.p === period;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('range').hidden = period !== 'custom';
  if ($('rFrom').value !== custom.from) $('rFrom').value = custom.from;
  if ($('rTo').value !== custom.to) $('rTo').value = custom.to;
  // 좁은 화면의 🕐 버튼: 기간 바를 접어도 지금 기간이 보이게 이름을 붙인다
  const name = periodName(period);
  $('wPeriodName').textContent = name;
  $('wPeriodBtn').setAttribute('aria-label', `기간: ${name}, 바꾸기`);
  updateLayoutVars(); // 좁은 화면에서 "직접 지정"은 기간 바를 아래 줄로 내린다(app.css): 패널 · 토스트 자리를 다시 잰다
  store.emit('period', { period, custom }); // 홈의 기간 바(homeList.js)도 같은 값을 보인다
}

// 홈의 기간 바가 보낸 것('setPeriod'): { period } 또는 "직접 지정"의 날짜 { from, to }. 우주의 기간 바를 누른 것과 같은 길을 탄다
function onSetPeriod({ period, from, to } = {}) {
  if (from !== undefined || to !== undefined) {
    custom = nextCustom(custom, { from: from ?? custom.from, to: to ?? custom.to });
    if (store.state.period === 'custom') applyPeriod('custom');
    else paintPeriod();
    return;
  }
  if (!period || period === store.state.period) return;
  applyPeriod(period);
}

// 기간을 바꾸고 다시 받는다. 연결이 끊긴 경우가 아닌데 실패하면 마지막으로 받은 기간으로 되돌린다
// (바로 전에 누른 기간이 아니다: 그 기간은 아직 받지 못했을 수 있다). 더 새로운 바꾸기가 있으면 그쪽에 맡긴다.
async function applyPeriod(period) {
  const token = ++periodSeq;
  store.state.period = period;
  if (period === 'custom') store.state.range = periodRange('custom', custom);
  paintPeriod();
  try {
    await store.reload();
    return true;
  } catch (err) {
    const back = revertTarget({ isLatest: token === periodSeq, offline: err?.code === 'offline', loaded });
    if (back) {
      store.state.period = back.period;
      store.state.range = back.range;
      if (back.period === 'custom' && back.custom) custom = back.custom;
      paintPeriod();
      toast('기간을 바꾸지 못했어요. 다시 눌러 주세요');
    }
    return false;
  }
}

function onPeriodClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el) return;
  if (el.id === 'wPeriodBtn') {
    const on = !isPeriodOpen();
    setPeriodOpen(on);
    if (on) document.querySelector('#period .seg button.on')?.focus({ preventScroll: true });
    return;
  }
  const period = el.dataset.act === 'today' ? 'today' : el.dataset.p;
  // 좁은 화면: 전체 · 오늘 · 이번 주를 고르면 기간 바를 접는다(직접 지정은 날짜를 고르게 남긴다)
  if (el.dataset.p && el.dataset.p !== 'custom' && narrowMq.matches) setPeriodOpen(false, { focus: true });
  if (!period || period === store.state.period) return;
  applyPeriod(period);
}

function onRangeChange() {
  // 비었거나 틀린 날짜는 전 값으로 되돌리고, 시작이 끝보다 뒤면 바꾼다
  custom = nextCustom(custom, { from: $('rFrom').value, to: $('rTo').value });
  if (store.state.period === 'custom') applyPeriod('custom');
  else paintPeriod();
}

/* ---------- 그리기 ---------- */
function paintBrand() {
  $('sRecLabel').textContent = periodCountLabel(store.state.period);
  $('sRec').textContent = num(store.state.summary?.in_period);
  $('sPlanet').textContent = num(store.state.planets.length);
}

function markNear() {
  for (const b of document.querySelectorAll('#dock button[data-planet]')) b.classList.toggle('here', same(b.dataset.planet, nearId));
}

// "+ 새 행성"을 목록 항목과 같은 폭으로: 목록에 스크롤 막대가 생기면 그 폭만큼 줄인다(스펙 6-10)
function syncNewPlanetWidth() {
  const dock = $('dock');
  const bar = dock.hidden ? 0 : Math.max(0, dock.offsetWidth - dock.clientWidth);
  $('wNewPlanet').style.setProperty('--dock-sbw', `${bar}px`);
}

// 바로 날아가기 목록: 색 점 · 이름 · 이 기간 별 개수. "+ 새 행성"(#wNewPlanet)은 목록 위에 고정돼 있어
// 여기서 그리지 않는다(행성이 없어도 보인다, 스펙 6-6). 이 목록만 세로로 스크롤한다.
function paintDock() {
  const dock = $('dock');
  const focused = dock.contains(document.activeElement) ? document.activeElement : null;
  // 다시 그린 뒤 같은 자리로 초점을 돌리려고 적어 둔다(날아가기 버튼 · ⋯ 버튼)
  const focusSel = focused?.dataset.planet !== undefined
    ? `button[data-planet="${CSS.escape(focused.dataset.planet)}"]`
    : focused?.dataset.more !== undefined
      ? `button[data-more="${CSS.escape(focused.dataset.more)}"]`
      : null;
  // 한 행 = 날아가기 버튼 + ⋯ 버튼(버튼 안에 버튼을 넣을 수 없어 나란히 둔다).
  // ⋯은 마우스를 올리거나 키보드로 그 행에 오면 개수 배지 자리에 나타난다. 터치 화면에서는 늘 보인다(app.css)
  const html = store.state.planets
      .map((p) => {
        const count = num(p.count_in_period);
        // 지금 기간에 별이 없는 행성은 흐리게(app.css .dock button.zero): 우주에서도 가장 작은 크기다. 누를 수는 있다
        const zero = !(Number(p.count_in_period) > 0);
        return (
          '<div class="drow">' +
          `<button type="button"${zero ? ' class="zero"' : ''} data-planet="${esc(p.id)}" aria-label="${esc(`'${p.name}' 행성으로 날아가기, ${periodCountLabel(store.state.period)} ${count}개`)}">` +
          `<span class="dot" style="background:${faceOf(p)}"></span><span class="t">${esc(p.name)}</span><span class="n">${count}</span></button>` +
          (planetLocked(p) ? '' : `<button type="button" class="more" data-more="${esc(p.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`'${p.name}' 행성 메뉴`)}" title="행성 메뉴">${MORE}</button>`) +
          '</div>'
        );
      })
      .join('');
  if (dock.dataset.html !== html) {
    dock.innerHTML = html; // 같으면 다시 그리지 않는다(스크롤 자리 · 초점이 그대로)
    dock.dataset.html = html;
  }
  dock.hidden = store.state.planets.length === 0;
  syncNewPlanetWidth();
  markNear();
  // 다시 그리기 전에 초점이 있던 버튼으로 되돌린다
  if (focusSel && !dock.contains(document.activeElement)) dock.querySelector(focusSel)?.focus({ preventScroll: true });
}

// 띠 배너(기간 바 바로 아래): 별 상한 초과. 빈 우주 안내는 말풍선(paintHint)으로 옮겼다
function paintBanner({ kind, todayButton }) {
  const el = $('wBanner');
  let html = '';
  if (kind === 'cap') {
    html =
      '<span>기간을 좁히면 별이 보여요</span>' +
      (todayButton ? '<button type="button" class="btn sm" data-act="today">오늘만 보기</button>' : '');
  }
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  el.hidden = html === '';
}

// 빈 우주 말풍선(기록하기 바로 위). 떠 있는 동안 기록하기 둘레에 번지는 테두리(.beckon)를 준다
function paintHint() {
  const el = $('wHint');
  const hint = store.state.inWorld
    ? emptyHint({
        total: store.state.summary?.total,
        planets: store.state.planets.length,
        dismissed: hintDismissed || readKey(HINT_KEY) === '1',
        offline: store.state.offline,
      })
    : null;
  if (hint) {
    $('wHintTitle').textContent = hint.title;
    $('wHintBody').textContent = hint.body;
  } else if (el.contains(document.activeElement)) {
    $('wLog').focus({ preventScroll: true }); // 사라지는 말풍선에 있던 초점은 기록하기로
  }
  el.hidden = !hint;
  $('wLog').classList.toggle('beckon', Boolean(hint));
  updateLayoutVars();
}

function dismissHint() {
  hintDismissed = true;
  writeKey(HINT_KEY, '1');
  paintHint();
}

function render() {
  if (!store.state.inWorld) return;
  const { planets, summary, period } = store.state;
  // 손님 별: 행성이 사라졌거나, 기간이 바뀌어 이제 기간 안의 별이면 손님이 아니다.
  // 그대로면 그 별이 지워지거나 옮겨지지 않았는지 확인한다.
  if (guest) {
    if (guestVerdict({ guest, planets, stars: store.state.stars }) === 'keep') revalidateGuest();
    else dropGuest();
  }
  const st = worldStateOf({ total: summary?.total, inPeriod: summary?.in_period, planets: planets.length, period, cap: STAR_CAP });
  sync();
  paintBrand();
  paintPeriod();
  paintDock();
  paintBanner(st);
  paintHint();
}

/* ---------- 누르기 ---------- */
function onDockClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el) return;
  if (el.dataset.more !== undefined) {
    openPlanetMenu(el);
    return;
  }
  const planetId = el.dataset.planet;
  if (!planetId) return;
  closeDrawer(); // 좁은 화면: 날아가는 모습이 보이게 서랍을 닫는다
  // 패널이 닫혀 있을 때 다른 곳으로 날아가면 손님 별은 숨는다(열려 있으면 패널 쪽이 정리한다)
  if (store.state.panelPlanetId === null || store.state.panelPlanetId === undefined) clearGuestStar();
  flightSeq += 1;
  flyTo(planetId).then((arrived) => arrived && store.emit('land', planetId));
}

// 행성 ⋯ 메뉴: 꾸미기 · 다른 행성과 합치기 · 지우기(홈의 행성 ⋯ 메뉴 · 행성 패널 메뉴와 같은 항목).
// 지우기는 행성 삭제 확인 창(안의 별을 어떻게 할지 고른다)을 거친다. 합친 행성의 패널이 열려 있었으면 다시 받은 'data'에서 panel.js가 닫는다.
// 좁은 화면에서는 서랍을 닫고 창을 연다(창이 서랍 뒤에 가리지 않게)
function openPlanetMenu(button) {
  const planet = store.state.planets.find((p) => same(p.id, button.dataset.more));
  if (!planet || planetLocked(planet)) return;
  const run = (fn) => () => {
    closeDrawer();
    fn();
  };
  openRowMenu(button, `'${planet.name}' 행성 메뉴`, [
    { key: 'edit', label: '꾸미기', run: run(() => openPlanetForm({ planet })) },
    { key: 'merge', label: '다른 행성과 합치기', disabled: mergeTargets(planet).length === 0, run: run(() => mergePlanet(planet)) },
    {
      key: 'del',
      label: '지우기',
      danger: true,
      run: run(() => confirmDeletePlanet(planet, store.state.planets.filter((p) => !same(p.id, planet.id)))),
    },
  ]);
}

/* ---------- 왼쪽 패널 · 조작 안내 ---------- */
/**
 * 왼쪽 패널을 접거나 편다. 접으면 왼쪽 위에 로고 버튼(#sideOpen)만 남는다.
 * 넓은 화면에서 사용자가 바꾼 것만 기억한다(remember). 760px 이하에서는 펼치면 덮이는 서랍이 된다.
 */
function setSide(collapsed, { remember = false, focus = false } = {}) {
  sideCollapsed = Boolean(collapsed);
  const narrow = narrowMq.matches;
  const side = $('side');
  if (sideCollapsed && side.contains(document.activeElement)) focus = true; // 숨는 패널에 있던 초점은 펼치기 버튼으로
  side.hidden = sideCollapsed;
  if (sideCollapsed) setMeMenu(false); // 패널이 접히면 그 버튼의 메뉴도 접는다
  $('sideOpen').hidden = !sideCollapsed;
  $('sideOpen').setAttribute('aria-expanded', String(!sideCollapsed));
  $('sideClose').setAttribute('aria-expanded', String(!sideCollapsed));
  const drawer = narrow && !sideCollapsed;
  $('left').classList.toggle('drawer', drawer);
  $('sideScrim').hidden = !drawer;
  // 서랍이 펼쳐진 동안 막 아래의 조작 UI는 초점도 누르기도 받지 않는다(Tab이 서랍 밖으로 나가지 않게)
  for (const id of DRAWER_INERT) {
    const el = $(id);
    if (el) el.inert = drawer;
  }
  if (remember && !narrow) writeKey(SIDE_KEY, sideCollapsed ? 'closed' : 'open');
  if (focus) (sideCollapsed ? $('sideOpen') : $('sideClose')).focus({ preventScroll: true });
}

/** 좁은 화면에서 왼쪽 서랍이 펼쳐져 있는지. */
export function isDrawerOpen() {
  return Boolean(store.state.inWorld) && narrowMq.matches && !sideCollapsed;
}

// 좁은 화면에서 펼친 서랍만 닫는다(넓은 화면의 패널은 그대로)
function closeDrawer() {
  if (narrowMq.matches && !sideCollapsed) setSide(true);
}

const restoreSide = () => setSide(initialSideCollapsed({ stored: readKey(SIDE_KEY), narrow: narrowMq.matches }));

// 조작 안내 줄: 펼치면 키 목록이 보인다. 이동 키를 누르면 접히고, 줄을 누르면 다시 펼친다
function setHelp(open) {
  $('help').classList.toggle('big', open);
  $('helpToggle').setAttribute('aria-expanded', String(open));
}

/* ---------- 배치 변수 ---------- */
// 기간 바 + 띠 배너의 아래 끝과 말풍선의 위 끝을 CSS에 넘긴다(W-02 패널 · 토스트 · 착륙 안내 자리).
// offsetTop은 페이드 인의 translate를 보지 않는다.
function updateLayoutVars() {
  const root = document.documentElement.style;
  const period = $('period');
  if (!period.hidden && period.offsetHeight) root.setProperty('--tr-bottom', `${period.offsetTop + period.offsetHeight}px`);
  const hint = $('wHint');
  if (!hint.hidden && hint.offsetHeight) root.setProperty('--hint-lift', `${innerHeight - hint.offsetTop}px`);
}

/* ---------- 사람 아이콘 메뉴 ---------- */
// 메뉴는 패널(#side) 밖, #left 안에 있다(패널이 overflow:hidden이라 안에 두면 잘린다).
// #left는 화면에 붙어 있으므로 버튼 위치를 #left 기준으로 바꿔 버튼 바로 아래 · 왼쪽 끝을 버튼 왼쪽 끝에 맞춘다
function placeMeMenu() {
  const menu = $('wMeMenu');
  if (menu.hidden) return;
  const b = $('wMe').getBoundingClientRect();
  const box = $('left').getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.max(8, Math.min(b.left, innerWidth - w - 8)); // 화면 밖으로 나가지 않게
  menu.style.left = `${left - box.left}px`;
  menu.style.top = `${b.bottom + 8 - box.top}px`;
}

function setMeMenu(on, { focus = false } = {}) {
  const menu = $('wMeMenu');
  if (menu.hidden === !on) return;
  menu.hidden = !on;
  $('wMe').setAttribute('aria-expanded', String(on));
  if (on) {
    placeMeMenu();
    menu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
  } else if (focus) $('wMe').focus({ preventScroll: true });
}

function onMeMenuClick(e) {
  const el = e.target instanceof Element ? e.target.closest('[data-me]') : null;
  if (!el) return;
  setMeMenu(false);
  const act = el.dataset.me;
  if (act === 'logout') {
    store.emit('signOut');
    return;
  }
  closeDrawer(); // 좁은 화면: 초점이 펼치기 버튼으로 간다 → 창을 닫으면 거기로 돌아온다
  if (act === 'account') store.emit('openAccount');
}

/* ---------- 시작 ---------- */
/** 조작 UI를 준비한다(한 번만). 그리기는 store의 'data'가 올 때마다(우주 안에서만) 한다. */
export function initHud() {
  if (ready) return;
  ready = true;

  $('period').addEventListener('click', onPeriodClick);
  $('rFrom').addEventListener('change', onRangeChange);
  $('rTo').addEventListener('change', onRangeChange);
  store.on('setPeriod', onSetPeriod);
  $('dock').addEventListener('click', onDockClick);
  $('wNewPlanet').addEventListener('click', () => {
    closeDrawer();
    store.emit('newPlanet');
  });
  // 사람 아이콘 메뉴: 패널 안에서 아래로 펼쳐진다. 바깥을 누르거나 Esc면 접힌다
  $('wCharacter').addEventListener('click', () => {
    closeDrawer(); // 좁은 화면: 초점이 펼치기 버튼으로 간다 → 창을 닫으면 거기로 돌아온다
    store.emit('openCharacter');
  });
  $('wMe').addEventListener('click', () => setMeMenu($('wMeMenu').hidden));
  $('wMeMenu').addEventListener('click', onMeMenuClick);
  addEventListener('pointerdown', (e) => {
    if ($('wMeMenu').hidden || !(e.target instanceof Node)) return;
    if (!$('wMeMenu').contains(e.target) && !$('wMe').contains(e.target)) setMeMenu(false);
  });
  // 초점이 메뉴 밖으로 나가면(Tab) 접는다. 패널 스크롤 · 화면 크기가 바뀌면 자리를 다시 맞춘다
  $('wMeMenu').addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to instanceof Node && ($('wMeMenu').contains(to) || $('wMe').contains(to))) return;
    if (to) setMeMenu(false);
  });
  $('side').addEventListener('scroll', placeMeMenu, true);
  addEventListener('resize', placeMeMenu);
  $('wLog').addEventListener('click', () => store.emit('openSave'));
  $('wHintX').addEventListener('click', dismissHint);
  paintPeriod();

  // 왼쪽 패널: 접기 · 펼치기, 좁은 화면의 서랍(바깥 누르기 · Esc로 닫기)
  $('sideClose').addEventListener('click', () => setSide(true, { remember: true, focus: true }));
  $('sideOpen').addEventListener('click', () => setSide(false, { remember: true, focus: narrowMq.matches }));
  $('sideScrim').addEventListener('click', () => setSide(true, { focus: true }));
  $('helpToggle').addEventListener('click', () => setHelp(!$('help').classList.contains('big')));
  // 패널 위의 끌기 · 휠은 우주로 넘어가지 않는다: controls.js는 캔버스 위의 이벤트만 받는다.
  // 여기서 전파를 끊지 않는다(dropzone.js가 window의 pointerdown으로 화면 안 끌기 표시를 지운다).
  // 목록 끝의 휠이 밖으로 번지지 않게 하는 것은 CSS(overscroll-behavior)
  // 좁은 화면의 서랍이 펼쳐져 있는 동안은 비행 키를 받지 않는다
  setInputBlocked(isDrawerOpen);
  // 서랍 안에서 Tab이 처음 · 끝을 넘으면 서랍 안에서 돈다(페이지 밖으로도 나가지 않게)
  $('side').addEventListener('keydown', (e) => {
    if (isDrawerOpen()) trapTab($('side'), e);
  });
  // Esc: 사람 아이콘 메뉴가 펼쳐져 있으면 그것부터 접는다(서랍보다 먼저)
  registerEscape(36, () => {
    if ($('wMeMenu').hidden) return false;
    setMeMenu(false, { focus: true });
    return true;
  });
  store.on('leavingWorld', () => setMeMenu(false));
  // Esc: 좁은 화면의 서랍은 아래 시트 위에 덮이는 맨 위 층이라 상세 → 목록(30)보다 먼저 닫는다(escape.js)
  registerEscape(35, () => {
    if (!store.state.inWorld || !narrowMq.matches || sideCollapsed) return false;
    setSide(true, { focus: true });
    return true;
  });
  // 좁은 화면의 기간 바: 바깥을 누르거나 Esc면 접는다. 넓은 화면으로 바뀌면 접힌 상태로 되돌린다
  addEventListener('pointerdown', (e) => {
    if (isPeriodOpen() && e.target instanceof Node && !$('period').contains(e.target)) setPeriodOpen(false);
  });
  registerEscape(34, () => {
    if (!store.state.inWorld || !isPeriodOpen()) return false;
    setPeriodOpen(false, { focus: true });
    return true;
  });
  narrowMq.addEventListener?.('change', () => setPeriodOpen(false));
  narrowMq.addEventListener?.('change', restoreSide);
  restoreSide();

  // 배치 변수: 기간 바 · 배너 · 말풍선의 크기가 바뀔 때마다
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(updateLayoutVars);
    ro.observe($('period'));
    ro.observe($('wHint'));
    new ResizeObserver(syncNewPlanetWidth).observe($('dock'));
  }
  addEventListener('resize', updateLayoutVars);

  // 받는 데 성공한 기간을 적어 둔다(우주 밖에서 받은 것도). 겹친 reload는 마지막 것만 'data'를 낸다
  store.on('data', () => {
    loaded = { period: store.state.period, range: store.state.range, custom };
  });
  store.on('data', render);
  store.on('near', (id) => {
    nearId = id ?? null;
    markNear();
  });

  // 손님 별
  store.on('guestStar', showGuestStar);
  store.on('manualMove', () => {
    setHelp(false);
    // 손님 별로 가던 길(누가 시작했든)이 이동 키로 끊겼으면 패널이 열려 있어도 숨긴다
    if (!guestArrived || store.state.panelPlanetId === null || store.state.panelPlanetId === undefined) clearGuestStar();
  });
  // controls.js가 끊긴 비행을 알리게 되면 쓴다. 새 손님 별로 떠나는 순간(이전 비행이 끊긴다)은 흘려보낸다
  store.on('flightCancelled', () => {
    if (!holdGuest && guest && !guestArrived) clearGuestStar();
  });
  store.on('leftPanelPlanet', () => {
    if (!holdGuest) clearGuestStar();
  });
  store.on('land', (planetId) => {
    if (guest && !same(planetId, guest.planet_id)) clearGuestStar();
  });
  const otherStar = (starId) => {
    if (!guest) return;
    if (same(starId, guest.id)) guestArrived = true;
    else clearGuestStar();
  };
  store.on('openStar', (e) => otherStar(e?.starId));
  store.on('leaveWorld', () => {
    // 우주 밖: 3D는 다음에 들어올 때 'data'로 다시 맞춘다
    dropGuest();
    setSelectedStar(null);
    nearId = null;
    setPeriodOpen(false);
    paintHint(); // 우주 밖: 말풍선과 기록하기 테두리를 내린다
    if (narrowMq.matches) setSide(true); // 좁은 화면은 다음에 들어올 때도 접힌 채로
  });
  store.on('offline', paintHint);
  store.on('enterWorld', updateLayoutVars);

  // 들어온 직후(잉크 막 뒤): 오늘 별이 없고 전체는 1개 이상이면 이번 주로, 이번 주에도 없으면 전체로 넓힌다.
  // 사용자가 직접 "오늘"을 고른 때에는 넓히지 않는다.
  onBeforeWorldOpens(async () => {
    widened = false;
    const seq = ++widenSeq;
    if (widenPending) {
      // 넓히는 사이 8초를 넘겨 홈으로 되돌아갔다가 다시 들어왔다: 이번에 받은 것이 이미 이번 주다
      widenPending = false;
      const p = store.state.period;
      widened = p === 'week' || p === 'all' ? p : false;
      return;
    }
    const { period, summary } = store.state;
    if (!shouldWiden({ period, inPeriod: summary?.in_period, total: summary?.total })) return;
    const prev = period;
    widenPending = true;
    store.state.period = 'week';
    try {
      await store.reload(); // 'data' → 다시 그린다
    } catch (err) {
      if (seq === widenSeq) {
        widenPending = false;
        store.state.period = prev;
      }
      throw err; // transition.js가 홈으로 되돌린다
    }
    if (seq !== widenSeq) return; // 그 사이 다시 들어왔다: 새 쪽이 이어받았다
    widenPending = false;
    if (!store.state.inWorld) {
      // 받는 사이 전환이 홈으로 되돌아갔다(8초 한도 등). 사용자는 넓힌 것을 못 봤으니 전 기간으로 되돌린다
      store.state.period = prev;
      paintPeriod();
      store.reload().catch(() => {});
      return;
    }
    // 이번 주에도 별이 없으면 전체로 한 번 더 넓힌다
    const s = store.state.summary;
    if (shouldWidenToAll({ period: 'week', inPeriod: s?.in_period, total: s?.total })) {
      store.state.period = 'all';
      paintPeriod();
      try {
        await store.reload();
      } catch {
        // 전체를 받지 못했으면 이번 주에 머문다
        if (seq === widenSeq) store.state.period = 'week';
      }
      if (seq !== widenSeq) return;
      paintPeriod();
    }
    widened = store.state.period;
  });
  // 기간을 넓혔다는 안내는 우주가 다 열리고 0.3초 뒤, 눈높이(화면 위쪽 1/3 가운데)에 4초 동안 띄운다(app.css #toast.notice).
  // 다른 토스트 자리(넓은 화면은 맨 아래, 좁은 화면은 맨 위)는 들어온 직후의 시선에서 멀어 놓치기 쉽다.
  // 함께 기간 바(좁은 화면은 🕐)를 한 번 반짝여 "무엇이 바뀌었는지"를 잇는다. 손님 별 토스트가 떠 있으면 그것을 남긴다.
  store.on('enterWorld', () => {
    if (!widened) return;
    const to = widened;
    widened = false;
    setTimeout(() => {
      if (!store.state.inWorld || guest) return;
      toast(widenToast(to), { notice: true, duration: 4000 });
      const tools = $('pTools');
      tools.classList.remove('flash');
      void tools.offsetWidth; // 다시 들어와도 반짝임이 처음부터
      tools.classList.add('flash');
      setTimeout(() => tools.classList.remove('flash'), 1800);
    }, 300);
  });
}
