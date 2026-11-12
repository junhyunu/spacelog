# spaceLog 1차 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메인 홈에서 블랙홀을 지나 우주로 들어가, 파일을 끌어다 놓거나 "기록하기"를 눌러 글 · 링크 · 파일을 행성별 별로 저장하고 둘러보는 로컬 웹 앱을 만든다.

**Architecture:** Node(Fastify) 로컬 서버 하나가 SQLite DB와 파일 보관함을 관리하고, 빌드된 화면까지 함께 제공한다. 화면은 Vite + 순수 JS 모듈이며, 시안(`spacelog-prototype.html`, 한 파일 · 전역 상태)의 3D · 스타일 · 마크업을 모듈로 나눠 옮기고 데이터만 API에서 받는다. 서버는 `buildApp(options)` 팩토리로 만들어 테스트에서 임시 폴더 · 가짜 의존성을 주입한다.

**Tech Stack:** Node.js 20+, Fastify 4, @fastify/multipart, @fastify/static, better-sqlite3, sharp, Vite 5, three@0.128.0, Vitest. 서체는 npm 패키지(`pretendard`, `@fontsource/black-han-sans`, `@fontsource/ibm-plex-mono`).

**Spec:** [docs/superpowers/specs/2026-11-12-spacelog-phase1-design.md](../specs/2026-11-12-spacelog-phase1-design.md). 화면 규격은 [DESIGN.md](../../../DESIGN.md), 옮길 코드는 [spacelog-prototype.html](../../../spacelog-prototype.html). 구현자는 세 파일을 모두 읽는다. 스펙과 DESIGN.md가 다르면 스펙이 기준이다.

## Global Constraints

- Node 22 이상(better-sqlite3 13 요구). 서버는 `127.0.0.1:4747`에만 연다(`PORT` 환경 변수로 변경 가능).
- 데이터 폴더: `SPACELOG_DATA`가 있으면 그 경로, 없으면 `os.homedir()/spaceLog`. 그 안에 `spacelog.db`, `vault/`, `thumbs/`.
- CDN을 쓰지 않는다. three.js · 서체 · 아이콘은 모두 번들에 들어간다.
- 탐사선(W-04) 관련은 아무것도 만들지 않는다: 탐사선 버튼 · 창, 별 목록 체크박스, "싣기" 버튼, 체크한 별의 핑크 표시, W-02 · W-03의 발. 시안의 `checked`, `cargo`, `#modal`, `loadLabel` 관련 코드는 옮기지 않는다.
- 시안의 "시안 상태" 선택 상자(`#demoSel`, `demo` 변수)와 예시 데이터(`PLANETS` 상수의 내용)는 옮기지 않는다.
- 색 · 서체 · 간격 · 쌓임 순서는 DESIGN.md 3장 토큰만 쓴다. 새 쌓임 순서: 놓기 막 42, 저장 창 43, 행성 꾸미기 창 44.
- `confirm()` · `prompt()` · `alert()`를 쓰지 않는다. 아이콘은 Lucide 인라인 SVG만. 이모지 금지.
- 문구는 DESIGN.md 13장을 따른다: 해요체, 느낌표 없음, "보내기 · 전송 · 발사" 금지, 토스트는 과거형.
- 사용자 입력(제목, 메모, 파일 이름, 링크 제목)을 HTML에 넣을 때는 반드시 `esc()`를 거친다.
- 누르는 영역 44px 이상, 포커스 링 표시(DESIGN.md 4장).
- 파일 하나 500MB 상한. 링크 제목 가져오기 제한 3초.
- 날짜: DB의 `created_at`은 UTC ISO 문자열. 기간은 화면이 사용자 현지 시각의 하루 경계를 ISO로 바꿔 `from`(포함) · `to`(미포함)로 보낸다. "이번 주"는 오늘 포함 최근 7일.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

테스트가 잡지 않으면 실제 사용에서 터지기 쉬운 다섯 가지. 각 항목의 테스트는 표시한 태스크에 들어 있다.

