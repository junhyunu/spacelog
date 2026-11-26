# 미분류 행성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 행성을 고르지 않고 저장한 기록이 모이는 잠긴 기본 행성 "미분류"를 더하고, 그 기록을 먼지 띠로 그리며, 여러 기록을 한 번에 옮기는 기능을 붙인다.

**Architecture:** 서버는 켤 때마다 id `unsorted` · slot `-1`인 행성을 보장하고, 그 행성의 수정 · 삭제 · 합치기를 403으로 막으며, 별 여러 개를 한 트랜잭션으로 옮기는 `POST /api/stars/move`를 더한다. 웹 3D는 미분류 행성을 줄무늬 구 + 먼지 스프라이트로 그리되 기존 별 객체(S)의 공전 · 날아가기 구조를 그대로 쓰고, 별 클릭을 없앤다. 웹 UI는 미분류의 꾸미기 · 지우기 · 합치기 메뉴를 숨기고, 행성 패널에 "여러 개 고르기"를 더한다.

**Tech Stack:** Node 22 · Fastify · better-sqlite3 · vitest · 바닐라 JS(Vite) · three.js r128

**Spec:** `docs/superpowers/specs/2026-11-26-unsorted-planet-design.md`

## Global Constraints

- 미분류 행성 값: id `'unsorted'`, name `'미분류'`, description `'고르지 않고 저장한 기록'`, slot `-1`, color_index `1`, deco `'rock'`, ring `0`. 상수 이름은 서버 · 웹 모두 `UNSORTED_ID`.
- 미분류 우주 좌표 `[14, 3, 0]`. 반지름 고정 `BASE_RADIUS`(4.2).
- 먼지: 크기 `1.3`(월드 단위), 궤도 반지름 6.0~8.6, 최대 `DUST_PER_PLANET = 300`알(최근 것부터).
- 잠금 오류: HTTP 403, `{ error: 'locked' }`.
- 저장 창 기본 행성: 열린 패널의 행성 → `UNSORTED_ID`. `lastPlanetId`는 기본값 계산에 쓰지 않는다(저장 자체는 그대로 둬도 된다).
- 화면 문구(그대로): 잠금 안내 `기본 행성이라 이름을 바꾸거나 지울 수 없어요`, 고르기 버튼 `여러 개 고르기`, 바 `N개 골랐어요`, 바 버튼 `행성 옮기기`, 확인 창 제목 `N개를 어느 행성으로 옮길까요?`, 확인 버튼 `N개 옮기기`, 토스트 `N개를 'X'(으)로 옮겼어요`, 실패 토스트 `옮기지 못했어요`.
- **`web/`·`server/` 변경과 커밋은 사용자 승인 뒤에만.** 각 태스크의 "커밋" 단계는 diff를 보여 주고 승인받은 뒤 master에 커밋한다(서브에이전트 포함, push는 따로 승인). `web/abtest/`는 건드리지 않는다.
- 테스트 명령: `npx vitest run <경로>`. 전체는 `npm test`.

## Review Focus

1. **미분류가 생기면서 기존 테스트 · 화면이 "행성 0개"를 가정하던 곳.** 새 DB에도 행성이 하나 있다. 서버 테스트의 행성 목록 비교와 웹의 "행성이 없으면 'new'" 같은 분기가 깨지지 않아야 한다 → Task 1에서 기존 테스트를 고치고, Task 3에서 `defaultPlanetId` 테스트.
2. **slot `-1` 때문에 새 행성 자리가 꼬이는 것.** `lowestFreeSlot`이 음수 자리를 보고 0을 이미 쓴 자리에 다시 주면 UNIQUE 오류가 난다 → Task 1 테스트 "미분류가 있어도 새 행성은 0, 1, 2…".
3. **일괄 이동에 지워진 별 · 같은 행성 별 · 중복 id가 섞인 요청.** 있는 별만 옮기고 개수를 정확히 돌려줘야 하며, 하나가 없다고 전체가 실패하면 안 된다 → Task 2 테스트.
4. **기간 밖이거나 300알을 넘는 미분류.** 먼지는 최근 300알까지만 그리고, 그 밖의 별을 옮겨도 3D가 오류 없이 넘어가야 한다(날아갈 먼지가 없으면 새 별이 그냥 생긴다) → Task 4 순수 함수 테스트.
5. **고르기 모드 중에 목록이 다시 그려지는 것('data' · 기간 바꾸기).** 고른 것이 목록에서 사라지면 선택에서도 빠져야 하고, 남은 것은 유지돼야 한다 → Task 6 테스트.

---

### Task 1: 서버 — 미분류 행성 보장과 잠금

