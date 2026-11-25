// 떠 있는 챗봇 버튼(#chatBtn, 2차 스펙 7장): 화면 오른쪽 아래 맨 구석. 기록하기와 같은 높이의 알약 버튼이다:
// 왼쪽에 툰 스타일 원자 그림(인라인 SVG), 오른쪽에 글자 "물어보기"(열려 있으면 "닫기"), 오른쪽 위에 빨간 점.
// 그림: 진보라 원, 흰 타원 궤도 3줄(0° · 60° · 120°, 잉크 외곽선), 가운데 노란 별(잉크 외곽선).
// 궤도 그룹은 chat.css가 20초에 한 바퀴 돌린다(모션 줄이기에서는 멈춤). 열리면 그림이 ✕로 바뀐다.
// 글자는 본문 서체다: 제목 서체는 이 크기에서 "물"의 획이 뭉친다.
//
// 좁은 화면(760px 이하)에서는 알약으로 나왔다가, 스크롤하거나 우주에서 움직이기 시작하거나 4초가 지나면
// 글자를 접고 둥근 버튼으로 줄어든다(목록을 덜 가리게). 한 번 줄어들면 그 방문 동안은 그대로다(새로고침하면 다시 알약).
// 여기서는 body에 chat-mini만 달고, 실제 모양은 chat.css가 좁은 화면에서만 바꾼다.
//
// 처음 한 번 말풍선(#chatHint): 우주 안에서 버튼 바로 위에 "기록에게 물어보세요"를 띄운다.
// ✕로 끄거나 챗봇을 한 번 열면 다시 뜨지 않는다(localStorage). 보일지는 chatLogic.js chatHintVisible이 정한다.
import { store } from '../store.js';
import { ico } from '../util.js';
import { chatButtonLabel, chatButtonText, chatHintVisible } from './chatLogic.js';

const STAR = '32,21.5 34.59,28.44 41.99,28.76 36.18,33.36 38.17,40.49 32,36.4 25.83,40.49 27.82,33.36 22.01,28.76 29.41,28.44';
const ORBIT = (deg, cls) => `<ellipse class="${cls}" cx="32" cy="32" rx="21" ry="8" transform="rotate(${deg} 32 32)"/>`;

// 테두리 · 그림자는 버튼이 가지므로 공에는 두지 않는다
const ATOM =
  '<svg class="atom" width="32" height="32" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
  '<circle class="ball" cx="32" cy="32" r="28.5" fill="#5b4fd6"/>' +
  '<g class="orbits">' +
  [0, 60, 120].map((d) => ORBIT(d, 'o-ink')).join('') +
  [0, 60, 120].map((d) => ORBIT(d, 'o-white')).join('') +
  '</g>' +
  `<polygon points="${STAR}" fill="#ffd23f" stroke="#1a1430" stroke-width="2.6" stroke-linejoin="round"/>` +
  '</svg>';

const MINI_AFTER_MS = 4000; // 이만큼 지나면 줄어든다
const HINT_KEY = 'spacelog.chatHintOff'; // '1'이면 말풍선을 다시 띄우지 않는다
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

/**
 * 버튼과 처음 한 번 말풍선을 준비한다. onToggle()은 버튼을 누를 때마다 불린다.
 * 읽지 않음은 빨간 점(그림)과 버튼의 이름("챗봇 열기, 읽지 않은 답 있음")으로 함께 알린다.
 * @returns {{ setOpen(open: boolean): void, setBehind(on: boolean): void, setUnread(on: boolean): void, el: HTMLButtonElement }}
 */
export function initChatButton({ onToggle } = {}) {
  const el = document.getElementById('chatBtn');
  el.innerHTML =
    `<span class="atomic" aria-hidden="true">${ATOM}<span class="x">${ico('x', 22)}</span></span>` +
    '<span class="t" aria-hidden="true"></span>' +
    '<span class="dot" aria-hidden="true" hidden></span>';
  const text = el.querySelector('.t');
  el.addEventListener('click', () => onToggle?.());
  let unread = false;
  let open = false;
  let behind = false; // 열려 있지만 행성 패널 아래에 있다
  const label = () => {
    el.setAttribute('aria-label', chatButtonLabel({ open, behind, unread }));
    text.textContent = chatButtonText({ open, behind });
  };
  label();

  // 처음 한 번 말풍선
  const hint = document.getElementById('chatHint');
  let dismissed = readKey(HINT_KEY) === '1';
  const paintHint = () => {
    const show = chatHintVisible({
      inWorld: store.state.inWorld,
      total: store.state.summary?.total,
      open,
      dismissed,
      offline: store.state.offline,
    });
    if (!show && hint.contains(document.activeElement)) el.focus({ preventScroll: true }); // 사라지는 말풍선의 초점은 버튼으로
    hint.hidden = !show;
  };
  const dismissHint = () => {
    if (!dismissed) {
      dismissed = true;
      writeKey(HINT_KEY, '1');
    }
    paintHint();
  };
  document.getElementById('chatHintX').addEventListener('click', dismissHint);
  for (const name of ['data', 'enterWorld', 'leaveWorld', 'leavingWorld', 'online', 'offline']) store.on(name, paintHint);
  paintHint();

  // 둥근 버튼으로 줄이기: 스크롤 · 우주에서 움직이기 · 시점 끌기 중 먼저 온 것, 아니면 4초 뒤
  const timer = setTimeout(shrink, MINI_AFTER_MS);
  function shrink() {
    clearTimeout(timer);
    document.removeEventListener('scroll', shrink, true);
    document.getElementById('stage')?.removeEventListener('pointerdown', shrink);
    document.body.classList.add('chat-mini');
  }
  document.addEventListener('scroll', shrink, { capture: true, passive: true });
  document.getElementById('stage')?.addEventListener('pointerdown', shrink, { passive: true });
  store.on('manualMove', shrink);

  return {
    el,
    setOpen(next) {
      open = Boolean(next);
      el.classList.toggle('open', open);
      el.setAttribute('aria-expanded', String(open));
      label();
      if (open) dismissHint(); // 한 번 열어 봤으면 말풍선은 다시 띄우지 않는다
      else paintHint();
    },
    setBehind(next) {
      behind = Boolean(next);
      label();
    },
    setUnread(on) {
      unread = Boolean(on);
      el.querySelector('.dot').hidden = !unread;
      label();
    },
  };
}
