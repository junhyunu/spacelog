// 체험판 가짜 서버의 상태와 저장소. 상태는 객체 하나(state)이고, 첨부의 바이트(원본 · 축소본)는 Blob 으로 따로 둔다.
//
// 저장소 어댑터(같은 모양이면 무엇이든):
//   loadState() → 상태 객체 | null          saveState(state)          (JSON 으로 담을 수 있는 값)
//   getAllBlobs() → Map<key, Blob>          putBlob(key, blob)        deleteBlob(key)          clear()
//   모두 Promise 를 돌려준다. 실패(용량 초과 등)하면 던진다 — 가게(openStore)가 받아 메모리로 계속 돈다.
// 브라우저: localStorage(상태 JSON) + IndexedDB(Blob). 테스트: memoryAdapter.
//
// 처음 열 때 seed.js 의 더미 데이터를 "지금"을 기준(anchor)으로 심고 그 기준을 상태에 함께 저장한다.
// 다시 열면 저장된 상태(같은 기준)를 그대로 읽으므로 날짜가 밀리지 않는다. reset() 때만 지금을 기준으로 다시 심는다.
import { LINK_TITLES, PLANETS, makePng, pngFromIdat, pngRaw, resolveSeed, seedFileBytes } from './seed.js';
import { UNSORTED_ID, cutTitle, defaultTitle, hashBytes, isImageUpload, parseFileName, uuid } from './rules.js';

export const STATE_VERSION = 1;
export const STATE_KEY = 'spacelog.demo.state.v1';
export const DB_NAME = 'spacelog-demo';
const BLOB_STORE = 'blobs';

/** 저장이 실패했을 때(용량 초과 · 저장소를 못 씀) 띄우는 안내. 화면은 메모리로 계속 돈다. */
export const STORAGE_ERROR_TOAST = '브라우저 저장 공간이 부족해요. 이번에 바꾼 내용은 새로 고침하면 사라질 수 있어요';

export const fileKey = (attId) => `file:${attId}`;
export const thumbKey = (attId) => `thumb:${attId}`;

/** 미분류 행성(서버의 ensureUnsorted 와 같은 값). */
export function unsortedPlanet(createdAt) {
  return { id: UNSORTED_ID, name: '미분류', description: '고르지 않고 저장한 기록', color_index: 1, deco: 'rock', ring: false, slot: -1, created_at: createdAt };
}

/* ---------- 어댑터 ---------- */

function quotaError() {
  const err = new Error('storage quota exceeded');
  err.name = 'QuotaExceededError';
  return err;
}

/**
 * 메모리 어댑터(테스트용). 같은 어댑터로 openStore 를 다시 부르면 "새로 고침"과 같다.
 * failing.load · failing.state · failing.blobs 를 true 로 두면 그 동작이 던진다(용량 초과 흉내).
 */
export function memoryAdapter({ failLoad = false, failState = false, failBlobs = false } = {}) {
  let saved = null;
  const blobs = new Map();
  const failing = { load: failLoad, state: failState, blobs: failBlobs };
  return {
    kind: 'memory',
    failing,
    async loadState() {
      if (failing.load) throw new Error('cannot read');
      return saved === null ? null : JSON.parse(saved);
    },
    async saveState(state) {
      if (failing.state) throw quotaError();
      saved = JSON.stringify(state);
    },
    async getAllBlobs() {
      if (failing.load) throw new Error('cannot read');
      return new Map(blobs);
    },
    async putBlob(key, blob) {
      if (failing.blobs) throw quotaError();
      blobs.set(key, blob);
    },
    async deleteBlob(key) {
      blobs.delete(key);
    },
    async clear() {
      saved = null;
      blobs.clear();
    },
    /** 테스트가 저장된 것을 들여다본다. */
    peek: () => ({ state: saved === null ? null : JSON.parse(saved), blobKeys: [...blobs.keys()] }),
  };
}

function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 브라우저 어댑터: 상태는 localStorage, Blob 은 IndexedDB. 둘 중 하나를 못 쓰면 그 동작이 던진다. */
export function browserAdapter({ key = STATE_KEY, dbName = DB_NAME } = {}) {
  let dbp = null;
  const db = () => {
    dbp ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexedDB unavailable'));
        return;
      }
      const open = indexedDB.open(dbName, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(BLOB_STORE)) open.result.createObjectStore(BLOB_STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('indexedDB blocked'));
    });
    dbp.catch(() => {
      dbp = null; // 다음에 다시 열어 본다
    });
    return dbp;
  };
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(BLOB_STORE, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
      Promise.resolve(fn(t.objectStore(BLOB_STORE))).then((v) => {
        out = v;
      }, reject);
    });
  };
  return {
    kind: 'browser',
    async loadState() {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    async saveState(state) {
      localStorage.setItem(key, JSON.stringify(state));
    },
    async getAllBlobs() {
      return tx('readonly', async (store) => {
        const [keys, values] = await Promise.all([req2promise(store.getAllKeys()), req2promise(store.getAll())]);
        return new Map(keys.map((k, i) => [String(k), values[i]]));
      });
    },
    async putBlob(k, blob) {
      await tx('readwrite', (store) => {
        store.put(blob, k);
      });
    },
    async deleteBlob(k) {
      await tx('readwrite', (store) => {
        store.delete(k);
      });
    },
    async clear() {
      let first = null;
      try {
        localStorage.removeItem(key);
      } catch (err) {
        first = err;
      }
      try {
        await tx('readwrite', (store) => {
          store.clear();
        });
      } catch (err) {
        first ??= err;
      }
      if (first) throw first;
    },
  };
}