**Files:**
- Modify: `server/planets.js` (`UNSORTED_ID` · `ensureUnsorted` 추가, `lowestFreeSlot`, PATCH · merge · DELETE 라우트)
- Modify: `server/db.js` (`openDb`의 켤 때마다 도는 트랜잭션에서 `ensureUnsorted(db)` 호출)
- Test: `server/test/planets.test.js`, `server/test/migration.test.js`
- Fix: 행성 목록 전체를 비교하던 기존 테스트(`planets`, `stars`, `chat`, `rag-sync`, `create`, `files` 중 깨지는 것)

**Interfaces:**
- Produces: `export const UNSORTED_ID = 'unsorted'`, `export function ensureUnsorted(db): void` (`server/planets.js`). `GET /api/planets`는 미분류를 맨 앞(slot -1)에 포함한다.

- [ ] **Step 1: 실패하는 테스트 쓰기** (`server/test/planets.test.js`)

```js
test('fresh db has the unsorted planet first', async () => {
  const all = await list();
  expect(all[0]).toMatchObject({ id: 'unsorted', name: '미분류', description: '고르지 않고 저장한 기록', slot: -1 });
});
test('new planets still take slots 0, 1, 2 with unsorted present', async () => {
  expect((await create({ name: 'a' })).slot).toBe(0);
  expect((await create({ name: 'b' })).slot).toBe(1);
});
test('unsorted cannot be patched, deleted or merged away', async () => {
  const other = await create({ name: 'x' });
  expect((await call('PATCH', '/api/planets/unsorted', { name: 'y' })).statusCode).toBe(403);
  expect((await call('DELETE', '/api/planets/unsorted?stars=delete')).statusCode).toBe(403);
  expect((await call('POST', '/api/planets/unsorted/merge', { into: other.id })).json()).toEqual({ error: 'locked' });
});
test('other planets can merge or move their stars into unsorted', async () => { /* 별 1개 가진 행성을 into: 'unsorted'로 merge → 200, 별의 planet_id === 'unsorted' */ });
```

`server/test/migration.test.js`: 판 5 DB(미분류 없음)를 열면 미분류가 생기고, 두 번 열어도 하나뿐인지.

- [ ] **Step 2: 실패 확인** — `npx vitest run server/test/planets.test.js server/test/migration.test.js` → 위 테스트 FAIL
- [ ] **Step 3: 구현**
  - `ensureUnsorted(db)`: `INSERT OR IGNORE INTO planets (...) VALUES ('unsorted', '미분류', '고르지 않고 저장한 기록', 1, 'rock', 0, -1, <now>)`. `planet_seq`는 건드리지 않는다.
  - `openDb`의 켤 때마다 도는 트랜잭션(`adoptLegacyStars` · `foldMemos`가 있는 곳)에서 부른다. `SCHEMA_VERSION`은 그대로 5.
  - `lowestFreeSlot`: `WHERE slot >= 0`.
  - PATCH `/api/planets/:id`, DELETE `/api/planets/:id`, POST `/api/planets/:id/merge`에서 `id === UNSORTED_ID`이면 `ApiError(403, 'locked')`. (`into === UNSORTED_ID`는 허용.)
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS
- [ ] **Step 5: 전체 서버 테스트** — `npx vitest run server` → 미분류 때문에 깨진 기존 테스트는 비교에서 미분류를 빼거나(`filter((p) => p.id !== 'unsorted')`) 기대값에 넣어 고친다. 동작을 바꾸는 수정은 하지 않는다. 전부 PASS.
- [ ] **Step 6: 커밋(승인 후)** — `feat(server): always-present unsorted planet, locked from edit/delete/merge`

### Task 2: 서버 — 별 여러 개 옮기기

**Files:**
- Modify: `server/stars.js` (라우트 `POST /api/stars/move`)
- Modify: `web/src/api.js` (`moveStars`)
- Test: `server/test/stars.test.js`

**Interfaces:**
- Produces: `POST /api/stars/move` body `{ ids: string[], planet_id: string }` → `200 { moved: number }`. 오류: ids가 배열이 아니거나 비었거나 500개 초과이거나 문자열이 아닌 값 → `400 invalid_ids`, 행성 없음 → `400 unknown_planet`. 웹 `api.moveStars(ids, planetId) → Promise<{ moved }>`.

- [ ] **Step 1: 실패하는 테스트**

