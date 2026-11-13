// 떠 있는 챗봇 버튼(#chatBtn, 2차 스펙 7장): 화면 오른쪽 아래 맨 구석. 툰 스타일 원자 그림(인라인 SVG)과 빨간 점.
// 그림: 보라 원 + 잉크 테두리, 흰 타원 궤도 3줄(0° · 60° · 120°, 잉크 외곽선), 가운데 노란 별(잉크 외곽선).
// 궤도 그룹은 chat.css가 20초에 한 바퀴 돌린다(모션 줄이기에서는 멈춤). 열리면 ✕로 바뀐다.
import { ico } from '../util.js';

const STAR = '32,21.5 34.59,28.44 41.99,28.76 36.18,33.36 38.17,40.49 32,36.4 25.83,40.49 27.82,33.36 22.01,28.76 29.41,28.44';
const ORBIT = (deg, cls) => `<ellipse class="${cls}" cx="32" cy="32" rx="21" ry="8" transform="rotate(${deg} 32 32)"/>`;

const ATOM =
  '<svg class="atom" width="56" height="56" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
  '<circle cx="32" cy="35.5" r="28.5" fill="#1a1430"/>' + // 아래로 떨어지는 단색 그림자
  '<circle class="ball" cx="32" cy="32" r="28.5" fill="#7a6cff" stroke="#1a1430" stroke-width="3.4"/>' +
  '<g class="orbits">' +
  [0, 60, 120].map((d) => ORBIT(d, 'o-ink')).join('') +
  [0, 60, 120].map((d) => ORBIT(d, 'o-white')).join('') +
  '</g>' +
  `<polygon points="${STAR}" fill="#ffd23f" stroke="#1a1430" stroke-width="2.6" stroke-linejoin="round"/>` +
  '</svg>';

/**
 * 버튼을 준비한다. onToggle()은 누를 때마다 불린다.
 * @returns {{ setOpen(open: boolean): void, setUnread(on: boolean): void, el: HTMLButtonElement }}
 */
export function initChatButton({ onToggle } = {}) {
  const el = document.getElementById('chatBtn');
  el.innerHTML = `${ATOM}<span class="x" aria-hidden="true">${ico('x', 24)}</span><span class="dot" aria-hidden="true" hidden></span>`;
  el.addEventListener('click', () => onToggle?.());
  let unread = false;
  let open = false;
  const label = () => {
    const base = open ? '챗봇 닫기' : '챗봇 열기';
    el.setAttribute('aria-label', unread && !open ? `${base}, 읽지 않은 답 있음` : base);
  };
  label();
  return {
    el,
    setOpen(next) {
      open = Boolean(next);
      el.classList.toggle('open', open);
      el.setAttribute('aria-expanded', String(open));
      label();
    },
    setUnread(on) {
      unread = Boolean(on);
      el.querySelector('.dot').hidden = !unread;
      label();
    },
  };
}
