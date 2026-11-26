// 우주 화면 위쪽 막대(별 찾기 · 기간 바 · 검색 줄, #period)의 숨김 판단만 모은 순수 함수(DOM 없음). 그리는 쪽은 topbar.js.

/**
 * 막대가 위로 숨는지(tucked), 숨은 막대를 손잡이로 내려 보고 있는지(peek).
 * - 우주 밖이면 늘 제자리.
 * - 행성 패널 · 챗봇 창 중 하나라도 열려 있으면 숨는다. 둘 다 닫히면 제자리로 오고 peek도 지운다.
 * - peek는 숨은 동안만 뜻이 있다. 검색 줄이 열려 있으면(searching) 숨은 동안에도 내려 둔다(숨은 칸에 초점이 남지 않게).
 */
export function topbarState({ inWorld = false, panelOpen = false, chatOpen = false, peek = false, searching = false } = {}) {
  const tucked = Boolean(inWorld) && (Boolean(panelOpen) || Boolean(chatOpen));
  return { tucked, peek: tucked && (Boolean(peek) || Boolean(searching)) };
}
