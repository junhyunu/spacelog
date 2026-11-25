// 노랑 카드. 2.2초(안내는 opts로 더 길게). 홈 · 좁은 화면은 위 가운데, 넓은 화면의 우주 안은 아래 가운데(기록하기 줄)에 뜬다(app.css #toast). 짧으면 한 줄, 길면 3줄까지 줄을 바꾼다(app.css #toast span). 끝난 일을 과거형으로 쓴다(DESIGN.md 13장).
let timer;
let wired = false;

// 좁은 화면의 서랍이 토스트 위에서 끝나도록 높이를 알린다(app.css). 너비가 바뀌면 줄 수가 달라지므로 다시 잰다.
function measure() {
  const el = document.getElementById('toast');
  if (!el || el.hidden) return;
  document.documentElement.style.setProperty('--toast-h', `${el.offsetHeight}px`);
}

/**
 * opts.duration: 보여 주는 시간(ms, 기본 2200).
 * opts.notice: 우주에 들어온 직후의 안내(기간을 넓혔다 등). 다른 토스트 자리 대신 눈높이(화면 위쪽 1/3 가운데)에 조금 크게 뜬다(app.css #toast.notice).
 */
export function toast(message, { duration = 2200, notice = false } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  if (!wired) {
    wired = true;
    window.addEventListener('resize', measure);
  }
  const text = document.createElement('span');
  text.textContent = String(message ?? '');
  el.replaceChildren(text);
  el.classList.toggle('notice', Boolean(notice));
  el.hidden = false;
  measure();
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.hidden = true;
  }, duration);
}
