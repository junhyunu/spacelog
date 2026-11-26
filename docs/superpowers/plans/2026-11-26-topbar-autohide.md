# 우주: 창이 열리면 위쪽 막대 숨기기 · 손잡이 · 검색 목록 맨 위 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 우주 화면에서 행성 패널이나 챗봇 창이 열려 있으면 위쪽 막대(별 찾기 버튼 · 기간 바 · 검색 칸, `#period`)를 위로 숨기고 그만큼 창을 늘린다. 숨은 동안 손잡이를 눌러 막대를 내릴 수 있다. 우주 패널의 고르기 모드에서는 "물어보기"를 숨기지 않는다. 검색 결과 목록은 늘 맨 위에 보인다.

**Architecture:** `body`에 상태 클래스 두 개(`top-tucked`: 창이 열려 막대가 숨은 상태, `top-peek`: 손잡이로 잠깐 내린 상태)를 두고 CSS가 막대 · 패널 · 챗봇 창의 위치와 높이를 바꾼다. 상태 계산은 순수 함수, 클래스 토글은 패널 · 챗봇 열림/닫힘 이벤트를 듣는 작은 모듈 하나가 맡는다.

**Tech Stack:** 바닐라 JS · CSS · vitest(node)

**Spec:** 2026-11-26 대화에서 사용자가 정한 것(아래 Global Constraints).

## Global Constraints

