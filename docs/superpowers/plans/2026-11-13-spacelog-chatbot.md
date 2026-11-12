# spaceLog 2차 · 기록 챗봇 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 별(기록 · 첨부)을 색인해 챗봇으로 찾고 · 묻고 · 요약하는 기능을, 수업의 파이썬 LangChain RAG 방식으로 붙인다.

**Architecture:** 브라우저는 지금처럼 Node 서버(4747)만 부른다. Node가 파이썬 Flask RAG 서버(`rag/`, 127.0.0.1:4748, 토큰 필요)를 자식 프로세스로 띄우고, 별이 바뀌면 색인을 맡기고, 질문은 Node의 "답 작업"이 파이썬에서 흘러오는 글자를 메시지에 저장하며 브라우저에 다시 흘려 보낸다. 대화 · 설정 · 색인 상태는 Node의 SQLite에, 벡터 색인은 파이썬이 `<데이터 폴더>/rag/index.json`에 둔다.

**Tech Stack:** Node 22+ · Fastify 5 · better-sqlite3 · Vitest / Python 3.11+ · Flask · langchain-core(`InMemoryVectorStore`, `DeterministicFakeEmbedding`, `GenericFakeChatModel`) · langchain-openai(`OpenAIEmbeddings`, `ChatOpenAI`) · langchain-text-splitters(`RecursiveCharacterTextSplitter`) · python-dotenv · pypdf · python-docx · openpyxl · python-pptx · pytest / 화면은 지금 그대로(Vite, 순수 JS).

**Spec:** [docs/superpowers/specs/2026-11-13-spacelog-chatbot-design.md](../specs/2026-11-13-spacelog-chatbot-design.md). 구현자는 스펙 전체와, 화면 규칙인 [DESIGN.md](../../../DESIGN.md) §3 · §4 · §13, 1차 스펙 §6-8 ~ §6-10을 읽는다.

## Global Constraints

- 파이썬 서버는 `127.0.0.1`에만 연다. 모든 요청은 헤더 `X-Spacelog-Token: <토큰>`이 맞아야 하고, 아니면 401. 토큰은 Node가 켤 때마다 `crypto.randomBytes(24)`로 만들어 환경 변수 `SPACELOG_RAG_TOKEN`으로 넘긴다.
- 포트: 파이썬 기본 4748, `SPACELOG_RAG_PORT`로 바꿀 수 있다. 데이터 폴더는 Node와 같은 `SPACELOG_DATA`.
- `.env`(프로젝트 루트)의 `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_EMBED_MODEL`(기본 `text-embedding-3-small`)을 파이썬만 읽는다. Node와 브라우저는 키 값을 절대 받거나 보내지 않는다(상태만: `key: true|false`).
- **챗봇이 꺼져 있으면(기본) 파이썬에 색인 · 답 요청을 하나도 보내지 않는다.** 빼 둔 행성의 별은 색인 요청을 보내지 않고, 검색 필터로 한 번 더 막는다.
- 테스트는 OpenAI를 절대 부르지 않는다: 파이썬은 `SPACELOG_FAKE_MODELS=1`이면 `DeterministicFakeEmbedding(size=64)`와 가짜 채팅 모델을 쓴다. Node 테스트는 가짜 RAG 클라이언트를 주입한다.
- 파이썬이 없거나 실패해도 Node와 화면의 다른 기능은 그대로 동작한다.
- 문구: 해요체, 느낌표 · 이모지 없음, "보내기 · 전송 · 발사" 대신 "묻기 · 띄우기". 화면에 들어가는 사용자 · 모델 글은 모두 `esc()`.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 파일은 경로를 지정해 `git add` 한다(`D22_*.html`은 무시 목록에 있다).
- 프로세스: 자기가 띄운 프로세스만 그 PID로 끈다. 4747 · 5173 · 4748은 사용자가 쓰고 있을 수 있다. 수동 확인은 다른 포트와 새 임시 데이터 폴더로 한다. `/api/attachments/:id/open|reveal`은 실제 서버에 보내지 않는다.

## Review Focus

