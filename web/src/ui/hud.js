// W-01 조작 UI: 왼쪽 패널(로고 · 숫자 · 바로 날아가기 목록 · 조작 안내) · 기간 바 · 띠 배너 · 재발견 카드 ·
// 빈 우주 말풍선 · 손님 별. 배치는 스펙 6-8(왼쪽 패널 · 오른쪽 위 기간 바 · 기록하기 위 말풍선).
// 시안 611~656행(renderDock · applyPeriod · pickRedis · renderRedis · worldState)과 guest · clearGuest를 옮겼다.
// 착륙 안내(#near)는 controls.js가 한다.
//
// store로 알리는 것:
//   'land'       planetId               목록에서 눌러 그 행성에 도착했을 때
//   'openStar'   { planetId, starId }   재발견 "날아가기"로 그 별의 행성에 도착했을 때
//   'openSave'   { tab: 'text' }        "기록하기"(#wLog · 빈 우주 카드)
//   'newPlanet'                         "+ 새 행성"(#wNewPlanet, 왼쪽 패널 목록 맨 위)
// store에서 듣는 것:
//   'data'             우주 안에 있을 때 전부 다시 그리고 3D를 맞춘다
//   'near'             planetId | null  목록의 노랑 표시
//   'guestStar'        star             transition.js: 기간 밖의 별로 들어옴 → showGuestStar
//   'manualMove'       패널이 닫혀 있거나 손님 별에 아직 도착하지 않았으면 손님 별을 숨긴다. 조작 안내 줄을 접는다
//   'flightCancelled'  (controls.js가 알리게 되면) 손님 별로 가던 길이 끊겼을 때 손님 별을 숨긴다
//   'leftPanelPlanet'  손님 별을 숨긴다
//   'land' · 'pickStar' · 'openStar'    손님 별이 아닌 곳으로 갔으면 숨긴다
//   'enterWorld'       기간을 넓혔으면 그 토스트
//   'leaveWorld'       손님 별 · 가까운 행성 표시를 지운다. 좁은 화면이면 왼쪽 서랍을 닫는다
//   'offline'          빈 우주 말풍선을 숨긴다(연결 실패 카드가 대신 말한다)
// 연결 실패 카드는 main.js(showOffline)가 #worldMsg에 그린다. #worldMsg는 이제 그 카드에만 쓴다(빈 우주 안내는 말풍선 #wHint).
// 화면 배치 변수(:root): --tr-bottom 기간 바 + 띠 배너의 아래 끝(W-02 패널 · 토스트가 그 아래에서 시작한다),
//   --hint-lift 화면 아래에서 말풍선 위 끝까지(좁은 화면의 착륙 안내가 그 위로 비킨다).
// 손님 별은 clearGuestStar()로 언제든(손님 별이 없을 때도) 숨길 수 있다: 패널 닫기 · 목록으로 · 삭제 · 이동.
import { api } from '../api.js';
import { store } from '../store.js';
import { flyTo, setInputBlocked } from '../three/controls.js';
import { STAR_CAP, setSelectedStar, syncUniverse } from '../three/planets.js';
import { PLANET_COLORS, daysAgo, esc, periodRange } from '../util.js';
import { registerEscape } from './escape.js';
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
  worldStateOf,
} from './hudLogic.js';
import { toast } from './toast.js';
import { onBeforeWorldOpens } from './transition.js';

