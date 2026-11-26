# 검색: 띄어쓰기 무시 · 낱말 나눠 찾기 · 한글 형태 맞추기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 홈 목록 검색과 우주 "별 찾기"가 띄어쓰기 차이("이번주" ↔ "이번 주"), 낱말 순서("RAG Flask"), 맥에서 온 한글(NFD)에 상관없이 찾고, 찾은 곳을 원래 글 위에 강조한다.

**Architecture:** 비교 규칙을 순수 모듈 하나(`web/src/ui/searchMatch.js`)에 모으고, `homeLogic.js`(matches · markHtml · snipHtml)와 `search.js`(거르기 · 메모 한 줄 · 강조)가 그것만 쓴다.

**Tech Stack:** 바닐라 JS · vitest(node)

**Spec:** 2026-11-26 대화에서 사용자가 정한 것(아래 Global Constraints가 전부).

## Global Constraints

- 비교 전 정규화: `String.prototype.normalize('NFC')` 후 `toLowerCase()`.
- 검색어 낱말: 공백(`\s+`)으로 나눈다. **1글자 낱말은 앞 낱말에 붙인다**(맨 앞이면 다음 낱말에 붙인다). 예: "이번 주" → ["이번주"], "주 계획" → ["주계획"], "Flask RAG" → ["flask", "rag"], 검색어가 1글자 하나뿐이면 그 1글자 낱말 하나.
- 낱말 비교는 **띄어쓰기를 무시**한다: 낱말과 글 양쪽에서 공백을 뺀 문자열로 포함 여부를 본다.
- 별이 맞는 조건: **모든 낱말**이 제목 · 본문(body) · 옛 memo 중 어디엔가 있다(낱말마다 다른 칸이어도 된다). 검색어가 비면 모두 맞다.
- 강조: 각 낱말이 나온 모든 곳을 원래 글의 위치로 되돌려 `<mark>`로 감싼다. 낱말 사이의 공백도 그 구간 안이면 함께 감싼다("이번주" 검색 → "이번 주" 전체). 겹치거나 맞닿은 구간은 하나로 합친다. 나머지는 `esc()`.
- 홈과 우주 별 찾기가 같은 함수를 쓴다(규칙이 두 곳에서 따로 놀지 않게).
- `web/abtest/`는 건드리지 않는다. 커밋은 컨트롤러가 사용자 승인 하에 한다(구현자는 커밋하지 않는다).

## Review Focus

1. 강조 위치가 원래 글과 어긋나는 것(공백이 여러 개 · 줄바꿈 · 영문 대소문자 · NFD 원문) → 위치 매핑 테스트.
2. 1글자 낱말 붙이기의 가장자리(맨 앞 1글자, 1글자만 여러 개 "a b c", 앞뒤 공백).
3. 낱말이 서로 다른 칸에 있을 때 맞음 + 강조는 각 칸에서 그 칸에 있는 낱말만.
4. 우주 별 찾기의 메모 한 줄(snip)이 찾은 낱말 근처를 보여 주는지.
5. 기존 홈 · 검색 테스트가 바뀐 규칙에서도 의미가 맞는지(기대값만 고치고 동작을 억지로 맞추지 않는다).

---

### Task 1: 공통 검색 규칙과 두 화면 적용

**Files:**
- Create: `web/src/ui/searchMatch.js`
- Modify: `web/src/ui/homeLogic.js` (`matches`, `markHtml`, `snipHtml`이 searchMatch를 쓰게)
- Modify: `web/src/ui/search.js` (거르기 `:129` 근처, `memoSnip`, 강조 — 지금 쓰는 `norm`/`includes`를 searchMatch로)
- Test: `web/src/test/searchMatch.test.js`(새 파일), 기존 `web/src/test/homeLogic.test.js`

**Interfaces (searchMatch.js):**
- `export function normText(s): string` — NFC + 소문자.
- `export function queryTerms(q): string[]` — 위 규칙대로 나눈 낱말(정규화 · 공백 없음). 빈 검색어면 `[]`.
- `export function matchesText(texts: string[], terms: string[]): boolean` — 모든 낱말이 texts 중 어딘가에 있으면 true(띄어쓰기 무시). terms가 비면 true.
- `export function markRanges(text: string, terms: string[]): Array<[start, end]>` — 정규화한 글 기준 강조 구간(끝 제외), 정렬 · 합침.
- `export function markHtml(text, q): string` — 강조 HTML(정규화한 글을 보여 준다). homeLogic의 markHtml은 이것을 그대로 쓰거나 다시 내보낸다.
- `export function snipAround(text, q, before = 12): string|null` — 줄바꿈 · 여러 칸을 한 칸으로 만든 글에서 첫 낱말이 처음 나온 곳 앞 `before`자부터(잘렸으면 앞에 "…") 강조 HTML. 못 찾으면 null. homeLogic `snipHtml`과 search.js 메모 한 줄이 이것을 쓴다.

- [ ] **Step 1: 실패하는 테스트** (`searchMatch.test.js`)

```js
expect(queryTerms('이번 주')).toEqual(['이번주']);
expect(queryTerms('주 계획')).toEqual(['주계획']);
expect(queryTerms('  Flask   RAG ')).toEqual(['flask', 'rag']);
expect(queryTerms('주')).toEqual(['주']);
expect(queryTerms('a b c')).toEqual(['abc']);
expect(queryTerms('')).toEqual([]);
expect(matchesText(['이번 주에는 Flask 웹'], queryTerms('이번주'))).toBe(true);
expect(matchesText(['이번주 회의'], queryTerms('이번 주'))).toBe(true);
expect(matchesText(['Flask 웹 기능과 RAG'], queryTerms('RAG Flask'))).toBe(true);
expect(matchesText(['제목 Flask', '본문 RAG'], queryTerms('flask rag'))).toBe(true); // 다른 칸
expect(matchesText(['Flask 웹'], queryTerms('Flask xyz'))).toBe(false);
expect(matchesText(['이번 주'.normalize('NFD')], queryTerms('이번주'))).toBe(true);
expect(markHtml('이번 주에는', '이번주')).toBe('<mark>이번 주</mark>에는');
expect(markHtml('Flask 와 RAG', 'rag flask')).toBe('<mark>Flask</mark> 와 <mark>RAG</mark>');
expect(markHtml('a<b> 이번  주', '이번주')).toBe('a&lt;b&gt; <mark>이번  주</mark>');
expect(snipAround('앞'.repeat(30) + ' 이번 주 끝', '이번주')).toMatch(/^…/);
```

- [ ] **Step 2: 실패 확인** — `npx vitest run web/src/test/searchMatch.test.js`
- [ ] **Step 3: 구현** — searchMatch.js를 만들고 homeLogic · search.js가 쓰게 바꾼다. 강조 위치 계산: 정규화한 글에서 공백이 아닌 글자만 모은 문자열과 "그 글자의 원래 위치" 배열을 만들고, 낱말을 그 문자열에서 찾은 뒤 시작 글자 위치 ~ 끝 글자 위치+1을 원래 구간으로 쓴다.
- [ ] **Step 4: 통과 확인** — `npx vitest run` 전체. 기존 테스트가 새 규칙 때문에 깨지면 기대값을 새 규칙에 맞게 고치고, 무엇을 왜 고쳤는지 보고한다.
- [ ] **Step 5: 빌드 확인** — `npx vite build --outDir <scratch>` 
- [ ] **Step 6: 커밋(컨트롤러, 승인됨)** — `feat(web): search ignores spacing, matches words in any order, normalizes Hangul`
