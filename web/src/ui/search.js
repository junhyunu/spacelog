// 우주 안 별 찾기(#wSearch · #wSearchBtn). 스펙에 없던 기능으로, 비교 테스트 화면에서 먼저 써 본 뒤 옮겼다.
// 넓은 화면: 기간 바 왼쪽의 동그란 🔍를 누르면 기간 바 아래에 검색 줄이 펼쳐지고, 결과 목록이 그 아래에 뜬다.
// 좁은 화면(760px 이하): 오른쪽 위 🔍를 누르면 전체 화면 검색이 열린다(← 로 닫는다).
// 모든 기간의 별에서 제목 · 내용(본문) · 메모를 찾는다. 서버에 검색 API가 없어 api.stars()로 한 번 받아 여기서 거른다
// (받아 둔 목록은 store의 'data'가 오면 버린다). 검색어가 비어 있으면 최근 별 5개를 보여 준다.
// 결과를 누르면 그 별로 날아간다: hud.js의 flyToStar가 기간 밖이면 손님 별로 보여 준다(챗봇 출처 카드와 같은 길).
// Esc(37): 전체 화면 검색 → 결과 목록 → 검색 줄 순으로 닫는다. 화면을 덮는 맨 위 층이라 서랍(35)보다 먼저.
import { api } from '../api.js';
import { store } from '../store.js';
import { PLANET_COLORS, esc } from '../util.js';
import { registerEscape } from './escape.js';
import { isOutsidePeriod } from './hudLogic.js';
import { flyToStar, setPeriodOpen } from './hud.js';

const $ = (id) => document.getElementById(id);
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };
const MAX = 30; // 결과는 최신순 30개까지
const faceOf = (planetId) => {
  const p = store.state.planets.find((x) => String(x.id) === String(planetId));
  return { name: p?.name ?? '', face: PLANET_COLORS[p?.color_index]?.face ?? '#7a6cff' };
};

let all = null; // 받아 둔 모든 별(최신순). null이면 다음 검색 때 다시 받는다
let loading = null;
let seq = 0;
let ready = false;

const norm = (t) => String(t ?? '').toLowerCase();

/** 찾은 낱말을 <mark>로 감싼다(나머지는 esc). */
function markQ(text, q) {
  text = String(text ?? '');
  if (!q) return esc(text);
  const low = norm(text);
  let out = '';
  let i = 0;
  let j;
  while ((j = low.indexOf(q, i)) !== -1) {
    out += `${esc(text.slice(i, j))}<mark>${esc(text.slice(j, j + q.length))}</mark>`;
    i = j + q.length;
  }
  return out + esc(text.slice(i));
}

/** 메모에서 찾았으면 그 낱말 둘레의 한 줄. 없으면 '' */
function memoSnip(memo, q) {
  const m = String(memo ?? '').replace(/\s+/g, ' ').trim();
  const at = q ? norm(m).indexOf(q) : -1;
  if (at < 0) return '';
  const from = Math.max(0, at - 12);
  return (from ? '…' : '') + markQ(m.slice(from), q);
}

