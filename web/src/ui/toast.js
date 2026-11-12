// 화면 위 가운데 노랑 카드. 2.2초. 짧으면 한 줄, 길면 3줄까지 줄을 바꾼다(app.css #toast span). 끝난 일을 과거형으로 쓴다(DESIGN.md 13장).
let timer;

export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  const text = document.createElement('span');
  text.textContent = String(message ?? '');
  el.replaceChildren(text);
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}