- 숨김 조건: 우주 화면에서 **행성 패널(#panel) 또는 챗봇 창(#chatPanel) 중 하나라도 열려 있으면** 막대를 숨긴다. 둘 다 닫히면 다시 내려온다. 별 찾기 버튼 · 기간 바 · 검색 칸은 **함께 숨고 함께 나온다**.
- 숨은 만큼 패널과 챗봇 창의 위쪽 끝을 올려 창을 늘린다(아래쪽은 그대로).
- 숨고 나타날 때 0.2초 위로 미끄러짐(`transform`), `prefers-reduced-motion`이면 바로.
- **손잡이:** 막대가 숨은 동안 화면 맨 위(막대가 있던 오른쪽 위)에 작은 탭을 둔다. 돋보기 · 시계 아이콘 + 아래 화살표로 "여기 검색 · 기간이 숨어 있다"를 보여 준다. `aria-label="검색과 기간 펼치기"`, `aria-expanded`. 누르면 막대가 내려온다(`top-peek`). 내려온 막대는 창 위에 겹쳐 보이며 창 크기는 바꾸지 않는다. 다시 접히는 때: 손잡이(이제 위 화살표, `aria-label="검색과 기간 접기"`)를 다시 누를 때, 기간을 고른 뒤, 막대 · 손잡이 · 검색 목록 밖을 누를 때, Esc. 검색 칸이 열려 있으면(검색 중이면) 밖을 눌러도 접지 않는다(검색을 닫으면 접는다).
- 패널 머리 문구: "이 기간 별 N개 · 전체 M개"의 "이 기간"을 실제 기간 이름(`#wPeriodName`과 같은 이름: "오늘" · "이번 주" · 직접 지정 범위)으로 바꾼다. 전체 기간일 때 문구는 지금 그대로. (막대가 숨어도 무엇으로 걸렀는지 보이게 — 누르는 기능은 없다.)
- 검색 결과 목록(#wResults, "최근 별" 포함)은 행성 패널 · 챗봇 창보다 **위(z-index)**에 보인다.
- 우주 행성 패널의 고르기 모드에서는 `body.picking`(물어보기 숨김)을 켜지 않는다. 홈 목록 고르기에서만 켠다. 채팅 창을 닫을 때의 초점 처리(고르는 중이면 아래 바로)는 홈 고르기에만 해당하게 둔다.
- 좁은 화면(≤760px)도 같은 규칙.
- `web/abtest/`는 건드리지 않는다. 구현자는 커밋하지 않는다(컨트롤러가 리뷰 뒤 커밋, 사용자 승인됨).

## Review Focus

1. 패널과 챗봇을 번갈아 열고 닫을 때(하나 닫아도 다른 하나가 열려 있으면 숨김 유지) 상태가 꼬이지 않는다.
2. 손잡이로 내린 상태에서 패널 · 챗봇이 모두 닫히면 `top-peek`도 정리되고 막대는 평소 자리로.
3. 우주를 떠날 때(홈으로 · 로그아웃) 클래스가 남지 않는다.
4. 검색 목록이 패널 · 챗봇 · 손잡이 위에 보이고, 검색 중 밖을 눌러도 막대가 접히지 않는다.
5. 키보드: 손잡이에 Tab으로 갈 수 있고, Esc 순서가 기존 escape.js 규칙과 맞는다.

---

### Task 1: 우주 패널 고르기에서 "물어보기" 숨기지 않기

**Files:**
- Modify: `web/src/ui/panel.js` (고르기 시작 · 끝에서 `setPickingUi` 호출 빼기)
- Modify: `web/src/ui/chatPanel.js` (닫을 때 초점 처리 — 홈 고르기에서만)
- Test: 해당 순수 함수가 있으면 그 테스트, 없으면 수동 확인 기록

- [ ] **Step 1:** 패널 고르기에서 `body.picking`을 켜지 않게 하고, 홈 고르기는 그대로 둔다. 채팅 창 닫기의 초점 대상이 우주 패널의 바를 고르지 않게 한다(홈 바 · 홈 전체 선택만).
- [ ] **Step 2:** `npx vitest run` 통과, 빌드 확인.

### Task 2: 위쪽 막대 자동 숨김 · 손잡이 · 패널 머리 기간 이름 · 검색 목록 맨 위

**Files:**
- Create: `web/src/ui/topbar.js` (상태 · 손잡이 · 이벤트)
- Create: `web/src/ui/topbarLogic.js` (순수: `topbarState({ inWorld, panelOpen, chatOpen, peek, searching }) → { tucked, peek }`)
- Modify: `web/index.html` (손잡이 버튼 하나), `web/src/main.js` (초기화), `web/src/ui/panel.js` (머리 문구), 필요하면 `web/src/ui/chatPanel.js`(열림 · 닫힘 이벤트를 store로 알리지 않는다면 알리게)
- Modify: `web/src/styles/app.css`, `web/src/styles/chat.css` (숨김 · 늘어남 · 손잡이 · `#wResults` z-index)
- Test: `web/src/test/topbarLogic.test.js`, 패널 머리 문구가 순수 함수에 있으면 그 테스트(`planetLogic`/`hudLogic` 쪽에 기간 이름 함수가 이미 있으면 재사용)

**Interfaces:**
- `topbarState`: `inWorld`가 false면 `{ tucked:false, peek:false }`. `panelOpen || chatOpen`이면 `tucked:true`, 아니면 `tucked:false, peek:false`. `peek`는 `tucked`일 때만 의미가 있다.
- `topbar.js`: `initTopbar()` — store 이벤트(패널 열림 'panelOpened' · 닫힘, 챗봇 열림 · 닫힘, 'enterWorld' · 'leaveWorld' · 'leavingWorld')를 듣고 `body`의 `top-tucked` · `top-peek`를 맞춘다. 손잡이 클릭 · 밖 클릭 · 기간 선택 · Esc(escape.js에 등록, 우선순위는 기존 순서에서 펼친 기간 바 근처) 처리.

- [ ] **Step 1: 실패하는 테스트** — topbarState 조합(우주 밖, 패널만, 챗봇만, 둘 다, 둘 다 닫힘 + peek true → peek false), 패널 머리 문구("오늘 별 3개 · 전체 6개", "이번 주 별 4개 · 전체 6개", 전체 기간이면 "전체 별 6개").
- [ ] **Step 2: 실패 확인** — `npx vitest run web/src/test/topbarLogic.test.js`
- [ ] **Step 3: 구현**
- [ ] **Step 4:** `npx vitest run` 전체 + vite build(임시 outDir)
- [ ] **Step 5: DESIGN.md** — 우주 화면(W-01) · 패널(W-02) · Esc 순서 · 체크리스트에 반영.