const md = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}월 ${d.getDate()}일`;
};

function loadAll() {
  if (all) return Promise.resolve(all);
  if (!loading) {
    loading = api
      .stars({})
      .then((list) => {
        all = [...(Array.isArray(list) ? list : [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return all;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

const query = () => norm($('wQ').value.trim());

function setResults(html) {
  const box = $('wResults');
  const on = html !== null;
  box.hidden = !on;
  if (on) box.innerHTML = html;
  $('wQ').setAttribute('aria-expanded', String(on));
}

const RECENT = 5; // 검색어가 비었을 때 보여 주는 최근 별 개수

/** 결과 한 줄. q가 있으면 찾은 낱말을 표시하고, 제목에 없으면 찾은 곳(메모 · 내용) 둘레 한 줄을 보여 준다. */
function rowHtml(s, q) {
  const p = faceOf(s.planet_id);
  const memo = q ? memoSnip(s.memo, q) : '';
  const body = q && !memo && !norm(s.title).includes(q) ? memoSnip(s.body, q) : '';
  const snip = memo ? `메모: ${memo}` : body ? `내용: ${body}` : '';
  const out = isOutsidePeriod(s, store.state.range);
  return (
    `<li><button type="button" class="wsr" data-star="${esc(s.id)}">` +
    `<span class="pdot" style="background:${p.face}" aria-hidden="true"></span>` +
    `<span class="tx"><span class="n">${markQ(s.title, q)}</span>` +
    (snip ? `<span class="m">${snip}</span>` : '') +
    `<span class="k">${esc(p.name)} · ${md(s.created_at)}${out ? ' · <i>기간 밖</i>' : ''}</span></span>` +
    '</button></li>'
  );
}

async function paint() {
  const q = query();
  $('wQClear').hidden = !$('wQ').value;
  if (!q && !isOpen()) {
    setResults(null);
    return;
  }
  const token = ++seq;
  let list;
  try {
    list = await loadAll();
  } catch {
    if (token === seq) setResults('<p class="sr-msg">별을 불러오지 못했어요. 잠시 뒤 다시 찾아 주세요</p>');
    return;
  }
  if (token !== seq || query() !== q) return; // 그사이 더 적었다
  if (!q) {
    // 검색어가 비었으면: 최근 별 5개(적지 않고 바로 고를 수 있게). 별이 없으면 무엇을 찾는지 안내
    if (!isOpen()) return;
    const recent = list.slice(0, RECENT);
    setResults(
      recent.length
        ? `<p class="sr-count">최근 별</p><ul>${recent.map((s) => rowHtml(s, '')).join('')}</ul>`
        : '<p class="sr-msg"><b>어떤 별을 찾을까요?</b>제목·내용·메모에서 모든 기간의 별을 찾아요</p>',
    );
    return;
  }
  const hits = list.filter((s) => norm(s.title).includes(q) || norm(s.body).includes(q) || norm(s.memo).includes(q));
  if (!hits.length) {
    setResults(`<p class="sr-msg"><b>‘${esc($('wQ').value.trim())}’에 맞는 별이 없어요</b>제목·내용·메모에서 찾았어요. 다른 낱말로 찾아보세요</p>`);
    return;
  }
  const rows = hits.slice(0, MAX).map((s) => rowHtml(s, q)).join('');
  const more = hits.length > MAX ? ` · 최신 ${MAX}개만 보여요` : '';
  setResults(`<p class="sr-count" aria-live="polite">${hits.length}개 찾았어요${more}</p><ul>${rows}</ul>`);
}

/* ---------- 검색 펼치기 · 접기(넓은 화면: 기간 바 아래 검색 줄 · 좁은 화면: 전체 화면) ---------- */
function isOpen() {
  return document.body.classList.contains('wsearch-open');
}

function setOpen(on, { focus = true } = {}) {
  if (on) setPeriodOpen(false); // 좁은 화면: 펼쳐 둔 기간 바는 접는다
  document.body.classList.toggle('wsearch-open', on);
  $('wSearchBtn').setAttribute('aria-expanded', String(on));
  if (on) {
    $('wQ').focus();
    paint();
  } else {
    setResults(null);
    if (focus) $('wSearchBtn').focus({ preventScroll: true });
  }
}

/** 검색을 접는다(결과 목록 · 좁은 화면의 펼친 검색). 검색어는 남긴다. */
function close({ focus = false } = {}) {
  if (isOpen()) setOpen(false, { focus });
  else setResults(null);
}

function pick(starId) {
  const star = all?.find((s) => String(s.id) === String(starId));
  if (!star) return;
  close();
  $('wQ').blur();
  flyToStar(star);
}

/** 별 찾기를 준비한다(한 번만). */
export function initSearch() {
  if (ready) return;
  ready = true;
  const input = $('wQ');
  input.addEventListener('input', paint);
  input.addEventListener('focus', () => {
    if (isOpen()) paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      $('wResults').querySelector('.wsr')?.focus(); // Enter: 첫 결과로(폰은 자판이 내려가 결과가 보인다)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('wResults').querySelector('.wsr')?.focus();
    }
  });
  $('wResults').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...$('wResults').querySelectorAll('.wsr')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) input.focus();
    else items[Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))]?.focus();
  });
  $('wResults').addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-star]') : null;
    if (b) pick(b.dataset.star);
  });
  $('wQClear').addEventListener('click', () => {
    input.value = '';
    paint();
    input.focus();
  });
  $('wQClose').addEventListener('click', () => setOpen(false));
  $('wSearchBtn').addEventListener('click', () => setOpen(!isOpen()));
  // 검색 밖을 누르면 접는다(검색어는 남는다). 넓은 화면은 결과 목록만, 좁은 화면은 펼친 검색째
  addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Node)) return;
    if ($('wSearch').contains(e.target) || $('wSearchBtn').contains(e.target)) return;
    if (!isOpen()) return;
    // 좁은 화면(전체 화면)과 넓은 화면의 빈 검색은 접는다. 넓은 화면에서 검색어가 있으면 결과 목록만 접는다
    if (narrowMq.matches || !$('wQ').value.trim()) setOpen(false, { focus: false });
    else setResults(null);
  });
  // Esc: 결과 목록 → (좁은 화면) 펼친 검색 순으로 닫는다. 화면을 덮는 맨 위 층이라 서랍(35)보다 먼저
  registerEscape(37, () => {
    if (!store.state.inWorld) return false;
    if (narrowMq.matches && isOpen()) {
      setOpen(false);
      return true;
    }
    if (!$('wResults').hidden && input.value.trim()) {
      setResults(null);
      input.focus();
      return true;
    }
    if (isOpen()) {
      setOpen(false);
      return true;
    }
    return false;
  });
  narrowMq.addEventListener?.('change', () => {
    if (isOpen()) setOpen(false, { focus: false }); // 전체 화면 ↔ 검색 줄 모양이 바뀌므로 접는다
  });
  store.on('data', () => {
    all = null; // 기록 · 이동 · 삭제 뒤에는 다시 받는다
    if (!$('wResults').hidden) paint();
  });
  store.on('leaveWorld', () => close());
}