1. **키 · 기록 유출**: 챗봇을 켜기 전, 빼 둔 행성, 챗봇을 끈 뒤 — 어느 경우에도 OpenAI 요청이 나가지 않아야 한다. (Task 3, Task 5 테스트)
2. **파이썬이 죽거나 늦게 뜰 때**: Node가 재시작을 시도하고, 그동안 색인 요청은 대기열에 남고, 답 작업은 `failed`로 끝나며 화면은 원인을 보여 준다. (Task 1, Task 3, Task 5)
3. **답 작업 중 Node 재시작 · 브라우저 새로고침**: `running` 메시지가 영원히 남지 않고, 새로고침 뒤 진행 중인 답을 다시 구독할 수 있다. (Task 5)
4. **출처 위조**: 모델이 준 적 없는 조각 번호를 말해도 카드가 생기지 않고, 쓴 번호가 없으면 "기록에서 찾지 못했어요"가 된다. (Task 4)
5. **큰 파일 · 깨진 파일**: 암호 걸린 PDF, 깨진 docx, 200,000자를 넘는 글이 서버를 죽이지 않고 상태에 원인을 남긴다. (Task 2)

---

## File Structure

```
rag/
  requirements.txt     flask langchain-core langchain-openai langchain-text-splitters python-dotenv pypdf python-docx openpyxl python-pptx pytest
  app.py               Flask 앱 만들기(create_app(config)), 토큰 검사, 경로 등록, __main__ 에서 127.0.0.1:포트로 실행
  config.py            환경 변수 · .env 읽기 → Config(data_dir, port, token, key_present, model, embed_model, fake)
  models.py            get_embeddings(cfg), get_chat(cfg) — 가짜/진짜 고르기
  extract.py           extract_text(path, ext) -> (text, note)  (note: None | 'partial' | 'unsupported' | 'error:<이유>')
  index.py             StarIndex: 조각 만들기 · 넣기 · 지우기 · 찾기 · 모아 저장(dump)
  answer.py            plan_question(), run_find/run_ask/run_summarize/run_chat — 이벤트 생성기
  prompts.py           프롬프트 문자열
  tests/               pytest (conftest 가 SPACELOG_FAKE_MODELS=1, 임시 데이터 폴더)
server/rag/
  process.js           startRag({ dataDir, port, env }) → { client, stop(), status() }  (파이썬 자식 프로세스 · 재시작)
  client.js            createRagClient({ baseUrl, token, fetch }) → health/indexStar/removeStars/reset/stats/answer
  sync.js              색인 맞추기: rag_status 표, 대기열, 재시도, reconcile()
  chat.js              대화 · 메시지 · 답 작업 · 설정 라우트
  test/                (server/test/ 아래에 둔다) rag-sync.test.js, chat.test.js, rag-process.test.js
web/src/ui/
  chatButton.js        떠 있는 버튼(원자 그림 SVG) · 빨간 점
  chatPanel.js         창 · 탭 3개 · 처음 켜기 확인
  chatThread.js        대화 화면 · 흘려 받기 · 출처 카드 · 별로 저장
  chatLogic.js         순수 함수(테스트 대상)
  styles/chat.css
web/src/test/chatLogic.test.js
```

---

### Task 1: 파이썬 RAG 서버 뼈대와 Node가 띄우고 끄기 (스펙 9장 2-1)

**Files:**
- Create: `rag/requirements.txt`, `rag/config.py`, `rag/models.py`, `rag/app.py`, `rag/tests/conftest.py`, `rag/tests/test_app.py`, `server/rag/process.js`, `server/rag/client.js`, `server/test/rag-process.test.js`, `scripts/rag-setup.mjs`
- Modify: `package.json`(scripts), `server/app.js`, `server/index.js`, `.gitignore`(`rag/.venv/`, `__pycache__/`, `.pytest_cache/`)

**Interfaces:**
- Produces (파이썬): `GET /health` → `{ ok: true, key: bool, model: str, embed_model: str, fake: bool }`. 토큰이 틀리면 401 `{ error: 'unauthorized' }`.
- Produces (Node):
  - `startRag({ dataDir, port = 4748, pythonPath, env, spawn = child_process.spawn }) → { client, stop(): Promise<void>, status(): { state: 'off'|'starting'|'ready'|'missing'|'crashed', reason?: string } }`. 파이썬 실행 파일은 `rag/.venv/Scripts/python.exe`(Windows) 또는 `rag/.venv/bin/python`. 없으면 `state: 'missing'`, `reason: 'not_installed'`, 자식을 띄우지 않는다. 띄운 뒤 `/health`를 0.3초마다 최대 20초 확인해 `ready`. 예기치 않게 끝나면 `crashed` 후 2 · 5 · 15 · 60초 간격으로 다시 띄운다(최대 4번, 성공하면 초기화). Node가 꺼질 때 `stop()`이 자식을 끝낸다(Windows는 `child.kill()` 후 3초 안에 안 끝나면 `taskkill /pid <그 자식 pid> /T /F` — 그 자식 PID만).
  - `createRagClient({ baseUrl, token, fetch = globalThis.fetch }) → { health(), indexStar(payload), removeStars(ids), reset(), stats(), answer(body, { signal }) → AsyncIterable<event> }` — 실패는 `RagError { code: 'unavailable'|'bad_response'|'rag_error', status, detail }`.
  - `buildApp` 옵션 `rag`(가짜 주입용). 없으면 `index.js`가 `startRag`로 만든 것을 넘긴다. `app.rag` 데코레이터.
  - `GET /api/chat/status` → `{ rag: { state, reason }, key: bool|null }`(파이썬이 `ready`일 때만 `key`를 채운다).
