// 챗봇 긴 답 "크게 보기"(chatThread.js 말풍선의 [크게 보기]). 답 하나를 넓게 읽는 창.
// 넓은 화면: 뒤를 어둡게 덮고 가운데에 읽기 창(폭 680px). 좁은 화면(760px 이하): 챗봇 위에 꽉 찬 화면, 머리 왼쪽 ← "대화로".
// 위: 물어본 말 한 줄. 가운데: 답 전체(말풍선과 같이 textContent · 줄바꿈 그대로, 마크다운은 그리지 않는다) · 근거.
// 아래: [복사] [별로 저장 | 띄운 별 보기 →]. 저장 · 근거 · 띄운 별은 창을 닫고 말풍선의 같은 동작을 한다.
// 닫기: ✕ · ← · Esc · 바깥(어두운 곳) 누르기. 닫으면 초점은 그 말풍선의 [크게 보기]로 돌아간다.
import { esc, ico } from '../util.js';
import { savedStarSource, sourceCardModel } from './chatLogic.js';
import { registerEscape } from './escape.js';
import { trapTab } from './planetForm.js';
import { store } from '../store.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
let box = null;
let current = null; // { m, actions, returnTo: () => Element | null }

function build() {
  if (box) return box;
  box = document.createElement('div');
  box.id = 'chatRead';
  box.hidden = true;
  box.innerHTML =
    '<section class="card cr-card" role="dialog" aria-modal="true" aria-labelledby="crTitle">' +
    '<header class="cr-head">' +
    `<button type="button" class="btn x ghost cr-back" data-cr="close" aria-label="대화로 돌아가기">${ico('arrow-left')}</button>` +
    '<div class="cr-hd"><h2 id="crTitle">답 크게 보기</h2><p class="cr-q" id="crQ"></p></div>' +
    `<button type="button" class="btn x cr-x" data-cr="close" aria-label="닫기">${ico('x')}</button>` +
    '</header>' +
    '<div class="cr-body" tabindex="-1"><p class="cr-tx" id="crText"></p><div class="cr-srcs srcs" id="crSrcs"></div></div>' +
    '<footer class="cr-foot" id="crFoot"></footer>' +
    '</section>';
  document.body.appendChild(box);
  box.addEventListener('click', onClick);
  // 바깥(어두운 곳)을 누르면 닫는다
  box.addEventListener('pointerdown', (e) => {
    if (e.target === box) closeRead();
  });
  box.addEventListener('keydown', (e) => trapTab(box.querySelector('.cr-card'), e));
  return box;
}

function sourcesHtml(m) {
  const sources = Array.isArray(m.sources) ? m.sources : [];
  if (!sources.length) return '';
  const items = sources
    .map((s, i) => {
      const v = sourceCardModel(s, store.state.planets);
      const inner =
        `<span class="pdot" style="background:${esc(v.color)}" aria-hidden="true"></span>` +
        `<span class="t">${esc(v.title)}</span>` +
        (v.date ? `<small>${esc(v.date)}</small>` : '');
      return v.gone
        ? `<li><div class="src gone" aria-disabled="true">${inner}</div></li>`
        : `<li><button type="button" class="src" data-cr-src="${i}" aria-label="${esc(`별 '${v.title}'(으)로 날아가기`)}">${inner}</button></li>`;
    })
    .join('');
  return `<p class="srclbl">근거 ${sources.length}개</p><ul aria-label="출처">${items}</ul>`;
}

function footHtml(m) {
  const saved = savedStarSource(m);
  return (
    `<button type="button" class="btn ghost" data-cr="copy">${ico('copy', 16)} 복사</button>` +
    (saved
      ? `<button type="button" class="btn ghost saved" data-cr="saved">${ico('star', 16)} 띄운 별 보기 →</button>`
      : `<button type="button" class="btn" data-cr="save">${ico('star', 16)} 별로 저장</button>`)
  );
}

/**
 * 답 하나를 크게 보기 창으로 연다.
 * m: 답 메시지 · question: 물어본 말(없으면 '') ·
 * actions: { onSource(source), onSave(m) } · returnTo(): 닫은 뒤 초점을 받을 요소(그 말풍선의 [크게 보기])
 */
export function openRead(m, question, actions = {}, returnTo = () => null) {
  if (!m) return;
  build();
  current = { m, actions, returnTo };
  $('crQ').textContent = question ? `Q. ${question}` : '';
  $('crQ').hidden = !question;
  $('crText').textContent = m.content ?? '';
  $('crSrcs').innerHTML = sourcesHtml(m);
  $('crFoot').innerHTML = footHtml(m);
  box.hidden = false;
  box.querySelector('.cr-body').scrollTop = 0;
  // 첫 초점: 보이는 닫기 버튼(넓은 화면 ✕, 좁은 화면 ←)
  [...box.querySelectorAll('[data-cr="close"]')].find((b) => b.offsetParent !== null)?.focus({ preventScroll: true });
}

/** 열려 있으면 닫는다. focus면 초점을 그 말풍선의 [크게 보기]로 돌린다. */
export function closeRead({ focus = true } = {}) {
  if (!box || box.hidden) return;
  const was = current;
  current = null;
  box.hidden = true;
  if (focus) was?.returnTo?.()?.focus({ preventScroll: true });
}

export const isReadOpen = () => Boolean(box && !box.hidden);

async function copy(m, btn) {
  try {
    await navigator.clipboard.writeText(String(m.content ?? ''));
    toast('답을 복사했어요');
  } catch {
    toast('복사하지 못했어요');
  }
  btn?.focus({ preventScroll: true });
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !current) return;
  const { m, actions } = current;
  const src = t.closest('[data-cr-src]');
  if (src) {
    const s = m.sources?.[Number(src.dataset.crSrc)];
    if (!s || !s.exists) return;
    closeRead({ focus: false });
    actions.onSource?.(s);
    return;
  }
  const act = t.closest('[data-cr]')?.dataset.cr;
  if (act === 'close') closeRead();
  else if (act === 'copy') copy(m, t.closest('button'));
  else if (act === 'save') {
    closeRead(); // 초점을 [크게 보기]에 둔 채 기록하기 창을 연다(창을 닫으면 거기로 돌아온다)
    actions.onSave?.(m);
  } else if (act === 'saved') {
    const s = savedStarSource(m);
    closeRead({ focus: false });
    if (s) actions.onSource?.(s);
  }
}

// Esc: 기록하기 창(60)보다 뒤, 챗봇 창 닫기(25) · 상세(30)보다 먼저
registerEscape(40, () => {
  if (!isReadOpen()) return false;
  closeRead();
  return true;
});
// 대화를 떠나거나 챗봇 창이 닫히면 같이 닫는다
store.on('chatClosed', () => closeRead({ focus: false }));
