// 체험판 가짜 서버의 검사 규칙. 실제 서버(server/planets.js · stars.js · files.js · character.js · app.js)의 규칙을
// 브라우저에서도 도는 순수 JS 로 옮긴 것이다(node 전용 모듈을 가져오지 않는다). 규칙이 바뀌면 같이 고친다.
// 같은 상태 · 같은 오류 코드인지는 web/src/test/demoApi.test.js 의 계약 테스트가 실제 서버와 맞춰 본다.

/** 실제 web/src/api.js 의 ApiError 와 같은 모양. data 는 서버가 준 오류 본문 전체({ error, ... }). */
export class ApiError extends Error {
  constructor(status, code, data = null) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** 서버가 { error: code } 로 답하는 실패. 클라이언트가 받는 ApiError 와 같다(data = 본문). */
export const fail = (status, code, extra = {}) => new ApiError(status, code, { error: code, ...extra });

/* ---------- 행성(server/planets.js) ---------- */
export const DECOS = ['town', 'crystal', 'forest', 'rock', 'ice', 'volcano', 'mushroom', 'cactus', 'flower', 'cloud'];
export const COLOR_COUNT = 16;
export const UNSORTED_ID = 'unsorted';
const NAME_MAX = 20;
const DESCRIPTION_MAX = 20;

const len = (s) => [...s].length;
// eslint-disable-next-line no-control-regex
const clean = (s) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '').trim();

/** 있는 값만 검사해 정리한다. 벗어나면 400 invalid_name · invalid_description · invalid_look. */
export function parsePlanetFields(body, { requireName }) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  if (src.name !== undefined || requireName) {
    if (typeof src.name !== 'string') throw fail(400, 'invalid_name');
    const name = clean(src.name);
    if (len(name) < 1 || len(name) > NAME_MAX) throw fail(400, 'invalid_name');
    out.name = name;
  }
  if (src.description !== undefined) {
    if (typeof src.description !== 'string') throw fail(400, 'invalid_description');
    const description = clean(src.description);
    if (len(description) > DESCRIPTION_MAX) throw fail(400, 'invalid_description');
    out.description = description;
  }
  if (src.color_index !== undefined) {
    if (!Number.isInteger(src.color_index) || src.color_index < 1 || src.color_index > COLOR_COUNT) throw fail(400, 'invalid_look');
    out.color_index = src.color_index;
  }
  if (src.deco !== undefined) {
    if (!DECOS.includes(src.deco)) throw fail(400, 'invalid_look');
    out.deco = src.deco;
  }
  if (src.ring !== undefined) {
    if (typeof src.ring !== 'boolean') throw fail(400, 'invalid_look');
    out.ring = src.ring;
  }
  return out;
}

/** n 번째(0부터)로 만드는 행성의 자동 배정 모습. */
export function lookFor(n) {
  return { color_index: (n % COLOR_COUNT) + 1, deco: DECOS[n % DECOS.length], ring: false };
}

/** 가장 작은 빈 자리(0 이상). 미분류는 -1 이다. */
export function lowestFreeSlot(planets) {
  const used = planets.map((p) => p.slot).filter((s) => s >= 0).sort((a, b) => a - b);
  let slot = 0;
  for (const s of used) {
    if (s !== slot) break;
    slot += 1;
  }
  return slot;
}

/* ---------- 별(server/stars.js · files.js) ---------- */
const TITLE_FROM_BODY_MAX = 40;
const TITLE_MAX = 200;
export const MEMO_MAX = 20000;
export const BODY_MAX_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS = 50;
export const MAX_IDS = 500;

export const cutTitle = (s) => [...s.trim()].slice(0, TITLE_MAX).join('').trim();

export function checkMemo(memo) {
  if (typeof memo !== 'string') throw fail(400, 'invalid_memo');
  if (memo.length > MEMO_MAX && [...memo].length > MEMO_MAX) throw fail(400, 'invalid_memo');
  return memo;
}

export function checkBody(body) {
  if (typeof body !== 'string') throw fail(400, 'invalid_body');
  if (body.length > MEMO_MAX && [...body].length > MEMO_MAX) throw fail(400, 'invalid_body');
  return body.trim() === '' ? null : body;
}

export function firstLine(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return [...line].slice(0, TITLE_FROM_BODY_MAX).join('');
}

