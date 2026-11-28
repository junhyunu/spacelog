// 화면 안 확인 창(#confirm). 브라우저의 confirm · prompt는 쓰지 않는다(DESIGN.md 4장).
// 기본 포커스는 취소(노랑 확인의 한 줄 입력만 입력창), Esc · 바깥 클릭 = 취소, 한 줄 입력에서 Enter = 확정.
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);

let current = null; // { finish(value) }
let wired = false;

function focusables() {
  return [...$('confirm').querySelectorAll('input, select, button')].filter((el) => !el.disabled && !el.hidden);
}

function onKeydown(e) {
  if (!current) return;
  if (e.key === 'Escape') {
    // 다른 Esc 처리(저장 창, 패널 닫기 등)보다 먼저 받고 거기서 끝낸다
    e.preventDefault();
    e.stopPropagation();
    current.finish(null);
    return;
  }
  if (e.key === 'Tab') {
    // 포커스가 창 밖으로 나가지 않게 돈다
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!$('confirm').contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener('keydown', onKeydown, true);
  let downOnBackdrop = false;
  $('confirm').addEventListener('mousedown', (e) => {
    downOnBackdrop = e.target === e.currentTarget;
  });
  $('confirm').addEventListener('click', (e) => {
    if (e.target === e.currentTarget && downOnBackdrop && current) current.finish(null);
    downOnBackdrop = false;
  });
  // Enter = 확정은 한 줄 입력에서만. 선택 상자의 Enter는 브라우저에 맡긴다(고르다가 확정되지 않게).
  // 한글 조합을 끝내는 Enter(isComposing · keyCode 229)는 확정이 아니다
  $('cExtra').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'text') return;
    e.preventDefault();
    $('cYes').click();
  });
  $('cNo').addEventListener('click', () => current?.finish(null));
  $('cYes').addEventListener('click', () => current?.confirm());
}

/** 설명을 문장마다 줄을 바꿔 넣는다("…요." · "…다." 뒤. #cBody 는 white-space: pre-line). 창이 떠 있는 동안 설명을 바꿀 때도 이것을 쓴다. */
export function setAskDesc(desc) {
  $('cBody').textContent = String(desc ?? '').replace(/(?<=[요다]\.)\s+(?=\S)/g, '\n');
}

/** 확인 창이 떠 있는지. 비행 키 · 끌어다 놓기를 막을 때 본다. */
export function isAskOpen() {
  return current !== null;
}

/** 떠 있는 확인 창을 취소로 닫는다. */
export function closeAsk() {
  current?.finish(null);
}

/**
 * 확인 창을 띄운다.
 * @param {object} o
 * @param {string} o.title        무엇이 어떻게 되는지
 * @param {string} [o.desc]       되돌릴 수 없는 것과 남는 것
 * @param {string} [o.confirmLabel='확인']
 * @param {'pink'|'yellow'} [o.confirmKind='pink']
 * @param {{ value?: string, maxLength?: number, placeholder?: string }} [o.input]  한 줄 입력
 * @param {{ options: { value: string, label: string }[], value?: string, label?: string }} [o.select]  선택 상자
 * @returns {Promise<string | true | null>} 취소면 null, 입력 · 선택이 있으면 그 값(입력은 앞뒤 공백을 뗀 것), 없으면 true
 */
export function ask({ title, desc = '', confirmLabel = '확인', confirmKind = 'pink', input, select } = {}) {
  wire();
  if (current) current.finish(null); // 겹쳐 띄우면 앞의 것은 취소로 끝낸다

  const box = $('confirm');
  const prevFocus = document.activeElement;
  $('cTitle').textContent = title ?? '';
  setAskDesc(desc);

  const extra = $('cExtra');
  extra.textContent = '';
  let field = null;
  if (input) {
    field = document.createElement('input');
    field.type = 'text';
    field.value = input.value ?? '';
    if (input.maxLength) field.maxLength = input.maxLength;
    if (input.placeholder) field.placeholder = input.placeholder;
    field.setAttribute('aria-label', input.placeholder || title || '입력');
    field.autocomplete = 'off';
    extra.appendChild(field);
  } else if (select) {
    field = document.createElement('select');
    for (const opt of select.options ?? []) {
      const el = document.createElement('option');
      el.value = String(opt.value);
      el.textContent = opt.label; // textContent라 esc가 필요 없다
      field.appendChild(el);
    }
    if (select.value !== undefined && select.value !== null) field.value = String(select.value);
    field.setAttribute('aria-label', select.label || title || '선택');
    extra.appendChild(field);
  }

  const yes = $('cYes');
  yes.textContent = confirmLabel;
  yes.className = `btn ${confirmKind === 'yellow' ? 'yellow' : 'pink'}`;

  box.hidden = false;
  // 되돌릴 수 없는 일(핑크)은 입력이 있어도 취소에서 시작한다
  if (input && confirmKind === 'yellow') {
    field.focus();
    field.select();
  } else {
    $('cNo').focus();
  }

  return new Promise((resolve) => {
    const mine = {
      finish(value) {
        if (current !== mine) return;
        current = null;
        box.hidden = true;
        extra.textContent = '';
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
        resolve(value);
      },
      confirm() {
        if (!field) return mine.finish(true);
        const value = input ? field.value.trim() : field.value;
        if (!value) {
          toast(input ? '내용을 입력해 주세요' : '하나를 골라 주세요');
          field.focus();
          return undefined;
        }
        return mine.finish(value);
      },
    };
    current = mine;
  });
}