const $ = (id) => document.getElementById(id);
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const faceOf = (planet) => PLANET_COLORS[planet?.color_index]?.face ?? '#7a6cff';
const SIDE_KEY = 'spacelog.leftPanel'; // 'open' | 'closed'
const HINT_KEY = 'spacelog.emptyHintOff'; // '1'이면 ✕로 끈 말풍선을 다시 띄우지 않는다
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };
// 서랍이 펼쳐진 동안 inert로 잠그는 것(막 아래에 있는 우주 위 UI)
const DRAWER_INERT = ['stage', 'period', 'near', 'redis', 'wHint', 'wLog', 'worldMsg', 'panel'];
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
let guest = null; // 손님 별 { id, planet_id }: 기간 밖인데 재발견으로 들어와 잠시 보여 주는 별
let guestArrived = false; // 손님 별에 도착했는지('openStar'). 가는 길에 끊기면 손님 별을 숨긴다
let guestSeq = 0; // 손님 별 다시 확인(api.star)의 세대
let holdGuest = false; // 손님 별로 날아가기를 시작하는 순간의 'leftPanelPlanet'은 흘려보낸다
// 마지막으로 받는 데 성공한 기간. 기간 바꾸기가 실패하면 여기로 되돌린다
let loaded = { period: store.state.period, range: store.state.range, custom };
let periodSeq = 0;
let widenSeq = 0;
let widenPending = false; // 들어올 때 이번 주로 넓히는 reload가 아직 끝나지 않았다
let flightSeq = 0;
let redisSeq = 0;
let redisStar = null; // 지금 재발견 카드에 그려진 별
let widened = false;
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
 * 기간 밖의 별 하나만 잠시 핑크로 보여 준다(DESIGN.md W-01 "재발견으로 들어온 별이 기간 밖일 때").
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

// 별로 날아간다(재발견 "날아가기"). 기간 밖이면 손님 별로 보여 주고, 도착하면 'openStar'.
function flyToStar(star) {
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
  const period = el.dataset.act === 'today' ? 'today' : el.dataset.p;
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
  $('sRec').textContent = num(store.state.summary?.in_period);
  $('sPlanet').textContent = num(store.state.planets.length);
}

function markNear() {
  for (const b of document.querySelectorAll('#dock button[data-planet]')) b.classList.toggle('here', same(b.dataset.planet, nearId));
}

// 바로 날아가기 목록: 색 점 · 이름 · 이 기간 별 개수. "+ 새 행성"(#wNewPlanet)은 목록 위에 고정돼 있어
// 여기서 그리지 않는다(행성이 없어도 보인다, 스펙 6-6). 이 목록만 세로로 스크롤한다.
function paintDock() {
  const dock = $('dock');
  const focused = dock.contains(document.activeElement) ? document.activeElement : null;
  const focusPlanet = focused?.dataset.planet;
  const html = store.state.planets
      .map((p) => {
        const count = num(p.count_in_period);
        return (
          `<button type="button" data-planet="${esc(p.id)}" aria-label="${esc(`'${p.name}' 행성으로 날아가기, 이 기간 별 ${count}개`)}">` +
          `<span class="dot" style="background:${faceOf(p)}"></span><span class="t">${esc(p.name)}</span><span class="n">${count}</span></button>`
        );
      })
      .join('');
  if (dock.dataset.html !== html) {
    dock.innerHTML = html; // 같으면 다시 그리지 않는다(스크롤 자리 · 초점이 그대로)
    dock.dataset.html = html;
  }
  dock.hidden = store.state.planets.length === 0;
  markNear();
  // 다시 그리기 전에 초점이 있던 버튼으로 되돌린다
  if (focusPlanet !== undefined && !dock.contains(document.activeElement)) {
    [...dock.querySelectorAll('button[data-planet]')].find((b) => b.dataset.planet === focusPlanet)?.focus({ preventScroll: true });
  }
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

function hideRedis() {
  const el = $('redis');
  el.hidden = true;
  el.textContent = '';
  redisStar = null;
}

// 재발견 카드: 색 점 · "N일 전 오늘의 별" · 제목 · "날아가기". 없으면 숨긴다(760px 이하는 CSS가 숨긴다).
// 받는 동안 더 새로운 그리기가 시작됐으면 버린다.
async function paintRedis(kind) {
  const seq = ++redisSeq;
  if (kind === 'empty' || kind === 'emptyPlanets') {
    hideRedis();
    return;
  }
  let star;
  try {
    star = await api.rediscovery();
  } catch (err) {
    if (seq === redisSeq && err?.code !== 'offline') hideRedis();
    return;
  }
  if (seq !== redisSeq || !store.state.inWorld) return;
  const planet = star ? store.state.planets.find((p) => same(p.id, star.planet_id)) : null;
  if (!star || !planet) {
    hideRedis();
    return;
  }
  const el = $('redis');
  redisStar = star;
  el.innerHTML =
    `<span class="pdot" style="background:${faceOf(planet)}"></span>` +
    `<div class="tx"><span class="eyebrow">${num(daysAgo(star.created_at))}일 전 오늘의 별</span><b>${esc(star.title || '제목 없음')}</b></div>` +
    '<button type="button" class="btn" id="redisGo">날아가기</button>';
  el.hidden = false;
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
  paintRedis(st.kind);
}

/* ---------- 누르기 ---------- */
function onDockClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el) return;
  const planetId = el.dataset.planet;
  if (!planetId) return;
  closeDrawer(); // 좁은 화면: 날아가는 모습이 보이게 서랍을 닫는다
  // 패널이 닫혀 있을 때 다른 곳으로 날아가면 손님 별은 숨는다(열려 있으면 패널 쪽이 정리한다)
  if (store.state.panelPlanetId === null || store.state.panelPlanetId === undefined) clearGuestStar();
  flightSeq += 1;
  flyTo(planetId).then((arrived) => arrived && store.emit('land', planetId));
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