- package.json scripts: `"rag:setup": "node scripts/rag-setup.mjs"`(파이썬 3.11+ 찾기 → `rag/.venv` 만들기 → `pip install -r rag/requirements.txt`; 못 찾으면 한국어로 설치 안내를 출력하고 종료 코드 1), `"rag:test": "node scripts/rag-test.mjs"`(venv의 python으로 `-m pytest rag/tests -q`). `npm test`는 그대로 Vitest만 돈다(파이썬 없는 PC에서도 통과).

- [ ] **Step 1: 실패하는 파이썬 테스트** (`rag/tests/test_app.py`): `test_health_requires_token`(토큰 없음 401, 틀림 401, 맞음 200), `test_health_reports_key_presence_without_value`(키를 넣고 응답 JSON에 키 값이 없는지, `key: true`), `test_fake_mode_flag`.
- [ ] **Step 2: `npm run rag:setup` 실행 → venv 생성 확인, `npm run rag:test` → FAIL 확인**
- [ ] **Step 3: `config.py` · `models.py` · `app.py` 구현 → PASS**
- [ ] **Step 4: 실패하는 Node 테스트** (`server/test/rag-process.test.js`, 가짜 `spawn`과 가짜 fetch 사용): 실행 파일 없음 → `missing`/`not_installed`, spawn 안 함 / health가 3번째에 성공 → `ready` / 자식이 끝나면 `crashed` → 2초 뒤 재시작(가짜 타이머) / `stop()`이 자식을 끝냄 / `GET /api/chat/status`가 상태를 돌려주고 키 값은 없음.
- [ ] **Step 5: `process.js` · `client.js` · 라우트 구현 → `npm test` PASS**
- [ ] **Step 6: 수동 확인** — 임시 데이터 폴더, 다른 포트(`PORT=4911 SPACELOG_RAG_PORT=4912`)로 `node server/index.js` 실행 → `GET /api/chat/status`가 `ready`, `key: true`(사용자의 .env 기준) → 서버 종료 후 파이썬 프로세스도 사라졌는지 확인. venv 폴더를 잠시 다른 이름으로 바꿔 `missing`도 확인하고 되돌린다.
- [ ] **Step 7: Commit** `feat(rag): python rag service skeleton started and stopped by node`

---

### Task 2: 글 뽑기 · 자르기 · 색인 (파이썬) (스펙 4장)

**Files:**
- Create: `rag/extract.py`, `rag/index.py`, `rag/tests/test_extract.py`, `rag/tests/test_index.py`, `rag/tests/fixtures/`(작은 pdf · docx · xlsx · pptx · hwpx · 깨진 docx · 암호 pdf를 테스트가 만들거나 담는다)
- Modify: `rag/app.py`