1. **이상한 파일 이름** — 한글 · 공백 · `..\` · 확장자 없음 · 이름 200자. 보관함 밖에 쓰이지 않고, 화면에는 원래 이름이 그대로 보여야 한다. (Task 4)
2. **보관함 사본이 디스크에서 사라짐** — 사용자가 탐색기로 지운 경우. 파일 요청 · 열기는 404, 화면은 "파일을 찾지 못했어요", 별 삭제는 그래도 된다. (Task 4, Task 10)
3. **링크가 응답하지 않거나 HTML이 아님** — 3초 뒤 주소를 제목으로 저장하고, 큰 응답을 끝까지 받지 않는다. (Task 3)
4. **화면을 연 뒤 서버가 꺼짐** — 요청이 실패하면 연결 실패 카드가 뜨고, 저장 창 · 메모에 쓰던 글은 지워지지 않는다. (Task 5, Task 11)
5. **폴더 · 0바이트 파일 · 같은 파일 2개를 한 번에 놓기** — 폴더는 빼고 토스트로 알리고, 0바이트는 저장하고, 같은 파일은 하나만 저장한다. (Task 4, Task 11)

---

## File Structure

```
package.json            루트 스크립트(dev · build · start · test), npm workspaces 없이 단일 패키지
vite.config.js          root: web, build.outDir: ../dist, dev proxy /api → 127.0.0.1:4747
server/
  index.js              buildApp() 호출 + listen
  app.js                buildApp(options): 플러그인 · 라우트 등록
  db.js                 openDb(dataDir): 스키마 생성, DB 핸들
  guard.js              Host · Origin 검사 훅
  planets.js            행성 라우트 + 자리(slot) 배정
  stars.js              별 라우트(글 · 링크 · 조회 · 수정 · 삭제 · 재발견)
  files.js              업로드 · 내려받기 · 축소본 · 열기 · 폴더에서 보기 라우트
  vault.js              보관함 파일 쓰기 · 지우기 · 해시 · 축소본
  linkTitle.js          fetchLinkTitle(url)
  opener.js             OS별 open · reveal
  test/*.test.js
web/
  index.html            시안의 <body> 마크업(탐사선 · 시안 상태 제외) + W-05 · 놓기 막
  src/main.js           시작점: 연결 확인 → 홈 그리기
  src/styles/           tokens.css, app.css(시안 <style> 이식), save.css(W-05 · 놓기 막)
  src/api.js            fetch 래퍼
  src/store.js          화면 상태 + 이벤트
  src/util.js           esc, ico, 날짜 · 기간, 행성 색, 파일 크기 표기
  src/three/scene.js    렌더러 · 배경 · 빛 · 툰 재질
  src/three/character.js
  src/three/planets.js  행성 · 별 · 이름표 만들기 · 지우기 · 날아오기
  src/three/slots.js    slotPosition(n), overviewDistance(positions)
  src/three/controls.js 키 · 카메라 모드 · 자동 비행 · 클릭 고르기 · 프레임 루프
  src/ui/toast.js, confirm.js, home.js, transition.js, hud.js, panel.js, planetForm.js, planetDelete.js, detail.js, saveModal.js, dropzone.js
  src/test/*.test.js
```

---

### Task 1: 프로젝트 뼈대와 DB

**Files:**
- Create: `package.json`, `.gitignore`, `vite.config.js`, `server/db.js`, `server/app.js`, `server/index.js`, `server/guard.js`, `server/test/helpers.js`, `server/test/app.test.js`

**Interfaces:**
- Produces:
  - `openDb(dataDir: string) → Database` (better-sqlite3 핸들. `dataDir`, `vault/`, `thumbs/`를 만들고 스키마를 적용)
  - `buildApp({ dataDir, allowedOrigins?: string[], fetchTitle?, opener?, maxFileBytes? }) → FastifyInstance`. `app.db`, `app.dataDir`로 접근.
  - `server/test/helpers.js`: `makeApp(overrides?) → { app, dataDir }` (임시 폴더 사용), `cleanup(dataDir)`
  - `GET /api/health → { ok: true }`

스키마:

```sql
CREATE TABLE IF NOT EXISTS planets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color_index INTEGER NOT NULL, deco TEXT NOT NULL, ring INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stars (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('text','image','link','file')),
  title TEXT NOT NULL, body TEXT, url TEXT, link_title TEXT,
  file_name TEXT, file_ext TEXT, file_size INTEGER, file_hash TEXT,
  vault_path TEXT, thumb_path TEXT, memo TEXT NOT NULL DEFAULT '',
  planet_id TEXT NOT NULL REFERENCES planets(id), created_at TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS stars_planet_created ON stars(planet_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS stars_hash ON stars(file_hash) WHERE file_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

`meta`의 `planet_seq`는 지금까지 만든 행성 수(색 · 장식 순번용, 삭제해도 줄지 않는다).

- [ ] **Step 1: `git init`, `package.json`, `.gitignore`(node_modules, dist, *.db) 만들고 의존성 설치**

스크립트: `"dev": "concurrently \"node --watch server/index.js\" \"vite\""`, `"build": "vite build"`, `"start": "node server/index.js"`, `"test": "vitest run"`. `"type": "module"`, `"engines": {"node": ">=20"}`.

- [ ] **Step 2: 실패하는 테스트 작성** (`server/test/app.test.js`)

```js
test('health', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4747' } });
  expect(res.statusCode).toBe(200); expect(res.json()).toEqual({ ok: true });
});
test('creates data folders and tables', () => {
  expect(fs.existsSync(path.join(dataDir, 'vault'))).toBe(true);
  expect(fs.existsSync(path.join(dataDir, 'thumbs'))).toBe(true);
  const names = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  expect(names).toEqual(expect.arrayContaining(['planets', 'stars', 'meta']));
});
test('rejects foreign Host', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: 'evil.example' } });
  expect(res.statusCode).toBe(403);
});
test('rejects foreign Origin', async () => {
  const res = await app.inject({ url: '/api/health', headers: { host: '127.0.0.1:4747', origin: 'http://evil.example' } });
  expect(res.statusCode).toBe(403);
});
test('allows configured dev origin', async () => {
  const { app: a2 } = await makeApp({ allowedOrigins: ['http://localhost:5173'] });
  const res = await a2.inject({ url: '/api/health', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 3: `npm test` → FAIL 확인**
- [ ] **Step 4: `db.js`, `guard.js`, `app.js`, `index.js` 구현**

`guard.js`: 허용 호스트는 `127.0.0.1:PORT`, `localhost:PORT`와 `allowedOrigins`의 host. `Origin` 헤더가 있으면 허용 목록에 있어야 한다. `index.js`는 실행 인자에 `--dev`가 있을 때만(`npm run dev`) `allowedOrigins: ['http://localhost:5173','http://127.0.0.1:5173']`를 넘기고, `dist/`가 있으면 `@fastify/static`으로 제공한다. `vite.config.js`의 proxy는 `changeOrigin: false`.

- [ ] **Step 5: `npm test` → PASS, `npm start` 뒤 `curl http://127.0.0.1:4747/api/health` → `{"ok":true}`**
- [ ] **Step 6: Commit** `chore: scaffold server, db schema, host guard`

---

### Task 2: 행성 API

**Files:**
- Create: `server/planets.js`, `server/test/planets.test.js`
- Modify: `server/app.js` (라우트 등록)

**Interfaces:**
- Consumes: `buildApp`, `app.db`, `makeApp`
- Produces (모든 행성 응답 모양): `{ id, name, description, color_index, deco, ring: boolean, slot, count_in_period, count_total }`
  - `GET /api/planets?from=ISO&to=ISO` → `Planet[]`, `slot` 오름차순. `from/to` 없으면 `count_in_period = count_total`
  - `GET /api/planets/next-look` → `{ color_index, deco, ring }` (다음에 만들 행성의 자동 배정 값. 꾸미기 창의 기본 선택용)
  - `POST /api/planets { name, description?, color_index?, deco?, ring? }` → 201 `Planet` (빠진 모습 값은 자동 배정)
  - `PATCH /api/planets/:id { name?, description?, color_index?, deco?, ring? }` → `Planet`
  - `POST /api/planets/:id/merge { into }` → `{ moved: number }` (별을 `into`로 옮기고 `:id` 삭제)
  - `DELETE /api/planets/:id` → 204. 별이 있으면 쿼리가 필요하다: `?stars=move&into=<id>`(별을 옮기고 삭제) 또는 `?stars=delete`(별도 함께 삭제). 없으면 409 `{ error: 'not_empty' }`. `into`가 없거나 자기 자신이면 400 `invalid_target`.
  - 내보내는 값: `DECOS = ['town','crystal','forest','rock','ice','volcano','mushroom','cactus','flower','cloud']`, `COLOR_COUNT = 16`
  - `app.decorate('removeStarFiles', fn)`: `?stars=delete`는 지울 별 목록을 `app.removeStarFiles(star)`로 넘긴다. Task 2에서는 아무 일도 하지 않는 기본 함수로 두고 Task 4가 보관함 정리로 바꾼다.
- 규칙: `name`은 앞뒤 공백을 뺀 1~20자, `description`은 0~20자, 벗어나면 400 `{ error: 'invalid_name' | 'invalid_description' }`. `color_index`는 1~16 정수, `deco`는 `DECOS` 중 하나, `ring`은 boolean, 아니면 400 `invalid_look`. 자동 배정: `n = planet_seq`일 때 `color_index = n % 16 + 1`, `deco = DECOS[n % 10]`, `ring = n % 3 === 1`. `slot` = 쓰이지 않는 가장 작은 0 이상의 정수. 없는 id는 404.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
test('first planet gets color 1, town, no ring, slot 0', ...) // color_index 1, deco 'town', ring false, slot 0, description ''
test('second planet has a ring', ...)                      // n=1 → ring true, deco 'crystal'
test('17th planet wraps to color 1 but deco is not town', ...) // color_index 1, deco DECOS[6] 'mushroom'
test('first 80 planets have unique colour+deco pairs', ...)
test('deleted slot is reused, look sequence is not', ...)  // 3개 생성 → 2번째 삭제 → 새 행성 slot 1, color_index 4
test('next-look matches what the next POST assigns', ...)
test('POST with explicit look uses it', ...)               // {color_index: 12, deco: 'cloud', ring: true}
test('invalid look → 400 invalid_look', ...)               // color_index 0, 17, deco 'x', ring 'yes'
test('PATCH changes look', ...)
test('delete with stars and stars=move moves them', ...)   // 대상 count_total 증가, 원본 404
test('delete with stars and stars=delete removes them and calls removeStarFiles for each', ...)
test('stars=move without into, or into itself → 400 invalid_target', ...)
test('rejects empty and 21-char names', ...)               // 400 invalid_name
test('trims name', ...)                                    // '  a  ' → 'a'
test('rename and describe', ...)                           // PATCH {name:'새 이름', description:'설명'} 반영
test('delete non-empty without stars param → 409', ...)
test('merge moves stars and removes source', ...)          // stars 2개 직접 INSERT → merge → moved 2, 원본 404, 대상 count_total 2
test('merge into itself or unknown → 400/404', ...)
test('counts respect period', ...)                         // created_at이 기간 안 1, 밖 1 → count_in_period 1, count_total 2
```

- [ ] **Step 2: `npx vitest run server/test/planets.test.js` → FAIL**
- [ ] **Step 3: `planets.js` 구현** (합치기 · 생성은 `db.transaction`)
- [ ] **Step 4: 같은 명령 → PASS**
- [ ] **Step 5: Commit** `feat: planet api`

---

### Task 3: 별 API (글 · 링크 · 조회 · 수정 · 삭제 · 재발견)

**Files:**
- Create: `server/stars.js`, `server/linkTitle.js`, `server/test/stars.test.js`, `server/test/linkTitle.test.js`
- Modify: `server/app.js`

**Interfaces:**
- Consumes: Task 2의 행성, `buildApp`의 `fetchTitle` 옵션(기본값 `fetchLinkTitle`)
- Produces (별 응답 모양): `{ id, type, title, body, url, link_title, file_name, file_ext, file_size, memo, planet_id, created_at, has_thumb }` (`vault_path` · `file_hash` · `search_text`는 내보내지 않는다)
  - `GET /api/stars?from&to&planet_id&limit` → `Star[]`, `created_at` 내림차순
  - `GET /api/stars/:id` → `Star`
  - `POST /api/stars { type: 'text'|'link', title?, body?, url?, planet_id, memo? }` → 201 `Star`
  - `PATCH /api/stars/:id { title?, memo?, planet_id? }` → `Star`
  - `DELETE /api/stars/:id` → 204 (Task 4가 보관함 정리를 덧붙인다)
  - `GET /api/rediscovery?today=YYYY-MM-DD&before=ISO` → `Star | null`
  - `GET /api/summary?from&to` → `{ in_period, total, planets }` (W-00 인사말 · W-01 로고 카드용)
  - 내보내는 함수: `insertStar(db, fields) → Star`, `buildSearchText(star) → string`, `toStarJson(row) → Star`
  - `fetchLinkTitle(url, { timeoutMs = 3000, maxBytes = 262144 } = {}) → Promise<string | null>`
- 규칙:
  - 글: `body`가 공백뿐이면 400 `empty_body`. `title`이 없으면 본문 첫 줄의 앞 40자.
  - 링크: `url`이 `http://` · `https://`로 시작하지 않으면 400 `invalid_url`. `link_title = await fetchTitle(url)`; null이면 `link_title = null`. `title`이 없으면 `link_title ?? url`.
  - 없는 `planet_id`는 400 `unknown_planet`.
  - `search_text` = 제목 · 본문 · 메모 · 링크 제목 · 주소 · 파일 이름을 줄바꿈으로 합친 것. 생성 · 수정 때마다 다시 만든다.
  - 재발견: `created_at < before`(화면이 "오늘 0시 − 7일"을 보낸다)인 별들을 `id` 순으로 놓고, `today` 문자열의 문자 코드 합을 개수로 나눈 나머지 번째를 고른다. 없으면 `null`.
  - `fetchLinkTitle`: `AbortController`로 제한 시간, `content-type`이 `text/html`이 아니면 null, 본문은 `maxBytes`까지만 읽고 끊는다. `<title>` 안의 글에서 HTML 엔티티(`&amp; &lt; &gt; &quot; &#39;`)를 풀고 공백을 정리하고 200자로 자른다. 어떤 오류든 null.

- [ ] **Step 1: 실패하는 테스트 작성**

`stars.test.js` (`makeApp({ fetchTitle: async () => '가짜 제목' })`):

```js
test('text star: title defaults to first line, max 40 chars', ...)
test('text star: blank body → 400 empty_body', ...)
test('link star: uses fetched title', ...)                       // title '가짜 제목', link_title '가짜 제목'
test('link star: falls back to url when fetch returns null', ...) // fetchTitle: async () => null → title === url
test('link star: ftp:// and javascript: → 400 invalid_url', ...)
test('unknown planet → 400', ...)
test('list filters by period and planet, newest first, honours limit', ...)
test('patch memo updates search_text', ...)   // db에서 search_text에 메모 글이 들어 있는지
test('patch planet_id moves star', ...)
test('delete removes star', ...)
test('response never leaks vault_path, file_hash, search_text', ...)
test('title with <script> is stored verbatim', ...)  // 서버는 그대로 저장, 이스케이프는 화면 책임
test('rediscovery: null when nothing older than `before`', ...)
test('rediscovery: same star for same `today`, deterministic', ...)
test('summary counts', ...)
```

`linkTitle.test.js` (테스트 안에서 `http.createServer`로 로컬 서버를 띄운다):

```js
test('reads <title> and decodes entities', ...)      // '<title> A &amp; B </title>' → 'A & B'
test('non-html content-type → null', ...)
test('server that never responds → null within timeout', ...)   // timeoutMs: 200, 걸린 시간 < 1000ms
test('stops reading after maxBytes', ...)             // 끝없이 쓰는 응답, maxBytes: 1024 → null을 1초 안에
test('connection refused → null', ...)
```

- [ ] **Step 2: `npx vitest run server/test/stars.test.js server/test/linkTitle.test.js` → FAIL**
- [ ] **Step 3: `linkTitle.js`, `stars.js` 구현**
- [ ] **Step 4: 같은 명령 → PASS**
- [ ] **Step 5: Commit** `feat: star api for text and links, rediscovery, summary`

---

### Task 4: 파일 업로드 · 보관함 · 열기

**Files:**
- Create: `server/vault.js`, `server/files.js`, `server/opener.js`, `server/test/files.test.js`
- Modify: `server/app.js`, `server/stars.js` (삭제 때 보관함 정리)

**Interfaces:**
- Consumes: `insertStar`, `toStarJson`, `buildApp`의 `opener` · `maxFileBytes`(기본 `500 * 1024 * 1024`) 옵션
- Produces:
  - `POST /api/stars/upload` (multipart). 필드: `planet_id`, `memo`, `titles`(JSON 문자열 배열, 파일 순서대로, 없어도 됨), 파일 필드 `files`(여러 개). **글 필드를 파일보다 먼저 보낸다.** → 200 `{ created: Star[], skipped: [{ file_name, reason: 'duplicate' | 'too_large' }] }`
  - `GET /api/stars/:id/file` (보관함 사본, `Content-Disposition: inline; filename*=UTF-8''…`), `GET /api/stars/:id/thumb` (webp)
  - `POST /api/stars/:id/open` → `{ action: 'opened' | 'revealed' }`, `POST /api/stars/:id/reveal` → `{ action: 'revealed' }`
  - `opener.js`: `defaultOpener = { open(absPath), reveal(absPath) }` — win32는 `cmd /c start "" <path>` · `explorer.exe /select,<path>`, darwin은 `open` · `open -R`, 그 밖은 `xdg-open`(reveal은 폴더를 연다). `child_process.spawn`에 인자 배열로 넘기고 셸 문자열을 만들지 않는다.
  - `vault.js`: `saveUpload(dataDir, stream, { id, ext, maxBytes }) → Promise<{ vaultPath, size, hash } | { tooLarge: true }>`, `makeThumb(dataDir, vaultPath, id) → Promise<string | null>`, `removeFiles(dataDir, star)`, `resolveVault(dataDir, relPath) → absPath` (결과가 `vault/` 밖이면 throw)
  - `isExecutableExt(ext) → boolean`: `exe bat cmd com msi lnk ps1 vbs js jse wsf scr pif cpl reg hta jar sh app command`
- 규칙:
  - 보관함 파일 이름은 `<별 id>.<ext>`. `ext`는 원래 이름의 마지막 `.` 뒤를 소문자로, `[a-z0-9]{1,10}`가 아니면 확장자 없이 `<별 id>`. 원래 이름은 `file_name`에 그대로 저장(경로 구분자가 있으면 마지막 조각만, 200자 초과는 자름).
  - `type`: 받은 MIME이 `image/`로 시작하면 `image`, 아니면 `file`. `file_ext`는 대문자 확장자(없으면 `''`).
  - `title`: `titles[i]`가 있으면 그것, 없으면 확장자를 뺀 파일 이름.
  - 스트림을 `vault/.tmp-<id>`에 쓰면서 SHA-256을 계산한다. 상한을 넘으면 임시 파일을 지우고 `too_large`. 해시가 이미 DB에 있거나 같은 요청 안에서 앞서 나왔으면 임시 파일을 지우고 `duplicate`.
  - 이미지면 `sharp(...).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp()` → `thumbs/<id>.webp`. 실패하면 축소본 없이 저장한다.
  - `open`: 글 별 400 `no_file`. 링크 별 400 `no_file`(화면이 새 탭으로 연다). 실행 파일 확장자면 `reveal`을 대신 부르고 `revealed`. 사본이 디스크에 없으면 404 `file_missing`.
  - 별 삭제: 사본과 축소본을 지운다. 파일이 이미 없어도 204.
  - `app.removeStarFiles`를 `removeFiles(dataDir, star)`로 바꿔, 행성을 `?stars=delete`로 지울 때도 사본 · 축소본이 지워지게 한다. 테스트 추가: `test('deleting a planet with stars=delete removes their vault copies and thumbs', ...)`.

- [ ] **Step 1: 실패하는 테스트 작성** (`form-data` 패키지나 직접 만든 multipart 본문으로 `app.inject`. `opener`는 호출을 기록하는 가짜)

```js
test('uploads two files → two stars sharing planet and memo', ...)
test('png becomes image star with thumb', ...)        // sharp로 만든 1x1 png, has_thumb true, GET thumb 200 image/webp
test('non-image becomes file star, ext uppercased', ...) // 'a.pdf' → type 'file', file_ext 'PDF', title 'a'
test('titles[] overrides file name', ...)
test('korean file name with spaces is preserved', ...) // '21일차 과제 안내.pdf' → file_name 그대로
test('path traversal name is reduced to last segment and stays in vault', ...) // '..\\..\\evil.txt' → file_name 'evil.txt', vault 폴더 밖에 새 파일 없음
test('no extension', ...)                             // 'README' → file_ext '', 저장됨
test('200+ char name is truncated', ...)
test('zero-byte file is saved', ...)                  // file_size 0
test('duplicate of existing star → skipped duplicate, no new vault file', ...)
test('same file twice in one request → one created, one skipped', ...)
test('over maxFileBytes → skipped too_large, temp file removed', ...) // makeApp({ maxFileBytes: 10 })
test('unknown planet → 400 and nothing written', ...)
test('GET file streams the copy with original name', ...)
test('open calls opener.open for pdf', ...)
test('open on .exe calls opener.reveal instead', ...)
test('open on text or link star → 400 no_file', ...)
test('vault copy deleted from disk → file/open/reveal 404 file_missing', ...)
test('delete star removes vault copy and thumb; still 204 when copy already gone', ...)
test('corrupt image still saves without thumb', ...)   // image/png MIME에 쓰레기 바이트 → created, has_thumb false
```

- [ ] **Step 2: `npx vitest run server/test/files.test.js` → FAIL**
- [ ] **Step 3: `vault.js`, `opener.js`, `files.js` 구현, `stars.js`의 삭제에 `removeFiles` 연결**

`@fastify/multipart`는 `limits.fileSize: maxFileBytes`로 등록하고 `req.parts()`를 순서대로 돌며, `part.file.truncated`를 스트림이 끝난 뒤 확인한다.

- [ ] **Step 4: `npm test` → 전체 PASS**
- [ ] **Step 5: Commit** `feat: file upload, vault, thumbnails, open and reveal`

---

### Task 5: 화면 뼈대 — 스타일 · 서체 · API 클라이언트 · 공통 UI

**Files:**
- Create: `web/index.html`, `web/src/main.js`, `web/src/styles/tokens.css`, `web/src/styles/app.css`, `web/src/api.js`, `web/src/store.js`, `web/src/util.js`, `web/src/ui/toast.js`, `web/src/ui/confirm.js`, `web/src/test/util.test.js`

**Interfaces:**
- Consumes: Task 1~4의 API
- Produces:
  - `api.js`: `api.health()`, `api.summary(range)`, `api.planets(range)`, `api.nextLook()`, `api.createPlanet({name, description, color_index, deco, ring})`, `api.patchPlanet(id, patch)`, `api.mergePlanet(id, into)`, `api.deletePlanet(id, { stars?: 'move'|'delete', into? })`, `api.stars({from, to, planet_id, limit})`, `api.star(id)`, `api.createStar(body)`, `api.uploadStars({ planet_id, memo, files: File[], titles: string[] }, onProgress(pct))`(XHR 사용), `api.patchStar(id, patch)`, `api.deleteStar(id)`, `api.rediscovery()`, `api.open(id)`, `api.reveal(id)`, `api.fileUrl(id)`, `api.thumbUrl(id)`. 실패 시 `ApiError { status, code }`를 던진다. 네트워크 실패는 `status 0, code 'offline'`이며 이때 `store.emit('offline')`.
  - `store.js`: `store.state = { inWorld, period: 'today'|'week'|'custom', range: {from, to}, planets: [], stars: [], summary, panelPlanetId, detailStarId, guestStarId, lastPlanetId }`, `store.on(event, fn)`, `store.emit(event, data)`, `store.reload() → Promise`(기간 기준 planets · stars · summary를 다시 받아 `'data'` 발행). `lastPlanetId`는 `localStorage('spacelog.lastPlanet')`에 보관.
  - `util.js`: `esc(s)`, `ico(name, size=18)`(시안 `IC`에 `plus`, `upload`, `type`, `link`, `file-text` 추가), `periodRange(period, custom, now=new Date()) → { from: ISO, to: ISO }`, `shortDate(iso) → '11.11'`, `daysAgo(iso, now) → number`, `fullDate(iso, now) → '2026-11-11 · 0일 전'`, `PLANET_COLORS[1..16] → { name, face, deep }`(1~8은 DESIGN.md 3-1 표, 9~16은 스펙 6-6 표. 1~8의 이름은 주황 · 하늘 · 연두 · 연보라 · 호박 · 분홍 · 청록 · 남보라), `DECO_NAMES = { town: '마을', crystal: '수정', forest: '숲', rock: '바위', ice: '얼음', volcano: '화산', mushroom: '버섯', cactus: '선인장', flower: '꽃', cloud: '구름' }`, `fileSize(bytes) → '1.2MB' | '크기 미확인'`, `firstLine(text, max=40)`
  - `toast(message)`, `ask({ title, desc, confirmLabel, confirmKind: 'pink'|'yellow', input?: { value, maxLength, placeholder } }) → Promise<string | true | null>` (취소면 null. 시안의 `#confirm` 동작을 옮긴다: 기본 포커스 취소, Esc · 바깥 클릭 = 취소, 입력창 Enter = 확정)

- [ ] **Step 1: 실패하는 테스트 작성** (`web/src/test/util.test.js`, 시간대에 흔들리지 않게 `now`를 주입)

```js
test('esc escapes & < > "', () => expect(esc('<b a="1">&')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;'));
test('periodRange today = local midnight to next midnight', ...)   // to - from === 24h, from <= now < to
test('periodRange week = 7 local days ending tomorrow midnight', ...) // to - from === 7*24h
test('periodRange custom is inclusive of the end date', ...)       // {from:'2026-11-01', to:'2026-11-03'} → 3일
test('daysAgo counts local calendar days', ...)                    // 어제 23:59 vs 오늘 00:01 → 1
test('fileSize', () => { expect(fileSize(1258291)).toBe('1.2MB'); expect(fileSize(null)).toBe('크기 미확인'); expect(fileSize(0)).toBe('0B'); });
test('firstLine trims and cuts at 40', ...)
test('PLANET_COLORS has 16 entries', () => {
  expect(PLANET_COLORS[1]).toMatchObject({ face: '#ff7a59', deep: '#b23a1c' });
  expect(PLANET_COLORS[16]).toMatchObject({ name: '코코아', face: '#c98a5a', deep: '#7a4520' });
  for (let i = 1; i <= 16; i++) expect(PLANET_COLORS[i].name).toBeTruthy(); });
test('every deep colour has contrast >= 4.8 on white and on #f4f2ff', ...)  // 테스트 안에서 WCAG 대비 계산
test('DECO_NAMES covers the ten decos', () => expect(Object.keys(DECO_NAMES)).toHaveLength(10));
```

- [ ] **Step 2: `npx vitest run web/src/test` → FAIL**
- [ ] **Step 3: `util.js` 구현 → PASS**
- [ ] **Step 4: 스타일과 마크업 옮기기**

시안 5~267행의 `<style>`을 `tokens.css`(`:root` 변수)와 `app.css`로 옮긴다. `@import`로 `pretendard/dist/web/variable/pretendardvariable.css`, `@fontsource/black-han-sans`, `@fontsource/ibm-plex-mono/400.css`를 불러온다. 시안 268~350행의 `<body>` 마크업을 `web/index.html`로 옮기되 `#modal`(탐사선), `#demo`(시안 상태), 탐사선 버튼 2개를 빼고, 그 자리에 `<button class="btn" id="hLog">` · `<button class="btn" id="wLog">`("기록하기", `plus` 아이콘)를 둔다.

- [ ] **Step 5: `api.js`, `store.js`, `toast.js`, `confirm.js`, `main.js` 구현**

`main.js`는 `api.health()`가 실패하면 W-00 연결 실패 카드("spaceLog 서버와 연결이 끊겼어요. 서버를 다시 켜고 새로고침해 주세요." + "새로고침")만 보인다. `store.on('offline')`도 같은 카드를 띄운다(W-01 안이면 W-01의 가운데 카드).

- [ ] **Step 6: 브라우저 확인** — `npm run dev` → `http://localhost:5173`. 서체 3종이 적용되고(개발자 도구 Network에 외부 도메인 요청 0건), 서버를 끄고 새로고침하면 연결 실패 카드가 뜬다.
- [ ] **Step 7: Commit** `feat: web shell, tokens, api client, toast and confirm`

---

### Task 6: 3D 우주 옮기기

**Files:**
- Create: `web/src/three/scene.js`, `character.js`, `planets.js`, `slots.js`, `controls.js`, `web/src/test/slots.test.js`

**Interfaces:**
- Consumes: `store`, `PLANET_COLORS`, `import * as THREE from 'three'`(0.128.0)
- Produces:
  - `slots.js`: `slotPosition(n: number) → [x, y, z]`, `overviewDistance(positions: [x,y,z][]) → number`
  - `scene.js`: `initScene(canvasParent) → { scene, camera, renderer }`, `toon(color, opts)`, `ol(mesh, scale)`, `part(...)`
  - `planets.js`: `syncUniverse({ planets, stars, guestStarId })`(DB 상태와 3D를 맞춘다: 없는 행성 · 별은 만들고, 사라진 것은 지우고, 이름 · 설명이 바뀌면 이름표를 다시 그리고, 목표 크기를 갱신), `flyStarIn(starId, fromWorldPos)`(시안 `flying` 곡선 1.5초), `planetMesh(id)`, `starMesh(id)`, `setSelectedStar(id | null)`(고른 별만 핑크)
  - `controls.js`: `startLoop()`, `enterOverview()`, `flyTo(planetId, starId?) → Promise`(도착 0.2초 뒤 resolve), `setInputBlocked(fn: () => boolean)`, 이벤트 `store.emit('land', planetId)`(E · 행성 클릭), `store.emit('pickStar', starId)`, `store.emit('near', planetId | null)`, `store.emit('leftPanelPlanet')`(표면 + 14 밖)
- 규칙:
  - `slotPosition`: `n` 0~3은 시안 예시 행성의 자리 `[0,0,-34], [36,7,-10], [-34,-5,-8], [-6,11,26]`, 4~9는 시안 `SLOTS` 6개. 10 이상은 고리: `k = floor((n-10)/8)`, `i = (n-10) % 8`, 반지름 `80 + 28k`, 각도 `i/8·2π + k·π/8`, 중심 `(0, 2, -6)`, `y = 2 + (i % 2 ? 8 : -8)`.
  - `overviewDistance`: 중심 `(0,2,-6)`에서 가장 먼 행성까지 거리 `R`에 대해 `max(62, R * 1.1)`. 조망 카메라의 `OV`와 휠 최대 거리(`max(80, OV + 18)`)에 쓴다.
  - 행성 기본 반지름은 4.2, 기간 안의 별 1개마다 +3.5%, 최대 반지름 6에서 멈춘다. 0.3초 보간은 시안 그대로.
  - 한 행성의 3D 별은 최근 50개만 그린다. 기간 안의 별이 2,000개를 넘으면 별을 하나도 그리지 않는다(`guestStarId`만 예외). 이름표 둘째 줄은 이 상태에서 "별 1,240개", 평소에는 `description`(비면 그리지 않는다).
  - 장식은 `DECO_BUILDERS[deco](ctx)` 표로 나눈다(`ctx = { spin, place, r, dark, light, rand }`). `town · crystal · forest · rock`은 시안 `buildPlanet`의 분기를 옮기고, `ice · volcano · mushroom · cactus · flower · cloud`는 스펙 6-6 표의 모양대로 같은 방식(`place(mesh, dir, height)`로 12~18개 흩뿌림, `ol()` 외곽선, `toon()` 재질)으로 새로 만든다. 고리는 `planet.ring`이 true일 때만.
  - `syncUniverse`는 행성의 `color_index` · `deco` · `ring`이 바뀌면 그 행성 그룹을 지우고 같은 자리에 다시 만든 뒤 별을 다시 붙인다.
  - 시안의 `checked` 기반 핑크는 없앤다. 핑크는 `setSelectedStar`로 고른 별(W-03에서 보는 별 · 재발견 별)뿐이다.
  - 그 밖의 수치(카메라, 속도, 충돌, 외곽선 배율, 배경)는 시안 390~570행과 DESIGN.md 8 · 9장 그대로.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
test('first four slots are the prototype sample positions', () => expect(slotPosition(0)).toEqual([0, 0, -34]));
test('slots 4-9 are the prototype SLOTS', () => expect(slotPosition(4)).toEqual([30, -10, 28]));
test('slot 10+ sits on a ring of radius 80 around (0,2,-6)', () => {
  const [x, , z] = slotPosition(10); expect(Math.hypot(x, z + 6)).toBeCloseTo(80, 5); });
test('second ring is radius 108', () => { const [x, , z] = slotPosition(18); expect(Math.hypot(x, z + 6)).toBeCloseTo(108, 5); });
test('no two of the first 40 slots are closer than 14', ...)
test('overviewDistance is 62 for the first ten, grows beyond', () => {
  expect(overviewDistance([...Array(10)].map((_, i) => slotPosition(i)))).toBe(62);
  expect(overviewDistance([slotPosition(10)])).toBeGreaterThan(62); });
test('overviewDistance of no planets is 62', () => expect(overviewDistance([])).toBe(62));
```

- [ ] **Step 2: `npx vitest run web/src/test/slots.test.js` → FAIL → `slots.js` 구현 → PASS**

"처음 10개는 62" 테스트가 실패하면(시안 자리 중 `R * 1.1 > 62`인 것이 있으면) 계수 1.1을 테스트가 통과하는 가장 큰 값으로 낮추고 그 값을 주석으로 남긴다.

- [ ] **Step 3: `scene.js`, `character.js`, `planets.js`, `controls.js`로 시안 코드를 옮긴다**
- [ ] **Step 4: 브라우저 확인** — 콘솔에서 임시로 행성 12개 · 별 몇 개를 API로 만든 뒤 우주에 들어가면: 조망에서 12개가 모두 화면 안에 보이고, 장식 10종이 서로 구별되며 모두 잉크 외곽선 · 3단 음영이고, WASD로 비행, 행성 근처에서 "E" 안내, 행성 클릭 시 `land` 이벤트가 콘솔에 찍힌다.
- [ ] **Step 5: Commit** `feat: port 3d universe with unbounded planet slots`

---

### Task 7: W-00 메인 홈과 블랙홀 전환

**Files:**
- Create: `web/src/ui/home.js`, `web/src/ui/transition.js`
- Modify: `web/src/main.js`

**Interfaces:**
- Consumes: `store`, `api`, `enterOverview`, `flyTo`, `startLoop`
- Produces: `renderHome()`, `enterWorld({ planetId?, starId? }) → Promise`(DESIGN.md 9-1의 5단계 + 조작 UI 200ms 페이드 인, 끝난 뒤 대상이 있으면 `flyTo`), `leaveWorld()`(9-2), `store.state.inWorld` 갱신
- 규칙: 시안의 `drawBH`, 흡입 · 잉크 막 코드를 그대로 옮긴다. 건너뛰기(클릭 · Esc)와 `prefers-reduced-motion` 분기를 유지한다. 홈의 데이터: 인사말 숫자 = 오늘 기간의 `summary.in_period`, 배지 = `summary.total` · `summary.planets`, 행성 목록 = `api.planets(오늘)`, 최근 별 = `api.stars({ limit: 5 })`, 재발견 = `api.rediscovery()`(null이면 카드 숨김).
- 상태 4가지(DESIGN.md W-00 표 + 스펙 6-1 문구): 정상 / 오늘 0개("오늘은 아직 별이 없어요") / 전체 0개(인사 "나만의 우주를 시작해 보세요", 빈 우주 카드 "아직 별이 없어요 / 파일을 끌어다 놓거나 기록하기를 눌러 첫 별을 띄워 보세요." + "기록하기" 버튼) / 연결 실패.

- [ ] **Step 1: `home.js`, `transition.js` 구현**
- [ ] **Step 2: 브라우저 확인**
  - 빈 DB: 전체 0개 상태가 보이고 "우주로 들어가기"는 동작한다.
  - 별이 있는 DB: 인사말 숫자가 맞고, 행성 목록에서 한 번 누르면 전환 뒤 그 행성으로 날아간다.
  - 전환 중 Esc로 건너뛴다. OS의 모션 줄이기를 켜면 페이드로 바뀐다.
  - "← 홈"으로 돌아오면 숫자가 최신이다.
- [ ] **Step 3: Commit** `feat: home screen and black hole transition`

---

### Task 8: W-01 조작 UI — 기간 · 목록 · 재발견 · 상태

**Files:**
- Create: `web/src/ui/hud.js`
- Modify: `web/src/main.js`

**Interfaces:**
- Consumes: `store`, `syncUniverse`, `flyTo`, `setSelectedStar`, `periodRange`
- Produces: `initHud()`. `store.on('data')`마다 로고 카드 숫자, 바로 날아가기 목록(`near` 이벤트로 노랑 표시), 재발견 카드, 가운데 상태 카드, 띠 배너를 다시 그리고 `syncUniverse`를 부른다. `showGuestStar(star)`(기간 밖 재발견 별: `store.state.guestStarId` 설정, 토스트 "N일 전 별이라 이 별만 잠시 보여드려요"), `clearGuestStar()`.
- 규칙: 시안 `applyPeriod`, `renderDock`, `renderRedis`, `worldState`를 옮긴다. 우주에 들어온 직후 오늘 0개이고 전체는 1개 이상이면 기간을 이번 주로 넓히고 토스트 "오늘 별이 없어 이번 주를 보여드려요". 2,000개 초과 띠 배너 "기간을 좁히면 별이 보여요" + "오늘만 보기"(기간이 오늘이면 버튼 없음). 760px 이하 배치는 시안 CSS 그대로.

- [ ] **Step 1: `hud.js` 구현**
- [ ] **Step 2: 브라우저 확인**
  - 기간 탭을 바꾸면 별 · 개수 · 행성 크기가 바뀐다. "직접 지정"에서 날짜 2칸이 나온다.
  - 오늘 별이 없는 DB로 들어가면 이번 주로 넓어지고 토스트가 뜬다.
  - 8일 전 `created_at`으로 별 하나를 DB에 직접 넣으면 재발견 카드가 뜨고, "날아가기"를 누르면 그 별만 핑크로 보이며 토스트가 뜬다.
  - 스크립트로 별 2,001개를 넣으면 별 없이 띠 배너와 "별 N개" 이름표가 보인다.
- [ ] **Step 3: Commit** `feat: world hud, period tabs, rediscovery, star cap`

---

### Task 9: W-02 행성 패널과 행성 메뉴

**Files:**
- Create: `web/src/ui/panel.js`, `web/src/ui/planetForm.js`, `web/src/ui/planetDelete.js`, `web/src/styles/planet.css`
- Modify: `web/index.html`(`#planetForm`, `#planetDel` 마크업), `web/src/main.js`, `web/src/ui/home.js` · `web/src/ui/hud.js`("+ 새 행성" 버튼), `web/src/three/controls.js`(Esc 순서 · 입력 차단), `web/src/styles/app.css`(체크박스 · 발 스타일 제거)

**Interfaces:**
- Consumes: `store`(`land`, `leftPanelPlanet`, `data`), `api`, `ask`, `toast`, `ico`, `PLANET_COLORS`, `DECO_NAMES`
- Produces: `openPanel(planetId, starId?)`, `closePanel()`, `renderPanel()`. 별 제목을 누르면 `store.emit('openDetail', starId)`.
  - `planetForm.js`: `openPlanetForm({ planet?: Planet }) → Promise<Planet | null>`(planet이 없으면 만들기: `api.nextLook()`으로 기본 선택 → `api.createPlanet`. 있으면 꾸미기: `api.patchPlanet`. 저장 뒤 `store.reload()`), `isPlanetFormOpen()`
  - `planetDelete.js`: `confirmDeletePlanet(planet, otherPlanets) → Promise<boolean>`(스펙 6-7의 세 경우를 그리고 `api.deletePlanet`을 부른다. 지웠으면 true)
- 규칙:
  - 머리: 색 원 46px, 이름 + ✎, "이 기간 별 N개 · 전체 M개", ⋯, ✕. `--accent`는 그 행성의 진한 색.
  - ✎는 `openPlanetForm({ planet })`을 연다. 제자리 이름 입력칸은 만들지 않는다.
  - 행성 꾸미기 창과 삭제 확인 창의 모양 · 문구 · 토스트는 스펙 6-6 · 6-7 그대로. 쌓임 순서 44. 창이 열려 있으면 비행 키를 받지 않고, Esc는 확인 창 다음, 저장 창 앞 순서로 이 창을 닫는다.
  - W-01 바로 날아가기 목록과 W-00 행성 목록 카드의 맨 끝에 "+ 새 행성"(고스트 작은 버튼, `plus` 12px)을 두고 `openPlanetForm({})`에 연결한다. 전체 0개 상태에서도 보인다(W-01은 가운데 카드 아래, W-00은 빈 우주 카드 안 "기록하기" 옆).
  - 목록 항목: 썸네일 · 제목 · 날짜. **체크박스 없음.** 썸네일은 이미지면 `api.thumbUrl(id)`(`has_thumb`가 false면 종류 아이콘), 링크 `link`, 파일 `file-text`, 글 `type`.
  - 메뉴: "새 행성 만들기"(`openPlanetForm({})`) / "행성 꾸미기"(`openPlanetForm({ planet })`) / "다른 행성과 합치기"(행성 1개뿐이면 비활성. 확인 창에 대상 선택 상자, 핑크 "합치기", 설명 "별 N개가 'OO'(으)로 옮겨가고 이 행성은 사라져요. 되돌릴 수 없어요.") / "행성 삭제"(`confirmDeletePlanet`, 항상 활성. 지워지면 패널을 닫고 조망으로).
  - 이 기간 별 0개: 점선 상자 "이 기간에는 이 행성에 별이 없어요. 위쪽에서 기간을 넓혀 보세요."
  - 패널의 발은 없다. 패널의 아래 위치 84px는 유지한다.
  - `leftPanelPlanet` 이벤트에서 패널을 닫는다. 행동 뒤에는 `store.reload()`.

- [ ] **Step 1: `panel.js` 구현** (시안 671~713행을 옮기고 위 규칙대로 고친다)
- [ ] **Step 2: 브라우저 확인**
  - 행성 클릭 · E · 목록으로 패널이 열리고, 멀리 날아가면 닫힌다.
  - 꾸미기 창에서 이름과 설명을 바꾸면 3D 이름표가 바로 바뀐다. 설명을 비우면 둘째 줄이 사라진다.
  - 꾸미기 창에서 색 · 장식 · 고리를 바꾸면 행성이 같은 자리에서 새 모습이 되고 별은 그대로 돈다. 패널의 포인트 색도 바뀐다.
  - 새 행성 창은 자동 배정 값이 미리 골라져 있고, 연달아 만들면 매번 다른 색 · 장식이 골라져 있다.
  - 왼쪽 아래 목록의 "+ 새 행성"으로 11개째까지 만들어도 겹치지 않고 조망에 다 보인다. 메인 홈의 "+ 새 행성"도 된다.
  - 합치기 뒤 별이 대상 행성에 있고 원래 행성이 사라진다.
  - 삭제: 빈 행성은 바로, 별 있는 행성은 "옮기고 지우기"와 "함께 지우기"가 각각 맞게 동작한다. 함께 지운 별의 파일이 보관함 폴더에서 사라진다. 행성이 하나뿐이면 고르기 없이 함께 지우기 설명만 나온다.
  - 색 원 · 장식 칩을 Tab과 Space · Enter로 고를 수 있고 포커스 링이 보인다.
  - 이름에 `<img src=x onerror=alert(1)>`을 넣어도 글자로만 보인다.
- [ ] **Step 3: Commit** `feat: planet panel and planet menu`

---

### Task 10: W-03 별 상세

**Files:**
- Create: `web/src/ui/detail.js`
- Modify: `web/src/ui/panel.js`(상세 보기 전환), `web/src/main.js`

**Interfaces:**
- Consumes: `store`(`openDetail`, `pickStar`), `api`, `ask`, `toast`, `flyStarIn`, `setSelectedStar`, `fullDate`, `fileSize`, `clearGuestStar`
- Produces: `renderDetail(star)`, `flushMemo() → Promise`(대기 중인 메모 저장을 즉시 실행. 패널을 닫거나 목록으로 돌아갈 때 부른다)
- 규칙(DESIGN.md W-03 + 스펙 5장):
  - 미리보기: 이미지는 4:3 상자에 `api.fileUrl(id)` + 파일 이름 꼬리표 / 파일은 확장자 아이콘 + 이름 + "PDF · 1.2MB" / 링크는 `link_title`(없으면 주소) + 주소 / 글은 본문 점선 상자.
  - 행동 버튼: 글 별은 둘 다 없음. 링크 별은 "원본 열기"만(`window.open(url, '_blank', 'noopener')`). 파일 · 이미지는 "원본 열기"(`api.open`) + "폴더에서 보기"(`api.reveal`). 응답이 `revealed`면 토스트 "실행 파일이라 폴더에서 보여드렸어요". 404 `file_missing`이면 토스트 "파일을 찾지 못했어요".
  - 메모: 입력을 멈추고 0.6초 뒤 `api.patchStar`. 상태 글 "입력을 멈추면 저장돼요" → "저장 중…" → "저장됨". 저장이 실패하면 "저장하지 못했어요. 다시 입력해 주세요"로 바꾸고 입력한 글은 그대로 둔다.
  - 행성 옮기기: 선택 상자를 바꾸면 `api.patchStar({ planet_id })` → `flyStarIn`으로 새 행성에 날아가고 → 목록으로 돌아가며 토스트 "'OO'(으)로 옮겼어요".
  - 지우기: 글자 링크 → `ask({ title: "별 'OO'을(를) 지울까요?", desc: "기록과 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.", confirmLabel: '지우기', confirmKind: 'pink' })` → `api.deleteStar` → 토스트 "지웠어요".
  - 발(싣기 버튼)은 없다. Esc는 상세 → 목록 → 패널 닫기 순서.
  - 상세를 여는 동안 그 별이 `setSelectedStar`로 핑크. 벗어나면 해제하고 `clearGuestStar()`.

- [ ] **Step 1: `detail.js` 구현** (시안 715~759행을 옮기고 위 규칙대로 고친다)
- [ ] **Step 2: 브라우저 확인**
  - 종류 4가지의 미리보기가 맞게 나온다. 이미지는 실제 이미지가 보인다.
  - 메모를 쓰고 0.6초 뒤 "저장됨", 새로고침해도 남는다. 쓰자마자 ✕로 닫아도 저장된다.
  - PDF "원본 열기"가 기본 프로그램으로 열리고, "폴더에서 보기"가 탐색기에서 사본을 선택한다. `.bat` 파일은 열리지 않고 폴더만 보인다.
  - 보관함 폴더에서 사본을 직접 지운 뒤 "원본 열기" → "파일을 찾지 못했어요". 그 별은 지울 수 있다.
  - 메모를 쓰는 도중 서버를 끄면 저장 실패 문구가 뜨고 쓴 글이 남아 있다.
- [ ] **Step 3: Commit** `feat: star detail with memo autosave, move, delete, open`

---

### Task 11: W-05 저장 창 · 기록하기 · 끌어다 놓기 · 붙여넣기

**Files:**
- Create: `web/src/ui/saveModal.js`, `web/src/ui/dropzone.js`, `web/src/ui/saveLogic.js`, `web/src/styles/save.css`, `web/src/test/saveLogic.test.js`
- Modify: `web/index.html`(`#save`, `#dropveil` 마크업), `web/src/main.js`, `web/src/three/controls.js`(Esc 순서, 입력 차단)

**Interfaces:**
- Consumes: `api`, `store`, `ask`, `toast`, `flyStarIn`, `firstLine`, `fileSize`, `PLANET_COLORS`
- Produces:
  - `openSave({ tab: 'text'|'link'|'file', text?, url?, files?: File[] })`, `isSaveOpen() → boolean`, `closeSave()`
  - `initDropzone()`
  - `saveLogic.js`(DOM 없는 순수 함수):
    - `classifyPaste({ files: File[], text: string }) → { tab, files?, url?, text? } | null` — 파일이 있으면 `file`, 글 전체가 공백 없는 `http(s)://` 주소 하나면 `link`, 그 밖의 비어 있지 않은 글이면 `text`, 아무것도 없으면 null
    - `canSubmit({ tab, text, url, files, planetId, newPlanetName }) → boolean`
    - `urlError(url) → string | null` — 비어 있으면 null, `http://` · `https://`로 시작하지 않으면 `'주소는 http로 시작해야 해요'`
    - `defaultPlanetId({ panelPlanetId, lastPlanetId, planets }) → string | 'new'`
    - `resultToast({ created, skipped }) → string`
    - `splitDropped(items: DataTransferItemList) → { files: File[], folders: number }` — `webkitGetAsEntry()?.isDirectory`인 항목은 빼고 센다
- 규칙: 스펙 6-2 ~ 6-4 전부. 덧붙여 정하는 것:
  - 새 행성을 고른 채 저장하면 `api.createPlanet` → 받은 id로 별 저장 순서로 부른다. 별 저장이 실패해도 만든 행성은 남긴다.
  - 파일 탭에 파일을 더 담을 때 이름 · 크기 · 수정 시각이 같은 파일은 다시 담지 않는다. 500MB를 넘는 파일은 담는 순간 빼고 토스트 "500MB보다 큰 파일은 담을 수 없어요".
  - 폴더를 놓으면 폴더는 빼고 토스트 "폴더는 담을 수 없어요. 파일만 놓아 주세요". 파일이 하나도 안 남으면 창을 열지 않는다.
  - `resultToast`: 모두 성공 "별 N개를 띄웠어요" / 일부 "별 N개를 띄웠어요. M개는 이미 있거나 너무 커서 빼놨어요" / 하나도 없음(1개, duplicate) "이미 있는 별이에요" / 하나도 없음(1개, too_large) "500MB보다 큰 파일은 담을 수 없어요" / 하나도 없음(여러 개) "띄운 별이 없어요. 이미 있거나 너무 큰 파일이에요". 하나도 저장되지 않았으면 창을 닫지 않는다.
  - 저장 실패(오프라인 포함): 창을 닫지 않고 발 위에 "저장하지 못했어요. 다시 눌러 주세요". 입력 내용과 담긴 파일은 그대로.
  - 성공 뒤: `store.state.lastPlanetId` 갱신 → `store.reload()` → W-01이면 새 별마다 `flyStarIn(id, 캐릭터 앞 아래쪽 위치)`. 패널이 그 행성으로 열려 있으면 새 항목에 1.2초 핑크 클래스.
  - 놓기 막은 `dragenter`/`dragleave` 횟수를 세어 깜빡이지 않게 하고, `dataTransfer.types`에 `Files`가 있을 때만 뜬다. 저장 창이 이미 열려 있으면 놓은 파일을 파일 탭 목록에 더한다. 확인 창이 열려 있으면 받지 않는다.
  - 붙여넣기는 `document`의 `paste`에서 `e.target`이 입력창 · 글 상자가 아닐 때만 처리한다.
  - Esc 순서: 확인 창 → 행성 꾸미기 창 → 저장 창 → 전환 건너뛰기 → 상세에서 목록 → 패널 닫기. 저장 창이 열려 있으면 비행 키를 받지 않는다(`setInputBlocked`).
  - 내용을 입력한 뒤 취소하면 `ask({ title: '쓰던 기록을 버릴까요?', desc: '입력한 내용이 사라져요.', confirmLabel: '버리기', confirmKind: 'pink' })`.

- [ ] **Step 1: 실패하는 테스트 작성** (`saveLogic.test.js`)

```js
test('classifyPaste: files win', ...)                       // {files:[f], text:'x'} → tab 'file'
test('classifyPaste: single url → link', ...)               // ' https://a.com/x ' → {tab:'link', url:'https://a.com/x'}
test('classifyPaste: url inside a sentence → text', ...)
test('classifyPaste: empty → null', ...)
test('urlError', () => { expect(urlError('')).toBeNull(); expect(urlError('naver.com')).toBe('주소는 http로 시작해야 해요'); expect(urlError('https://a.com')).toBeNull(); });
test('canSubmit: needs content and a planet', ...)          // 글 공백뿐 false / 파일 0개 false / planetId 'new' + 이름 '' false / 'new' + '공부' true
test('canSubmit: link with invalid url is false', ...)
test('defaultPlanetId: panel planet first, then last saved, then new', ...)
test('defaultPlanetId: last saved planet that no longer exists → first planet', ...)
test('defaultPlanetId: no planets → "new"', ...)
test('resultToast: all saved', () => expect(resultToast({ created: [1, 2], skipped: [] })).toBe('별 2개를 띄웠어요'));
test('resultToast: partial', () => expect(resultToast({ created: [1], skipped: [{ reason: 'duplicate' }] })).toBe('별 1개를 띄웠어요. 1개는 이미 있거나 너무 커서 빼놨어요'));
test('resultToast: single duplicate', () => expect(resultToast({ created: [], skipped: [{ reason: 'duplicate' }] })).toBe('이미 있는 별이에요'));
test('resultToast: single too large', ...)
test('splitDropped: skips directories and counts them', ...) // 가짜 items: [{kind:'file', webkitGetAsEntry:()=>({isDirectory:true})}, {kind:'file', getAsFile:()=>f, webkitGetAsEntry:()=>({isDirectory:false})}] → {files:[f], folders:1}
```

- [ ] **Step 2: `npx vitest run web/src/test/saveLogic.test.js` → FAIL → `saveLogic.js` 구현 → PASS**
- [ ] **Step 3: 마크업 · `save.css` · `saveModal.js` · `dropzone.js` 구현, `#hLog` · `#wLog` · 빈 우주 카드의 버튼을 `openSave({ tab: 'text' })`에 연결**
- [ ] **Step 4: 브라우저 확인**
  - 빈 DB에서 "기록하기" → 행성 칸이 "+ 새 행성 만들기"로 시작하고, 이름을 넣어 글을 저장하면 첫 행성과 별이 생긴다.
  - 기록하기 → 파일 탭 → "파일 고르기"로 PDF와 이미지를 함께 올리면 별 2개가 생긴다(기록하기에서도 파일 업로드가 된다).
  - 우주 화면에 파일 3개를 끌어다 놓으면 막 → 저장 창(파일 탭, 3개 담김) → 저장 → 별 3개가 행성으로 날아 들어가고 행성이 커진다. 새로고침해도 남는다.
  - 메인 홈에서도 끌어다 놓기가 된다. 저장 뒤 인사말 숫자가 바뀐다.
  - 같은 파일을 다시 놓으면 "이미 있는 별이에요"가 뜨고 창이 남는다.
  - 폴더를 놓으면 폴더 안내 토스트가 뜬다.
  - 주소를 복사해 화면에서 Ctrl+V → 링크 탭에 주소가 담겨 열린다. 저장하면 링크 제목이 별 제목이 된다.
  - 글을 쓰다 Esc → "쓰던 기록을 버릴까요?".
  - 서버를 끄고 "별 띄우기" → 창이 닫히지 않고 실패 문구가 뜨며 내용이 남는다.
  - 저장 창이 열린 동안 WASD로 캐릭터가 움직이지 않는다.
- [ ] **Step 5: Commit** `feat: save modal, log button, drag-drop and paste`

---

### Task 12: 마무리 — 반응형 · 모션 줄이기 · 전체 확인 · 실행 안내

**Files:**
- Create: `README.md`
- Modify: 확인 중 드러난 화면 파일들

- [ ] **Step 1: `npm run build && npm start` 뒤 `http://127.0.0.1:4747`에서 연다.** 개발자 도구 Network에서 외부 도메인 요청이 0건인지 확인한다(링크 저장 때 서버가 여는 요청은 브라우저에 보이지 않는다).
- [ ] **Step 2: DESIGN.md 11장 목록을 하나씩 확인한다.** "W-04" 묶음과 "체크한 별이 우주에서 핑크가 된다" 항목은 건너뛴다. 실패한 항목은 고치고 다시 확인한다.
- [ ] **Step 3: 창 너비 760px 이하에서** W-00 1단, W-02 아래 시트, 기간 탭 · 목록 위치, 저장 창이 화면을 넘지 않는지 확인한다.
- [ ] **Step 4: OS 모션 줄이기를 켜고** 전환이 페이드로, 패널 튀어 오름 · 항목 깜빡임이 꺼지는지 확인한다.
- [ ] **Step 5: `README.md` 작성** — 필요한 것(Node 20+), `npm install`, `npm run dev`, `npm run build && npm start`, 데이터가 저장되는 위치와 `SPACELOG_DATA`, 백업 방법(데이터 폴더 통째로 복사).
- [ ] **Step 6: `npm test` → 전체 PASS**
- [ ] **Step 7: Commit** `chore: responsive and reduced-motion pass, readme`
