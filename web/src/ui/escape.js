// Esc 한 곳에서 받기. 우선순위가 높은 것부터 부르고, 처음 true를 돌려준 처리가 키를 가져간다.
//
// 최종 순서(DESIGN.md 9-4 + 스펙):
//   확인 창            confirm.js가 document 캡처 단계에서 직접 받고 전파를 끊는다 → 여기까지 오지 않는다
//   행성 꾸미기 창 70  planetForm.js · planetDelete.js(행성 삭제 창도 같은 자리)
//   저장 창        60  saveModal.js(Task 11)
//   전환 건너뛰기      transition.js가 window에서 직접 받는다. 전환 중에는 50 아래 처리를 부르지 않는다
//   왼쪽 서랍 닫기 35  hud.js(760px 이하에서 펼친 왼쪽 패널만. 아래 시트 위에 덮이는 맨 위 층이라 상세보다 먼저)
//   상세에서 목록  30  panel.js
//   패널 닫기      20  panel.js(메뉴가 열려 있으면 메뉴부터 접는다)
//
// 이 모듈은 다른 모듈을 불러오지 않는다(테스트는 node 환경). 확인 창 · 전환 여부는 main.js가
// setEscapeGuards()로 넣어 준다.

const TRANSITION_LINE = 50; // 전환 건너뛰기의 자리. 이보다 낮은 처리는 전환 중에 쉬게 한다

export function createEscapeStack() {
  const items = []; // { priority, handler }, 높은 순
  let guards = {};

  /** Esc 처리를 더한다. handler()가 true를 돌려주면 그 키는 거기서 끝난다. 돌려주는 함수를 부르면 뺀다. */
  function register(priority, handler) {
    if (typeof handler !== 'function') return () => {};
    const item = { priority: Number(priority) || 0, handler };
    const at = items.findIndex((it) => it.priority < item.priority);
    if (at < 0) items.push(item);
    else items.splice(at, 0, item);
    return () => {
      const i = items.indexOf(item);
      if (i >= 0) items.splice(i, 1);
    };
  }

  /** { isAskOpen, isTransitioning }: 확인 창이 떠 있으면 아무것도 하지 않고, 전환 중이면 창만 닫는다. */
  function setGuards(next = {}) {
    guards = { ...guards, ...next };
  }

  /** Esc 한 번을 처리한다. 누군가 가져갔으면 true. */
  function run() {
    if (guards.isAskOpen?.()) return false;
    const transitioning = Boolean(guards.isTransitioning?.());
    for (const item of [...items]) {
      if (transitioning && item.priority < TRANSITION_LINE) break;
      try {
        if (item.handler() === true) return true;
      } catch (err) {
        console.error('[escape] Esc 처리 중 오류', err);
      }
    }
    return false;
  }

  return { register, setGuards, run };
}

const stack = createEscapeStack();

export const registerEscape = stack.register;
export const setEscapeGuards = stack.setGuards;

if (typeof document !== 'undefined') {
  // document의 버블 단계: 확인 창(document 캡처, 전파 끊음)이 가져간 Esc는 오지 않고,
  // 전환 건너뛰기(window 버블)보다는 먼저 온다. 창을 닫았으면 전파를 끊어 건너뛰기가 함께 일어나지 않게 한다.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (stack.run()) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}