```js
test('move many stars in one call', async () => { /* 별 3개(미분류) → POST {ids:[a,b,c], planet_id: p} → {moved:3}, 셋 다 planet_id === p */ });
test('missing, duplicate and already-there ids are skipped', async () => {
  // ids: [a, a, 'nope', b(이미 p)] → {moved: 1}
});
test('bad bodies are 400', async () => {
  // ids: [] / 'a' / [1] / 501개 → invalid_ids, planet_id 없는 행성 → unknown_planet
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run server/test/stars.test.js`
- [ ] **Step 3: 구현** — 한 트랜잭션에서 `UPDATE stars SET planet_id = ? WHERE id = ? AND planet_id <> ?`를 중복 뺀 id마다 실행하고 바뀐 행 수를 더한다. 실제로 옮긴 id들로 `app.ragSync?.markStars(movedIds, 'patch')`(단일 PATCH와 같은 이유 문자열). `/api/stars/:id` 보다 먼저 맞도록 등록 순서를 확인한다(POST라 충돌은 없지만 같은 파일 안에 둔다).
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋(승인 후)** — `feat(server): POST /api/stars/move moves many stars at once`

### Task 3: 웹 로직 — 상수 · 자리 · 저장 창 기본값

**Files:**
- Modify: `web/src/util.js` (`UNSORTED_ID`, `isUnsorted(planetOrId): boolean`)
- Modify: `web/src/three/slots.js` (`UNSORTED_SLOT = -1`, `UNSORTED_POSITION = [14, 3, 0]`, `slotPosition(-1)`)
- Modify: `web/src/ui/saveLogic.js:153-164` (`defaultPlanetId`)
- Modify: `web/src/ui/saveModal.js:132` (`lastPlanetId` 인자 제거)
- Test: `web/src/test/slots.test.js`, `web/src/test/saveLogic.test.js`, `web/src/test/util.test.js`

**Interfaces:**
- Produces: `UNSORTED_ID`, `isUnsorted(x)`(x는 행성 객체 또는 id, `String(x?.id ?? x) === 'unsorted'`) — `web/src/util.js`. `slotPosition(-1)` → `[14, 3, 0]`. `defaultPlanetId({ panelPlanetId, planets }) → string`.

- [ ] **Step 1: 실패하는 테스트**

```js
// slots.test.js
expect(slotPosition(-1)).toEqual([14, 3, 0]);
// 기존 겹침 검사(1~40개)에 미분류 자리를 더해도 겹치지 않는다: margin은 미분류만 10(먼지 띠), 나머지 9.
// saveLogic.test.js
const ps = [{ id: 'unsorted' }, { id: 'a' }, { id: 'b' }];
expect(defaultPlanetId({ panelPlanetId: 'b', planets: ps })).toBe('b');
expect(defaultPlanetId({ panelPlanetId: null, planets: ps })).toBe('unsorted');
expect(defaultPlanetId({ panelPlanetId: 'gone', planets: ps })).toBe('unsorted');
expect(defaultPlanetId({ planets: [{ id: 'a' }] })).toBe('a'); // 미분류가 아직 없는 옛 서버
expect(defaultPlanetId({ planets: [] })).toBe('new');
```

`saveLogic.test.js`에 `lastPlanetId`를 쓰는 기존 기대값이 있으면 새 순서로 고친다.

- [ ] **Step 2: 실패 확인** — `npx vitest run web/src/test/slots.test.js web/src/test/saveLogic.test.js web/src/test/util.test.js`
- [ ] **Step 3: 구현** — `slotPosition`은 `n === UNSORTED_SLOT`이면 `[...UNSORTED_POSITION]`, 그 밖의 음수는 지금처럼 0번. `defaultPlanetId` 주석도 새 순서로.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋(승인 후)** — `feat(web): unsorted planet constants, slot and save default`

### Task 4: 웹 3D — 미분류 모습 · 먼지 · 별 클릭 없애기

**Files:**
- Modify: `web/src/three/planets.js` (`buildLook` 분기, `createStar` 분기, `syncUniverse` 상한, `scaleFor` 고정, `labelOf`, `pickTargets`, `paintStars`, `dispose`)
- Create: `web/src/three/dust.js` (먼지 텍스처 · 재질 · 줄무늬 텍스처, `pickDrawn` 순수 함수)
- Modify: `web/src/three/controls.js:209-227` (`pick`), 머리 주석
- Modify: `web/src/ui/panel.js` (`pickStar` 구독 · `onPickStar` 삭제), `web/src/ui/hud.js:641`, `web/src/three/dev.js:65-67`, `web/src/main.js:142` 주석
- Test: `web/src/test/dust.test.js` (새 파일)