**Interfaces:**
- `extract_text(path: str, ext: str, limit=200_000) -> tuple[str, str | None]`: txt · md · csv · json · log(utf-8, 실패하면 cp949), pdf(pypdf, 페이지 글 합침, 글이 거의 없으면 `('', 'no_text')`), docx(python-docx 문단 + 표), xlsx(openpyxl `read_only=True, data_only=True`, 시트마다 `## <시트>` 다음 행을 ` | `로), pptx(슬라이드마다 `## 슬라이드 n`), hwpx(zip 안 `Contents/section*.xml`의 글자 노드). 그 밖은 `('', 'unsupported')`. 예외는 잡아서 `('', 'error:<짧은 이유>')`. 길면 잘라서 `(text[:limit], 'partial')`.
- `StarIndex(data_dir, embeddings, chunk_size=800, chunk_overlap=100)`:
  - `upsert(star: dict) -> dict` — star = `{ id, planet_id, planet_name, title, body, memo, created_at, attachments: [{ id, kind, file_name, file_ext, url, link_title, path }] }`(path는 Node가 준 절대 경로). 별의 기존 조각을 지우고 새로 만든다. 조각 원문: `title` · `body` · `memo` · 링크(`link_title + url`) · 파일(이름 + 뽑은 글). 각 Document의 metadata: `star_id, planet_id, created_at, source('title'|'body'|'memo'|'link'|'file'), attachment_id, file_name, kind`. 조각 id `"<star_id>:<n>"`. 돌려주는 값 `{ chunks: int, notes: [{ attachment_id, note }] }`.
  - `remove(star_ids: list[str]) -> int`, `reset() -> None`, `stats() -> { chunks, stars }`.
  - `search(query, k=8, star_filter=None) -> list[tuple[Document, float]]` — `similarity_search_with_score`에 `filter=lambda doc: ...` 로 planet · 기간 · 제외 행성을 거른다.
  - `chunks_for(star_ids) -> list[Document]` (요약용, star_id · n 순서).
  - 저장: 바뀌면 `_dirty`, 마지막 변경 5초 뒤 또는 `flush()`에서 `<data>/rag/index.json.tmp`에 `dump` → `os.replace`. 켤 때 파일이 있으면 `InMemoryVectorStore.load(path, embedding)`, 깨졌으면 `index.json.broken-<시각>`으로 옮기고 빈 색인으로 시작(로그).
- Flask: `POST /index`(body = star) → `{ chunks, notes }`, `POST /remove` `{ star_ids }`, `POST /reset`, `GET /stats`, `POST /flush`. 프로세스 종료 신호에서 `flush()`.

- [ ] **Step 1: 실패하는 테스트** (`test_extract.py`): 각 형식에서 기대 글자 포함 / 200,001자 → `partial` / 깨진 docx → `error:` / 암호 pdf → `error:` 또는 `no_text`(둘 다 허용, 예외로 죽지 않음) / hwp → `unsupported` / cp949 txt.
- [ ] **Step 2: 실패하는 테스트** (`test_index.py`, 가짜 임베딩): upsert 두 번 → 조각 수 그대로(교체) / remove 뒤 search에 안 나옴 / 메타데이터 필드 / planet 필터 · 기간 필터 · 제외 행성 필터 / flush 후 새 StarIndex가 load해 같은 조각 수 / 깨진 index.json → 옮기고 빈 색인 / 저장이 tmp → replace(중간에 tmp만 남아도 다음 로드가 성공).
- [ ] **Step 3: `npm run rag:test` → FAIL → 구현 → PASS**
- [ ] **Step 4: Flask 경로 테스트 추가 → PASS**
- [ ] **Step 5: Commit** `feat(rag): extract text from attachments and keep a per-star index`

---

### Task 3: Node 색인 맞추기 · 챗봇 설정 (스펙 4장 · 7장 설정)

**Files:**
- Create: `server/rag/sync.js`, `server/test/rag-sync.test.js`
- Modify: `server/db.js`(판 1→2: 2차의 표를 **한 번에** 만든다 — `rag_status`와 Task 5의 `conversations` · `messages`. 기존 DB면 옮기기 전에 `bak-2` 백업, 1차와 같은 규칙), `server/app.js`, `server/stars.js` · `server/planets.js` · `server/files.js`(변경 알림 한 줄씩), `server/rag/chat.js`(설정 라우트만 이 태스크에서)