export function isHttpUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 여러 별을 다루는 요청의 ids: 문자열 배열, 1~500개. */
export function checkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((v) => typeof v === 'string')) {
    throw fail(400, 'invalid_ids');
  }
}

export const utf8Length = (s) => new TextEncoder().encode(s).length;

/** 제목을 비웠을 때: 본문 첫 줄(40자) → 첫 파일 이름(확장자 뺌) → 첫 링크 제목 → 첫 주소. */
export function defaultTitle(body, attachments) {
  const fromBody = body ? firstLine(body) : '';
  if (fromBody) return fromBody;
  const file = attachments.find((a) => a.kind !== 'link');
  if (file) return cutTitle(file.stem);
  const link = attachments.find((a) => a.kind === 'link');
  return link ? cutTitle(link.link_title ?? link.url) : '';
}

const FILE_NAME_MAX = 200;
const RASTER_EXTS = new Set('png jpg jpeg gif webp bmp avif tif tiff heic'.split(' '));

export function isImageUpload(mimetype, ext) {
  return String(mimetype ?? '').toLowerCase().startsWith('image/') && RASTER_EXTS.has(String(ext ?? '').toLowerCase());
}

/** server/files.js parseFileName 과 같다. → { fileName, ext, stem } */
export function parseFileName(raw) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  let name = cleaned.split(/[\\/]/).map((s) => s.trim()).filter((s) => s !== '').pop() ?? '';
  if (name === '') name = 'untitled';
  let dot = name.lastIndexOf('.');
  let ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!/^[a-z0-9]{1,10}$/.test(ext)) {
    ext = '';
    dot = -1;
  }
  const chars = [...name];
  if (chars.length > FILE_NAME_MAX) {
    if (dot > 0) {
      const suffix = name.slice(dot);
      name = [...name.slice(0, dot)].slice(0, FILE_NAME_MAX - [...suffix].length).join('') + suffix;
      dot = name.length - suffix.length;
    } else {
      name = chars.slice(0, FILE_NAME_MAX).join('');
    }
  }
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return { fileName: name, ext, stem };
}

/* ---------- 캐릭터(server/character.js) ---------- */
export const CHARACTER_KINDS = ['astronaut', 'robot', 'cat', 'alien', 'bear', 'human'];
export const CHARACTER_FLAMES = ['orange', 'blue', 'green', 'pink'];
export const DEFAULT_CHARACTER = Object.freeze({ kind: 'astronaut', suit: 0, accent: 0, flame: 'orange' });
const colorOk = (v) => Number.isInteger(v) && v >= 0 && v <= 16;

export function parseCharacter(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, suit, accent, flame } = value;
  if (typeof kind !== 'string' || !CHARACTER_KINDS.includes(kind)) return null;
  if (!colorOk(suit) || !colorOk(accent)) return null;
  if (typeof flame !== 'string' || !CHARACTER_FLAMES.includes(flame)) return null;
  return { kind, suit, accent, flame };
}

/* ---------- 기간 쿼리(server/app.js preHandler) ---------- */
/** from · to 를 UTC ISO 로 맞춘다. 빈 값은 뺀다. 읽을 수 없으면 400 invalid_period. */
export function normalizePeriod(range) {
  const out = {};
  for (const key of ['from', 'to']) {
    const v = range?.[key];
    if (v === undefined || v === null || v === '') continue;
    const t = Date.parse(String(v));
    if (Number.isNaN(t)) throw fail(400, 'invalid_period');
    out[key] = new Date(t).toISOString();
  }
  return out;
}

export const inPeriod = (iso, { from, to } = {}) => (!from || iso >= from) && (!to || iso < to);

/* ---------- id · 해시 ---------- */
/** crypto.randomUUID 가 없으면(보안 문맥이 아닌 http 등) 직접 만든다. */
export function uuid() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* 아래로 */
    }
  }
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 같은 파일 찾기용 해시(16진 문자열). SHA-256 을 쓰고, 못 쓰면 64비트 FNV-1a 두 벌로 대신한다. */
export async function hashBytes(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const d = await subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch {
      /* 아래로 */
    }
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ bytes.length;
  for (const v of bytes) {
    h1 = Math.imul(h1 ^ v, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ v, 2246822519) >>> 0;
  }
  return `fnv-${bytes.length}-${h1.toString(16)}-${h2.toString(16)}`;
}
