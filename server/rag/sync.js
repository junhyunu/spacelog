// 챗봇 색인 맞추기(스펙 4장). 별이 바뀌면 파이썬 색인에 하나씩 다시 보낸다.
// 원칙: 챗봇이 꺼져 있으면 파이썬에 아무 요청도 보내지 않는다. 빼 둔 행성의 별은 색인하지 않는다.
// 상태는 rag_status 표에, 지워야 할 별 id 는 meta 'rag_removals' 에(별 행이 지워지면 rag_status 도 사라지므로) 남긴다.
// 지울 목록은 별을 지우는 트랜잭션 안에서 적는다(recordRemovals). 커밋 뒤 서버가 꺼져도 잃지 않는다.
import crypto from 'node:crypto';
import path from 'node:path';

export const DEFAULT_CHAT_SETTINGS = Object.freeze({ enabled: false, consented: false, excluded_planets: [] });
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
export const INDEX_TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;
const KEY_MISSING = 'key_missing';

// --- meta 읽고 쓰기 ---
function readMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function deleteMeta(db, key) {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}
function readJson(db, key) {
  const raw = readMeta(db, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 설정(meta 'chat'). 없어진 행성 id 는 빼고 돌려준다.
export function readSettings(db) {
  const raw = readJson(db, 'chat');
  const src = raw && typeof raw === 'object' ? raw : {};
  const ids = Array.isArray(src.excluded_planets) ? src.excluded_planets.filter((x) => typeof x === 'string') : [];
  const exists = db.prepare('SELECT 1 FROM planets WHERE id = ?');
  return {
    enabled: src.enabled === true,
    consented: src.consented === true,
    excluded_planets: [...new Set(ids)].filter((id) => exists.get(id) !== undefined),
  };
}

export function writeSettings(db, settings) {
  writeMeta(db, 'chat', JSON.stringify({
    enabled: settings.enabled === true,
    consented: settings.consented === true,
    excluded_planets: [...settings.excluded_planets],
  }));
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

// 이번 달 요청 수(meta 'chat_usage' = { month, requests }). 지난 달 값이면 0. Task 5 가 늘린다.
export function readUsage(db, now = Date.now) {
  const month = monthOf(now());
  const raw = readJson(db, 'chat_usage');
  if (raw && raw.month === month && Number.isInteger(raw.requests) && raw.requests >= 0) return { month, requests: raw.requests };
  return { month, requests: 0 };
}

// --- 지울 별 목록(meta 'rag_removals') ---
// 색인에 보낸 적이 있는 별만 담는다. 그래도 한없이 커지지 않게 오래된 것부터 버린다.
export const REMOVALS_MAX = 10_000;

export function readRemovals(db) {
  const v = readJson(db, 'rag_removals');
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

export function addRemovals(db, ids, log = console) {
  if (!ids.length) return;
  const set = new Set(readRemovals(db));
  for (const id of ids) set.add(id);
  let list = [...set];
  if (list.length > REMOVALS_MAX) {
    const dropped = list.length - REMOVALS_MAX;
    list = list.slice(dropped);
    log.warn?.(`[rag-sync] rag_removals over ${REMOVALS_MAX}: dropped the ${dropped} oldest id(s)`);
  }
  writeMeta(db, 'rag_removals', JSON.stringify(list));
}

// 색인에 보낸 적이 있는가: done · failed 행이 있거나, 지금 보내는 중인 별.
export function wasSent(db, id, inFlight = null) {
  if (id === inFlight) return true;
  const row = db.prepare('SELECT status FROM rag_status WHERE star_id = ?').get(id);
  return row?.status === 'done' || row?.status === 'failed';
}

// 별을 지우는 트랜잭션 안에서(별 행이 지워져 rag_status 가 사라지기 전에) 부른다.
// 커밋 뒤 서버가 꺼져도 지울 목록이 남는다. inFlight = app.ragSync?.inFlight().
export function recordRemovals(db, ids, inFlight = null) {
  addRemovals(db, ids.filter((id) => wasSent(db, id, inFlight)));
}

// --- 별 → 파이썬에 보낼 모양 ---
export function starPayload(db, dataDir, id) {
  const star = db
    .prepare('SELECT s.*, p.name AS planet_name FROM stars s JOIN planets p ON p.id = s.planet_id WHERE s.id = ?')
    .get(id);
  if (!star) return null;
  const atts = db.prepare('SELECT * FROM attachments WHERE star_id = ? ORDER BY position').all(id);
  return {
    payload: {
      id: star.id,
      planet_id: star.planet_id,
      planet_name: star.planet_name,
      title: star.title,
      body: star.body ?? null,
      memo: star.memo ?? '',
      created_at: star.created_at,
      attachments: atts.map((a) => ({
        id: a.id,
        kind: a.kind,
        file_name: a.file_name ?? null,
        file_ext: a.file_ext ?? null,
        url: a.url ?? null,
        link_title: a.link_title ?? null,
        // 글을 뽑는 것은 파일뿐이다(이미지는 이름만).
        path: a.kind === 'file' && a.vault_path ? path.resolve(dataDir, a.vault_path) : null,
      })),
    },
    // 해시에는 경로 대신 파일의 내용 해시(없으면 크기 + 이름)를 넣는다.
    fileKeys: atts.map((a) => (a.kind === 'link' ? null : a.file_hash ?? `${a.file_size ?? ''}:${a.file_name ?? ''}`)),
  };
}

// 파일 읽기 방식의 판(rag/extract.py). 새 형식을 읽게 되면 올린다 → 해시가 바뀌어 저장된 별을 다시 읽는다.
// 2: HTML(html · htm)
export const READER_VERSION = 2;

export function contentHash({ payload, fileKeys }) {
  const forHash = {
    reader: READER_VERSION,
    ...payload,
    attachments: payload.attachments.map(({ path: _p, ...a }, i) => ({ ...a, file: fileKeys[i] })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(forHash)).digest('hex');
}

// 색인 상태 숫자. 상태 행이 없는 별(아직 한 번도 보지 않은 별)은 pending 으로 센다.
export function indexCounts(db) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM stars').get();
  const counts = { done: 0, failed: 0, pending: 0, skipped: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM rag_status GROUP BY status').all()) counts[r.status] = r.n;
  return {
    total,
    done: counts.done,
    failed: counts.failed,
    pending: Math.max(0, total - counts.done - counts.failed - counts.skipped),
    skipped: counts.skipped,
    indexing: false,
    last_indexed_at: db.prepare('SELECT MAX(indexed_at) AS t FROM rag_status').get().t ?? null,
  };
}

const isKeyMissing =(err) => err?.code === 'rag_error' && err?.status === 503 && err?.detail === KEY_MISSING;
const isTimeout = (err) => err?.code === 'timeout' || (err?.code === 'unavailable' && /timeout|abort/i.test(String(err?.detail ?? '')));
const isUnavailable = (err) => err?.code === 'unavailable' && !isTimeout(err);

export function createSync({
  db,
  dataDir,
  rag,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  pollMs = POLL_MS,
  indexTimeoutMs = INDEX_TIMEOUT_MS,
  log = console,
}) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const client = () => rag?.client;
  const ready = () => rag?.status?.()?.state === 'ready';
  const enabled = () => readSettings(db).enabled;

  const queue = []; // 별 id, 먼저 들어온 것부터
  const queued = new Set();
  const dirty = new Set(); // 색인 중에 다시 바뀐 별
  let current = null;
  let pumping = false;
  let reconciling = false;
  let reconcileAgain = false;
  let running = false;
  let keyBlocked = false; // key_missing 을 받은 뒤: 설정이 바뀌거나 파이썬이 다시 ready 가 될 때까지 색인 요청을 보내지 않는다
  let generation = 0; // 색인을 비울(reset) 때마다 하나 늘린다
  let embedKey = null; // '<embed_model>|<fake>' (마지막 /health)
  let lastState = null;
  let pollTimer = null;
  let waiters = [];
  let removeFailures = 0; // /remove 가 잇달아 실패한 수
  let removeRetryAt = null; // 이 시각(ms) 전에는 /remove 를 다시 보내지 않는다

  const q = {
    row: db.prepare('SELECT * FROM rag_status WHERE star_id = ?'),
    exists: db.prepare('SELECT 1 FROM stars WHERE id = ?'),
    planetOf: db.prepare('SELECT planet_id FROM stars WHERE id = ?'),
    // 별이 그사이 지워졌으면 아무것도 쓰지 않는다(외래 키).
    upsert: db.prepare(`INSERT INTO rag_status (star_id, content_hash, status, error, notes, attempts, next_try_at, indexed_at)
      SELECT @star_id, @content_hash, @status, @error, @notes, @attempts, @next_try_at, @indexed_at
       WHERE EXISTS (SELECT 1 FROM stars WHERE id = @star_id)
      ON CONFLICT(star_id) DO UPDATE SET content_hash = excluded.content_hash, status = excluded.status,
        error = excluded.error, notes = excluded.notes, attempts = excluded.attempts,
        next_try_at = excluded.next_try_at, indexed_at = excluded.indexed_at`),
  };

  function write(starId, fields) {
    const prev = q.row.get(starId) ?? {};
    q.upsert.run({
      star_id: starId,
      content_hash: prev.content_hash ?? null,
      status: 'pending',
      error: null,
      notes: prev.notes ?? null,
      attempts: prev.attempts ?? 0,
      next_try_at: null,
      indexed_at: prev.indexed_at ?? null,
      ...fields,
    });
  }

  // --- 지울 별 목록(meta) ---
  const removals = () => readRemovals(db);
  function dropRemovals(ids) {
    const done = new Set(ids);
    const rest = removals().filter((id) => !done.has(id));
    if (rest.length) writeMeta(db, 'rag_removals', JSON.stringify(rest));
    else deleteMeta(db, 'rag_removals');
  }
  // 아직 지워야 하는가: 별이 없거나, 빼 둔 행성에 있다(다시 넣은 별은 지우지 않는다).
  function stillRemovable(id, excluded) {
    const row = q.planetOf.get(id);
    return !row || excluded.has(row.planet_id);
  }

  // --- 대기열 ---
  function enqueue(id) {
    if (id === current) {
      dirty.add(id);
      return;
    }
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  }

  function settle() {
    if (pumping || reconciling) return;
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  }

  function canWork() {
    return running && db.open && ready() && enabled();
  }

  async function withTimeout(promise) {
    let t;
    const timeout = new Promise((_, reject) => {
      t = globalThis.setTimeout(() => reject(Object.assign(new Error('index timeout'), { code: 'timeout' })), indexTimeoutMs);
      t.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      globalThis.clearTimeout(t);
    }
  }

  async function ensureEmbedKey() {
    if (embedKey) return;
    try {
      const h = await client().health();
      embedKey = `${h?.embed_model ?? ''}|${h?.fake === true}`;
    } catch {
      // 다음 기회에
    }
  }

  // 지울 별을 한 번에 지운다. → false 면 지우지 못했다(목록은 그대로 두고, 1분 · 5분 · 30분 뒤 tick 에서 다시).
  // 실패의 종류(storage_error · 4xx · 시간 초과 · 연결 안 됨)와 상관없이 기다린다. 성공하면 기다림을 푼다.
  async function flushRemovals() {
    const excluded = new Set(readSettings(db).excluded_planets);
    const all = removals();
    const ids = all.filter((id) => stillRemovable(id, excluded));
    if (ids.length < all.length) dropRemovals(all.filter((id) => !ids.includes(id)));
    if (!ids.length) return true;
    if (removeRetryAt !== null && now() < removeRetryAt) return false;
    try {
      await withTimeout(client().removeStars(ids));
    } catch (err) {
      removeFailures += 1;
      removeRetryAt = now() + RETRY_DELAYS_MS[Math.min(removeFailures, RETRY_DELAYS_MS.length) - 1];
      log.error?.(`[rag-sync] remove failed: ${err?.code ?? err?.message}`);
      return false;
    }
    removeFailures = 0;
    removeRetryAt = null;
    dropRemovals(ids);
    return true;
  }

  // 별 하나를 처리한다. → 'stop' 이면 파이썬에 닿지 않았으니 그 별을 대기열 앞에 다시 두고 멈춘다.
  async function processOne(id) {
    // 기다릴 일(/health)은 먼저 다 한다. 그 뒤로는 indexStar 를 부를 때까지 await 가 없으므로,
    // 아래에서 읽는 설정 · 행성은 보내는 순간의 값이다(기다리는 사이에 빼거나 꺼도 보내지 않는다).
    if (!keyBlocked && q.exists.get(id) !== undefined) await ensureEmbedKey();
    if (!running || !db.open || !ready()) return 'stop'; // 파이썬이 내려갔다: 대기열 앞에 다시 두고 멈춘다
    if (!enabled()) return 'ok'; // 꺼졌다: 보내지 않는다(켤 때 reconcile 이 다시 본다)

    const settings = readSettings(db);
    const excluded = new Set(settings.excluded_planets);
    const planet = q.planetOf.get(id);

    // 지워진 별: 지울 목록은 지우는 트랜잭션이 남겼다. 대기열이 비면 pump 가 한 번에 지운다.
    if (!planet) return 'ok';

    const row = q.row.get(id);

    // 빼 둔 행성 → 색인에 있었을 수 있으면 지울 목록에 넣고 skipped(지우기는 pump 가 한 번에).
    if (excluded.has(planet.planet_id)) {
      if (wasSent(db, id)) addRemovals(db, [id], log);
      write(id, { status: 'skipped', content_hash: null, attempts: 0, notes: null });
      return 'ok';
    }

    const built = starPayload(db, dataDir, id);
    const hash = contentHash(built);
    if (row?.status === 'done' && row.content_hash === hash) return 'ok'; // 내용이 같으면 다시 보내지 않는다

    if (keyBlocked) {
      write(id, { status: 'failed', error: KEY_MISSING, content_hash: row?.content_hash ?? null });
      return 'ok';
    }

    const gen = generation;
    try {
      const res = await withTimeout(client().indexStar(built.payload, { timeout: indexTimeoutMs }));
      if (gen !== generation) {
        // 그사이 색인을 비웠다. 다시 보낸다.
        write(id, { status: 'pending', content_hash: null });
        dirty.add(id);
        return 'ok';
      }
      if (res?.discarded === true) {
        // 색인하는 사이 파이썬이 이 별의 /remove 를 받아 결과를 버렸다. 색인에 없다.
        // 지금도 빼 둔 행성이면 skipped 그대로, 아니면 pending 으로 두고(켜져 있으면) 다시 보낸다.
        const p = q.planetOf.get(id);
        if (p && new Set(readSettings(db).excluded_planets).has(p.planet_id)) {
          write(id, { status: 'skipped', content_hash: null, attempts: 0, notes: null });
        } else {
          write(id, { status: 'pending', content_hash: null, attempts: 0 });
          if (enabled()) dirty.add(id);
        }
        return 'ok';
      }
      write(id, {
        status: 'done',
        content_hash: hash,
        error: null,
        notes: JSON.stringify(Array.isArray(res?.notes) ? res.notes : []),
        attempts: 0,
        next_try_at: null,
        indexed_at: iso(),
      });
      if (embedKey && readMeta(db, 'rag_embed') !== embedKey) writeMeta(db, 'rag_embed', embedKey);
      return 'ok';
    } catch (err) {
      if (isUnavailable(err)) return 'stop';
      if (isKeyMissing(err)) {
        keyBlocked = true;
        write(id, { status: 'failed', error: KEY_MISSING, content_hash: row?.content_hash ?? null, next_try_at: null });
        return 'ok';
      }
      const attempts = (row?.status === 'failed' ? row.attempts : 0) + 1;
      const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
      const error = isTimeout(err) ? 'timeout' : err?.detail ?? err?.code ?? 'error';
      write(id, {
        status: 'failed',
        error: String(error),
        content_hash: row?.content_hash ?? null,
        attempts,
        next_try_at: iso(now() + delay),
      });
      return 'ok';
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (canWork()) {
        if (!queue.length) {
          if (!removals().length) break;
          if (!(await flushRemovals())) break;
          continue;
        }
        const id = queue.shift();
        queued.delete(id);
        current = id;
        let result;
        try {
          result = await processOne(id);
        } catch (err) {
          if (!db.open) break; // 서버가 꺼지는 중
          log.error?.('[rag-sync] unexpected error', err);
          result = 'ok';
        } finally {
          current = null;
        }
        if (result === 'stop') {
          dirty.delete(id);
          queue.unshift(id);
          queued.add(id);
          break;
        }
        if (dirty.delete(id)) enqueue(id);
      }
    } finally {
      pumping = false;
      settle();
    }
  }

  function kick() {
    if (canWork()) void pump();
  }

  function queueDueFailures({ includeKeyMissing }) {
    const rows = db
      .prepare(`SELECT star_id, error, next_try_at FROM rag_status WHERE status = 'failed'`)
      .all();
    const t = iso();
    for (const r of rows) {
      if (r.error === KEY_MISSING) {
        if (includeKeyMissing) enqueue(r.star_id);
      } else if (!r.next_try_at || r.next_try_at <= t) {
        enqueue(r.star_id);
      }
    }
  }

  function clearAndMarkAllPending() {
    generation += 1;
    db.prepare(`UPDATE rag_status SET status = 'pending', content_hash = NULL, error = NULL, attempts = 0, next_try_at = NULL
      WHERE status != 'skipped'`).run();
    deleteMeta(db, 'rag_embed');
  }

  async function reconcileOnce() {
    const c = client();
    let health;
    try {
      health = await c.health();
    } catch {
      return;
    }
    embedKey = `${health?.embed_model ?? ''}|${health?.fake === true}`;
    const stored = readMeta(db, 'rag_embed');
    if (stored && stored !== embedKey) {
      // 임베딩 모델이 바뀌었다 → 옛 벡터와 섞이지 않게 처음부터.
      try {
        await c.reset();
      } catch {
        return;
      }
      clearAndMarkAllPending();
    } else {
      try {
        const stats = await c.stats();
        const { n } = db.prepare("SELECT COUNT(*) AS n FROM rag_status WHERE status = 'done'").get();
        if (Number.isInteger(stats?.stars) && stats.stars < n) {
          // 파이썬이 깨진 색인을 옮기고 빈 색인으로 시작했다 → done 을 다시 보낸다.
          db.prepare("UPDATE rag_status SET status = 'pending', content_hash = NULL WHERE status = 'done'").run();
        }
      } catch {
        // stats 가 없어도 해시 비교는 한다.
      }
    }

    const excluded = new Set(readSettings(db).excluded_planets);
    const stars = db.prepare('SELECT id, planet_id FROM stars ORDER BY created_at, id').all();
    const rows = new Map(db.prepare('SELECT * FROM rag_status').all().map((r) => [r.star_id, r]));
    const t = iso();
    for (const s of stars) {
      const row = rows.get(s.id);
      if (excluded.has(s.planet_id)) {
        if (!row || row.status !== 'skipped') enqueue(s.id);
        continue;
      }
      if (!row || row.status === 'pending' || row.status === 'skipped') {
        enqueue(s.id);
      } else if (row.status === 'failed') {
        if (row.error === KEY_MISSING || !row.next_try_at || row.next_try_at <= t) enqueue(s.id);
      } else if (row.content_hash !== contentHash(starPayload(db, dataDir, s.id))) {
        enqueue(s.id);
      }
    }
  }

  // 모든 별을 비교해 대기열을 채운다. 켜져 있고 파이썬이 ready 일 때만.
  async function reconcile() {
    if (!canWork()) return;
    if (reconciling) {
      reconcileAgain = true;
      return new Promise((resolve) => waiters.push(resolve));
    }
    reconciling = true;
    try {
      do {
        reconcileAgain = false;
        try {
          await reconcileOnce();
        } catch (err) {
          if (db.open) log.error?.('[rag-sync] reconcile failed', err);
        }
      } while (reconcileAgain && canWork());
    } finally {
      reconciling = false;
    }
    if (db.open) kick();
    settle();
  }

  function tick() {
    if (!running || !db.open) return;
    const state = rag?.status?.()?.state ?? 'off';
    if (state !== lastState) {
      lastState = state;
      if (state === 'ready') {
        keyBlocked = false;
        embedKey = null;
        void reconcile();
      }
    }
    if (canWork()) {
      queueDueFailures({ includeKeyMissing: false });
      kick();
    }
  }

  function schedule() {
    if (!running) return;
    pollTimer = setTimer(() => {
      pollTimer = null;
      try {
        tick();
      } finally {
        schedule();
      }
    }, pollMs);
    pollTimer?.unref?.();
  }

  // 별(들)이 바뀌었다. 꺼져 있으면 아무것도 보내지 않는다.
  // 지워진 별은 지우는 트랜잭션이 recordRemovals 로 이미 목록에 남겼다. 여기서는 일정만 잡는다.
  function markStars(ids, _reason) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === 'string');
    if (!enabled()) return;
    for (const id of list) enqueue(id);
    kick();
  }

  return {
    markStars,
    // 지금 파이썬에 보내는 중인 별 id(없으면 null). 별을 지우는 트랜잭션이 recordRemovals 에 넘긴다.
    inFlight: () => current,
    markPlanet(planetId) {
      markStars(db.prepare('SELECT id FROM stars WHERE planet_id = ?').all(planetId).map((r) => r.id), 'planet');
    },
    // 새로 뺀 행성들: 그 별을 바로 skipped 로, 색인에 있었으면 지운다(켜져 있고 ready 면 지금, 아니면 켤 때).
    async excludePlanets(planetIds) {
      if (!planetIds.length) return;
      const stars = db
        .prepare('SELECT id FROM stars WHERE planet_id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(planetIds))
        .map((r) => r.id);
      addRemovals(db, stars.filter((id) => wasSent(db, id, current)), log);
      for (const id of stars) {
        write(id, { status: 'skipped', content_hash: null, attempts: 0, notes: null });
        if (id === current) dirty.add(id); // 색인 중이던 별은 끝난 뒤 다시 보고 지운다
      }
      if (canWork()) await flushRemovals();
    },
    // 설정이 바뀌었다: key_missing 막힘을 풀고, 꺼졌으면 대기열을 비운다.
    settingsChanged() {
      keyBlocked = false;
      if (!enabled()) {
        queue.length = 0;
        queued.clear();
      }
    },
    reconcile,
    // 실패한 별을 지금 다시.
    async retryFailed() {
      keyBlocked = false;
      db.prepare("UPDATE rag_status SET attempts = 0, next_try_at = NULL WHERE status = 'failed'").run();
      if (!canWork()) return;
      queueDueFailures({ includeKeyMissing: true });
      kick();
    },
    // 처음부터 다시: 파이썬 색인을 비우고 전부 pending.
    async reindexAll() {
      keyBlocked = false;
      await client().reset();
      clearAndMarkAllPending();
      await reconcile();
    },
    status() {
      return { ...indexCounts(db), indexing: enabled() && (current !== null || queue.length > 0 || reconciling) };
    },
    start() {
      if (running) return;
      running = true;
      tick();
      schedule();
    },
    stop() {
      running = false;
      if (pollTimer) clearTimer(pollTimer);
      pollTimer = null;
    },
    tick,
    // 테스트용: 지금 할 수 있는 일이 다 끝날 때까지 기다린다.
    idle() {
      if (!pumping && !reconciling) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
