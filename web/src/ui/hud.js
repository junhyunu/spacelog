// W-01 조작 UI: 로고 카드 숫자 · 기간 탭 · 바로 날아가기 목록 · 재발견 카드 · 가운데 상태 카드 · 띠 배너 · 손님 별.
// 시안 611~656행(renderDock · applyPeriod · pickRedis · renderRedis · worldState)과 guest · clearGuest를 옮겼다.
// 조작 안내를 한 줄로 줄이는 것과 착륙 안내(#near)는 controls.js가 이미 한다.
//
// store로 알리는 것:
//   'land'       planetId               목록에서 눌러 그 행성에 도착했을 때
//   'openStar'   { planetId, starId }   재발견 "날아가기"로 그 별의 행성에 도착했을 때
//   'openSave'   { tab: 'text' }        "기록하기"(#wLog · 빈 우주 카드)
//   'newPlanet'                         "+ 새 행성"(#wNewPlanet)
// store에서 듣는 것:
//   'data'             우주 안에 있을 때 전부 다시 그리고 3D를 맞춘다
//   'near'             planetId | null  목록의 노랑 표시
//   'guestStar'        star             transition.js: 기간 밖의 별로 들어옴 → showGuestStar
//   'manualMove'       패널이 닫혀 있으면 손님 별을 숨긴다. 조작 안내를 한 줄로
//   'leftPanelPlanet'  손님 별을 숨긴다
//   'land' · 'pickStar' · 'openStar'    손님 별이 아닌 곳으로 갔으면 숨긴다
//   'enterWorld'       기간을 넓혔으면 그 토스트
//   'leaveWorld'       손님 별 · 가까운 행성 표시를 지운다
// 연결 실패 카드는 main.js(showOffline)가 #worldMsg에 그린다. 그 카드가 떠 있는 동안 #worldMsg는 건드리지 않는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { flyTo } from '../three/controls.js';
import { STAR_CAP, setSelectedStar, syncUniverse } from '../three/planets.js';
import { PLANET_COLORS, daysAgo, esc, ico, periodRange } from '../util.js';
import { defaultCustom, isOutsidePeriod, nextCustom, shouldWiden, worldStateOf } from './hudLogic.js';
import { toast } from './toast.js';
import { onBeforeWorldOpens } from './transition.js';

const $ = (id) => document.getElementById(id);
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const faceOf = (planet) => PLANET_COLORS[planet?.color_index]?.face ?? '#7a6cff';
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

let ready = false;
let custom = defaultCustom(); // "직접 지정"의 날짜 { from, to } 'YYYY-MM-DD'
let nearId = null;
let guest = null; // 손님 별 { id, planet_id }: 기간 밖인데 재발견으로 들어와 잠시 보여 주는 별
let holdGuest = false; // 손님 별로 날아가기를 시작하는 순간의 'leftPanelPlanet'은 흘려보낸다
let flightSeq = 0;
let redisSeq = 0;
let redisStar = null; // 지금 재발견 카드에 그려진 별
let widened = false;

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
  store.state.guestStarId = guest.id;
  sync();
  setSelectedStar(guest.id);
  toast(`${num(daysAgo(star.created_at))}일 전 별이라 이 별만 잠시 보여드려요`);
}

