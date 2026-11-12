// 노랑 카드. 2.2초. 보통은 화면 위 가운데, 패널 · 서랍이 열려 있으면 비어 있는 자리에 뜬다(app.css #toast). 짧으면 한 줄, 길면 3줄까지 줄을 바꾼다(app.css #toast span). 끝난 일을 과거형으로 쓴다(DESIGN.md 13장).
let timer;

export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  const text = document.createElement('span');
  text.textContent = String(message ?? '');
  el.replaceChildren(text);
  el.hidden = false;
  // 좁은 화면의 서랍이 토스트 위에서 끝나도록 높이를 알린다(app.css)
  document.documentElement.style.setProperty('--toast-h', `${el.offsetHeight}px`);
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}
