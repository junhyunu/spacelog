// 시작점: 서체 · 스타일을 싣고, 서버 연결을 확인한 뒤 데이터를 받는다.
// 서체는 npm 패키지에서 번들로 들어간다(CDN 없음).
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource/black-han-sans';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/planet.css';
import './styles/rowmenu.css';
import './styles/character.css';
import './styles/detail.css';
import './styles/save.css';
import './styles/chat.css';
import './styles/account.css';
import './styles/home.css';
import './styles/landing.css';
import './styles/remind.css';
import './styles/select.css'; // 선택 상자 화살표: 각 창의 선택 상자 규칙 뒤에 와야 한다
import './styles/press.css'; // 누르는 순간의 반응: 모든 부품 규칙 뒤에 와야 한다

import { api } from './api.js';
import { store } from './store.js';
import { setCharacterLook } from './three/character.js';
import { initAccount, isSignedIn } from './ui/account.js';
import { closeCharacterForm, openCharacterForm } from './ui/characterForm.js';
import { normalizeLook } from './ui/characterLogic.js';
import { isAskOpen } from './ui/confirm.js';
import { initChat } from './ui/chatPanel.js';
import { initDropzone } from './ui/dropzone.js';
import { setEscapeGuards } from './ui/escape.js';
import { initHome, renderHome } from './ui/home.js';
import { initHud } from './ui/hud.js';
import { initLongPress } from './ui/longPress.js';
import { initSearch } from './ui/search.js';
import { initTopbar } from './ui/topbar.js';
import { initPanel } from './ui/panel.js';
import { initRemind } from './ui/remind.js';
import { initRemindTransition } from './ui/remindTransition.js';
import { closePlanetDelete } from './ui/planetDelete.js';
import { closePlanetForm, openPlanetForm } from './ui/planetForm.js';
import { openSave } from './ui/saveModal.js';
import { toast } from './ui/toast.js';
import { enterWorld, isTransitioning, leaveWorld } from './ui/transition.js';

const $ = (id) => document.getElementById(id);

// iOS Safari는 터치 리스너가 하나도 없으면 :active(누르는 순간의 반응, press.css)를 보여 주지 않는다
addEventListener('touchstart', () => {}, { passive: true });

const OFFLINE_CARD =
  '<span class="eyebrow">연결 끊김</span>' +
  '<h3>spaceLog 서버와 연결이 끊겼어요.<br>서버를 다시 켜고 새로고침해 주세요.</h3>' +
  '<button type="button" class="btn" data-retry>새로고침</button>';

/**
 * 연결 실패 카드를 띄운다. W-00이면 로고만 남기고 가운데 카드, W-01이면 가운데 상태 카드.
 * 열려 있는 창(저장 창 · 패널)과 쓰던 글은 건드리지 않는다.
 */
export function showOffline() {
  store.state.offline = true;
  const inWorld = store.state.inWorld;
  const card = inWorld ? $('worldMsg') : $('hState');
  const other = inWorld ? $('hState') : $('worldMsg');
  if (!inWorld) {
    document.querySelector('#home .hero').hidden = true;
    $('hMain').hidden = true;
    $('hLog').hidden = true;
  }
  if (other.querySelector('[data-retry]')) other.hidden = true;
  if (!card.querySelector('[data-retry]')) {
    card.innerHTML = OFFLINE_CARD;
    card.querySelector('[data-retry]').addEventListener('click', retry);
  }
  card.hidden = false;
}

function hideOffline() {
  store.state.offline = false;
  for (const card of [$('hState'), $('worldMsg')]) {
    if (card.querySelector('[data-retry]')) {
      card.hidden = true;
      card.textContent = '';
    }
  }
  document.querySelector('#home .hero').hidden = false;
  $('hMain').hidden = false;
  $('hLog').hidden = false;
}

/**
 * 서버 연결을 확인하고 데이터를 다시 받는다. 되면 true.
 * 안 되면 연결 실패 카드를 띄우고 false.
 */
export async function checkConnection() {
  const wasOffline = store.state.offline;
  try {
    await api.health();
    if (wasOffline) hideOffline();
    await store.reload(); // 끝나면 'data'
    if (wasOffline) store.emit('online');
    return true;
  } catch (err) {
    // 서버가 오류로 답한 것(4xx · 5xx)은 연결 끊김이 아니다.
    if (err?.code === 'offline') showOffline();
    else toast('데이터를 불러오지 못했어요. 새로고침해 주세요');
    return false;
  }
}

let retrying = false;
async function retry(e) {
  if (retrying) return;
  retrying = true;
  const btn = e.currentTarget;
  btn.disabled = true;
  const ok = await checkConnection();
  retrying = false;
  if (btn.isConnected) btn.disabled = false;
  toast(ok ? '서버와 다시 연결했어요' : '아직 연결되지 않았어요. 서버를 켠 뒤 다시 눌러 주세요');
}

