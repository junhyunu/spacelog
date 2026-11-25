# 글칸 "메모" 하나로 합치기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 별의 글을 `body` 한 칸으로 합치고, 별 띄우기 창과 상세 패널 모두 이것을 "메모"라는 이름의 칸 하나로 보여 주며 상세 패널에서 바로 고칠 수 있게 한다.

**Architecture:** 서버는 DB 판 3 이전으로 옛 `memo`를 `body` 아래에 합치고, `PATCH /api/stars/:id`가 `body`를 받게 한다. 웹은 상세 패널의 자동 저장기를 `memo` 대신 `body`에 묶고 점선 본문 상자를 없앤다. 별 띄우기 창은 저장 방식은 그대로 두고 칸 이름 · 위치 · 크기만 바꾼다.

**Tech Stack:** Node 22 · Fastify · better-sqlite3 · vitest · 바닐라 JS(Vite)

**Spec:** `docs/superpowers/specs/2026-11-25-memo-unify-design.md`

## Global Constraints

- 글자 수 한도: 2만 자, 코드 포인트로 센다(서버 `MEMO_MAX`, 웹 `MEMO_MAX` = 20000 재사용).
- 숫자 표시: 1만 8천 자 이상이면 칸 아래에 `"18,200 / 20,000"`(`toLocaleString('ko-KR')`), 2만 자를 넘으면 빨간색(`.bad`).
- 칸 이름 "메모", placeholder **"이 별에 남길 말"**(두 곳 같게). 제목 빈칸 안내 **"비워 두면 메모 첫 줄을 써요"**.
- 메모칸 크기(두 곳 같게): 최소 3줄, 최대 `40vh`, 쓰는 만큼 자동으로 늘어남, `resize:none`, `maxlength`는 쓰지 않는다.
- `memo` 열은 지우지 않는다. `PATCH`의 `memo`도 계속 받는다.
- 이전할 때 합치는 모양: `body`가 비어 있지 않으면 `body + "\n\n" + memo`, 비어 있으면 `memo`. 그다음 `memo = ''`.
- **커밋은 사용자 승인 뒤에만.** 각 태스크 끝의 "커밋" 단계는 변경을 보여 주고 승인을 받은 뒤 실행한다(서브에이전트 포함, push 금지).
- 테스트 명령: `npx vitest run <경로>`(루트 `package.json`의 `test` = `vitest run`).

## Review Focus

1. **자동 저장 직후 상세 패널이 다시 그려져 쓰던 글이나 한글 조합이 끊기는 것.** `detailKey`가 지금은 `memo`만 빼는데, 이제 `body`가 바뀐다. 쓰는 중에 화면이 그대로 있어야 한다 → Task 3 테스트.
2. **본문을 다 지운 별.** 첨부가 없는 별에서 메모를 비우면 별이 빈 채로 남는다. 400이 나면 안 되고, "종류"는 "텍스트"로 바뀌며, 제목은 그대로여야 한다 → Task 2 테스트.
3. **이전을 두 번 돌리는 것, 또는 중간에 실패하는 것.** 다시 켜도 메모가 두 번 붙지 않아야 하고, 실패하면 DB가 그대로 남아야 한다 → Task 1 테스트.
4. **2만 자를 넘는 붙여넣기.** 별 띄우기 창은 몰래 자르지 않고 버튼을 막아야 한다. 상세 패널은 "메모가 너무 길어요"를 보여야 한다(서버 오류 코드가 `invalid_body`여도) → Task 3 테스트.
5. **늦게 도착한 다시 받기가 방금 저장한 글을 옛 글로 덮는 것.** ledger가 `body`를 고쳐 줘야 한다 → Task 3 테스트.

---

### Task 1: DB 판 3 — 옛 메모를 본문에 합치기

**Files:**
- Modify: `server/db.js` (`SCHEMA_VERSION`, `migrateTo3` 추가, `openDb`의 이전 블록)
- Test: `server/test/migration.test.js`

**Interfaces:**
- Produces: `SCHEMA_VERSION === 3`. 판 2→3 이전은 `bak-3` 백업을 먼저 만든다(기존 `backup()` 흐름 그대로).

- [ ] **Step 1: 실패하는 테스트 쓰기**

`makeV1`처럼 판 2 DB를 만드는 `makeV2(dataDir)`를 추가한다(`openDb`로 만든 뒤 `user_version = 2`로 되돌리고 별 넷을 넣는다). 테스트 세 개:

