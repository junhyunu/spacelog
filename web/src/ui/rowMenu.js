// 목록 행의 ⋯ 메뉴(왼쪽 패널 행성 목록 · 행성 패널 별 목록이 함께 쓴다).
// 메뉴는 하나(#rowMenu)뿐이고 body에 붙어 화면 위에 뜬다(패널의 overflow에 잘리지 않게).
// 누른 ⋯ 버튼 바로 아래, 오른쪽 끝을 버튼 오른쪽 끝에 맞춘다. 자리가 없으면 버튼 위로 뜬다.
// 바깥을 누르거나 · Esc · 화면 크기가 바뀌거나 · 데이터가 다시 그려지면 닫힌다. 닫히면 초점은 ⋯ 버튼으로.
import { store } from '../store.js';
import { esc } from '../util.js';
import { registerEscape } from './escape.js';

let menu = null; // #rowMenu
let anchor = null; // 지금 메뉴를 연 ⋯ 버튼
let actions = new Map(); // 항목 키 → 할 일

function ensure() {
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'rowMenu';
  menu.className = 'card';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-k]') : null;
    if (!b) return;
    const run = actions.get(b.dataset.k);
    closeRowMenu({ focus: true }); // 창을 열기 전에 초점을 ⋯ 버튼에 둔다: 창이 닫히면 거기로 돌아온다
    run?.();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Tab') {
      closeRowMenu(); // Tab은 메뉴를 닫고 원래 순서대로 나간다
      return;
    }
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  });
  addEventListener('pointerdown', (e) => {
    if (menu.hidden || !(e.target instanceof Node)) return;
    if (menu.contains(e.target) || anchor?.contains(e.target)) return;
    closeRowMenu();
  });
  addEventListener('resize', () => closeRowMenu());
  store.on('data', () => closeRowMenu()); // 목록이 다시 그려지면 ⋯ 버튼이 바뀐다
  return menu;
}

function place() {
  const b = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(Math.max(8, b.right - w), innerWidth - w - 8);
  const below = b.bottom + 6;
  const top = below + h > innerHeight - 8 ? Math.max(8, b.top - h - 6) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/** 메뉴가 떠 있는지. */
export function isRowMenuOpen() {
  return Boolean(menu && !menu.hidden);
}

/** 메뉴를 닫는다. focus면 ⋯ 버튼으로 초점을 돌린다(초점이 메뉴 안에 있었어도 돌린다). */
export function closeRowMenu({ focus = false } = {}) {
  if (!menu || menu.hidden) return;
  const inside = menu.contains(document.activeElement);
  menu.hidden = true;
  anchor?.setAttribute('aria-expanded', 'false');
  if ((focus || inside) && anchor?.isConnected) anchor.focus({ preventScroll: true });
  anchor = null;
}

/**
 * ⋯ 버튼 아래에 메뉴를 연다. 같은 버튼으로 다시 부르면 닫는다.
 * @param {HTMLElement} button  누른 ⋯ 버튼
 * @param {string} label        메뉴 이름(화면 읽기 프로그램용)
 * @param {{ key: string, label: string, danger?: boolean, disabled?: boolean, run: () => void }[]} items
 */
export function openRowMenu(button, label, items) {
  ensure();
  if (anchor === button && !menu.hidden) {
    closeRowMenu({ focus: true });
    return;
  }
  closeRowMenu();
  anchor = button;
  actions = new Map(items.map((it) => [it.key, it.run]));
  menu.setAttribute('aria-label', label);
  menu.innerHTML = items
    .map(
      (it) =>
        `<button type="button" role="menuitem" data-k="${esc(it.key)}"${it.danger ? ' class="danger"' : ''}${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`,
    )
    .join('');
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  place();
  menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
}

// Esc: 다른 것(왼쪽 서랍 35 · 사람 아이콘 메뉴 36)보다 먼저 이 메뉴부터 닫는다
registerEscape(38, () => {
  if (!isRowMenuOpen()) return false;
  closeRowMenu({ focus: true });
  return true;
});