/** 손님 별을 다시 숨긴다. 손님 별이 없으면 아무 일도 없다. */
export function clearGuestStar() {
  if (!guest) return;
  const id = guest.id;
  guest = null;
  store.state.guestStarId = null;
  sync();
  // 다른 별의 상세가 열려 있으면 그 별의 핑크는 건드리지 않는다
  const detail = store.state.detailStarId;
  if (detail === null || detail === undefined || same(detail, id)) setSelectedStar(null);
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

// 기간을 바꾸고 다시 받는다. 연결이 끊긴 경우가 아닌데 실패하면 전 기간으로 되돌린다.
async function applyPeriod(period) {
  const prev = { period: store.state.period, range: store.state.range };
  store.state.period = period;
  if (period === 'custom') store.state.range = periodRange('custom', custom);
  const mine = store.state.range;
  paintPeriod();
  try {
    await store.reload();
    return true;
  } catch (err) {
    if (err?.code !== 'offline' && store.state.period === period && (period !== 'custom' || store.state.range === mine)) {
      store.state.period = prev.period;
      store.state.range = prev.range;
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

const NEW_PLANET_BTN = `<button type="button" class="btn ghost sm" id="wNewPlanet" data-act="newPlanet">${ico('plus', 12)} 새 행성</button>`;

function markNear() {
  for (const b of document.querySelectorAll('#dock button[data-planet]')) b.classList.toggle('here', same(b.dataset.planet, nearId));
}

// 바로 날아가기 목록: 색 점 · 이름 · 이 기간 별 개수, 맨 끝에 "+ 새 행성".
// 별도 행성도 없으면 목록을 숨기고 "+ 새 행성"은 가운데 카드에 둔다(id가 하나만 있게).
function paintDock(kind) {
  const dock = $('dock');
  const focused = dock.contains(document.activeElement) ? document.activeElement : null;
  const focusPlanet = focused?.dataset.planet;
  const focusNew = focused?.id === 'wNewPlanet';
  for (const b of [...dock.querySelectorAll('button')]) b.remove();
  if (kind === 'empty') {
    dock.hidden = true;
    return;
  }
  dock.insertAdjacentHTML(
    'beforeend',
    store.state.planets
      .map((p) => {
        const count = num(p.count_in_period);
        return (
          `<button type="button" data-planet="${esc(p.id)}" aria-label="${esc(`'${p.name}' 행성으로 날아가기, 이 기간 별 ${count}개`)}">` +
          `<span class="dot" style="background:${faceOf(p)}"></span><span class="t">${esc(p.name)}</span><span class="n">${count}</span></button>`
        );
      })
      .join('') + NEW_PLANET_BTN,
  );
  dock.hidden = false;
  markNear();
  // 다시 그리기 전에 초점이 있던 버튼으로 되돌린다
  if (focusNew) $('wNewPlanet')?.focus({ preventScroll: true });
  else if (focusPlanet !== undefined) {
    [...dock.querySelectorAll('button[data-planet]')].find((b) => b.dataset.planet === focusPlanet)?.focus({ preventScroll: true });
  }
}

// 띠 배너(기간 탭 바로 아래, 760px 이하에서는 바로 위): 별 상한 초과 · 빈 행성만 있는 우주
function paintBanner({ kind, todayButton }) {
  const el = $('wBanner');
  let html = '';
  if (kind === 'cap') {
    html =
      '<span>기간을 좁히면 별이 보여요</span>' +
      (todayButton ? '<button type="button" class="btn sm" data-act="today">오늘만 보기</button>' : '');
  } else if (kind === 'emptyPlanets') {
    html = '<span>아직 별이 없어요. 기록하기를 눌러 첫 별을 띄워 보세요</span>';
  }
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  el.hidden = html === '';
}

// 가운데 상태 카드: 전체 0개(행성도 없음). 연결 실패 카드가 떠 있으면 그대로 둔다.
function paintMsg(kind) {
  const el = $('worldMsg');
  if (store.state.offline || el.querySelector('[data-retry]')) return;
  if (kind === 'empty') {
    if (el.dataset.kind !== 'empty') {
      el.innerHTML =
        '<span class="eyebrow">빈 우주</span><h3>아직 별이 없어요</h3>' +
        '<p>파일을 끌어다 놓거나 기록하기를 눌러 첫 별을 띄워 보세요.</p>' +
        `<div class="hrow"><button type="button" class="btn" data-act="log">${ico('plus')} 기록하기</button>${NEW_PLANET_BTN}</div>`;
      el.dataset.kind = 'empty';
    }
    el.hidden = false;
  } else {
    el.hidden = true;
    el.textContent = '';
    delete el.dataset.kind;
  }
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
  // 손님 별의 행성이 사라졌으면 손님 별도 없다
  if (guest && !planets.some((p) => same(p.id, guest.planet_id))) {
    guest = null;
    store.state.guestStarId = null;
  }
  const st = worldStateOf({ total: summary?.total, inPeriod: summary?.in_period, planets: planets.length, period, cap: STAR_CAP });
  sync();
  paintBrand();
  paintPeriod();
  paintDock(st.kind);
  paintBanner(st);
  paintMsg(st.kind);
  paintRedis(st.kind);
}

/* ---------- 누르기 ---------- */
function onDockClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el) return;
  if (el.dataset.act === 'newPlanet') {
    store.emit('newPlanet');
    return;
  }
  const planetId = el.dataset.planet;
  if (!planetId) return;
  // 패널이 닫혀 있을 때 다른 곳으로 날아가면 손님 별은 숨는다(열려 있으면 패널 쪽이 정리한다)
  if (store.state.panelPlanetId === null || store.state.panelPlanetId === undefined) clearGuestStar();
  flightSeq += 1;
  flyTo(planetId).then((arrived) => arrived && store.emit('land', planetId));
}

function onMsgClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el) return;
  if (el.dataset.act === 'log') store.emit('openSave', { tab: 'text' });
  else if (el.dataset.act === 'newPlanet') store.emit('newPlanet');
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
  $('worldMsg').addEventListener('click', onMsgClick);
  $('redis').addEventListener('click', onRedisClick);
  $('wLog').addEventListener('click', () => store.emit('openSave', { tab: 'text' }));
  paintPeriod();

  store.on('data', render);
  store.on('near', (id) => {
    nearId = id ?? null;
    markNear();
  });

  // 손님 별
  store.on('guestStar', showGuestStar);
  store.on('manualMove', () => {
    $('help').classList.remove('big');
    if (store.state.panelPlanetId === null || store.state.panelPlanetId === undefined) clearGuestStar();
  });
  store.on('leftPanelPlanet', () => {
    if (!holdGuest) clearGuestStar();
  });
  store.on('land', (planetId) => {
    if (guest && !same(planetId, guest.planet_id)) clearGuestStar();
  });
  const otherStar = (starId) => {
    if (guest && !same(starId, guest.id)) clearGuestStar();
  };
  store.on('pickStar', otherStar);
  store.on('openStar', (e) => otherStar(e?.starId));
  store.on('leaveWorld', () => {
    // 우주 밖: 3D는 다음에 들어올 때 'data'로 다시 맞춘다
    guest = null;
    store.state.guestStarId = null;
    setSelectedStar(null);
    nearId = null;
    redisSeq += 1;
    redisStar = null;
  });

  // 들어온 직후(잉크 막 뒤): 오늘 별이 없고 전체는 1개 이상이면 이번 주로 넓힌다.
  // 사용자가 직접 "오늘"을 고른 때에는 넓히지 않는다.
  onBeforeWorldOpens(async () => {
    widened = false;
    const { period, summary } = store.state;
    if (!shouldWiden({ period, inPeriod: summary?.in_period, total: summary?.total })) return;
    store.state.period = 'week';
    try {
      await store.reload(); // 'data' → 다시 그린다
    } catch (err) {
      store.state.period = 'today';
      throw err; // transition.js가 홈으로 되돌린다
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