function onRedisClick(e) {
  const el = e.target instanceof Element ? e.target.closest('#redisGo') : null;
  if (el && redisStar) flyToStar(redisStar);
}

/* ---------- 시작 ---------- */
/** 조작 UI를 준비한다(한 번만). 그리기는 store의 'data'가 올 때마다(우주 안에서만) 한다. */
export function initHud() {
  if (ready) return;
  ready = true;

  $('period').addEventListener('click', onPeriodClick);
  $('rFrom').addEventListener('change', onRangeChange);
  $('rTo').addEventListener('change', onRangeChange);
  $('dock').addEventListener('click', onDockClick);
  $('wNewPlanet').addEventListener('click', () => {
    closeDrawer();
    store.emit('newPlanet');
  });
  $('redis').addEventListener('click', onRedisClick);
  $('wLog').addEventListener('click', () => store.emit('openSave', { tab: 'text' }));
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
  // Esc: 좁은 화면의 서랍은 아래 시트 위에 덮이는 맨 위 층이라 상세 → 목록(30)보다 먼저 닫는다(escape.js)
  registerEscape(35, () => {
    if (!store.state.inWorld || !narrowMq.matches || sideCollapsed) return false;
    setSide(true, { focus: true });
    return true;
  });
  narrowMq.addEventListener?.('change', restoreSide);
  restoreSide();

  // 배치 변수: 기간 바 · 배너 · 말풍선의 크기가 바뀔 때마다
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(updateLayoutVars);
    ro.observe($('period'));
    ro.observe($('wHint'));
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
  store.on('pickStar', otherStar);
  store.on('openStar', (e) => otherStar(e?.starId));
  store.on('leaveWorld', () => {
    // 우주 밖: 3D는 다음에 들어올 때 'data'로 다시 맞춘다
    dropGuest();
    setSelectedStar(null);
    nearId = null;
    redisSeq += 1;
    redisStar = null;
    paintHint(); // 우주 밖: 말풍선과 기록하기 테두리를 내린다
    if (narrowMq.matches) setSide(true); // 좁은 화면은 다음에 들어올 때도 접힌 채로
  });
  store.on('offline', paintHint);
  store.on('enterWorld', updateLayoutVars);

  // 들어온 직후(잉크 막 뒤): 오늘 별이 없고 전체는 1개 이상이면 이번 주로 넓힌다.
  // 사용자가 직접 "오늘"을 고른 때에는 넓히지 않는다.
  onBeforeWorldOpens(async () => {
    widened = false;
    const seq = ++widenSeq;
    if (widenPending) {
      // 넓히는 사이 8초를 넘겨 홈으로 되돌아갔다가 다시 들어왔다: 이번에 받은 것이 이미 이번 주다
      widenPending = false;
      widened = store.state.period === 'week';
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
    widened = true;
  });
  // 토스트는 우주가 열린 뒤에 띄운다. transition.js가 바로 뒤에 띄우는 안내("WASD로…" · "비행 중…")보다
  // 나중에 나오게 한 박자 늦춘다. 손님 별 토스트가 떠 있으면 그것을 남긴다.
  store.on('enterWorld', () => {
    if (!widened) return;
    widened = false;
    setTimeout(() => {
      if (store.state.inWorld && !guest) toast('오늘 별이 없어 이번 주를 보여드려요');
    }, 0);
  });
}