**Interfaces:**
- 새 표: `rag_status (star_id TEXT PRIMARY KEY REFERENCES stars(id) ON DELETE CASCADE, content_hash TEXT, status TEXT NOT NULL CHECK(status IN ('pending','done','failed','skipped')), error TEXT, notes TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, indexed_at TEXT)`, 그리고 Task 5의 두 표(정의는 Task 5).
- 설정(`meta` 키 `chat`, JSON): `{ enabled: false, consented: false, excluded_planets: [] }`.
- `createSync({ db, dataDir, rag, now = Date.now, setTimer }) → { markStars(ids, reason), markPlanet(planetId), reconcile(), retryFailed(), reindexAll(), status(), start(), stop() }`:
  - `starPayload(id)` — 별 · 행성 이름 · 첨부(파일은 `path.resolve(dataDir, vault_path)`)를 스펙 Task 2 모양으로 만든다. `content_hash` = 그 payload(경로 제외, 파일은 `file_hash` 또는 크기+이름) JSON의 sha256.
  - 처리 순서: 챗봇 꺼짐 → 아무것도 안 보냄. 빼 둔 행성 → `skipped` + `rag.removeStars`. 지워진 별 → `rag.removeStars`. 그 밖 → `rag.indexStar` → `done`(notes 저장) 또는 `failed`(error, attempts+1, next_try_at = 1분 · 5분 · 30분, 이후 30분).
  - 한 번에 하나씩(동시성 1). 파이썬이 `ready`가 아니면 대기열에 남긴다.
  - `reconcile()`: 모든 별의 hash를 계산해 `rag_status`와 비교, 다른 것 · 없는 것 · 기한이 된 실패를 대기열에. 서버를 켤 때(챗봇이 켜져 있으면), 챗봇을 켤 때, 파이썬이 `ready`로 바뀔 때 부른다.
  - `status()` → `{ total, done, failed, pending, skipped, indexing: bool, last_indexed_at }`.
- 변경 알림: 별 만들기 · PATCH(title · memo · planet_id) · 지우기 → `app.ragSync.markStars([id])`. 행성 PATCH(이름) · 합치기 · 지우기 → 해당 별들. 데코레이터가 없으면(테스트) 아무 일도 하지 않게 `app.ragSync?.`.
- 라우트(`server/rag/chat.js`): `GET /api/chat/settings` → `{ enabled, consented, excluded_planets, key, rag: { state, reason }, index: status(), usage: { month: 'YYYY-MM', requests } }`. `PUT /api/chat/settings` `{ enabled?, consented?, excluded_planets? }` — `enabled: true`는 `consented: true`가 같은 요청이나 이전에 있어야 함(아니면 400 `consent_required`). 행성 id 검증(없는 id → 400 `unknown_planet`). 빼는 행성이 늘면 그 별들 즉시 `removeStars` + `skipped`. 켜면 `reconcile()`. `POST /api/chat/reindex` `{ scope: 'failed'|'all' }` — all은 `rag.reset()` 후 전부 `pending`.

- [ ] **Step 1: 실패하는 테스트** (가짜 rag 클라이언트가 호출을 기록): 꺼져 있으면 별을 만들어도 호출 0번 / 켜기 전 consent 없으면 400 / 켜면 기존 별 전부 indexStar / 빼 둔 행성 별은 호출 없음 + `skipped` / 행성을 나중에 빼면 removeStars / 같은 내용 재색인 안 함(hash) / 메모 바꾸면 다시 / 실패 → failed + next_try_at 1분(가짜 시계) → 재시도 성공 / 파이썬 unavailable이면 pending 유지 / 별 지우기 → removeStars / reindex all → reset 후 전부 / status 숫자.
- [ ] **Step 2: FAIL → 구현 → `npm test` PASS**
- [ ] **Step 3: Commit** `feat(server): keep the rag index in sync with stars and add chat settings`

---

### Task 4: 질문에 답하기 (파이썬) (스펙 5장)

**Files:**
- Create: `rag/answer.py`, `rag/prompts.py`, `rag/tests/test_answer.py`
- Modify: `rag/app.py`

**Interfaces:**
- `POST /answer` 요청: `{ question, history: [{ role, content }], context: { planet_id?, planet_name?, star_id? }, today: 'YYYY-MM-DD', tz_offset_min: int, excluded_planets: [], planets: [{ id, name }] }`. 응답: `application/x-ndjson` 줄 단위 이벤트:
  - `{"type":"plan","intent":"find|ask|summarize|chat","from":ISO|null,"to":ISO|null,"planet_id":id|null,"star_ids":[]}`
  - `{"type":"token","text":"..."}` (여러 번)
  - `{"type":"sources","stars":[{ "star_id", "attachment_id"|null, "file_name"|null }]}`
  - `{"type":"done","not_found":bool}` 또는 `{"type":"error","code":"key_missing|openai_error|too_broad|internal","message":"..."}`
