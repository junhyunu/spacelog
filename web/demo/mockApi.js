// 체험판(서버 없는 빌드) 전용 가짜 api. 실제 web/src/api.js 와 같은 이름 · 같은 인자 · 같은 응답 모양 · 같은 오류 코드다.
// vite.demo.config.js(Task 2)가 web/src/api.js 를 이 파일로 바꿔 끼운다(실제 앱 코드는 그대로).
//
// 상태는 web/demo/store.js(브라우저: localStorage + IndexedDB, 이 브라우저에만)에 있고, 규칙은 web/demo/rules.js(서버 규칙을 옮긴 것)다.
// 네트워크로는 아무것도 보내지 않는다.
//
// 체험판에서 못 하는 것(원본 열기 · 폴더에서 보기 · 링크 제목 가져오기)은 실제 앱이 이미 다루는 방식으로 실패하거나 비워 두고,
// 앱이 실패 토스트를 띄우지 않는 모양으로 돌려주고 체험판 안내만 띄운다(DEMO_*_TOAST).
// 다만 큰 파일(too_large)은 서버와 같은 skipped 를 돌려주므로 앱의 토스트가 먼저 뜨고, 안내가 바로 뒤(다음 타이머 차례)에 덮는다.
import { toast } from '../src/ui/toast.js';
import {
  ApiError,
  BODY_MAX_BYTES,
  MAX_ATTACHMENTS,
  UNSORTED_ID,
  checkBody,
  checkIds,
  checkMemo,
  cutTitle,
  defaultTitle,
  fail,
  hashBytes,
  inPeriod,
  isHttpUrl,
  isImageUpload,
  lookFor,
  lowestFreeSlot,
  normalizePeriod,
  parseCharacter,
  parseFileName,
  parsePlanetFields,
  DEFAULT_CHARACTER,
  utf8Length,
  uuid,
} from './rules.js';
import { createChat } from './chat.js';
import { fileKey, openStore, thumbKey } from './store.js';

export { ApiError };

/** 체험판의 파일 하나 상한(실제 앱은 500MB). 넘는 파일은 서버처럼 skipped(too_large)로 빼고 안내를 띄운다. */
export const DEMO_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEMO_OPEN_TOAST = '체험판에서는 쓸 수 없어요. 실제 앱에서는 내 컴퓨터에 보관된 원본 파일을 열어요';
export const DEMO_LINK_TITLE_TOAST = '체험판에서는 링크 제목을 가져오지 않아요';
export const DEMO_TOO_BIG_TOAST = '체험판에서는 50MB보다 큰 파일은 담을 수 없어요';
/** Blob 이 없을 때 <img src> 에 넣는 주소. 불러오기가 실패해(onerror) 앱이 아이콘으로 바꾼다(서버의 404 와 같은 모습). */
export const MISSING_URL = 'about:invalid#spacelog-demo-missing';

const THUMB_SIZE = 320; // server/vault.js 와 같다
const JSON_BODY_LIMIT = Math.floor(BODY_MAX_BYTES * 1.5); // server/files.js 와 같다
const NOTICE_MS = 3200;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 요청 본문이 JSON 을 거쳐 서버에 닿는 것과 같게(undefined 칸이 빠지고 값이 복사된다)
const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// 쿼리 문자열과 같게: 빈 값은 빠지고 나머지는 문자열
const q = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));
const clone = (v) => (v === undefined || v === null ? null : structuredClone(v));

/* ---------- 응답 모양(서버의 toPlanetJson · toStarJson · toAttachmentJson) ---------- */

function planetJson(st, p, period = {}) {
  const mine = st.stars.filter((s) => s.planet_id === p.id);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    color_index: p.color_index,
    deco: p.deco,
    ring: Boolean(p.ring),
    slot: p.slot,
    count_in_period: mine.filter((s) => inPeriod(s.created_at, period)).length,
    count_total: mine.length,
  };
}