**Interfaces:**
- Consumes: `isUnsorted`(Task 3), `UNSORTED_POSITION`(Task 3, `slotPosition` 경유)
- Produces (`web/src/three/dust.js`):
  - `export const DUST_SIZE = 1.3`, `export const DUST_PER_PLANET = 300`, `export const DUST_ORBIT = [6.0, 8.6]`, `export const BAND_TILT = [0.42, 0, -0.22]`
  - `export function pickDrawn(starList, planetIds, { perPlanet, perUnsorted }) → Map<starId, planetId>` — 최신순 목록에서 행성마다 상한까지 고른다(미분류는 `perUnsorted`, 그 밖은 `perPlanet`). 지금 `syncUniverse`의 별 고르기 루프를 이 함수로 옮긴다.
  - `export function dustMaterials() → { normal: THREE.SpriteMaterial, on: THREE.SpriteMaterial }`(하양 / 핑크, 한 번 만들어 함께 씀), `export function stripeTexture(seed: string) → THREE.CanvasTexture`

- [ ] **Step 1: 실패하는 테스트** (`dust.test.js`, three 없이 도는 `pickDrawn`만)

```js
const list = [...Array(320)].map((_, i) => ({ id: `u${i}`, planet_id: 'unsorted' })).concat(
  [...Array(60)].map((_, i) => ({ id: `a${i}`, planet_id: 'a' })));
const m = pickDrawn(list, new Set(['unsorted', 'a']), { perPlanet: 50, perUnsorted: 300 });
expect([...m.values()].filter((p) => p === 'unsorted')).toHaveLength(300);
expect([...m.values()].filter((p) => p === 'a')).toHaveLength(50);
expect(m.has('u0')).toBe(true); expect(m.has('u300')).toBe(false); // 최근 것부터
expect(pickDrawn([{ id: 'x', planet_id: 'gone' }], new Set(['a']), { perPlanet: 50, perUnsorted: 300 }).size).toBe(0);
```

`pickDrawn`이 three를 import하지 않게 `dust.js` 안에서 three는 함수 안에서만 쓰거나, `pickDrawn`을 `dust.js` 맨 위 순수 부분에 두고 three import는 그대로 둬도 vitest(jsdom 아님)에서 import만으로 깨지지 않는지 확인한다(`slots.js`처럼 따로 둬야 하면 `web/src/three/dustLogic.js`로 나눈다).

- [ ] **Step 2: 실패 확인** — `npx vitest run web/src/test/dust.test.js`
- [ ] **Step 3: 구현**
  - `createPlanet`에서 `P.unsorted = isUnsorted(d.id)`. `scaleFor`는 미분류면 늘 1(`targetScale`도).
  - `buildLook`: 미분류면 몸은 `SphereGeometry(r, 48, 32)` + `toon(0xffffff, { map: stripeTexture(P.id) })` + `ol(…, 1.035)`, 장식 · 깃발 · 고리를 만들지 않는다. 이름표는 그대로.
  - `labelOf`: 미분류이고 `capMode`면 `먼지 N알`.
  - `createStar(id, P, fromPos)`: `P.unsorted`면 `mesh` 대신 `new THREE.Sprite(dustMaterials().normal)`(scale `DUST_SIZE`), `pivot.rotation.set(...BAND_TILT)`, `holder.rotation.y` 무작위, `extra = DUST_ORBIT[0] - r + rand * (DUST_ORBIT[1] - DUST_ORBIT[0])`, 띠 두께는 `S.mesh.position.y`에 ±0.22 무작위(`orbitRadius`가 x만 쓰므로 y는 생성 때 한 번), `speed`는 0.16~0.21을 √반지름으로 나눈 값(안쪽이 빠름). userData는 그대로 둔다.
  - 날아가는 동안의 크기 변화(`updateUniverse`의 `scale.setScalar`)는 스프라이트면 `DUST_SIZE`를 곱한다. 궤도에 들어가면 `DUST_SIZE`로 되돌린다.
  - `paintStars`: 스프라이트는 `material`을 `dustMaterials().on/normal`로.
  - `dispose`: 먼지 재질은 함께 쓰므로 지우지 않는다(`o.isSprite`면서 먼지 재질이면 건너뜀).
  - `syncUniverse`의 별 고르기를 `pickDrawn(starList, new Set(planets.keys()), { perPlanet: STARS_PER_PLANET, perUnsorted: DUST_PER_PLANET })`로 바꾼다.
  - 별 클릭 없애기: `pickTargets()`는 행성 몸만 돌려준다(주석 고침). `controls.js`의 `pick`에서 `starId` 분기를 지우고 행성만 처리. `pickStar` 이벤트를 듣던 `panel.js`(`onPickStar`와 구독), `hud.js:641`, `dev.js`의 구독을 지우고, 머리 주석의 `pickStar` 줄을 지운다. `flyTo(planetId, starId)`의 두 번째 인자를 다른 곳에서 쓰는지 grep으로 확인하고, 안 쓰면 그대로 둔다(이번 범위 밖).