- `plan_question(chat, req) -> Plan`: 모델에게 JSON만 내게 하고(프롬프트에 오늘 날짜 · 행성 목록 · 맥락), 파싱 실패 · 알 수 없는 intent는 `ask`, 모르는 행성 id · 잘못된 날짜는 `null`로. "이 행성" · "이 별"은 context로 채운다.
- 검색: `k=8`, 점수 기준 `MIN_SCORE`(기본 0.25, 가짜 임베딩 테스트에 맞춰 조정 가능하게 설정값) 미만 버림, 필터는 plan + excluded.
- `find`: 남은 조각의 별을 중복 없이 최대 8개 → `sources` → 짧은 안내 한 문장(`"찾은 별 N개예요."`, 모델 호출 없음) → done.
- `ask`: 조각이 없으면 `"기록에서 찾지 못했어요."` 토큰 + `done(not_found=true)`, 모델 호출 없음. 있으면 `[1] … [n]` 번호 붙인 조각과 수업의 원칙(조각만 보고 답 · 없으면 모른다 · 해요체)으로 답을 흘려 보내고, 마지막 줄에 `사용한 조각: 1, 3` 형식을 내게 한다. 코드는 이 마지막 줄을 화면 글에서 떼어 내고(흘려 보내는 중에도 이 줄은 내보내지 않는다), 실제로 준 번호만 출처로. 쓴 번호가 없으면 답 대신 "기록에서 찾지 못했어요." 하나로 바꾼다(이미 보낸 토큰은 `{"type":"replace","text":...}` 이벤트로 덮는다).
- `summarize`: 대상 별(plan.star_ids, 또는 planet · 기간으로 Node가 아니라 색인 메타데이터에서 고른 별)의 `chunks_for` 전부. 200개 별 초과 → `error too_broad`. 글자 수 합이 24,000자 이하면 한 번에, 넘으면 12,000자 묶음마다 요약 → 합쳐 최종 요약. 출처는 대상 별 전부(최대 20개, 그 이상은 개수만 안내).
- `chat`: 기록을 찾지 않고 짧게 답(`prompts.HELP`의 사용법 안내 근거).
- 키가 없으면 첫 이벤트로 `error key_missing`.

- [ ] **Step 1: 실패하는 테스트** (가짜 임베딩 + 계획 · 답을 미리 정해 둔 가짜 채팅 모델): find가 맞는 별 카드 / ask에서 모델이 `사용한 조각: 2`라고 하면 출처가 조각 2의 별만, 그 줄은 화면 글에 없음 / 준 적 없는 번호 `9` → 무시 / 번호 0개 → replace로 "찾지 못했어요" / 조각 없음 → 모델 호출 0번 / 제외 행성 조각은 검색 결과에 없음 / 기간 필터 / summarize 큰 범위 → 묶음 요약 호출 횟수 / 201개 → too_broad / plan JSON 깨짐 → ask로 / "이 행성 요약" + context → planet_id 채움 / 키 없음 → key_missing.
- [ ] **Step 2: FAIL → 구현 → PASS**
- [ ] **Step 3: Commit** `feat(rag): answer find/ask/summarize with code-attached sources`

---

### Task 5: 대화 저장과 답 작업 (Node) (스펙 6장 · 5장 5항)

**Files:**
- Modify: `server/rag/chat.js` (표는 Task 3의 판 2 마이그레이션에서 이미 만들었다)
- Create: `server/test/chat.test.js`

**Interfaces:**
- 표: `conversations (id TEXT PK, title TEXT NOT NULL, created_at, updated_at, unread INTEGER NOT NULL DEFAULT 0)`, `messages (id TEXT PK, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('running','done','stopped','failed')), error TEXT, created_at TEXT NOT NULL)`, 인덱스 `(conversation_id, created_at)`.
- 라우트:
  - `GET /api/chat/conversations` → `[{ id, title, updated_at, unread, last: { role, preview } }]` 최신순.
  - `POST /api/chat/conversations` → 빈 대화(제목 '새 대화'). `DELETE /api/chat/conversations/:id`(running 답이 있으면 먼저 멈춤).
  - `GET /api/chat/conversations/:id` → `{ conversation, messages }`, 그리고 `unread = 0`.
  - `POST /api/chat/conversations/:id/messages` `{ question, context }` → 202 `{ user_message, assistant_message }`. 조건: 챗봇 켜짐(아니면 409 `chat_off`), 파이썬 ready(아니면 503 `rag_unavailable`), 다른 답이 running이면 409 `busy`. 질문 1~2,000자. 첫 질문이면 제목 = 질문 앞 30자.
  - `GET /api/chat/messages/:id/stream` → SSE(`text/event-stream`): 지금까지의 `content`를 `snapshot`으로 먼저 보내고, 이후 `token` · `replace` · `sources` · `done` · `error`. 끝난 메시지면 snapshot + done만.
  - `POST /api/chat/messages/:id/stop` → 작업 중단, `status: 'stopped'`.
  - `GET /api/chat/unread` → `{ count }`.