function attachmentJson(a) {
  return {
    id: a.id,
    kind: a.kind,
    position: a.position,
    file_name: a.file_name ?? null,
    file_ext: a.file_ext ?? null,
    file_size: a.file_size ?? null,
    url: a.url ?? null,
    link_title: a.link_title ?? null,
    has_thumb: Boolean(a.thumb),
  };
}

const attsOf = (st, starId) => st.attachments.filter((a) => a.star_id === starId).sort((a, b) => a.position - b.position);

// 잠든 별 블랙홀: 마지막으로 본 때. 기능이 생기기 전에 저장된 체험판 상태의 별은 기능이 생긴 때(remind_since)부터 센다
const seenOf = (st, s) => s.seen_at ?? st.remind_since ?? s.created_at;
const REMIND_DAYS = [0, 7, 14, 30];
const DAY_MS = 24 * 60 * 60 * 1000;
const remindDays = (st) => (REMIND_DAYS.includes(st.remind?.days) ? st.remind.days : 14);

function starJson(st, s) {
  const atts = attsOf(st, s.id);
  const thumb = atts.find((a) => a.kind === 'image' && a.thumb);
  return {
    id: s.id,
    type: atts.length ? atts[0].kind : 'text',
    title: s.title,
    body: s.body ?? null,
    memo: s.memo ?? '',
    fav: Boolean(s.fav),
    planet_id: s.planet_id,
    created_at: s.created_at,
    seen_at: seenOf(st, s),
    remind_off: Boolean(s.remind_off_at),
    has_thumb: Boolean(thumb),
    thumb_attachment_id: thumb ? thumb.id : null,
    attachment_count: atts.length,
    attachments: atts.map(attachmentJson),
  };
}

const findPlanet = (st, id) => st.planets.find((p) => p.id === id) ?? null;
const findStar = (st, id) => st.stars.find((s) => s.id === id) ?? null;
const planetExists = (st, id) => typeof id === 'string' && id !== '' && Boolean(findPlanet(st, id));
const byNewest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.row - a.row);

/* ---------- 축소본(브라우저에서만) ---------- */

/** 이미지 Blob → 320px 안쪽 webp 축소본 Blob. 캔버스가 없는 곳(node 테스트)이나 실패하면 null(서버의 makeThumb 실패와 같다). */
export async function makeThumbInBrowser(blob) {
  if (typeof createImageBitmap !== 'function') return null;
  const hasOffscreen = typeof OffscreenCanvas === 'function';
  if (!hasOffscreen && typeof document === 'undefined') return null;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_SIZE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (hasOffscreen) {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', 0.82));
  } catch {
    return null;
  } finally {
    bmp?.close?.();
  }
}

/** 기본 안내: 앱의 노랑 토스트(문서가 없으면 아무것도 하지 않는다). */
function browserNotify(message, { duration = NOTICE_MS } = {}) {
  if (typeof document === 'undefined') return;
  toast(message, { duration });
}

/**
 * 가짜 api 를 만든다. 기본 인스턴스(api)는 처음 부를 때 브라우저 저장소를 연다.
 * @param {object} opts
 * @param {object|Promise<object>} [opts.store]  openStore()가 준 가게(테스트는 memoryAdapter 로 연 것)
 * @param {(message: string, opts?: { duration?: number }) => void} [opts.notify]  안내 토스트
 * @param {number} [opts.latency]  응답 전 기다리는 ms(서버처럼 잠깐 뒤에)
 * @param {number} [opts.uploadMs]  파일 올리기 진행률을 흉내 내는 시간(ms)
 * @param {number} [opts.noticeDelay]  안내를 띄우기 전 기다리는 ms(0: 다음 타이머 차례 — 앱이 같은 응답으로 띄우는 토스트보다 늘 뒤)
 * @param {number} [opts.tokenMs]  챗봇 답의 토큰 사이 간격
 * @param {number} [opts.thinkMs]  챗봇 답의 첫 토큰 전 시간
 * @param {(blob: Blob) => Promise<Blob|null>} [opts.makeThumb]
 * @param {number} [opts.maxFileBytes]
 */