/** 브라우저면 browserAdapter, 아니면(node) memoryAdapter. */
export function defaultAdapter() {
  let hasLocal = false;
  try {
    hasLocal = typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    hasLocal = false; // 저장소 접근이 막힌 브라우저(사이트 데이터 차단)
  }
  return hasLocal ? browserAdapter() : memoryAdapter();
}

/* ---------- 심기 ---------- */

// 브라우저 · node 의 CompressionStream 이 있으면 PNG 를 압축해 저장소를 아낀다(없으면 압축하지 않은 PNG).
async function seedPng(spec) {
  if (typeof CompressionStream !== 'function' || typeof Response !== 'function') return makePng(spec);
  try {
    const stream = new Blob([pngRaw(spec)]).stream().pipeThrough(new CompressionStream('deflate'));
    const z = new Uint8Array(await new Response(stream).arrayBuffer());
    return pngFromIdat(spec, z);
  } catch {
    return makePng(spec);
  }
}

/** 기준 시각 anchor 로 심은 새 상태와 Blob 들. → { state, blobs: Map } */
export async function buildSeedState(anchor) {
  const seed = resolveSeed(anchor);
  const state = {
    version: STATE_VERSION,
    anchor: seed.anchor,
    planet_seq: PLANETS.length, // 서버는 행성을 만들 때마다 하나씩 늘린다(미분류는 세지 않는다)
    row: 0, // 별의 넣은 순서(서버의 rowid)
    planets: [unsortedPlanet(seed.planetAt)],
    stars: [],
    attachments: [],
    character: null, // 저장한 적 없음 → 기본값
    // 아래는 챗봇(web/demo/chat.js)이 쓴다. 체험판은 처음부터 켜 두어 바로 물어볼 수 있다
    chat: { enabled: true, consented: true, excluded_planets: [] },
    conversations: [],
    messages: [],
  };
  const blobs = new Map();
  const planetId = { unsorted: UNSORTED_ID };
  seed.planets.forEach((p, i) => {
    const id = uuid();
    planetId[p.key] = id;
    state.planets.push({
      id, name: p.name, description: p.description ?? '', color_index: p.color_index, deco: p.deco,
      ring: Boolean(p.ring), slot: i, created_at: p.created_at,
    });
  });

  const byKey = new Map();
  for (const s of seed.stars) {
    const id = uuid();
    const atts = [];
    for (const f of s.files ?? []) {
      const { name, type, bytes } = f.png ? { name: f.name, type: 'image/png', bytes: await seedPng(f.png) } : seedFileBytes(f);
      const parsed = parseFileName(name);
      const kind = isImageUpload(type, parsed.ext) ? 'image' : 'file';
      const attId = uuid();
      blobs.set(fileKey(attId), new Blob([bytes], { type }));
      atts.push({
        id: attId, kind, stem: parsed.stem, file_name: parsed.fileName, file_ext: parsed.ext.toUpperCase(),
        file_size: bytes.length, file_hash: await hashBytes(bytes), mime: type, has_file: true,
        // 미리 넣은 그림은 작아서 원본을 축소본으로 그대로 쓴다
        thumb: kind === 'image' ? 'self' : null, url: null, link_title: null,
      });
    }
    for (const url of s.links ?? []) {
      atts.push({
        id: uuid(), kind: 'link', file_name: null, file_ext: null, file_size: null, file_hash: null, mime: null,
        has_file: false, thumb: null, url, link_title: LINK_TITLES[url] ?? null,
      });
    }
    const body = typeof s.body === 'string' && s.body.trim() !== '' ? s.body : null;
    const title = (s.title ? cutTitle(s.title) : '') || defaultTitle(body, atts);
    atts.forEach((a, position) => {
      delete a.stem;
      Object.assign(a, { star_id: id, position, created_at: s.created_at });
      state.attachments.push(a);
    });
    state.row += 1;
    const star = {
      id, title, body, memo: '', fav: Boolean(s.fav), planet_id: planetId[s.p ?? 'unsorted'], created_at: s.created_at, row: state.row,
    };
    state.stars.push(star);
    if (s.key) byKey.set(s.key, { star, atts });
  }

  for (const conv of seed.conversations) {
    const id = uuid();
    state.conversations.push({ id, title: conv.title, created_at: conv.created_at, updated_at: conv.updated_at, unread: conv.unread });
    for (const m of conv.messages) {
      const sources = [];
      for (const ref of m.sources) {
        const key = typeof ref === 'string' ? ref : ref.key;
        const hit = byKey.get(key);
        if (!hit) continue;
        const att = typeof ref === 'object' && ref.file ? hit.atts.find((a) => a.kind !== 'link') : null;
        sources.push({ star_id: hit.star.id, attachment_id: att?.id ?? null, file_name: att?.file_name ?? null });
      }
      state.messages.push({
        id: uuid(), conversation_id: id, role: m.role, content: m.content, sources, status: 'done', error: null,
        created_at: m.created_at, saved_star_id: null,
      });
    }
  }
  return { state, blobs };
}

