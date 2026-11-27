// 터치 화면에서 목록 줄을 꾹 누르면(0.5초) 그 줄의 ⋯ 메뉴를 연다. 마우스 · 펜은 지금처럼 ⋯ 버튼을 쓴다.
// 대상: 홈 별 목록(#hTable .srow) · 홈 행성 목록(#hDock .drow) · 우주 행성 목록(#dock .drow) · 행성 패널 별 목록(#panel .recw).
// 메뉴는 그 줄의 ⋯ 버튼을 누른 것과 똑같이 연다(각 화면의 메뉴 코드를 그대로 쓴다). 터치 화면에서 ⋯는 화면에서만
// 숨고(rowmenu.css · home.css) 스크린리더에는 남는다. 메뉴는 숨은 ⋯ 자리(줄 오른쪽 끝)에 붙어 뜬다.
// 손가락이 움직이면(스크롤) 취소한다. 꾹 누른 뒤 손을 뗄 때 오는 클릭(상세 열기 · 행성 고르기)은 먹는다.
const ROWS = '#hTable .srow[data-id], #hDock .drow, #dock .drow, #panel .recw';
const HOLD_MS = 500;
const SLOP = 10; // 이만큼(px) 움직이면 스크롤로 본다

let timer = 0;
let start = null; // { x, y, id }
let firedAt = 0; // 마지막으로 메뉴를 연 때. 그 뒤 잠깐 오는 클릭 · 길게 누르기 메뉴를 막는다

function cancel() {
  clearTimeout(timer);
  timer = 0;
  start = null;
}

function onDown(e) {
  if (e.pointerType !== 'touch' || !e.isPrimary || !(e.target instanceof Element)) return;
  // 입력칸(이름 바꾸기) · 고르기 체크칸에서는 하지 않는다
  if (e.target.closest('input, textarea, select, [data-tedit], .pickcb')) return;
  const row = e.target.closest(ROWS);
  const more = row?.querySelector('.more');
  if (!more || more.disabled) return;
  cancel();
  start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  timer = setTimeout(() => {
    timer = 0;
    start = null;
    if (!more.isConnected) return;
    navigator.vibrate?.(10); // 안드로이드: 짧은 떨림(iOS 웹은 지원하지 않는다)
    more.click(); // 이 클릭은 막지 않는다: firedAt은 그 뒤에 적는다
    firedAt = Date.now();
  }, HOLD_MS);
}

function onMove(e) {
  if (!start || e.pointerId !== start.id) return;
  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
}

const justFired = () => Date.now() - firedAt < 800;

export function initLongPress() {
  if (typeof document === 'undefined') return;
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, (e) => start && e.pointerId === start.id && cancel(), { passive: true });
  // 꾹 누른 손을 뗄 때 오는 클릭: 줄을 누른 것으로 치지 않는다(메뉴 안을 누른 것은 그대로)
  document.addEventListener(
    'click',
    (e) => {
      if (!justFired() || !(e.target instanceof Element) || e.target.closest('#rowMenu')) return;
      if (!e.target.closest(ROWS)) return;
      e.preventDefault();
      e.stopPropagation();
      firedAt = 0;
    },
    true,
  );
  // 안드로이드 · 데스크톱 크롬의 길게 누르기 메뉴(contextmenu)를 줄 위에서는 띄우지 않는다
  document.addEventListener('contextmenu', (e) => {
    if ((timer || justFired()) && e.target instanceof Element && e.target.closest(ROWS)) e.preventDefault();
  });
}
