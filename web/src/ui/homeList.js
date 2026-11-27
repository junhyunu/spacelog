// W-00 홈의 아래 영역: 왼쪽 행성 패널(#hSide) + 거르기 줄 + 별 목록(#hTable).
// 비교 테스트 홈(docs/research/ab-test/spacelog-home.html)에서 먼저 써 본 화면을 옮겼다. 계산은 homeLogic.js(순수 함수).
//
// 데이터: 우주와 같은 것을 쓴다. store.state.planets(기간 안의 별 수 count_in_period) · store.state.stars(기간 안의 별).
//   기간도 우주와 같은 값이다. 기간을 쥐고 있는 것은 hud.js라서 이벤트로 주고받는다(서로 불러오지 않는다):
//     알리는 것  'setPeriod' { period }            기간 버튼을 눌렀다
//                'setPeriod' { from, to }          "직접 지정"의 날짜를 바꿨다
//     듣는 것    'period' { period, custom }       기간 바를 다시 그릴 때(hud.js paintPeriod)
//                'data'                            다시 받았다 → 목록을 다시 그린다(우주 밖에 있을 때만)
// 검색: 지금 고른 행성 · 기간 안에서 제목 · 메모를 찾는다. 범위 밖에도 맞는 별이 있으면 개수를 알려 주려고
//   모든 별을 한 번 받아 둔다(서버에 검색 API가 없다. 우주 안 검색 search.js와 같은 방식). 'data'가 오면 버린다.
// 좁은 화면(760px 이하): 행성 패널은 왼쪽에서 덮이는 서랍이다(로고 옆 아이콘 · 거르기 줄의 행성 버튼으로 연다).
//   기간 바는 시계 버튼을 눌렀을 때만 거르기 줄 아래에 펼쳐진다. 우주의 왼쪽 서랍 · 🕐와 같은 규칙이다.
// 별을 누르면: 목록 자리(#hDetail)에 상세가 펼쳐진다. 우주의 상세(detail.js)를 그대로 쓰고 머리만 다르다(이전 · 다음).
//   그동안 거르기 줄 · 목록은 숨고 왼쪽 행성 패널은 그대로다. 이전 · 다음은 목록에 보이던 순서를 따른다(←/→ 키도).
//   Esc · "목록으로"로 돌아오면 보던 스크롤 자리로 돌아간다. 상세의 "우주에서 보기"는 initHomeList의 openStar(star)를 부른다.
import { api } from '../api.js';
import { store } from '../store.js';
import { planetDeep, planetFace, esc, ico, listDate } from '../util.js';
import { flushMemo, renderDetail } from './detail.js';
import { contentLabel } from './detailLogic.js';
import { registerEscape } from './escape.js';
import { PAGE, countTitle, emptyState, filterStars, firstLine, markHtml, matches, neighbors, orderStars, pageOf, snipHtml } from './homeLogic.js';
import { defaultCustom } from './hudLogic.js';
import { confirmDeletePlanet } from './planetDelete.js';
import { openPlanetForm } from './planetForm.js';
import { mergePlanet, mergeTargets } from './planetMerge.js';
import { keepPicked, moveTargets, pickAllHtml, pickAllState, pickBarHtml, pickButtonHtml, planetLocked, thumbKind, toggleAll, togglePickedId } from './planetLogic.js';
import { openRowMenu } from './rowMenu.js';
import { deletePickedStars, deleteStar, movePickedStars, moveStar, setPickingUi, toggleFavStar } from './starActions.js';
import { createTitleEditor, titleEditHtml } from './titleEdit.js';

const $ = (id) => document.getElementById(id);
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const faceOf = (planet) => planetFace(planet);
const LAYERS =
  '<svg class="i" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m2 12 8.58 3.91a2 2 0 0 0 1.66 0L21 12"/><path d="m2 17 8.58 3.91a2 2 0 0 0 1.66 0L21 17"/></svg>';
const SIDE_LABEL = { all: '전체 별', today: '오늘 별', week: '이번 주 별', custom: '이 기간 별' };
const PERIOD_NAME = { all: '전체', today: '오늘', week: '이번 주', custom: '직접 지정' };
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };

// 고른 것. 기간은 store.state.period(우주와 같이 쓴다)
const S = { planet: 'all', group: false, fav: false, q: '', limit: PAGE, detail: null }; // detail: 상세를 보고 있는 별 id
const keep = new Set(); // "자주 찾음만" 보는 중에 ☆를 끈 별: 거르기가 바뀔 때까지 흐리게 남긴다
let custom = defaultCustom(); // "직접 지정"의 날짜(hud.js가 알려 준다)
let all = null; // 검색용: 모든 기간의 별. null이면 필요할 때 다시 받는다
let allLoading = null;
let ready = false;
let onOpenStar = () => {};
let backY = 0; // 상세를 열기 전의 스크롤 자리(목록으로 돌아올 때 되돌린다)
let sideOpen = false; // 좁은 화면의 행성 서랍이 열려 있는지
let sideOpener = null; // 서랍을 연 버튼(로고 옆 아이콘 · 행성 버튼). 닫으면 초점을 거기로 돌린다
// 여러 개 골라 옮기기(우주 행성 패널과 같은 모드 · 같은 문구). 목록이 바뀌면 보이는 줄에 남은 것만 남긴다(keepPicked)
let picking = false;
let pickedIds = new Set();
// 별 ⋯ 메뉴의 "이름 바꾸기": 그 줄의 제목 칸이 입력칸이 된다(우주 행성 패널과 같은 동작). 끝나면 초점은 그 별 제목으로
const rowEdit = createTitleEditor({
  render: () => renderHomeList(),
  focusAfter: (id) => $('hTable').querySelector(`[data-fk="open:${CSS.escape(id)}"]`)?.focus({ preventScroll: true }),
});