- [ ] **Step 4: 통과 확인** — `npx vitest run web/src/test` 전부 PASS
- [ ] **Step 5: 눈으로 확인** — `npm run dev`로 띄워 확인: (1) 출발 직후 오른쪽 앞에 줄무늬 행성, (2) 미분류로 저장하면 먼지 한 알이 날아와 띠에 들어감, (3) 별 · 먼지를 눌러도 상세가 안 열리고 행성이 눌림, (4) 조망에서 미분류가 다른 행성과 겹치지 않음. 화면 캡처 1장을 사용자에게 보여 준다. 띄운 서버는 직접 끈다(다른 포트를 쓰는 프로세스는 건드리지 않는다).
- [ ] **Step 6: 커밋(승인 후)** — `feat(web): unsorted planet with dust band; stars are no longer clickable`

### Task 5: 웹 UI — 미분류 공통 표시(색 · 순서 · 잠금)

미분류는 DB에 color_index 1(주황)로 들어 있어, 손대지 않으면 목록 · 칩 · 패널 강조색이 주황으로 나온다. 행성 색을 쓰는 모든 곳이 한 함수를 거치게 해 미분류를 슬레이트색으로 맞춘다.

**Files:**
- Modify: `web/src/util.js` (`planetFace(planet)`, `planetDeep(planet)`)
- Modify (행성 색을 직접 읽던 곳 전부를 위 함수로): `web/src/ui/chatLogic.js:64`, `chatPanel.js:47`, `detail.js:187,202`, `homeList.js:35,253`, `hud.js:59`, `panel.js:68,169`, `saveModal.js:97`, `search.js:20`. (`planetForm.js`의 색 견본 · `characterLogic.js` · `three/planets.js`의 `colorOf`는 행성 색이 아니라 팔레트라 그대로.)
- Modify: `web/src/ui/panel.js` (`listHtml` 머리: ✎ 버튼 · ⋯ 메뉴 숨김, 잠금 안내 줄)
- Modify: `web/src/ui/hud.js:314` (왼쪽 행성 목록의 ⋯ 버튼), `web/src/ui/homeList.js:129` (홈 행성 목록의 ⋯ 버튼)
- Modify: `web/src/styles/app.css` (`.lockline` 한 줄)
- Test: `web/src/test/planetLogic.test.js`, `web/src/test/util.test.js`

**Interfaces:**
- Consumes: `isUnsorted`(Task 3)
- Produces:
  - `export const UNSORTED_FACE = '#4c5b6b'`, `export const UNSORTED_DEEP = '#26303c'`, `export function planetFace(planet, fallback = '#7a6cff'): string`, `export function planetDeep(planet, fallback = ''): string` (`web/src/util.js`). 미분류면 슬레이트, 아니면 `PLANET_COLORS[color_index]`, 없으면 fallback.
  - `export function planetLocked(planet): boolean` (`web/src/ui/planetLogic.js`, `isUnsorted` 감쌈 — UI 파일들이 이것 하나만 본다)
- 공통 규칙: 행성이 나오는 모든 목록 · 선택 칸(왼쪽 목록, 홈 행성 필터, 저장 창, 옮기기 확인 창, 챗봇 제외 설정)에서 미분류는 맨 위. 서버가 slot 순(미분류 -1)으로 주므로, 다른 기준으로 다시 정렬하는 곳이 있으면 미분류를 앞에 고정한다.

- [ ] **Step 1: 실패하는 테스트** — `planetLocked({ id: 'unsorted' }) === true`, `planetLocked({ id: 'a' }) === false`, `planetLocked(null) === false`; `planetFace({ id: 'unsorted', color_index: 1 }) === '#4c5b6b'`, `planetFace({ id: 'a', color_index: 1 }) === '#ff7a59'`, `planetFace(null) === '#7a6cff'`, `planetDeep({ id: 'unsorted' }) === '#26303c'`
- [ ] **Step 2: 실패 확인** — `npx vitest run web/src/test/planetLogic.test.js`
- [ ] **Step 3: 구현** — 잠긴 행성이면: 패널 머리의 ✎(`data-act="edit"`)와 ⋯(`data-act="menu"`)를 그리지 않고, `.body` 맨 위에 `<div class="lockline">기본 행성이라 이름을 바꾸거나 지울 수 없어요</div>`. 왼쪽 · 홈 행성 목록은 ⋯ 버튼을 그리지 않는다(자리는 비워 정렬을 맞춘다). `openPlanetMenu`들은 혹시 불려도 잠긴 행성이면 바로 돌아간다. 다른 행성의 "합치기" · "지우기 → 별 옮길 곳" 목록에는 미분류가 그대로 나온다.
- [ ] **Step 4: 통과 확인 + 눈으로 확인**(미분류 패널에 ✎ · ⋯ 없음, 안내 줄 보임, 미분류가 어디서도 주황으로 나오지 않음)
- [ ] **Step 5: 커밋(승인 후)** — `feat(web): unsorted planet shown consistently and locked in planet lists`

