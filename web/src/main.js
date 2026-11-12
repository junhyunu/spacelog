// 시작점: 서체 · 스타일을 싣고, 서버 연결을 확인한 뒤 데이터를 받는다.
// 서체는 npm 패키지에서 번들로 들어간다(CDN 없음).
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource/black-han-sans';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/planet.css';
import './styles/detail.css';

import { api } from './api.js';
import { store } from './store.js';
import { isAskOpen } from './ui/confirm.js';
import { setEscapeGuards } from './ui/escape.js';
import { initHome } from './ui/home.js';
import { initHud } from './ui/hud.js';
import { initPanel } from './ui/panel.js';
import { closePlanetDelete } from './ui/planetDelete.js';
import { closePlanetForm, openPlanetForm } from './ui/planetForm.js';
import { toast } from './ui/toast.js';
import { enterWorld, isTransitioning, leaveWorld } from './ui/transition.js';

const $ = (id) => document.getElementById(id);

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
    document.querySelector('#home .home-grid').hidden = true;
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
  document.querySelector('#home .home-grid').hidden = false;
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

// W-00 메인 홈과 블랙홀 전환. 홈은 'data'가 올 때마다(우주 밖일 때) 다시 그려진다.
initHome({ enter: enterWorld });
$('goHome').addEventListener('click', () => leaveWorld());

// W-01 조작 UI. 우주 안에서 'data'가 올 때마다 다시 그리고 3D를 맞춘다(손님 별 포함).
initHud();

// Esc 순서(escape.js): 확인 창 → 행성 꾸미기 창 → 저장 창 → 전환 건너뛰기 → 상세에서 목록 → 패널 닫기
setEscapeGuards({ isAskOpen, isTransitioning });

// W-02 행성 패널(+ 상세). 'land' · 'openStar' · 'pickStar'로 열리고 'leftPanelPlanet'으로 닫힌다.
initPanel();

// "+ 새 행성"(#hNewPlanet · #wNewPlanet · 빈 우주 카드): 행성 꾸미기 창을 만들기로 연다.
// 저장하면 store.reload() → 'data' → 우주 안이면 3D · 목록, 밖이면 홈의 행성 목록이 다시 그려진다.
store.on('newPlanet', () => openPlanetForm({}));
// 우주에서 나갈 때는 열려 있는 창을 모두 닫는다(패널은 panel.js가 닫는다)
store.on('leavingWorld', () => {
  closePlanetForm();
  closePlanetDelete();
});

checkConnection();