/** 미분류만 있는 빈 상태(테스트가 실제 서버의 새 DB 와 맞춰 볼 때). → { state, blobs } */
export async function buildEmptyState(anchor) {
  const at = new Date(anchor).toISOString();
  return {
    state: {
      version: STATE_VERSION, anchor: at, planet_seq: 0, row: 0, planets: [unsortedPlanet(at)], stars: [], attachments: [],
      character: null, chat: { enabled: false, consented: false, excluded_planets: [] }, conversations: [], messages: [],
    },
    blobs: new Map(),
  };
}

const validState = (s) =>
  s && typeof s === 'object' && s.version === STATE_VERSION && typeof s.anchor === 'string' &&
  Array.isArray(s.planets) && Array.isArray(s.stars) && Array.isArray(s.attachments);

/* ---------- 가게 ---------- */

/**
 * 상태를 열거나(저장된 것이 있으면) 처음 상태로 심는다. 저장소가 실패해도 던지지 않는다(메모리로 계속).
 * @param {{ adapter?: object, now?: () => Date, seed?: (anchor: Date) => Promise<{ state, blobs }> }} opts
 *   seed: 처음 상태를 만드는 함수(기본 buildSeedState — 더미 데이터. 테스트는 buildEmptyState).
 */
export async function openStore({ adapter = defaultAdapter(), now = () => new Date(), seed: makeSeed = buildSeedState } = {}) {
  const listeners = new Map();
  const urls = new Map(); // key → object URL
  let failing = false;

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[demo store] listener failed', err);
      }
    }
  };

  const store = {
    adapter,
    state: null,
    blobs: new Map(),
    /** 마지막 저장 실패({ kind, error, message }). 저장이 다시 되면 null. */
    storageError: null,
    get anchor() {
      return store.state?.anchor ?? null;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    nextRow() {
      store.state.row = (store.state.row ?? 0) + 1;
      return store.state.row;
    },
    /** 상태를 저장소에 쓴다. 실패하면 false(상태는 메모리에 그대로). */
    async commit() {
      try {
        await adapter.saveState(store.state);
        ok();
        return true;
      } catch (err) {
        report('state', err);
        return false;
      }
    },
    /** Blob 을 둔다. 저장소에 못 써도 메모리에는 남는다(이번 방문 동안은 보인다). */
    async putBlob(key, blob) {
      store.blobs.set(key, blob);
      try {
        await adapter.putBlob(key, blob);
        return true;
      } catch (err) {
        report('blob', err);
        return false;
      }
    },
    async deleteBlobs(keys) {
      for (const key of keys) {
        store.blobs.delete(key);
        const url = urls.get(key);
        if (url) {
          urls.delete(key);
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* 없음 */
          }
        }
        try {
          await adapter.deleteBlob(key);
        } catch {
          /* 지우기 실패는 다음 reset 이 치운다 */
        }
      }
    },
    blob: (key) => store.blobs.get(key),
    /** <img src> 에 쓸 주소. Blob 이 없으면 null. */
    url(key) {
      if (urls.has(key)) return urls.get(key);
      const blob = store.blobs.get(key);
      if (!blob || typeof URL?.createObjectURL !== 'function') return null;
      let url;
      try {
        url = URL.createObjectURL(blob);
      } catch {
        return null;
      }
      urls.set(key, url);
      return url;
    },
    /** 저장소를 비우고 지금을 기준으로 다시 심는다. */
    async reset() {
      for (const url of urls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* 없음 */
        }
      }
      urls.clear();
      try {
        await adapter.clear();
      } catch (err) {
        report('clear', err);
      }
      await seed();
      emit('reset', store.state);
    },
  };

  function ok() {
    if (!failing) return;
    failing = false;
    store.storageError = null;
    emit('storage-ok');
  }

  function report(kind, error) {
    store.storageError = { kind, error, message: STORAGE_ERROR_TOAST };
    console.warn(`[demo store] ${kind} storage failed`, error);
    if (failing) return; // 실패가 이어지는 동안은 한 번만 알린다
    failing = true;
    emit('storage-error', store.storageError);
  }

  async function seed() {
    const built = await makeSeed(now());
    store.state = built.state;
    store.blobs = new Map();
    for (const [key, blob] of built.blobs) await store.putBlob(key, blob);
    await store.commit();
  }

  let loaded = null;
  try {
    loaded = await adapter.loadState();
  } catch (err) {
    report('load', err);
  }
  if (validState(loaded)) {
    store.state = loaded;
    try {
      store.blobs = await adapter.getAllBlobs();
    } catch (err) {
      report('load', err);
      store.blobs = new Map();
    }
  } else {
    await seed();
  }
  return store;
}
