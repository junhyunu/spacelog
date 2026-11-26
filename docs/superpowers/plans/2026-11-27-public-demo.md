# 체험용 공개 데모(서버 없는 빌드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 외부 사용자가 링크 하나로 spaceLog를 직접 만져 볼 수 있게, 실제 앱 화면을 그대로 쓰되 서버 대신 브라우저 안 가짜 서버로 도는 체험판을 만들어 Vercel에 올린다.

**Architecture:** 리서치용 빌드(`vite.abtest.config.js` + `web/abtest/`)와 같은 방식: Vite 플러그인이 `web/src/api.js`를 `web/demo/mockApi.js`로 바꿔 끼운다. 가짜 서버는 상태를 한 객체로 들고(저장소 어댑터: 브라우저는 localStorage + IndexedDB, 테스트는 메모리), 실제 서버와 같은 모양의 값을 돌려준다. 더미 데이터는 로컬 데모(`scripts/demo.mjs`)와 한 파일을 같이 쓴다.

**Tech Stack:** 바닐라 JS · Vite · vitest(node) · Vercel(정적)

**Spec:** 2026-11-27 대화에서 사용자가 정한 것(아래 Global Constraints).

## Global Constraints

- **실제와 다르게 흉내 내지 않는다.** 체험판에서 못 하는 것은 버튼을 실제 앱과 똑같이 두고, 누르면 안내만 띄운다(다른 동작 금지).
  - 원본 열기 · 폴더에서 보기: 토스트 `체험판에서는 쓸 수 없어요. 실제 앱에서는 내 컴퓨터에 보관된 원본 파일을 열어요`
  - 링크 제목: 미리 넣은 링크는 제목이 있다. 방문자가 새로 넣은 링크는 제목을 가져오지 않는다(주소가 제목 — 실제 앱에서 못 가져왔을 때와 같은 모습). 저장할 때 토스트 `체험판에서는 링크 제목을 가져오지 않아요`(링크가 있을 때만).
- 그 밖의 기능(행성 만들기 · 꾸미기 · 지우기 · 합치기, 미분류 잠금 403 locked, 별 저장 · 고치기 · 지우기 · 옮기기, 여러 개 옮기기 · 지우기(500개 제한 포함), 그림 · 파일 첨부와 축소본, 자주 찾음, 기간 · 요약, 캐릭터 꾸미기)은 실제 서버와 **같은 응답 모양 · 같은 오류 코드**로 동작한다.
- 데이터는 **방문자 브라우저에만** 저장한다(다른 방문자와 섞이지 않는다). 네트워크로 아무것도 보내지 않는다.
- 더미 데이터: `scripts/demo.mjs`의 목록을 공용 모듈로 옮겨 두 데모가 같이 쓴다. 날짜는 **연 날 기준 상대 날짜**(오늘 · 이번 주가 늘 채워져 보이게).
- 챗봇: OpenAI를 쓰지 않는다. 추천 질문 칩과 대표 질문 몇 개에 데모 데이터에 맞춘 답 + 근거 별 카드를 실제처럼 토큰 단위로 흘려 보낸다(`streamAnswer` 콜백 그대로). 그 밖의 질문은 `체험판에서는 준비된 질문에만 답해요` + 추천 질문 안내. 미리 넣은 대화 기록 4개. 설정 화면(행성 제외 등)은 동작하되 실제 색인은 없다.
- 안내 띠(화면 위, 닫을 수 없음, 작게): `체험용 데모예요 · 입력한 내용은 이 브라우저에만 저장돼요` + 버튼 `처음 상태로`(확인 창 뒤 저장소를 비우고 새로 고침).
- 로그인 없이 바로 시작(데모 계정 자동).
- 실제 앱 코드(`web/src/`, `server/`)는 바꾸지 않는 것이 원칙. 꼭 필요하면 바꿀 내용을 보고에 적고 컨트롤러 승인을 받는다. `web/abtest/` · `vite.abtest.config.js`는 건드리지 않는다.
- 빌드: `npm run build:demo` → `dist-demo/`(여러 파일, 해시 이름; 한 파일로 묶지 않는다). `.gitignore`에 `dist-demo` 추가. Vercel 설정 파일(`vercel.json`: buildCommand · outputDirectory)을 둔다.
- 구현자는 커밋하지 않는다.

