// 화면 위 가운데 노랑 카드. 한 줄, 2.2초. 끝난 일을 과거형으로 쓴다(DESIGN.md 13장).
let timer;

export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = String(message ?? '');
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}