- 답 작업 `runAnswer(messageId)`: 설정의 `excluded_planets`, 행성 목록, `today`(요청이 보낸 사용자 현지 날짜), 같은 대화 마지막 6개 메시지를 담아 `rag.answer()`를 소비. 토큰은 메모리에 이어 붙이고 0.5초마다 DB에 저장, 구독자(SSE)에게 바로 전달. done/error에서 최종 저장, sources는 지금 있는 별만 남겨 저장(별 카드에 쓸 `title`, `planet_id`, `created_at`은 응답 때 붙인다). 창이 그 대화를 보고 있지 않으면(구독자가 없으면) `unread = 1`. 매 답마다 `usage` 월 카운터 +1(`meta` 키 `chat_usage`).
- 서버를 켤 때 `running`인 메시지는 `failed`, error `'interrupted'`.
- 메시지 응답 JSON의 sources는 `[{ star_id, attachment_id, file_name, exists, title, planet_id, created_at }]`.

- [ ] **Step 1: 실패하는 테스트** (가짜 rag.answer가 이벤트를 정해진 간격으로 냄): 꺼져 있으면 409 / 질문 → 202, SSE로 토큰들 · sources · done / 중간에 SSE를 끊고 다시 붙으면 snapshot부터 이어짐 / stop → stopped, 이후 토큰 저장 안 됨 / 두 번째 질문 busy 409 / 구독자 없이 끝나면 unread 1, GET하면 0 / error 이벤트 → failed + error / 서버 재시작 시 running → failed / 지워진 별의 sources는 exists false / 대화 지우면 메시지도 / 제목 30자 / usage 증가 / history 6개만 전달.
- [ ] **Step 2: FAIL → 구현 → PASS**
- [ ] **Step 3: Commit** `feat(server): conversations, messages and background answer jobs`

---

### Task 6: 챗봇 화면 (스펙 7장)

**Files:**
- Create: `web/src/ui/chatButton.js`, `web/src/ui/chatPanel.js`, `web/src/ui/chatThread.js`, `web/src/ui/chatLogic.js`, `web/src/styles/chat.css`, `web/src/test/chatLogic.test.js`
- Modify: `web/index.html`(마크업), `web/src/main.js`(초기화 · CSS), `web/src/api.js`(챗봇 API 함수), `web/src/ui/hud.js`/`home.js`(기록하기 버튼 위치), `web/src/ui/escape.js`(우선순위), `web/src/util.js`(필요 아이콘)