```js
test('v2 → v3: memo is appended under body, then cleared; search_text keeps both', () => {
  // 별: A body '본문' memo '메모' / B body null memo '메모만' / C body '본문만' memo '' / D body '  ' memo '메모'
  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(3);
  expect(row('A')).toMatchObject({ body: '본문\n\n메모', memo: '' });
  expect(row('B')).toMatchObject({ body: '메모만', memo: '' });
  expect(row('C')).toMatchObject({ body: '본문만', memo: '' });
  expect(row('D')).toMatchObject({ body: '메모', memo: '' });
  expect(row('A').search_text).toContain('본문\n\n메모');
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-3']);
});
test('v2 → v3: re-opening does not append the memo twice', ...);   // 두 번 openDb → A.body === '본문\n\n메모'
test('v2 → v3 that fails part-way leaves memo and body untouched', ...); // 기존 'fails part-way' 테스트와 같은 방법
```

기존 `expect(SCHEMA_VERSION).toBe(2)`는 3으로 고친다.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run server/test/migration.test.js`
Expected: FAIL (`user_version` 2, body 그대로)

- [ ] **Step 3: `migrateTo3(db)` 구현**

SQL 한 번으로 합친다: `UPDATE stars SET body = CASE WHEN body IS NULL OR trim(body) = '' THEN memo ELSE body || char(10) || char(10) || memo END, memo = '' WHERE memo <> ''`. 합친 별의 id로 `rebuildSearchText(db, ids)`를 부른다. `openDb`의 트랜잭션 안에서 `if (!fresh && version < 3) migrateTo3(db);`. 챗봇 색인은 따로 표시하지 않는다(켤 때 `reconcile`이 `content_hash`를 비교해 다시 넣는다). 판 설명 주석에 `3 = 메모를 본문으로 합침`을 더한다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run server/test/migration.test.js`
Expected: PASS

- [ ] **Step 5: 커밋 (승인 후)**

```bash
git add server/db.js server/test/migration.test.js
git commit -m "feat(server): schema v3 folds each star's memo into its body"
```

---

### Task 2: 서버 — 본문 고치기와 2만 자 한도

**Files:**
- Modify: `server/stars.js` (`checkBody` 추가, `parsePatch`, PATCH의 UPDATE 문)
- Modify: `server/files.js:66-71` (`parseStarFields`의 본문 검사)
- Test: `server/test/stars.test.js`, `server/test/create.test.js`

**Interfaces:**
- Produces: `export function checkBody(body: unknown): string | null` in `server/stars.js` — 문자열이 아니면 `ApiError(400,'invalid_body')`, 코드 포인트로 `MEMO_MAX` 초과면 같은 오류, 공백뿐이면 `null`, 그 밖에는 그대로.
- Produces: `PATCH /api/stars/:id`가 `{ body }`를 받는다. 응답은 지금처럼 `toStarJson`.

- [ ] **Step 1: 실패하는 테스트 쓰기** (`stars.test.js`)

```js
test('PATCH body: saves, rebuilds search_text, marks rag; blank → null; keeps title', async () => {
  const star = await post({ type: 'text', title: '제목', body: '처음', planet_id: planet.id });
  const res = await call('PATCH', `/api/stars/${star.id}`, { body: '고친 글' });
  expect(res.json()).toMatchObject({ body: '고친 글', title: '제목' });
  expect(dbRow(star.id).search_text).toContain('고친 글');
  const blank = await call('PATCH', `/api/stars/${star.id}`, { body: '  \n' });
  expect(blank.statusCode).toBe(200);
  expect(blank.json()).toMatchObject({ body: null, title: '제목' });
});
test('PATCH body: 20000 code points ok, 20001 or a non-string → 400 invalid_body', ...); // '😀'.repeat(MEMO_MAX) 통과
```

기존 `stars.test.js:353`의 "몰래 바꾸기"(`body`를 무시한다) 단언에서 `body`를 뺀다(`type` · `id` · `created_at`만 무시). `create.test.js`에 추가: `POST` 본문 `'가'.repeat(MEMO_MAX + 1)` → 400 `invalid_body`, `'😀'.repeat(MEMO_MAX)` → 201.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run server/test/stars.test.js server/test/create.test.js`
Expected: FAIL

- [ ] **Step 3: 구현**

`parsePatch`: `if (src.body !== undefined) out.body = checkBody(src.body);`(주석 "본문 · 첨부는 고치지 않는다" → "첨부는 고치지 않는다"). UPDATE 문에 `body = @body` 추가. `parseStarFields`: 바이트 한도(`BODY_MAX_BYTES`)는 전송 한도로 그대로 두고, 그 뒤 `out.body = checkBody(src.body)`. PATCH 쪽 `ragSync.markStars`는 이미 불리므로 그대로.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run server`
Expected: PASS (서버 전체, 기존 1MB 관련 테스트 포함)

