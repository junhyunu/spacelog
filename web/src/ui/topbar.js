// 우주 화면 위쪽 막대(#period: 별 찾기 🔍 · 기간 바 · 검색 줄 · 띠 배너) 자동 숨김과 손잡이(#topHandle).
//
// 넓은 화면(761px 이상)에서만: 행성 패널(#panel) · 챗봇 창(#chatPanel) 중 하나라도 열려 있으면 막대는 위로 숨고(body.top-tucked), 창은 그만큼 위로 늘어난다(app.css).
// 숨은 동안 오른쪽 위에 손잡이가 매달린다. 누르면 막대가 창 위로 내려오고(body.top-peek, 창 크기는 그대로) 손잡이는 숨는다.
// 내려온 동안 접기는 막대 줄 오른쪽 끝의 #topFold(위 화살표).
// 다시 접히는 때: 접기(#topFold)를 누를 때 · 기간(전체 · 오늘 · 이번 주)을 고른 뒤 · 막대와 손잡이 밖을 누를 때 · Esc(escape.js 33).
// 검색 줄이 열려 있으면(body.wsearch-open) 밖을 눌러도 접지 않고, 검색을 닫으면 접는다(topbarLogic.js).
//
// store에서 듣는 것: 'panelOpened' · 'panelClosed'(panel.js), 'chatOpened' · 'chatClosed'(chatPanel.js),
// 'enterWorld' · 'leavingWorld' · 'leaveWorld'(transition.js). 열림 여부는 이벤트마다 두 창의 hidden으로 다시 읽는다.
// 좁은 화면(760px 이하)에서는 숨기지 않는다(topbarLogic.js). 창 폭이 760px을 넘나들면 다시 판단한다.
import { store } from '../store.js';
import { registerEscape } from './escape.js';
import { topbarState } from './topbarLogic.js';

const $ = (id) => document.getElementById(id);
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };

let ready = false;
let inWorld = false;
let peek = false; // 사용자가 손잡이로 내렸는지(검색 중이라 내려 둔 것과 따로)
let shown = { tucked: false, peek: false };

const isSearching = () => document.body.classList.contains('wsearch-open');

function update() {
  const body = document.body;
  const s = topbarState({
    inWorld,
    narrow: narrowMq.matches,
    panelOpen: !$('panel').hidden,
    chatOpen: !$('chatPanel').hidden,
    peek,
    searching: isSearching(),
  });
  if (!s.tucked) peek = false;
  shown = s;
  body.classList.toggle('top-tucked', s.tucked);
  body.classList.toggle('top-peek', s.peek);
  const handle = $('topHandle');
  handle.hidden = !s.tucked || s.peek; // 내려온 동안은 막대 안의 접기(#topFold)가 대신한다
  // 숨는 막대 안에 초점이 남아 있으면 손잡이로 옮긴다(숨은 버튼이 키를 받지 않게)
  if (s.tucked && !s.peek && $('period').contains(document.activeElement)) {
    if (handle.getClientRects().length) handle.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
}

/** 손잡이로 내린 막대를 접는다. 접었으면 true. */
function collapse({ focus = false } = {}) {
  if (!peek) return false;
  peek = false;
  update();
  if (focus && !$('topHandle').hidden) $('topHandle').focus({ preventScroll: true });
  return true;
}

function leave() {
  inWorld = false;
  peek = false;
  update();
}

/** 위쪽 막대 자동 숨김을 준비한다(한 번만). */
export function initTopbar() {
  if (ready) return;
  ready = true;
  inWorld = Boolean(store.state.inWorld);

  $('topHandle').addEventListener('click', () => {
    peek = true;
    update();
    // 손잡이는 숨으니 초점은 막대 줄 끝의 접기로
    if (shown.peek) $('topFold').focus({ preventScroll: true });
  });
  $('topFold').addEventListener('click', () => {
    // 검색 줄이 열려 있으면 검색을 닫는다(닫히면 아래 관찰자가 접고 초점은 손잡이로 간다)
    if (!peek || isSearching()) return void $('wQClose').click();
    collapse({ focus: true });
  });

  // 기간을 고르면 접는다. "직접 지정"은 날짜를 고르게 남긴다(접기 · 밖 · Esc로 접는다)
  $('period').addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('.seg button[data-p]') : null;
    if (b && b.dataset.p !== 'custom') collapse({ focus: $('period').contains(document.activeElement) });
  });

  // 막대 · 손잡이(검색 목록은 막대 안) 밖을 누르면 접는다. 검색 중이면 그대로 둔다
  addEventListener('pointerdown', (e) => {
    if (!peek || isSearching() || !(e.target instanceof Node)) return;
    if ($('period').contains(e.target) || $('topHandle').contains(e.target)) return;
    collapse();
  });

  // 검색 줄이 열리고 닫히는 것(search.js가 body.wsearch-open을 바꾼다). 닫히면 손잡이로 내린 것도 접는다
  let wasSearching = isSearching();
  new MutationObserver(() => {
    const now = isSearching();
    if (now === wasSearching) return;
    wasSearching = now;
    if (!now) peek = false;
    update();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // Esc: 펼친 기간 바(34) 다음, 이미지 크게 보기(32) 앞. 내려온 막대가 창 위에 덮이므로 창 안의 것보다 먼저 접는다
  registerEscape(33, () => {
    if (!inWorld || !peek) return false;
    return collapse({ focus: $('period').contains(document.activeElement) }); // 채팅 · 패널에서 누른 Esc는 초점을 그대로 둔다
  });

  for (const ev of ['panelOpened', 'panelClosed', 'chatOpened', 'chatClosed']) store.on(ev, update);
  store.on('enterWorld', () => {
    inWorld = true;
    update();
  });
  store.on('leavingWorld', leave);
  store.on('leaveWorld', leave);
  narrowMq.addEventListener?.('change', update);
  update();
}
