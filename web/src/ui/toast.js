// 노랑 카드. 2.2초. 보통은 화면 위 가운데, 패널 · 서랍이 열려 있으면 비어 있는 자리에 뜬다(app.css #toast). 짧으면 한 줄, 길면 3줄까지 줄을 바꾼다(app.css #toast span). 끝난 일을 과거형으로 쓴다(DESIGN.md 13장).
let timer;
let wired = false;

// 좁은 화면의 서랍이 토스트 위에서 끝나도록 높이를 알린다(app.css). 너비가 바뀌면 줄 수가 달라지므로 다시 잰다.
function measure() {
  const el = document.getElementById('toast');
  if (!el || el.hidden) return;
  document.documentElement.style.setProperty('--toast-h', `${el.offsetHeight}px`);
}

export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  if (!wired) {
    wired = true;
    window.addEventListener('resize', measure);
  }
  const text = document.createElement('span');
  text.textContent = String(message ?? '');
  el.replaceChildren(text);
  el.hidden = false;
  measure();
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}
