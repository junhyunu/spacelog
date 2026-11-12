// W-03 별 상세 — 자리만 잡아 둔 것. Task 10이 이 파일을 채운다(미리보기 · 메모 자동 저장 · 옮기기 · 지우기).
// panel.js가 부르는 모양은 그대로 둔다:
//   renderDetail(container, star, planet, { onBack, onClose })  container(#panel)의 내용을 통째로 그린다
//   flushMemo() → Promise                                       대기 중인 메모 저장을 바로 끝낸다
import { PLANET_COLORS, esc, ico, shortDate } from '../util.js';

/**
 * 별 상세를 그린다.
 * @param {HTMLElement} container  #panel. 머리까지 통째로 바꾼다
 * @param {object} star            별(서버가 준 모양)
 * @param {object} planet          그 별의 행성
 * @param {{ onBack?: () => void, onClose?: () => void }} handlers  ← 목록으로 / ✕ 패널 닫기
 */
export function renderDetail(container, star, planet, { onBack, onClose } = {}) {
  const face = PLANET_COLORS[planet?.color_index]?.face ?? '#7a6cff';
  const body = star.type === 'link' ? star.url : star.type === 'text' ? star.body : star.file_name;
  container.innerHTML =
    '<header>' +
    `<button type="button" class="btn x ghost" data-d="back" aria-label="목록으로">${ico('arrow-left')}</button>` +
    `<div class="hd"><div class="sub pname"><span class="dot" style="background:${face}"></span><span class="t">${esc(planet?.name)}</span></div>` +
    `<h2 class="h2s">${esc(star.title || '제목 없음')}</h2></div>` +
    `<button type="button" class="btn x" data-d="close" aria-label="닫기">${ico('x')}</button>` +
    '</header>' +
    `<div class="body"><div class="lbl">${esc(shortDate(star.created_at))}</div>` +
    (body ? `<div class="detail">${esc(body)}</div>` : '') +
    '</div>';
  container.querySelector('[data-d="back"]').addEventListener('click', () => onBack?.());
  container.querySelector('[data-d="close"]').addEventListener('click', () => onClose?.());
}

/** 대기 중인 메모 저장을 바로 끝낸다. 지금은 메모가 없어 할 일이 없다. */
export function flushMemo() {
  return Promise.resolve();
}