- [ ] **Step 5: 커밋 (승인 후)**

```bash
git add server/stars.js server/files.js server/test/stars.test.js server/test/create.test.js
git commit -m "feat(server): stars' body can be edited (PATCH), capped at 20,000 characters"
```

---

### Task 3: 웹 로직 — 저장기 · ledger · 다시 그리기 열쇠 · 글자 수 표시

**Files:**
- Modify: `web/src/ui/detailLogic.js` (ledger, `failState`, `MEMO_STATUS`, `memoCount` 추가)
- Modify: `web/src/ui/planetLogic.js:149-152` (`detailKey`)
- Modify: `web/src/ui/saveLogic.js:126-135` (`canSubmit`)
- Test: `web/src/test/detailLogic.test.js`, `planetLogic.test.js`, `saveLogic.test.js`

**Interfaces:**
- Produces: `export function memoCount(text: string): { text: string, over: boolean } | null` in `detailLogic.js` — 코드 포인트 수 < 18000이면 `null`, 아니면 `{ text: '18,200 / 20,000', over: n > MEMO_MAX }`.
- Produces: ledger의 `record(id, text)` / `resolve` / `apply`가 `star.body`를 다룬다(이름은 그대로 둔다).
- Produces: `createMemoSaver`의 `failState`는 `invalid_memo`와 `invalid_body` 둘 다 `'toolong'`으로 본다.
- Produces: `detailKey(star, planets)`는 `body`와 `memo`를 빼고 대신 `hasBody: boolean`을 넣는다.
- Produces: `canSubmit`은 `text`가 `MEMO_MAX`(코드 포인트)를 넘으면 `false`.

- [ ] **Step 1: 실패하는 테스트 쓰기**

```js
// detailLogic
expect(memoCount('가'.repeat(17999))).toBeNull();
expect(memoCount('가'.repeat(18200))).toEqual({ text: '18,200 / 20,000', over: false });
expect(memoCount('😀'.repeat(20001))).toEqual({ text: '20,001 / 20,000', over: true });
// saver: save가 { code: 'invalid_body' }로 실패 → state 'toolong'
// ledger: record('1','새 글') 뒤 apply([{ id: '1', body: '옛 글' }]) → body === '새 글', true
// planetLogic
expect(detailKey({ id: 1, body: 'a' }, [])).toBe(detailKey({ id: 1, body: 'b' }, []));
expect(detailKey({ id: 1, body: 'a' }, [])).not.toBe(detailKey({ id: 1, body: null }, []));
// saveLogic
expect(canSubmit({ text: '가'.repeat(20001), planetId: '1' })).toBe(false);
expect(canSubmit({ text: '😀'.repeat(20000), planetId: '1' })).toBe(true);
```

기존 ledger 테스트가 `memo`를 쓰고 있으면 `body`로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run web/src/test`
Expected: FAIL

- [ ] **Step 3: 구현**

위 Interfaces대로 고친다. `memoCount`는 `longerThan`과 같은 코드 포인트 세기를 쓴다. `MEMO_STATUS.toolong` 문구는 그대로("메모가 너무 길어요").

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run web/src/test`
Expected: PASS

- [ ] **Step 5: 커밋 (승인 후)**

```bash
git add web/src/ui/detailLogic.js web/src/ui/planetLogic.js web/src/ui/saveLogic.js web/src/test
git commit -m "feat(web): memo saver and ledger follow the star's body; character count helper"
```

---

### Task 4: 상세 패널 — 점선 상자 없애고 메모칸이 본문을 고친다

**Files:**
- Modify: `web/src/ui/detail.js` (`topHtml` 252-255, `remember` · `patchMemo` 49-72, `renderDetail` 517-556, `showStatus` 489)
- Modify: `web/src/styles/detail.css:20`, `web/src/styles/app.css:181`

**Interfaces:**
- Consumes: Task 2의 `PATCH { body }`, Task 3의 `memoCount`, ledger(`body`), `failState`.