### Task 6: 웹 UI — 여러 개 골라 옮기기(우주 패널 · 홈 목록)

우주 행성 패널과 홈 별 목록에 같은 고르기 모드를 둔다. 상태 계산 · 문구 · 서버 호출은 공통 함수 하나씩만 쓰고, 두 화면은 그리기와 누르기만 각자 한다.

**Files:**
- Modify: `web/src/ui/panel.js` (고르기 모드 상태 · 그리기 · 누르기 · Esc)
- Modify: `web/src/ui/homeList.js` (같은 고르기 모드. 홈은 여러 행성의 별이 섞여 보이므로 "다른 행성" 목록은 고른 별들이 모두 같은 행성일 때만 그 행성을 빼고, 섞였으면 전체 행성을 보인다. 이미 그 행성에 있는 별은 서버가 건너뛴다)
- Modify: `web/src/styles/home.css` (홈 목록 체크칸 · 아래 바, 우주 패널과 같은 모양)
- Modify: `web/src/ui/starActions.js` (`moveStars`)
- Modify: `web/src/ui/planetLogic.js` (`keepPicked`, `moveManyCopy`)
- Modify: `web/src/styles/app.css` (체크칸 · 아래 바)
- Test: `web/src/test/planetLogic.test.js`

**Interfaces:**
- Consumes: `api.moveStars`(Task 2)
- Produces:
  - `planetLogic.js`: `export function moveTargets(pickedStars: {planet_id}[], planets) → planets[]`(고른 별이 모두 한 행성이면 그 행성을 뺀 목록, 섞였으면 전체), `export function keepPicked(picked: Set<string>, stars: {id}[]) → Set<string>`(목록에 남은 것만), `export function moveManyCopy(n: number, others: {id,name}[]) → ask() 인자`(제목 `${n}개를 어느 행성으로 옮길까요?`, desc `옮기면 우주에서도 그 행성으로 날아가요.`, confirmLabel `${n}개 옮기기`, confirmKind `'yellow'`, select = `moveCopy`와 같은 모양)
  - `starActions.js`: `export async function moveStars(ids: string[], others) → Promise<string|null>`(옮긴 행성 id, 취소 · 실패면 null). 성공하면 `store.state.stars`의 planet_id를 먼저 고치고 토스트 `${n}개를 '${name}'(으)로 옮겼어요`, `store.reload()`. 실패는 `moveStar`와 같은 방식(`offline`이 아니면 `옮기지 못했어요`).

- [ ] **Step 1: 실패하는 테스트**