// 어떤 요청이든 네트워크에서 실패하면 api.js가 'offline'을 알린다
store.on('offline', showOffline);
// 잠깐 끊겼다가 다음 요청이 성공하면(개발 중 서버 재시작 등) 카드를 걷고 다시 받는다.
store.on('reachable', () => {
  if (store.state.offline) checkConnection();
});

// 로그인(시연용, account.js). 로그인 전에는 body.signed-out으로 기록과 관련된 것을 숨긴다.
// 로그인 · 로그아웃이 바뀌면: 우주 안이면 홈으로 나가고(로그아웃), 홈이면 다시 그린다.
initAccount();
store.on('authChange', ({ signedIn }) => {
  if (!signedIn && store.state.inWorld) leaveWorld();
  else if (!store.state.inWorld) renderHome();
});

// W-00 메인 홈과 블랙홀 전환. 홈은 'data'가 올 때마다(우주 밖일 때) 다시 그려진다.
initHome({ enter: enterWorld });
$('goHome').addEventListener('click', () => leaveWorld());

// W-01 조작 UI. 우주 안에서 'data'가 올 때마다 다시 그리고 3D를 맞춘다(손님 별 포함).
initHud();
initSearch();
// 잠든 별 블랙홀: 잠든 별 수를 센다('data' · 'seen' 때마다). 화면은 우주의 블랙홀('blackHole') · 홈 안내가 연다
initRemind();
initRemindTransition({ enter: enterWorld });

// Esc 순서(escape.js): 확인 창 → 행성 꾸미기 창 → 저장 창 → 전환 건너뛰기 → 좁은 화면의 왼쪽 서랍 → 상세에서 목록 → 챗봇 창 닫기 → 패널 닫기
setEscapeGuards({ isAskOpen, isTransitioning });

// W-02 행성 패널(+ 상세). 'land' · 'openStar'로 열리고 'leftPanelPlanet'으로 닫힌다.
initPanel();
// 터치 화면: 목록 줄을 꾹 누르면 그 줄의 ⋯ 메뉴(홈 · 우주의 별 줄 · 행성 줄)
initLongPress();

// 날이 바뀌면(켜 둔 채 자정을 넘김 · 오래 둔 탭으로 돌아옴) 'dayChanged': 목록의 "오늘 · 어제 · n일 전"을 다시 그린다(util.js listDate)
{
  let day = new Date().toDateString();
  const checkDay = () => {
    const now = new Date().toDateString();
    if (now === day) return;
    day = now;
    store.emit('dayChanged');
  };
  setInterval(checkDay, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkDay();
  });
}

// "+ 새 행성"(#hNewPlanet · #wNewPlanet): 행성 꾸미기 창을 만들기로 연다.
// 저장하면 store.reload() → 'data' → 우주 안이면 3D · 목록, 밖이면 홈의 행성 목록이 다시 그려진다.
store.on('newPlanet', () => openPlanetForm({}));
// 우주 안 사람 아이콘 메뉴의 "캐릭터 꾸미기"(hud.js): 캐릭터 꾸미기 창을 연다(스펙 6-10).
store.on('openCharacter', () => openCharacterForm());
// "기록하기"(#hLog · #wLog): 기록하기 창을 연다. 버튼은 home.js · hud.js가 듣고 'openSave'로 알린다.
store.on('openSave', (o) => {
  if (!isSignedIn()) return toast('로그인하면 기록할 수 있어요');
  openSave(o ?? {});
});
// 끌어다 놓기 · 붙여넣기(W-00 · W-01 어디서나)
initDropzone();
// 챗봇(2차 스펙 7장): 오른쪽 아래 버튼 · 창 · 읽지 않음 확인. W-00 · W-01 어디서나
initChat();
// 행성 패널 · 챗봇 창이 열린 동안 위쪽 막대를 숨기고 손잡이를 단다(topbar.js)
initTopbar();
// 우주에서 나갈 때 패널 · 행성 창은 닫는다. 저장 창은 비어 있고 한가할 때만 스스로 닫힌다(쓰던 글을 지키려고).
store.on('leavingWorld', () => {
  closePlanetForm();
  closePlanetDelete();
  closeCharacterForm();
});

// 캐릭터의 모습을 한 번 받는다(스펙 6-10). 못 받으면 기본 모습으로 두고, 다시 연결되면 한 번 더 받는다.
// 우주를 아직 만들지 않았으면 setCharacterLook은 적어만 둔다(transition.js가 처음 들어갈 때 그 모습으로 만든다).
async function loadCharacter() {
  if (store.state.characterLoaded) return;
  let look;
  try {
    look = await api.character();
  } catch {
    return; // 연결 끊김은 api.js가 알린다
  }
  if (store.state.characterLoaded) return; // 받는 사이 꾸미기 창에서 저장했다: 그쪽이 더 새롭다
  store.state.character = normalizeLook(look);
  store.state.characterLoaded = true;
  setCharacterLook(store.state.character);
}
store.on('online', loadCharacter);
loadCharacter();

checkConnection();