## Review Focus

1. 가짜 서버 응답 모양이 실제 서버와 어긋나 화면이 깨지는 것 → 실제 서버(`makeApp`)와 가짜 서버에 같은 요청을 보내 **키 집합 · 타입**을 비교하는 계약 테스트.
2. 저장소 한도: 큰 파일을 올리면 localStorage/IndexedDB가 넘친다 → 파일 크기 상한(체험판 50MB)과 넘칠 때의 안내, 저장 실패에도 화면이 죽지 않는다.
3. 상대 날짜: 자정을 넘기거나 다시 열었을 때 더미 데이터 날짜가 다시 밀리지 않는다(처음 연 날을 기준으로 고정, "처음 상태로" 때만 다시 계산).
4. 챗봇 스트림: 멈추기(stopAnswer), 중간에 창 닫기, 새로 고침 뒤 대화 기록이 남는다.
5. 안내 띠가 위쪽 막대 · 손잡이 · 왼쪽 패널과 겹치지 않는다(좁은 화면 포함).

---

### Task 1: 공용 더미 데이터 + 가짜 서버(행성 · 별 · 첨부 · 요약 · 캐릭터)

**Files:**
- Create: `web/demo/seed.js`(순수 데이터 + 상대 날짜 계산), `web/demo/store.js`(상태 · 저장소 어댑터), `web/demo/mockApi.js`(`api` · `ApiError`, 실제 `web/src/api.js`와 같은 이름 · 같은 인자)
- Modify: `scripts/demo.mjs`(목록을 `web/demo/seed.js`에서 가져오게)
- Test: `web/src/test/demoApi.test.js`(계약 테스트 + 동작 테스트)

- [ ] 실패하는 테스트 → 구현 → 통과. 계약 테스트는 `server/test/helpers.js`의 `makeApp`으로 띄운 실제 서버와 가짜 서버에 같은 순서의 요청(행성 목록 · 만들기 · 고치기 · 합치기 · 지우기 3가지, 미분류 잠금, 별 만들기 글/링크/파일, 고치기, 옮기기, 여러 개 옮기기/지우기, 요약, 캐릭터)을 보내 응답의 키 집합 · 값 타입 · 오류 status/code가 같은지 본다.
- [ ] `npm run demo -- --reset`이 여전히 같은 데이터를 심는지 확인(포트가 비어 있을 때만; 떠 있으면 건너뛰고 보고).

### Task 2: 가짜 챗봇 + 체험판 빌드 + 안내 띠 + 안내 문구

**Files:**
- Create: `web/demo/chat.js`(준비된 질문 · 답 · 근거, 스트림 흉내), `web/demo/main.js`(시작점: 자동 로그인, 안내 띠, 처음 상태로), `web/demo/demo.css`, `vite.demo.config.js`, `vercel.json`
- Modify: `web/demo/mockApi.js`(챗봇 메서드 연결), `package.json`(`build:demo`, `preview:demo`), `.gitignore`, `README.md`
- Test: `web/src/test/demoChat.test.js`

- [ ] 준비된 질문 매칭(추천 질문 칩 전부 + 대표 질문), 그 밖의 질문 안내, 스트림 순서(onSnapshot → onToken… → onSources → onDone), 멈추기, 대화 목록 · 읽지 않음 테스트.
- [ ] 원본 열기 · 폴더에서 보기 · 링크 제목 안내가 Global Constraints 문구대로 뜨는지(가짜 api가 실제 앱이 이미 처리하는 오류 코드로 실패를 돌려주고 토스트를 띄우는 방식 — 실제 앱 코드를 바꾸지 않는다).
- [ ] `npm run build:demo` 성공, `dist-demo/`를 정적 서버로 열어 동작 확인.

### Task 3: 화면 점검 → 배포

- [ ] 컨트롤러: 넓은 화면 · 휴대폰 폭에서 홈 · 우주 · 저장 · 고르기 · 챗봇 · 안내 띠 확인.
- [ ] 최종 리뷰 → 커밋(사용자 승인) → Vercel 배포(사용자 로그인 필요).
