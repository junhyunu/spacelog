// 시작점: 서체 · 스타일을 싣고, 서버 연결을 확인한 뒤 데이터를 받는다.
// 서체는 npm 패키지에서 번들로 들어간다(CDN 없음).
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource/black-han-sans';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';

import { api } from './api.js';
import { store } from './store.js';
import { toast } from './ui/toast.js';

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

checkConnection();