/* ---------- 그리기 ---------- */
// 내용이 바뀌었을 때만 갈아 끼우고, 초점은 같은 것(data-fk)으로 되돌린다
function swap(el, html) {
  if (el.dataset.html === html) return;
  const active = document.activeElement;
  const key = active instanceof HTMLElement && el.contains(active) ? active.dataset.fk : null;
  el.innerHTML = html;
  el.dataset.html = html;
  if (key) el.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function thumb(star) {
  const kind = thumbKind(star);
  if (kind === 'thumb') {
    return `<span class="th" aria-hidden="true"><img src="${esc(api.attachmentThumbUrl(star.thumb_attachment_id))}" alt="" loading="lazy" decoding="async" data-fallback="image"></span>`;
  }
  return `<span class="th" aria-hidden="true">${ico(kind, 18)}</span>`;
}

function paintPeriod() {
  const period = store.state.period;
  for (const b of $('hSeg').children) {
    const on = b.dataset.p === period;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('hRange').hidden = period !== 'custom';
  if ($('hFrom').value !== custom.from) $('hFrom').value = custom.from;
  if ($('hTo').value !== custom.to) $('hTo').value = custom.to;
  // 좁은 화면의 시계 버튼: 기간 바를 접어도 지금 기간을 알 수 있게 이름을 붙이고, "전체"가 아니면 분홍 점
  const name = PERIOD_NAME[period] ?? '';
  $('hPeriodBtn').setAttribute('aria-label', `기간: ${name}, 바꾸기`);
  $('hPeriodBtn').title = `기간: ${name}`;
  $('hPeriodBtn').classList.toggle('narrowed', period !== 'all');
}

/* ---------- 좁은 화면: 행성 서랍 · 기간 바 펼치기 ---------- */
// 서랍을 열고 닫는다. 열려 있는 동안 뒤쪽(상단 줄 · 블랙홀 · 목록 · 챗봇)은 누를 수 없다(inert)
function setSide(open, { focus = true } = {}) {
  open = Boolean(open);
  if (open === sideOpen) return;
  if (open && $('hMain').hidden) return; // 목록 영역이 없는 상태(연결 끊김 등)
  if (open) sideOpener = document.activeElement?.closest?.('#hSideOpen,#hPlanetBtn') ?? $('hSideOpen');
  sideOpen = open;
  document.body.classList.toggle('hside-open', open);
  $('hScrim').hidden = !open;
  for (const id of ['hSideOpen', 'hPlanetBtn']) $(id).setAttribute('aria-expanded', String(open));
  for (const el of [document.querySelector('.home-top'), document.querySelector('#home .hero'), $('hList'), $('chatBtn'), $('chatPanel')]) if (el) el.inert = open;
  if (open) $('hSideClose').focus({ preventScroll: true });
  else if (focus) (sideOpener?.offsetParent ? sideOpener : $('hSideOpen')).focus({ preventScroll: true });
}

const isPeriodOpen = () => document.querySelector('#hList .hl-head').classList.contains('p-open');
function setPeriodOpen(open, { focus = false } = {}) {
  document.querySelector('#hList .hl-head').classList.toggle('p-open', Boolean(open));
  $('hPeriodBtn').setAttribute('aria-expanded', String(Boolean(open)));
  if (!open && focus) $('hPeriodBtn').focus({ preventScroll: true });
}

function paintSide(planets, stars) {
  const period = store.state.period;
  $('hsLabel').textContent = SIDE_LABEL[period] ?? SIDE_LABEL.custom;
  $('hsRec').textContent = num(stars.length);
  $('hsPlanet').textContent = num(planets.length);
  const item = (id, name, n, dot, label) =>
    `<button type="button" data-planet="${esc(id)}" data-fk="planet:${esc(id)}" aria-pressed="${same(S.planet, id)}"${n > 0 ? '' : ' class="zero"'} aria-label="${esc(label)}">` +
    `${dot}<span class="t">${esc(name)}</span><span class="n">${num(n)}</span></button>`;
  const html =
    item('all', '전체 보기', stars.length, `<span class="dot all">${LAYERS}</span>`, `전체 보기, ${SIDE_LABEL[period] ?? ''} ${num(stars.length)}개`) +
    planets
      .map((p) => {
        const n = Number(p.count_in_period) || 0;
        return (
          '<div class="drow">' +
          item(p.id, p.name, n, `<span class="dot" style="background:${faceOf(p)}"></span>`, `'${p.name}' 행성의 별 보기, ${SIDE_LABEL[period] ?? ''} ${num(n)}개`) +
          (planetLocked(p) ? '' : `<button type="button" class="more" data-more="${esc(p.id)}" data-fk="pmore:${esc(p.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`'${p.name}' 행성 메뉴`)}" title="행성 메뉴">${ico('ellipsis', 18)}</button>`) +
          '</div>'
        );
      })
      .join('');
  swap($('hDock'), html);
}

function rowHtml(s, planet, q) {
  const id = esc(s.id);
  const title = s.title || '제목 없음';
  const date = esc(listDate(s.created_at));
  // 메모에서 찾았으면 그 낱말 둘레의 한 줄(왜 나왔는지 알게). 못 찾았으면 메모 첫 줄
  const snip = snipHtml(s.body, q) ?? snipHtml(s.memo, q);
  const note = firstLine(s.body);
  if (picking) {
    // 고르는 중: ☆ 자리에 체크칸, 줄 어디를 눌러도 고르기 · 풀기(상세를 열지 않는다). ⋯ 메뉴는 없다
    const on = pickedIds.has(String(s.id));
    return (
      `<div class="srow pick${on ? ' on' : ''}" data-id="${id}">` +
      `<span class="c-fav"><button type="button" class="pickcb" data-a="pick" data-fk="pick:${id}" role="checkbox" aria-checked="${on}" aria-label="${esc(title)}"><span class="cb" aria-hidden="true"></span></button></span>` +
      `<span class="sttl">${thumb(s)}<span class="tx"><span class="n">${markHtml(title, q)}</span>` +
      `<span class="k"><span>${esc(contentLabel(s))}</span><span class="k-dt">${date}</span></span>${snip ? `<span class="snip">메모: ${snip}</span>` : ''}</span></span>` +
      `<span class="spl c-pl"><span class="dot" style="background:${faceOf(planet)}"></span><span class="t">${esc(planet?.name ?? '')}</span></span>` +
      `<span class="smemo c-memo"${note ? ` title="${esc(note)}"` : ''}>${snip ?? esc(note)}</span>` +
      `<span class="sdate c-dt"><span class="d">${date}</span></span></div>`
    );
  }
  const fav = `<span class="c-fav"><button type="button" class="sfav" data-a="fav" data-fk="fav:${id}" aria-pressed="${Boolean(s.fav)}" aria-label="${esc(`'${title}' 자주 찾음`)}" title="자주 찾음">${ico('star', 18)}</button></span>`;
  if (rowEdit.is(s.id)) {
    // 이름을 바꾸는 중: 제목 칸이 입력칸 + 저장. 행성 · 메모 · 날짜는 그대로, ⋯은 없다
    return (
      `<div class="srow editing" data-id="${id}">${fav}` +
      `<div class="sttl">${thumb(s)}${titleEditHtml({ focusAttr: 'data-fk', key: `tin:${s.id}` })}</div>` +
      `<span class="spl c-pl"><span class="dot" style="background:${faceOf(planet)}"></span><span class="t">${esc(planet?.name ?? '')}</span></span>` +
      `<span class="smemo c-memo">${esc(note)}</span>` +
      `<span class="sdate c-dt"><span class="d">${date}</span></span></div>`
    );
  }
  return (
    `<div class="srow${S.fav && !s.fav ? ' dim' : ''}" data-id="${id}">${fav}` +
    `<button type="button" class="sttl" data-a="open" data-fk="open:${id}">${thumb(s)}<span class="tx"><span class="n">${markHtml(title, q)}</span>` +
    `<span class="k"><span>${esc(contentLabel(s))}</span><span class="k-dt">${date}</span></span>${snip ? `<span class="snip">메모: ${snip}</span>` : ''}</span></button>` +
    `<span class="spl c-pl"><span class="dot" style="background:${faceOf(planet)}"></span><span class="t">${esc(planet?.name ?? '')}</span></span>` +
    `<span class="smemo c-memo"${note ? ` title="${esc(note)}"` : ''}>${snip ?? esc(note)}</span>` +
    `<span class="sdate c-dt"><span class="d">${date}</span>` +
    `<button type="button" class="more" data-a="more" data-fk="more:${id}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`'${title}' 별 메뉴`)}" title="별 메뉴">${ico('ellipsis', 18)}</button></span></div>`
  );
}

function emptyHtml(kind, elsewhere) {
  const q = esc(S.q.trim());
  const btn = (act, label) => `<button type="button" class="btn ghost sm" data-act="${act}">${label}</button>`;
  if (kind === 'search-elsewhere') return `<div class="sempty"><b>‘${q}’에 맞는 별이 없어요</b><p>다른 행성·기간에 ${num(elsewhere)}개 있어요.</p>${btn('qAll', '전체에서 찾기')}</div>`;
  if (kind === 'search-none') return `<div class="sempty"><b>‘${q}’에 맞는 별이 없어요</b><p>제목·메모에서 찾았어요. 다른 낱말로 찾아보세요.</p>${btn('qClear', '검색어 지우기')}</div>`;
  if (kind === 'fav') return `<div class="sempty"><b>자주 찾음으로 표시한 별이 없어요</b><p>목록의 ☆을 눌러 표시해 보세요.</p>${btn('favOff', '자주 찾음만 끄기')}</div>`;
  // 별이 하나도 없다(처음 쓰는 사람): 어느 기간 · 행성을 보고 있든 첫 별을 띄우는 길을 알려 준다
  const first = `<div class="sempty"><b>아직 별이 없어요</b><p>파일을 끌어다 놓거나 기록하기를 눌러 첫 별을 띄워 보세요.</p><button type="button" class="btn" data-act="log">${ico('plus', 16)} 기록하기</button></div>`;
  if (!(Number(store.state.summary?.total) > 0)) return first;
  const everyPeriod = store.state.period === 'all';
  const everyPlanet = S.planet === 'all';
  if (everyPeriod && everyPlanet) return first;
  if (everyPeriod) return `<div class="sempty"><b>이 행성에는 아직 별이 없어요</b><p>다른 행성을 골라 보세요.</p>${btn('resetFilter', '전체 보기로')}</div>`;
  return `<div class="sempty"><b>이 기간에는 별이 없어요</b><p>기간을 넓히거나 다른 행성을 골라 보세요.</p>${btn('resetFilter', '전체 기간 · 전체 보기로')}</div>`;
}

// 지금 거르기로 목록에 보이는 별(보이는 순서 그대로). 상세의 이전 · 다음도 이 순서를 쓴다
function shownList(planets, stars) {
  return orderStars(filterStars(stars, { planetId: S.planet, fav: S.fav, q: S.q.trim(), keep }), { group: S.group, planets, planetId: S.planet });
}

function paintTable(planets, stars, list) {
  const q = S.q.trim();
  const byId = new Map(planets.map((p) => [String(p.id), p]));
  const shown = list.filter((s) => !S.fav || s.fav).length; // 흐리게 남겨 둔 줄은 세지 않는다
  // 검색 중: 지금 범위(행성 · 기간 · 자주 찾음) 밖에서 맞는 별의 수(모든 별을 받아 둔 뒤에만 안다)
  const everywhere = q && all ? all.filter((s) => matches(s, q)).length : 0;
  const outside = Math.max(0, everywhere - list.length);
  const planetName = S.planet === 'all' ? '' : (byId.get(String(S.planet))?.name ?? '');

  // 고르기 버튼: 보이는 별이 2개 이상이면(행성이 하나뿐이어도 지우기는 된다. 고르는 중에는 같은 자리가 "취소")
  const pickBtn = pickButtonHtml({ picking, canPick: list.length >= 2, focusAttr: 'data-fk' });
  let html = `<div class="shead"><h3 class="scount" aria-live="polite">${esc(countTitle({ shown, planetName, q }))}</h3>${pickBtn}</div>`;
  if (outside > 0 && list.length) html += `<p class="sqmore">다른 행성·기간에 ${num(outside)}개 더 있어요<button type="button" data-act="qAll">전체에서 찾기</button></p>`;

  const empty = emptyState({ shown: list.length, q, fav: S.fav, elsewhere: everywhere });
  if (empty) {
    html += emptyHtml(empty, everywhere);
  } else {
    const { rows, rest } = pageOf(list, S.limit);
    const grouped = S.group && S.planet === 'all';
    // 고르는 중: ☆ 칸 머리 자리에 전체 선택 체크칸(보이는 별 = 지금 거르기에서 더 보기까지 펼친 줄)
    const favHead = picking
      ? `<span class="c-fav">${pickAllHtml({ state: pickAllState(pickedIds, rows.map((s) => s.id)), focusAttr: 'data-fk' })}</span>`
      : '<span class="c-fav" aria-hidden="true"></span>';
    html += `<div class="srow head">${favHead}<span>제목 · 종류</span><span class="c-pl">행성</span><span class="c-memo">메모</span><span class="c-dt">넣은 날</span></div>`;
    let last = null;
    for (const s of rows) {
      const p = byId.get(String(s.planet_id));
      if (grouped && !same(last, s.planet_id)) {
        last = s.planet_id;
        const n = list.filter((x) => same(x.planet_id, s.planet_id)).length;
        html += `<div class="sgrp"><span class="dot" style="background:${faceOf(p)}"></span>${esc(p?.name ?? '')}<span class="n">${num(n)}</span></div>`;
      }
      html += rowHtml(s, p, q);
    }
    if (rest > 0) html += `<div class="smore"><button type="button" class="btn ghost sm" data-act="more" data-fk="more-rows">더 보기 (${num(rest)}개 남음)</button></div>`;
  }
  // "행성 옮기기"는 옮길 행성이 없으면(moveTargets가 빈 목록) 잠긴다. "지우기"는 고른 것이 있으면 늘 된다
  if (picking) html += pickBarHtml({ count: pickedIds.size, canMove: moveTargets(stars.filter((s) => pickedIds.has(String(s.id))), planets).length > 0, focusAttr: 'data-fk' });
  $('hTable').classList.toggle('picking', picking);
  swap($('hTable'), html);
  const group = $('hTable').querySelector('.srow.editing [data-tedit]');
  if (group) rowEdit.bind(group, stars.find((s) => rowEdit.is(s.id)));
}

/** 행성 패널 · 거르기 줄 · 목록을 지금 상태로 다시 그린다. */
export function renderHomeList() {
  if (!ready) return;
  const planets = store.state.planets ?? [];
  const stars = store.state.stars ?? [];
  if (S.planet !== 'all' && !planets.some((p) => same(p.id, S.planet))) S.planet = 'all'; // 고른 행성이 사라졌다
  if (S.q.trim() && !all) loadAll();
  const list = shownList(planets, stars);
  if (S.detail !== null && !list.some((s) => same(s.id, S.detail))) S.detail = null; // 보던 별이 목록에서 빠졌다(지움 · 옮김 · 기간)
  if (picking) pickedIds = keepPicked(pickedIds, pageOf(list, S.limit).rows); // 보이는 줄에서 사라진 별(거르기 · 옮김 · 지움 · 기간)은 선택에서 뺀다
  if (rowEdit.active && (picking || S.detail !== null || !pageOf(list, S.limit).rows.some((s) => rowEdit.is(s.id)))) rowEdit.clear(); // 고치던 줄이 안 보인다
  paintPeriod();
  paintSide(planets, stars);
  const selPlanet = S.planet === 'all' ? null : planets.find((p) => same(p.id, S.planet));
  $('hPlanetBtnName').textContent = selPlanet ? selPlanet.name : '전체 보기';
  const pdot = $('hPlanetBtn').querySelector('.dot');
  pdot.classList.toggle('all', !selPlanet);
  pdot.style.background = selPlanet ? faceOf(selPlanet) : '';
  pdot.innerHTML = selPlanet ? '' : LAYERS;
  $('hGroupSw').hidden = S.planet !== 'all';
  $('hGroupSw').setAttribute('aria-checked', String(S.group));
  $('hFavSw').setAttribute('aria-checked', String(S.fav));
  if ($('hQ').value !== S.q) $('hQ').value = S.q;
  $('hQClear').hidden = !S.q;
  paintTable(planets, stars, list);
  paintDetail(planets, list);
}

// 상세를 보는 동안: 거르기 줄 · 목록을 숨기고 그 자리에 상세를 그린다(한 기록만 보고 있어 거를 것이 없다)
function paintDetail(planets, list) {
  const box = $('hDetail');
  const star = S.detail === null ? null : list.find((s) => same(s.id, S.detail));
  const head = document.querySelector('#hList .hl-head');
  head.hidden = Boolean(star);
  $('hTable').hidden = Boolean(star);
  if (!star) {
    if (!box.hidden) {
      flushMemo(); // 쓰던 메모를 마저 저장한다
      box.hidden = true;
      box.textContent = '';
    }
    return;
  }
  const planet = planets.find((p) => same(p.id, star.planet_id));
  const { index, total } = neighbors(list, star.id);
  box.style.setProperty('--accent', planetDeep(planet));
  box.hidden = false;
  renderDetail(box, star, planet, {
    onBack: () => closeDetail(),
    home: {
      index,
      total,
      onPrev: () => stepDetail(-1),
      onNext: () => stepDetail(1),
      onFly: () => flushMemo().then(() => onOpenStar(star)),
      // 행성을 옮겼다: 다시 그리면 목록에 남았는지에 따라 상세에 머물거나 목록으로 돌아간다
      onMoved: () => {
        renderHomeList();
        if (S.detail === null) $('home').scrollTo({ top: backY });
      },
    },
  });
}

function openDetail(id) {
  const home = $('home');
  backY = home.scrollTop;
  S.detail = String(id);
  renderHomeList();
  // 상세의 머리가 보이게 맞춘다: 긴 목록의 아래쪽에서 열었으면 올리고,
  // 좁은 화면처럼 상세가 화면 아래쪽(행성 패널 밑)에 있으면 내린다
  const fromTop = $('hList').getBoundingClientRect().top - home.getBoundingClientRect().top;
  const top = fromTop + home.scrollTop - 82;
  if (fromTop < 82 || fromTop > home.clientHeight * 0.6) home.scrollTo({ top: Math.max(0, top) });
  $('hDetail').querySelector('[data-d="back"]')?.focus({ preventScroll: true });
}

function closeDetail() {
  const id = S.detail;
  if (id === null) return;
  S.detail = null;
  renderHomeList();
  $('home').scrollTo({ top: backY });
  $('hTable').querySelector(`[data-fk="open:${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

// 이전(-1) · 다음(+1) 별로. 넘긴 뒤에도 같은 버튼에 초점을 둔다(끝에 닿아 잠기면 반대쪽 버튼)
function stepDetail(d) {
  if (S.detail === null) return;
  const list = shownList(store.state.planets ?? [], store.state.stars ?? []);
  const { prevId, nextId } = neighbors(list, S.detail);
  const next = d < 0 ? prevId : nextId;
  if (next === null) return;
  S.detail = next;
  renderHomeList();
  const box = $('hDetail');
  const btn = box.querySelector(`[data-d="${d < 0 ? 'prev' : 'next'}"]`);
  (btn && !btn.disabled ? btn : box.querySelector(`[data-d="${d < 0 ? 'next' : 'prev'}"]`))?.focus({ preventScroll: true });
}

// 거르기(행성 · 묶기 · 자주 찾음 · 검색 · 기간)가 바뀌었다: 흐리게 남겨 둔 별을 빼고 첫 쪽부터 다시 보인다
function refilter() {
  keep.clear();
  S.limit = PAGE;
  renderHomeList();
}

// 모든 기간의 별(검색어가 범위 밖에서도 맞는지 세는 데 쓴다)
function loadAll() {
  if (allLoading) return;
  allLoading = api
    .stars()
    .then((list) => {
      all = Array.isArray(list) ? list : [];
    })
    .catch(() => {
      /* 못 받으면 "다른 행성·기간에 N개"만 빠진다. 연결 실패 카드는 api.js가 띄운다 */
    })
    .finally(() => {
      allLoading = null;
      if (all) renderHomeList();
    });
}

/* ---------- 여러 개 골라 옮기기 · 지우기 ---------- */
// 고르기를 끝낸다(다시 그리지는 않는다). 물어보기 버튼도 다시 보인다
function endPick() {
  if (picking) setPickingUi(false);
  picking = false;
  pickedIds = new Set();
}

// 고르기를 켜고 끈다. 켤 때 상세를 보고 있었으면 닫는다. 초점은 같은 자리의 버튼(여러 개 고르기 ↔ 취소)에 남는다
function togglePick() {
  if (picking) endPick();
  else {
    if (S.detail !== null) S.detail = null;
    picking = true;
    pickedIds = new Set();
    setPickingUi(true);
  }
  renderHomeList();
  $('hTable').querySelector('[data-act="pick"]')?.focus({ preventScroll: true });
}

function togglePicked(id) {
  pickedIds = togglePickedId(pickedIds, id);
  renderHomeList();
}

// 머리의 전체 선택: 지금 보이는 줄(거르기 · 검색 · 더 보기까지)을 모두 고르거나 비운다. 초점은 체크칸에 남는다(swap이 data-fk로 되찾는다)
function togglePickAll() {
  const list = shownList(store.state.planets ?? [], store.state.stars ?? []);
  pickedIds = toggleAll(pickedIds, pageOf(list, S.limit).rows.map((s) => s.id));
  renderHomeList();
}

// 옮기기 · 지우기가 끝난 뒤. result = movePickedStars · deletePickedStars의 값, act = 누른 바 버튼('movePicked' | 'pickdel')
function afterPickAction(result, act) {
  if (result === null || result === undefined || !picking) return;
  if (result.partial) {
    // 앞 묶음만 처리됐다: 처리된 별은 선택에서 빼고 바로 다시 그린다. 고르기는 이어 간다(남은 것을 다시 누를 수 있게)
    const done = new Set(result.doneIds);
    pickedIds = new Set([...pickedIds].filter((id) => !done.has(id)));
    renderHomeList();
    const t = $('hTable');
    (t.querySelector(`.pickbar [data-act="${act}"]:not(:disabled)`) ?? t.querySelector('.pickall, [data-act="pick"]'))?.focus({ preventScroll: true });
    return;
  }
  endPick();
  renderHomeList();
  // 목록이 비면 고르기 버튼 · 줄이 없다: 빈 목록 안내의 버튼 → 검색 칸으로(패널이 닫기 버튼으로 돌아가는 것과 같은 자리)
  ($('hTable').querySelector('[data-act="pick"], .sttl, .sempty button') ?? $('hQ'))?.focus({ preventScroll: true });
}

async function movePicked() {
  afterPickAction(await movePickedStars(pickedIds), 'movePicked');
}

async function deletePicked() {
  afterPickAction(await deletePickedStars(pickedIds), 'pickdel');
}

/* ---------- 누르기 ---------- */
// ☆: 우주의 행성 패널 · 상세와 같이 쓴다(starActions.js). 다시 그리기 · 흐리게 남기기는 'starChanged'에서 한다
function toggleFav(star) {
  keep.delete(String(star.id));
  toggleFavStar(star);
}

// 별 ☆ · 이름이 바뀌었다(이 목록 · 상세 · 우주 어디서든)
function onStarChanged({ id } = {}) {
  const star = store.state.stars.find((s) => same(s.id, id));
  if (star) {
    const cached = all?.find((s) => same(s.id, id)); // 검색용 목록도 맞춘다
    if (cached && cached !== star) Object.assign(cached, { fav: star.fav, title: star.title });
    if (S.fav && !star.fav) keep.add(String(star.id)); // "자주 찾음만" 보는 중에 끈 별: 바로 빼지 않고 흐리게 남긴다
  }
  const home = $('home');
  if (!store.state.inWorld && !home.hidden && !home.inert) renderHomeList();
}

// 행성 합치기(우주 행성 패널 메뉴와 같은 창). 보던 행성을 합쳤으면 받은 행성으로 거르기를 옮긴다(옮겨 간 별이 바로 보이게)
async function mergeFromHome(planet) {
  const into = await mergePlanet(planet);
  if (!into || !same(S.planet, planet.id)) return;
  S.planet = into;
  S.detail = null;
  refilter();
}

function openStarMenu(button, star) {
  const others = store.state.planets.filter((p) => !same(p.id, star.planet_id));
  openRowMenu(button, `'${star.title || '제목 없음'}' 별 메뉴`, [
    { key: 'rename', label: '이름 바꾸기', run: () => rowEdit.start(star) },
    { key: 'move', label: '행성 옮기기', disabled: others.length === 0, run: () => moveStar(star, others).then((moved) => moved && renderHomeList()) },
    { key: 'del', label: '지우기', danger: true, run: () => deleteStar(star).then((gone) => gone && renderHomeList()) },
  ]);
}

function openPlanetMenu(button) {
  const planet = store.state.planets.find((p) => same(p.id, button.dataset.more));
  if (!planet || planetLocked(planet)) return;
  openRowMenu(button, `'${planet.name}' 행성 메뉴`, [
    // 좁은 화면: 서랍은 연 채로 창을 띄운다(창이 서랍 위에 뜬다). 닫으면 초점이 그 줄의 ⋯로 돌아온다
    { key: 'edit', label: '꾸미기', run: () => openPlanetForm({ planet }) },
    { key: 'merge', label: '다른 행성과 합치기', disabled: mergeTargets(planet).length === 0, run: () => mergeFromHome(planet) },
    { key: 'del', label: '지우기', danger: true, run: () => confirmDeletePlanet(planet, store.state.planets.filter((p) => !same(p.id, planet.id))) },
  ]);
}

function onDockClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el) return;
  if (el.dataset.more) {
    openPlanetMenu(el);
    return;
  }
  if (!el.dataset.planet) return;
  // 상세를 보는 중에 행성을 고르면 상세를 닫고 그 행성의 목록을 보인다
  if (same(el.dataset.planet, S.planet) && S.detail === null) {
    setSide(false); // 좁은 화면: 같은 행성을 다시 골라도 서랍은 닫는다
    return;
  }
  S.planet = el.dataset.planet;
  S.detail = null;
  refilter();
  setSide(false); // 좁은 화면: 고르면 서랍을 닫고 목록을 보여 준다
}

function onTableClick(e) {
  if (e.target instanceof Element && e.target.closest('[data-tedit]')) return; // 이름 입력칸 · 저장은 titleEdit.js가 받는다
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  // 고르는 중: 줄(체크칸 · 제목 · 빈 자리) 어디를 눌러도 고르기 · 풀기
  if (picking && !el?.dataset.act) {
    const row = e.target instanceof Element ? e.target.closest('.srow.pick[data-id]') : null;
    if (row) togglePicked(row.dataset.id);
    return;
  }
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'pick') {
    togglePick();
    return;
  }
  if (act === 'movePicked') {
    if (!el.disabled) movePicked();
    return;
  }
  if (act === 'pickdel') {
    if (!el.disabled) deletePicked();
    return;
  }
  if (act === 'pickall') {
    if (picking) togglePickAll();
    return;
  }
  if (act === 'more') {
    S.limit += PAGE;
    renderHomeList();
  } else if (act === 'qAll') {
    // 범위를 다 푼다: 모든 행성 · 모든 기간 · 자주 찾음 끔. 검색어는 그대로
    Object.assign(S, { planet: 'all', fav: false });
    if (store.state.period !== 'all') store.emit('setPeriod', { period: 'all' });
    refilter();
    $('hQ').focus({ preventScroll: true });
  } else if (act === 'qClear') {
    clearQuery();
  } else if (act === 'favOff') {
    S.fav = false;
    refilter();
    $('hFavSw').focus({ preventScroll: true });
  } else if (act === 'resetFilter') {
    S.planet = 'all';
    if (store.state.period !== 'all') store.emit('setPeriod', { period: 'all' });
    refilter();
  }
  if (act) return;
  const star = store.state.stars.find((s) => same(s.id, el.closest('.srow')?.dataset.id));
  if (!star) return;
  if (el.dataset.a === 'fav') toggleFav(star);
  else if (el.dataset.a === 'more') openStarMenu(el, star);
  else if (el.dataset.a === 'open') openDetail(star.id);
}

function clearQuery() {
  S.q = '';
  refilter();
  $('hQ').focus({ preventScroll: true });
}

// 축소본을 못 받으면(보관함에서 사라짐 등) 종류 아이콘으로 바꾼다
function onImgError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const box = img.closest('.th');
  if (box) box.innerHTML = ico(img.dataset.fallback, 18);
}

/* ---------- 시작 ---------- */
/**
 * 홈의 목록을 준비한다(한 번만).
 * @param {{ openStar?: (star: object) => void }} [o] 별 제목을 눌렀을 때 부를 것
 */
export function initHomeList({ openStar } = {}) {
  if (ready) return;
  ready = true;
  if (typeof openStar === 'function') onOpenStar = openStar;

  $('hDock').addEventListener('click', onDockClick);
  $('hTable').addEventListener('click', onTableClick);
  $('hTable').addEventListener('error', onImgError, true);
  $('hQ').addEventListener('input', () => {
    S.q = $('hQ').value;
    refilter();
  });
  $('hQ').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.q) {
      e.preventDefault();
      e.stopPropagation();
      clearQuery();
    } else if (e.key === 'Enter' && !e.isComposing) {
      $('hQ').blur(); // 폰: 자판을 내려 결과가 보이게
    }
  });
  $('hQClear').addEventListener('click', clearQuery);
  $('hGroupSw').addEventListener('click', () => {
    S.group = !S.group;
    refilter();
  });
  $('hFavSw').addEventListener('click', () => {
    S.fav = !S.fav;
    refilter();
  });
  $('hSeg').addEventListener('click', (e) => {
    const p = e.target instanceof Element ? e.target.closest('button')?.dataset.p : null;
    // 좁은 화면: 전체 · 오늘 · 이번 주를 고르면 기간 바를 접는다(직접 지정은 날짜를 고르게 남긴다)
    if (p && p !== 'custom' && narrowMq.matches) setPeriodOpen(false, { focus: true });
    if (p && p !== store.state.period) store.emit('setPeriod', { period: p });
  });
  for (const id of ['hFrom', 'hTo']) $(id).addEventListener('change', () => store.emit('setPeriod', { from: $('hFrom').value, to: $('hTo').value }));

  // 좁은 화면: 행성 서랍 · 기간 바 펼치기
  $('hSideOpen').addEventListener('click', () => setSide(true));
  $('hPlanetBtn').addEventListener('click', () => setSide(true));
  $('hSideClose').addEventListener('click', () => setSide(false));
  $('hScrim').addEventListener('click', () => setSide(false));
  $('hsNew').addEventListener('click', () => setSide(false)); // 새 행성 창은 home.js가 띄운다
  $('hPeriodBtn').addEventListener('click', () => {
    const open = !isPeriodOpen();
    setPeriodOpen(open);
    if (open) $('hSeg').querySelector('button.on')?.focus({ preventScroll: true });
  });
  narrowMq.addEventListener?.('change', () => {
    setSide(false, { focus: false });
    setPeriodOpen(false);
  });
  // Esc: 서랍(맨 위 층) → 펼친 기간 바. 우주의 왼쪽 서랍(35) · 기간 바(34)와 같은 자리다
  registerEscape(35, () => {
    if (!sideOpen || store.state.inWorld) return false;
    setSide(false);
    return true;
  });
  registerEscape(34, () => {
    if (store.state.inWorld || !narrowMq.matches || !isPeriodOpen()) return false;
    setPeriodOpen(false, { focus: true });
    return true;
  });

  // 상세를 보는 동안의 키: ←/→로 이전 · 다음(글을 쓰는 칸 · 창 안에서는 받지 않는다), Esc로 목록으로
  document.addEventListener('keydown', (e) => {
    if (S.detail === null || store.state.inWorld || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (!(t instanceof Element) || !(t === document.body || $('hDetail').contains(t))) return; // 다른 창에 초점이 있다
    if (t.closest('input, textarea, select')) return;
    e.preventDefault();
    stepDetail(e.key === 'ArrowLeft' ? -1 : 1);
  });
  // 이미지 크게 보기(32)를 먼저 닫은 다음이다
  registerEscape(29, () => {
    if (S.detail === null || store.state.inWorld) return false;
    closeDetail();
    return true;
  });
  // 고르는 중이면 고르기를 끝낸다(상세 29 다음, 챗봇 창 25보다 먼저)
  registerEscape(28, () => {
    if (!picking || store.state.inWorld || $('home').hidden) return false;
    togglePick();
    return true;
  });

  store.on('period', (p) => {
    if (p?.custom) custom = p.custom;
    keep.clear();
    S.limit = PAGE;
    paintPeriod(); // 목록은 새 기간의 별을 받은 뒤('data') 다시 그린다
  });
  // 우주로 들어가면 고르기를 끝낸다(돌아왔을 때 고르던 상태가 남지 않게)
  store.on('enterWorld', () => {
    endPick();
    $('hTable').classList.remove('picking');
  });
  // 로그인 · 로그아웃: 보이는 별이 바뀌니 고르기를 끝낸다. main.js의 같은 이벤트(홈 다시 그리기)가 먼저 돌았을 수 있어 여기서도 다시 그린다
  store.on('authChange', () => {
    if (!picking) return;
    endPick();
    $('hTable').classList.remove('picking');
    if (!store.state.inWorld && !$('home').hidden) renderHomeList();
  });
  store.on('starChanged', onStarChanged);
  store.on('dayChanged', () => renderHomeList()); // 목록 날짜(오늘 · 어제 …)를 새 날 기준으로
  store.on('data', () => {
    all = null; // 받아 둔 모든 별은 낡았다
    // 우주 밖에 있고 전환 중(inert)이 아닐 때만(빨려 들어가는 중인 요소를 갈아 끼우지 않게)
    const home = $('home');
    if (!store.state.inWorld && !home.hidden && !home.inert) renderHomeList();
  });
}