export function createMockApi({
  store,
  notify = browserNotify,
  latency = 0,
  uploadMs = 0,
  noticeDelay = 0,
  tokenMs = 25,
  thinkMs = 400,
  makeThumb = makeThumbInBrowser,
  maxFileBytes = DEMO_MAX_FILE_BYTES,
} = {}) {
  let current = null;
  let readyP = null;
  let noticeChain = Promise.resolve();

  // 안내를 차례로 띄운다(앞의 것이 보일 시간을 준 뒤 다음 것)
  function notice(...messages) {
    const list = messages.filter(Boolean);
    if (!list.length) return;
    noticeChain = noticeChain.then(async () => {
      await wait(noticeDelay);
      for (const [i, m] of list.entries()) {
        if (i) await wait(NOTICE_MS);
        try {
          notify(m, { duration: NOTICE_MS });
        } catch (err) {
          console.error('[demo] notice failed', err);
        }
      }
    });
  }

  function ready() {
    readyP ??= Promise.resolve(store ?? openStore()).then((s) => {
      current = s;
      // 잠든 별 블랙홀이 생기기 전의 상태: 지금부터 센다(오래된 별이 한꺼번에 블랙홀로 몰리지 않게. 서버의 판 6 옮기기와 같다)
      if (!s.state.remind_since) {
        s.state.remind_since = new Date().toISOString();
        s.commit().catch(() => {});
      }
      chat.recover(s); // 새로 고침으로 끊긴 답은 failed / interrupted(서버를 켤 때와 같다)
      s.on('storage-error', (e) => notice(e.message));
      if (s.storageError) notice(s.storageError.message);
      return s;
    });
    return readyP;
  }

  // 메서드 하나: 가게가 열리기를 기다리고, 잠깐 쉰 뒤, 응답의 복사본을 돌려준다
  const route = (fn) => async (...args) => {
    const s = await ready();
    if (latency) await wait(latency);
    return clone(await fn(s, ...args));
  };

  // 별(과 첨부)을 상태에서 빼고 Blob 을 지운다
  async function removeStars(s, ids) {
    const gone = new Set(ids);
    const atts = s.state.attachments.filter((a) => gone.has(a.star_id));
    s.state.stars = s.state.stars.filter((x) => !gone.has(x.id));
    s.state.attachments = s.state.attachments.filter((a) => !gone.has(a.star_id));
    await s.commit();
    await s.deleteBlobs(atts.flatMap((a) => [fileKey(a.id), thumbKey(a.id)]));
  }

  // server/files.js parseStarFields
  function parseStarFields(st, src) {
    const out = { title: '', body: null, memo: '', links: [] };
    if (src.title !== undefined && src.title !== null) {
      if (typeof src.title !== 'string') throw fail(400, 'invalid_title');
      out.title = cutTitle(src.title);
    }
    if (src.body !== undefined && src.body !== null) {
      if (typeof src.body !== 'string' || utf8Length(src.body) > BODY_MAX_BYTES) throw fail(400, 'invalid_body');
      out.body = checkBody(src.body);
    }
    if (src.memo !== undefined && src.memo !== null) out.memo = checkMemo(src.memo);
    if (src.links !== undefined && src.links !== null) {
      if (!Array.isArray(src.links) || src.links.some((u) => typeof u !== 'string')) throw fail(400, 'invalid_links');
      out.links = [...new Set(src.links.map((u) => u.trim()))];
      if (out.links.some((u) => !isHttpUrl(u))) throw fail(400, 'invalid_url');
      if (out.links.length > MAX_ATTACHMENTS) throw fail(400, 'too_many_attachments');
    }
    if (!planetExists(st, src.planet_id)) throw fail(400, 'unknown_planet');
    out.planet_id = src.planet_id;
    return out;
  }

  // 파일 올리기 흉내: 진행률 → onUploaded. 다 보내기 전에 멈추면 aborted.
  async function fakeUpload(totalBytes, onProgress, signal, onUploaded) {
    const steps = 5;
    const ms = uploadMs || 0;
    const per = Math.round(ms / steps + Math.min(800, totalBytes / 40_000) / steps);
    for (let i = 1; i <= steps; i++) {
      await wait(per);
      if (signal?.aborted) throw new ApiError(0, 'aborted');
      if (typeof onProgress === 'function') onProgress(Math.round((i / steps) * 100));
    }
    if (typeof onUploaded === 'function') onUploaded();
  }

  // 파일 하나 → 첨부(바이트는 blobs 에) | { reason }
  async function readFile(file, s, seen) {
    const name = parseFileName(file?.name);
    const size = Number(file?.size);
    if (Number.isFinite(size) && size > maxFileBytes) return { name, reason: 'too_large' };
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      // 읽을 수 없는 파일(폴더 등). 실제 api 는 XHR 오류 → 서버가 살아 있으면 upload_failed
      throw new ApiError(0, 'upload_failed');
    }
    if (bytes.length > maxFileBytes) return { name, reason: 'too_large' };
    const hash = await hashBytes(bytes);
    if (seen.has(hash) || s.state.attachments.some((a) => a.file_hash === hash)) return { name, reason: 'duplicate', hash };
    const type = String(file.type ?? '');
    const kind = isImageUpload(type, name.ext) ? 'image' : 'file';
    const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    let thumb = null;
    if (kind === 'image') {
      try {
        thumb = (await makeThumb(blob)) ?? null;
      } catch {
        thumb = null;
      }
    }
    return {
      name,
      hash,
      blob,
      thumb,
      attachment: {
        id: uuid(), kind, stem: name.stem, file_name: name.fileName, file_ext: name.ext.toUpperCase(), file_size: bytes.length,
        file_hash: hash, mime: type || null, has_file: true, thumb: thumb ? 'blob' : null, url: null, link_title: null,
      },
    };
  }

  const api = {
    health: route(() => ({ ok: true })),

    summary: route((s, range) => {
      const period = normalizePeriod({ from: q(range?.from), to: q(range?.to) });
      const st = s.state;
      return {
        in_period: st.stars.filter((x) => inPeriod(x.created_at, period)).length,
        total: st.stars.length,
        planets: st.planets.length,
      };
    }),

    planets: route((s, range) => {
      const period = normalizePeriod({ from: q(range?.from), to: q(range?.to) });
      return [...s.state.planets].sort((a, b) => a.slot - b.slot).map((p) => planetJson(s.state, p, period));
    }),

    nextLook: route((s) => lookFor(s.state.planet_seq ?? 0)),

    createPlanet: route(async (s, { name, description, color_index, deco, ring } = {}) => {
      const fields = parsePlanetFields(json({ name, description, color_index, deco, ring }), { requireName: true });
      const st = s.state;
      const n = st.planet_seq ?? 0;
      const auto = lookFor(n);
      const p = {
        id: uuid(),
        name: fields.name,
        description: fields.description ?? '',
        color_index: fields.color_index ?? auto.color_index,
        deco: fields.deco ?? auto.deco,
        ring: Boolean(fields.ring ?? auto.ring),
        slot: lowestFreeSlot(st.planets),
        created_at: new Date().toISOString(),
      };
      st.planets.push(p);
      st.planet_seq = n + 1;
      await s.commit();
      return planetJson(st, p);
    }),

    patchPlanet: route(async (s, planetId, patch) => {
      const id = String(planetId);
      if (id === UNSORTED_ID) throw fail(403, 'locked');
      const p = findPlanet(s.state, id);
      if (!p) throw fail(404, 'not_found');
      const fields = parsePlanetFields(json(patch), { requireName: false });
      if (Object.keys(fields).length) {
        Object.assign(p, fields);
        await s.commit();
      }
      return planetJson(s.state, p);
    }),

    mergePlanet: route(async (s, planetId, into) => {
      const id = String(planetId);
      const target = json({ into })?.into;
      if (id === UNSORTED_ID) throw fail(403, 'locked');
      if (!findPlanet(s.state, id)) throw fail(404, 'not_found');
      if (typeof target !== 'string' || !target || target === id) throw fail(400, 'invalid_target');
      if (!findPlanet(s.state, target)) throw fail(404, 'not_found');
      let moved = 0;
      for (const star of s.state.stars) {
        if (star.planet_id === id) {
          star.planet_id = target;
          moved += 1;
        }
      }
      s.state.planets = s.state.planets.filter((p) => p.id !== id);
      await s.commit();
      return { moved };
    }),

    deletePlanet: route(async (s, planetId, { stars, into } = {}) => {
      const id = String(planetId);
      const mode = q(stars);
      const target = mode === 'move' ? q(into) : undefined;
      const st = s.state;
      if (id === UNSORTED_ID) throw fail(403, 'locked');
      if (!findPlanet(st, id)) throw fail(404, 'not_found');
      if (mode === 'move') {
        if (typeof target !== 'string' || !target || target === id || !findPlanet(st, target)) throw fail(400, 'invalid_target');
        for (const star of st.stars) if (star.planet_id === id) star.planet_id = target;
        st.planets = st.planets.filter((p) => p.id !== id);
        await s.commit();
        return null; // 204
      }
      if (mode === 'delete') {
        const ids = st.stars.filter((x) => x.planet_id === id).map((x) => x.id);
        st.planets = st.planets.filter((p) => p.id !== id);
        await removeStars(s, ids);
        return null;
      }
      if (st.stars.some((x) => x.planet_id === id)) throw fail(409, 'not_empty');
      st.planets = st.planets.filter((p) => p.id !== id);
      await s.commit();
      return null;
    }),

    character: route((s) => parseCharacter(s.state.character) ?? { ...DEFAULT_CHARACTER }),

    saveCharacter: route(async (s, { kind, suit, accent, flame } = {}) => {
      const look = parseCharacter(json({ kind, suit, accent, flame }));
      if (!look) throw fail(400, 'invalid_character');
      s.state.character = look;
      await s.commit();
      return look;
    }),

    stars: route((s, { from, to, planet_id, limit, fav } = {}) => {
      const period = normalizePeriod({ from: q(from), to: q(to) });
      const pid = q(planet_id);
      const lim = q(limit);
      let list = s.state.stars.filter((x) => inPeriod(x.created_at, period));
      if (fav) list = list.filter((x) => x.fav);
      if (pid) list = list.filter((x) => x.planet_id === pid);
      list = [...list].sort(byNewest);
      if (lim && /^[1-9]\d{0,8}$/.test(lim)) list = list.slice(0, Number(lim));
      return list.map((x) => starJson(s.state, x));
    }),

    star: route((s, starId) => {
      const star = findStar(s.state, String(starId));
      if (!star) throw fail(404, 'not_found');
      return starJson(s.state, star);
    }),

    patchStar: route(async (s, starId, patch) => {
      const star = findStar(s.state, String(starId));
      if (!star) throw fail(404, 'not_found');
      const raw = json(patch);
      const src = raw && typeof raw === 'object' ? raw : {};
      const out = {};
      if (src.body !== undefined) out.body = checkBody(src.body);
      if (src.title !== undefined) {
        if (typeof src.title !== 'string' || src.title.trim() === '') throw fail(400, 'invalid_title');
        out.title = cutTitle(src.title);
      }
      if (src.memo !== undefined) out.memo = checkMemo(src.memo);
      if (src.fav !== undefined) {
        if (typeof src.fav !== 'boolean') throw fail(400, 'invalid_fav');
        out.fav = src.fav;
      }
      if (src.planet_id !== undefined) {
        if (!planetExists(s.state, src.planet_id)) throw fail(400, 'unknown_planet');
        out.planet_id = src.planet_id;
      }
      if (src.seen_at !== undefined) {
        const t = typeof src.seen_at === 'string' ? Date.parse(src.seen_at) : NaN;
        if (Number.isNaN(t)) throw fail(400, 'invalid_seen_at');
        out.seen_at = new Date(t).toISOString();
      }
      if (src.remind_off !== undefined) {
        if (typeof src.remind_off !== 'boolean') throw fail(400, 'invalid_remind_off');
        out.remind_off_at = src.remind_off ? new Date().toISOString() : null;
      }
      Object.assign(star, out);
      await s.commit();
      return starJson(s.state, star);
    }),

    seenStar: route(async (s, starId) => {
      const star = findStar(s.state, String(starId));
      if (!star) throw fail(404, 'not_found');
      star.seen_at = new Date().toISOString();
      await s.commit();
      return { id: star.id, seen_at: star.seen_at };
    }),

    /* ---------- 잠든 별 블랙홀(server/remind.js) ---------- */
    remind: route((s, { limit } = {}) => {
      const lim = q(limit);
      let n = 20;
      if (lim !== undefined) {
        if (!/^[1-9]\d{0,2}$/.test(lim) || Number(lim) > 100) throw fail(400, 'invalid_query');
        n = Number(lim);
      }
      const st = s.state;
      const days = remindDays(st);
      if (!days) return { days, total: 0, stars: [] };
      const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
      const list = st.stars
        .filter((x) => !x.remind_off_at && seenOf(st, x) < cutoff)
        .sort((a, b) => (seenOf(st, a) < seenOf(st, b) ? -1 : seenOf(st, a) > seenOf(st, b) ? 1 : a.row - b.row));
      return { days, total: list.length, stars: list.slice(0, n).map((x) => starJson(st, x)) };
    }),

    remindOff: route((s) => ({
      stars: s.state.stars
        .filter((x) => x.remind_off_at)
        .sort((a, b) => (a.remind_off_at < b.remind_off_at ? 1 : a.remind_off_at > b.remind_off_at ? -1 : b.row - a.row))
        .map((x) => starJson(s.state, x)),
    })),

    setRemindOff: route(async (s, ids, off) => {
      const body = json({ ids, off }) ?? {};
      checkIds(body.ids);
      if (typeof body.off !== 'boolean') throw fail(400, 'invalid_off');
      const at = new Date().toISOString();
      let changed = 0;
      for (const id of new Set(body.ids)) {
        const star = findStar(s.state, id);
        if (!star) continue;
        if (body.off) star.remind_off_at = at;
        else if (star.remind_off_at) Object.assign(star, { remind_off_at: null, seen_at: at });
        else continue;
        changed += 1;
      }
      if (changed) await s.commit();
      return { changed };
    }),

    remindSettings: route((s) => ({ days: remindDays(s.state) })),

    saveRemindSettings: route(async (s, days) => {
      if (!REMIND_DAYS.includes(days)) throw fail(400, 'invalid_remind_settings');
      s.state.remind = { days };
      await s.commit();
      return { days };
    }),

    moveStars: route(async (s, ids, planetId) => {
      const body = json({ ids, planet_id: planetId }) ?? {};
      checkIds(body.ids);
      if (!planetExists(s.state, body.planet_id)) throw fail(400, 'unknown_planet');
      let moved = 0;
      for (const id of new Set(body.ids)) {
        const star = findStar(s.state, id);
        if (star && star.planet_id !== body.planet_id) {
          star.planet_id = body.planet_id;
          moved += 1;
        }
      }
      if (moved) await s.commit();
      return { moved };
    }),

    deleteStars: route(async (s, ids) => {
      const body = json({ ids }) ?? {};
      checkIds(body.ids);
      const found = [...new Set(body.ids)].filter((id) => findStar(s.state, id));
      if (found.length) await removeStars(s, found);
      return { deleted: found.length };
    }),

    deleteStar: route(async (s, starId) => {
      const star = findStar(s.state, String(starId));
      if (!star) throw fail(404, 'not_found');
      await removeStars(s, [star.id]);
      return null; // 204
    }),

    /**
     * 실제 api.createStar 와 같다(→ { star, skipped }). 파일은 File · Blob(이름 · type · arrayBuffer()) 목록.
     * 파일이 있으면 진행률(onProgress) → onUploaded 를 흉내 내고, 그 전에 signal 로 멈추면 ApiError(0, 'aborted').
     * 체험판 차이: 새 링크의 제목은 가져오지 않는다(null), 파일은 50MB 까지(넘으면 skipped too_large).
     */
    createStar: async ({ planet_id, title, body, links, files } = {}, onProgress, { signal, onUploaded } = {}) => {
      const s = await ready();
      const list = Array.from(files ?? []);
      const fields = {
        planet_id: String(planet_id ?? ''),
        title: typeof title === 'string' ? title : '',
        body: typeof body === 'string' ? body : '',
        links: Array.from(links ?? [], String),
      };
      if (signal?.aborted) throw new ApiError(0, 'aborted');
      if (latency) await wait(latency);
      const st = s.state;
      const skipped = [];
      const files2 = []; // 읽은 파일 { attachment, blob, thumb }
      let parsed;
      if (!list.length) {
        if (utf8Length(JSON.stringify(fields)) > JSON_BODY_LIMIT) throw fail(413, 'too_large');
        parsed = parseStarFields(st, fields);
      } else {
        // multipart: 글 칸이 1MB(필드 상한)를 넘으면 잘려서 invalid_body
        if (utf8Length(fields.body) > BODY_MAX_BYTES) throw fail(400, 'invalid_body');
        parsed = parseStarFields(st, fields);
        if (parsed.links.length + list.length > MAX_ATTACHMENTS) throw fail(400, 'too_many_attachments');
        const total = list.reduce((n, f) => n + (Number(f?.size) || 0), 0);
        await fakeUpload(total, onProgress, signal, onUploaded);
        const seen = new Set();
        for (const f of list) {
          const res = await readFile(f, s, seen);
          if (res.attachment) {
            files2.push(res);
            seen.add(res.hash);
          } else if (!(res.reason === 'duplicate' && seen.has(res.hash))) {
            skipped.push({ file_name: res.name.fileName, reason: res.reason });
          }
        }
      }
      const tooBig = skipped.some((x) => x.reason === 'too_large');
      const linkAtts = parsed.links.map((url) => ({
        id: uuid(), kind: 'link', file_name: null, file_ext: null, file_size: null, file_hash: null, mime: null,
        has_file: false, thumb: null, url, link_title: null, // 체험판은 링크 제목을 가져오지 않는다
      }));
      const atts = [...files2.map((x) => x.attachment), ...linkAtts];
      if (!parsed.body && atts.length === 0 && skipped.length === 0) throw fail(400, 'empty_star');
      if (!parsed.body && atts.length === 0) {
        if (tooBig) notice(DEMO_TOO_BIG_TOAST);
        throw fail(409, 'nothing_to_save', { skipped });
      }
      const id = uuid();
      const created = new Date().toISOString();
      const starTitle = parsed.title || defaultTitle(parsed.body, atts);
      for (const x of files2) {
        await s.putBlob(fileKey(x.attachment.id), x.blob);
        if (x.thumb) await s.putBlob(thumbKey(x.attachment.id), x.thumb);
      }
      atts.forEach((a, position) => {
        delete a.stem;
        Object.assign(a, { star_id: id, position, created_at: created });
        st.attachments.push(a);
      });
      const star = {
        id, title: starTitle, body: parsed.body, memo: parsed.memo ?? '', fav: false, planet_id: parsed.planet_id,
        created_at: created, seen_at: created, row: s.nextRow(),
      };
      st.stars.push(star);
      await s.commit();
      notice(tooBig && DEMO_TOO_BIG_TOAST, linkAtts.length > 0 && DEMO_LINK_TITLE_TOAST);
      return clone({ star: starJson(st, star), skipped });
    },

    /** 체험판에서는 원본을 열 수 없다: 서버와 같은 검사(not_found · no_file · file_missing) 뒤, 아무것도 열지 않고 안내만 띄운다. */
    openAttachment: route((s, attId) => launch(s, attId)),
    revealAttachment: route((s, attId) => launch(s, attId)),

    /** <img src> 에 쓸 주소(object URL). 가게가 아직 안 열렸거나 바이트가 없으면 MISSING_URL. */
    attachmentFileUrl: (attId) => current?.url(fileKey(String(attId))) ?? MISSING_URL,
    attachmentThumbUrl: (attId) => {
      if (!current) return MISSING_URL;
      const att = current.state.attachments.find((a) => a.id === String(attId));
      if (!att?.thumb) return MISSING_URL;
      return current.url(att.thumb === 'self' ? fileKey(att.id) : thumbKey(att.id)) ?? MISSING_URL;
    },

    /* ---------- 챗봇: web/demo/chat.js(준비된 질문 · 흘려 보내기 흉내). 아래에서 붙인다 ---------- */
  };

  async function launch(s, attId) {
    const att = s.state.attachments.find((a) => a.id === String(attId));
    if (!att) throw fail(404, 'not_found');
    if (!att.has_file) throw fail(400, 'no_file');
    if (!s.blob(fileKey(att.id))) throw fail(404, 'file_missing');
    // 앱의 실패 토스트가 뜨지 않게 성공으로 돌려준다(action 이 'revealed' 가 아니면 detail.js 는 아무 말도 하지 않는다).
    // 아무것도 열지 않고 체험판 안내만 띄운다.
    notice(DEMO_OPEN_TOAST);
    return { action: 'demo' };
  }

  const chat = createChat({ route, ready, tokenMs, thinkMs });
  Object.assign(api, chat.methods);

  /**
   * 체험판 전용: 앱이 api.js 를 거치지 않고 직접 부르는 fetch('/api/…')를 받는다(web/demo/main.js 가 window.fetch 에 끼운다).
   * 그런 곳은 하나뿐이다: 화면이 사라지는 순간(pagehide) 메모를 keepalive 로 보내는 detail.js 의 PATCH /api/stars/:id.
   * 기다릴 수 없는 순간이라 가게가 열려 있으면 await 없이 바로 상태를 고치고 저장한다(localStorage 쓰기는 동기).
   * 그 밖의 /api 요청은 404 { error: 'not_found' }. 네트워크로는 보내지 않는다.
   */
  api.demoFetch = async (input, init = {}) => {
    const respond = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const m = /^\/api\/stars\/([^/?#]+)$/.exec(path);
    if (!m || String(init.method ?? 'GET').toUpperCase() !== 'PATCH') return respond(404, { error: 'not_found' });
    const s = current ?? (await ready());
    const star = findStar(s.state, decodeURIComponent(m[1]));
    if (!star) return respond(404, { error: 'not_found' });
    try {
      const raw = JSON.parse(String(init.body ?? '{}'));
      if (raw && typeof raw === 'object' && raw.body !== undefined) star.body = checkBody(raw.body);
    } catch (err) {
      if (err instanceof ApiError) return respond(err.status, err.data ?? { error: err.code });
      return respond(400, { error: 'invalid_body' });
    }
    void s.commit();
    return respond(200, starJson(s.state, star));
  };

  /** 체험판 전용(실제 api 에는 없다): 가게(store.js)를 받는다. Task 2 의 안내 띠 · 챗봇이 쓴다. */
  api.demoStore = ready;
  /** 체험판 전용: 저장소를 비우고 지금을 기준으로 다시 심는다. */
  api.resetDemo = async () => {
    const s = await ready();
    await s.reset();
  };
  return api;
}

/** 앱이 쓰는 기본 인스턴스. 처음 부를 때 브라우저 저장소(localStorage + IndexedDB)를 연다. */
export const api = createMockApi({
  latency: typeof window === 'undefined' ? 0 : 60,
  uploadMs: typeof window === 'undefined' ? 0 : 600,
});