```js
expect([...keepPicked(new Set(['a', 'b', 'x']), [{ id: 'a' }, { id: 'b' }, { id: 'c' }])]).toEqual(['a', 'b']);
const c = moveManyCopy(3, [{ id: 'p', name: '독서 노트' }]);
expect(c).toMatchObject({ title: '3개를 어느 행성으로 옮길까요?', confirmLabel: '3개 옮기기', confirmKind: 'yellow' });
expect(c.select.value).toBe('p');
const ps = [{ id: 'unsorted' }, { id: 'a' }, { id: 'b' }];
expect(moveTargets([{ planet_id: 'unsorted' }, { planet_id: 'unsorted' }], ps).map((p) => p.id)).toEqual(['a', 'b']);
expect(moveTargets([{ planet_id: 'unsorted' }, { planet_id: 'a' }], ps).map((p) => p.id)).toEqual(['unsorted', 'a', 'b']);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** (`panel.js`)
  - 상태: `let picking = false; let picked = new Set();` 행성을 바꾸거나 패널을 닫으면 둘 다 초기화.
  - 목록 위 `.lbl` 줄 오른쪽에 `여러 개 고르기` 버튼(`data-act="pick"`, 별이 2개 이상이고 다른 행성이 있을 때만). 고르기 중에는 같은 자리가 `취소`.
  - 고르기 중: 각 행 앞에 체크칸(`role="checkbox"`, `aria-checked`), 행을 누르면 상세 대신 선택 토글, ⋯ 버튼 숨김. 패널 아래에 바 `<b>N</b>개 골랐어요` + `행성 옮기기`(0개면 disabled).
  - `행성 옮기기` → `moveStars([...picked], others)` → 성공하면 고르기 끝.
  - `renderList` 때마다 `picked = keepPicked(picked, stars)`.
  - Esc: 고르기 중이면 고르기부터 끝낸다(`registerEscape(20, …)` 안에서 메뉴 다음 순서).
  - 다시 그릴 때 초점 유지는 기존 `data-focus` 방식으로(`pick:${id}`, `pickbar`).
- [ ] **Step 4: 통과 확인** — `npx vitest run web/src/test` 전부 PASS
  - `homeList.js`도 같은 상태 · 버튼 · 바 · 문구로 만든다(목록 툴바에 `여러 개 고르기`, 행 앞 체크칸, 아래 바). 행성 필터 · 검색어 · 자주 찾음 · 더 보기로 목록이 바뀌면 `keepPicked`로 정리. 상세를 보고 있던 중이면 고르기를 켤 때 상세를 닫는다.
- [ ] **Step 5: 눈으로 확인** — (우주) 미분류 별 3개를 골라 옮기면 먼지 3알이 그 행성으로 날아가 별이 되고 토스트가 뜬다. 고르는 중에 기간을 바꿔도 오류가 없다. (홈) 행성 필터 "미분류"에서 2개를 골라 옮기면 목록에서 빠지고 토스트가 뜬다. 캡처 각 1장.
- [ ] **Step 6: 커밋(승인 후)** — `feat(web): pick several stars in a planet panel and move them at once`

### Task 7: 문서 — DESIGN.md

**Files:**
- Modify: `DESIGN.md` (행성 · 3D · 패널 장에 미분류 행성, 먼지, 고르기 모드, 별 클릭 없음 반영)

- [ ] **Step 1:** spec의 결정 1~8을 해당 장에 짧게 넣고, 별 클릭으로 상세가 열린다는 기존 문장을 지운다(`grep -n "별을 누르" DESIGN.md`로 찾는다).
- [ ] **Step 2:** `npm test` 전체 PASS 확인
- [ ] **Step 3: 커밋(승인 후)** — `docs(design): unsorted planet, dust band, multi-move`

---

## 추가 (2026-11-26, 사용자 요청): 여러 개 지우기 · 전체 선택 체크칸 · 고르는 중 "물어보기" 숨김

사용자 결정: 전체 선택은 표 머리의 **체크칸 하나**(모두 고름 ✓ / 일부 − / 없음 빈칸, 누르면 전체 선택 ↔ 선택 해제), 범위는 **지금 보이는 목록만**(홈은 "더 보기"로 불러온 줄까지, 패널은 패널 목록), 고르는 동안 **"물어보기" 버튼 숨김**, **홈 목록 · 우주 패널 둘 다**. 버튼 이름은 "지우기".

### Task 8: 서버 — 별 여러 개 지우기

**Files:**
- Modify: `server/stars.js` (라우트 `POST /api/stars/delete`)
- Modify: `web/src/api.js` (`deleteStars`)
- Test: `server/test/stars.test.js`

**Interfaces:**
- Produces: `POST /api/stars/delete` body `{ ids: string[] }` → `200 { deleted: number }`. ids 검사는 `/api/stars/move`와 같다(배열 · 1~500개 · 문자열, 아니면 `400 invalid_ids`). 없는 id · 중복은 건너뛰고 세지 않는다. 웹 `api.deleteStars(ids) → Promise<{ deleted }>`.
- 동작은 단일 `DELETE /api/stars/:id`와 같게: 한 트랜잭션에서 지울 별 행과 첨부를 읽고 `recordRemovals(db, ids, inFlight)` 후 DELETE, 커밋 뒤 `app.ragSync?.markStars(deletedIds, 'delete')`, 그다음 별마다 `app.removeStarFiles(row)`(실패는 console.error만, 삭제는 이미 끝남). ids 검사 함수는 move와 하나로 나눠 쓴다.

- [ ] **Step 1: 실패하는 테스트** — 3개 지우기 → `{deleted:3}`, DB에서 사라짐, `markStars` 인자 `[[ids,'delete']]`, `removeStarFiles`가 별마다 불림; 없는 id · 중복 섞기 → 실제 지운 수만; 잘못된 body → 400 `invalid_ids`, 아무것도 안 지워짐.
- [ ] **Step 2: 실패 확인** — `npx vitest run server/test/stars.test.js`
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인 + `npx vitest run server`**
- [ ] **Step 5: 커밋(승인 후)**

### Task 9: 웹 — 전체 선택 체크칸 · 지우기 버튼 · 물어보기 숨김 · 좁은 화면 배치

**Files:**
- Modify: `web/src/ui/planetLogic.js` (`pickAllState`, `toggleAll`, `pickBarHtml`에 지우기 버튼, `deleteManyCopy`, `deleteManyToast`)
- Modify: `web/src/ui/starActions.js` (`deletePickedStars`)
- Modify: `web/src/ui/panel.js`, `web/src/ui/homeList.js` (머리 체크칸, 지우기 연결, 고르기 시작 · 끝에서 물어보기 숨김 토글)
- Modify: `web/src/styles/app.css`, `web/src/styles/home.css`, `web/src/styles/chat.css`(숨김 규칙)
- Test: `web/src/test/planetLogic.test.js`

**Interfaces:**
- Consumes: `api.deleteStars`(Task 8)
- Produces (`planetLogic.js`):
  - `pickAllState(pickedIds: Set<string>, visibleIds: string[]) → 'all' | 'some' | 'none'` (보이는 것이 0개면 'none')
  - `toggleAll(pickedIds, visibleIds) → Set<string>` ('all'이면 빈 Set, 아니면 보이는 것 전부)
  - `pickAllHtml({ state, focusAttr }) → string` — `role="checkbox"`, `aria-checked`는 'true' | 'mixed' | 'false', `aria-label="보이는 별 모두 고르기"`, 일부일 때 '−' 표시. 행 체크칸과 같은 모양.
  - `pickBarHtml({ count, focusAttr })` — 오른쪽에 `[행성 옮기기]`(노랑) 다음 `[지우기]`(흰 바탕 · 분홍 글자, `data-act="pickdel"`), 0개면 둘 다 잠김.
  - `deleteManyCopy(n, copies) → ask() 인자` — 제목 `${n}개를 지울까요?`, desc는 copies>0이면 `기록과 첨부 파일 ${copies}개의 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.`, 아니면 `기록 ${n}개가 지워져요. 되돌릴 수 없어요.`, confirmLabel `${n}개 지우기`, confirmKind `'pink'`.
  - `deleteManyToast(deleted) → string` — `${deleted}개를 지웠어요`, 0이면 `그 별들은 이미 지워졌어요`.
- `starActions.js`: `deletePickedStars(pickedIds) → Promise<number|null>` — 확인 창(copies는 고른 별들의 `attachment_count`가 아니라 파일 · 그림 첨부 수: 목록 별에 정보가 없으면 `api.star(id)`로 받지 말고, 목록에 있는 `file_count`/`attachments` 등 이미 있는 값으로 셀 수 있으면 세고, 없으면 copies 0 문구 대신 `기록 N개와 첨부 파일의 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.`를 쓴다 — 구현자가 목록 데이터에 있는 필드를 확인해 결정하고 보고), 성공하면 `store.state.stars`에서 빼고 토스트, `store.reload()`. 실패는 `지우지 못했어요. 다시 눌러 주세요`(offline 제외).
- 물어보기 숨김: 고르기를 켜면 `document.body.classList.add('picking')`, 끝나면(취소 · 옮기기/지우기 성공 · 패널 닫힘 · 홈 떠남 · 행성 바뀜) 뺀다. 두 화면이 같은 함수(`setPickingUi(on)` 같은 것, planetLogic이 아닌 DOM 헬퍼라 starActions.js나 작은 새 함수로)를 쓴다. CSS: `body.picking #chatBtn{display:none}`. 고르기 바의 물어보기용 오른쪽 여백(home.css `.pickbar` padding-right calc)은 지운다.
- 좁은 화면(≤760px): 아래 바를 두 줄로 — 위 줄 "N개 골랐어요", 아래 줄 [행성 옮기기 | 지우기]를 반반 넓게(누르기 쉽게, 높이 ≥44px). 우주 패널의 바는 패널 폭이 좁으니 늘 이 두 줄 배치.
- 홈 목록 머리: 고르기 중에는 ☆ 칸 머리 자리에 전체 선택 체크칸, 오른쪽에 `취소`. 패널: 목록 라벨 줄 왼쪽에 전체 선택 체크칸, 오른쪽 `취소`.

- [ ] **Step 1: 실패하는 테스트** — pickAllState(none/some/all/보이는 0개), toggleAll(일부→전부, 전부→빈 Set, 보이지 않는 고른 id는 전부 선택 시 결과에 남지 않음), pickAllHtml aria-checked 3가지, pickBarHtml에 지우기 버튼과 잠김, deleteManyCopy 두 문구 · 라벨, deleteManyToast 두 경우.
- [ ] **Step 2: 실패 확인** — `npx vitest run web/src/test/planetLogic.test.js`
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인 + `npx vitest run` + vite build(임시 outDir)**
- [ ] **Step 5: 커밋(승인 후)**