**Interfaces:**
- `api.chatStatus()`, `api.chatSettings()`, `api.saveChatSettings(patch)`, `api.reindex(scope)`, `api.conversations()`, `api.createConversation()`, `api.conversation(id)`, `api.deleteConversation(id)`, `api.ask(conversationId, { question, context })`, `api.stopAnswer(messageId)`, `api.unread()`, `api.streamAnswer(messageId, { onSnapshot, onToken, onReplace, onSources, onDone, onError }) → close()`(`EventSource`).
- `chatLogic.js`(테스트 먼저): `contextFor(state) → { planet_id, planet_name, star_id }`(열린 패널 · 상세), `quickQuestions(state) → string[]`(홈 탭 버튼 3개 규칙), `indexLine(status, now) → string`(스펙 7장 문구: "챗봇이 읽은 기록: 별 132개 중 130개 · 마지막으로 읽은 시각 오후 3:20", "읽는 중… 45 / 132", 실패 문구), `sourceCardModel(source, planets) → { title, color, date, file, gone }`, `unavailableMessage(status) → string`(파이썬 없음: "챗봇을 준비하지 못했어요. README의 챗봇 설치 순서를 따라 주세요", 키 없음: "OpenAI 키가 없어요. .env 파일에 키를 넣고 서버를 다시 켜 주세요", 꺼짐 · 재시작 중 등), `canSend({ text, composing, busy, enabled }) → bool`, `titleFrom(question)`.
- 버튼: `#chatBtn`, 오른쪽 아래 맨 구석(`right: var(--edge)`), 기록하기(`#wLog`, `#hLog` 쪽 W-00 버튼 위치 규칙은 그대로)는 그 왼쪽으로. 원자 그림은 인라인 SVG: 보라 원 · 3px 잉크 테두리 · 가운데 노란 별(5각) · 흰 타원 궤도 3줄(60° 간격), 궤도 그룹이 천천히 회전(CSS, 20초 한 바퀴, 모션 줄이기면 멈춤). 열리면 ✕ 아이콘. 빨간 점 `.dot`.
- 창: `#chatPanel` (z-index 41 — 행성 패널과 같은 층으로 두고 "나중에 연 것 위" 규칙은 둘 중 열릴 때 `data-front` 갱신으로 처리, 대화상자 42+보다 아래), 폭 380px · 최대 높이 75vh, 760px 이하 전체 화면. 탭 홈 / 대화 / 설정. Esc 우선순위 25(드로어 35와 상세 30 사이 — escape.js 주석 순서 갱신).
- 처음 켜기 확인: 스펙 7장 문구 + 행성 체크 목록 + 취소 · 켜기 → `saveChatSettings({ consented: true, enabled: true, excluded_planets })`.
- 대화 화면: 말풍선, 입력칸(Enter 보내기 — `isComposing`이면 무시, Shift+Enter 줄바꿈), 답 중 "멈추기". 답 말풍선은 텍스트만(`textContent`, 줄바꿈 보존 — 마크다운 렌더링 안 함). 출처 카드 클릭: 우주면 `flyTo(planet_id, star_id)` → `store.emit('openStar', …)`(기간 밖이면 손님 별 규칙 그대로, hud의 함수 사용), 홈이면 `enterWorld({ planetId, starId })`. 좁은 화면이면 창 닫기. "별로 저장": `openSave({ text: 답 내용 })`(쓰던 글이 있으면 기존 규칙대로 덮어쓰지 않음).
- 설정 탭: 켜기 · 끄기 스위치, 빼 둘 행성 체크 목록(바꾸면 저장), 키 상태, 색인 줄 + [다시 시도] · [처음부터 다시 읽기](확인 창), 이번 달 요청 수, OpenAI 안내 문구.
- 빨간 점: 버튼 · 대화 탭 · 목록 항목. 30초마다 `api.unread()`(창이 열려 있고 대화를 보고 있으면 생략), 답 작업을 구독 중이면 끝날 때 바로 갱신.

- [ ] **Step 1: `chatLogic.test.js` 실패하는 테스트 → 구현 → PASS**
- [ ] **Step 2: 마크업 · CSS · 모듈 구현**
- [ ] **Step 3: 브라우저 확인**(자기 포트 · 새 임시 데이터 폴더, `SPACELOG_FAKE_MODELS=1`로 파이썬을 가짜 모델로 띄워 비용 없이): 버튼 위치 · 원자 그림(스크린샷 확인), 처음 켜기 확인 → 켜기, 빼 둔 행성, 질문 → 글자가 차례로, 출처 카드 → 별로 날아감, 홈에서 카드 → 전환 후 날아감, 멈추기, 창 닫고 답 끝 → 빨간 점, 새로고침 중 답 이어 보기, 대화 목록 · 지우기, 별로 저장, 설정 색인 줄, 파이썬 없음 · 키 없음 문구, 760px 이하, 모션 줄이기, 키보드만으로 조작.
- [ ] **Step 4: Commit** `feat(web): chat button, panel, threads, sources and settings`

---

### Task 7: 마무리 (스펙 7장 문구 · 9장 2-6)

**Files:**
- Modify: `README.md`(챗봇 설치 순서: 파이썬 3.11+, `npm run rag:setup`, `.env`, 켜는 법, 비용 · 개인정보 안내, `npm run rag:test`), `DESIGN.md` 원칙 4 문구, 1차 스펙의 해당 문구

- [ ] **Step 1: 문서 갱신**
- [ ] **Step 2: `npm test`, `npm run rag:test`, `npm run build` 모두 통과**
- [ ] **Step 3: 실제 키 확인 — 사용자에게 먼저 묻고(비용 발생) 승인받은 뒤에만**: 임시 데이터 폴더에 예시 별 몇 개(글 · PDF · 링크)를 넣고 실제 모델로 찾기 · 묻기 · 요약 · 없는 질문 각 1개. 결과를 보고한다.
- [ ] **Step 4: Commit** `docs: chatbot setup and privacy notes`