- [ ] **Step 1: 구현**
  - `topHtml`: 점선 본문 상자(`.detail`)를 그리지 않는다.
  - `patchMemo` → 보내는 것을 `{ body: text }`로 바꾼다(keepalive 쪽도). `remember`는 `inStore.body` · `current.star.body`를 고친다.
  - `renderDetail`: `saverFor(id, star.body ?? '')`. placeholder `"이 별에 남길 말"`. 메모칸 아래 `<small class="cnt" id="memoCnt" hidden>`. 입력할 때마다 `memoCount`로 숫자를 그리고(`over`면 `.bad`), 칸 높이를 내용에 맞춘다(`saveModal.js`의 `growText`와 같은 방식).
  - CSS: `#panel #memo`에 `min-height: calc(3 * 1.55em + 20px); max-height: 40vh; overflow-y: auto; resize: none`.
- [ ] **Step 2: 확인**

Run: `npx vitest run` → PASS. 그다음 `npm run dev`로 띄워 확인한다(포트 · 프로세스는 [[subagent-process-safety]] 규칙대로 자기 것만).
  - dots 별 열기 → 점선 상자가 없고, 메모칸에 옛 본문이 보인다.
  - 고치고 기다리면 "저장됨" → 목록에 갔다 다시 열어도 고친 글이 남아 있다.
  - 한글을 쓰는 중에 저장돼도 조합이 끊기지 않는다.
  - 2만 자를 넘게 붙여넣으면 빨간 숫자와 "메모가 너무 길어요"가 보인다.
- [ ] **Step 3: 커밋 (승인 후)**

```bash
git add web/src/ui/detail.js web/src/styles/detail.css web/src/styles/app.css
git commit -m "feat(web): star detail edits the body in one memo field; dashed body box removed"
```

---

### Task 5: 별 띄우기 창 — 메모칸을 아래로, 이름 · 크기 맞추기 · 문서

**Files:**
- Modify: `web/index.html:105-124`
- Modify: `web/src/ui/saveModal.js` (`TITLE_EMPTY`, `onTextInput`, `growText`, 숫자 표시)
- Modify: `web/src/styles/save.css:29,67`
- Modify: `DESIGN.md`, `docs/superpowers/specs/2026-11-12-spacelog-phase1-design.md:269` (글 칸 설명)

**Interfaces:**
- Consumes: Task 3의 `memoCount`, `canSubmit`.

- [ ] **Step 1: 구현**
  - 순서: 도구 줄(파일 첨부 · 링크 붙이기 · `svCount`) → 링크 줄 → 칩 → 제목 → **메모** → 행성. `svText`를 `<div class="fld"><label class="lbl" for="svText">메모</label><textarea id="svText" rows="3" placeholder="이 별에 남길 말">…<small class="cnt" id="svMemoCnt" hidden></small></div>`로 감싸 제목 아래로 옮긴다. `aria-label="글"`은 뺀다.
  - `TITLE_EMPTY` = `'비워 두면 메모 첫 줄을 써요'`, `index.html`의 placeholder도 같게.
  - `onTextInput`에서 `memoCount`로 숫자를 그린다. 창을 열면 지금처럼 `svText`에 초점을 둔다.
  - CSS: `#save #svText`의 `min-height: calc(3 * 1.6em + 20px); max-height: 40vh`. 끌어다 놓기 강조(`body.dragging-files #save #svText`)는 그대로.
  - 문서: 글 칸 설명을 "메모 칸(3줄~40vh, 2만 자, 첨부 아래 · 제목 다음)"으로 고친다.
- [ ] **Step 2: 확인**

Run: `npx vitest run` → PASS. 개발 서버에서 확인한다.
  - 창을 열면 메모칸에 커서가 있다.
  - 글만 써서 띄우면 제목이 첫 줄로 들어간다.
  - 파일을 끌어다 놓아도 칸 위치가 맞다.
  - 2만 1자를 붙여넣으면 "별 띄우기" 버튼이 막히고 숫자가 빨갛다.
  - 폭 460px 이하에서도 칸이 넘치지 않는다.
- [ ] **Step 3: 커밋 (승인 후)**

```bash
git add web/index.html web/src/ui/saveModal.js web/src/styles/save.css DESIGN.md docs/superpowers/specs/2026-11-12-spacelog-phase1-design.md
git commit -m "feat(web): save dialog's text field becomes the memo field under the title"
```
