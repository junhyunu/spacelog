// 기록하기 창(W-05 대체, 스펙 6-9) · 끌어다 놓기 · 붙여넣기의 순수 함수(DOM 없음).
// 글 + 첨부 파일 + 링크를 저장하면 별 하나가 된다. 한도는 서버와 같다:
// 첨부(파일 + 링크) 50개, 파일 하나 500MB, 제목 200자, 행성 이름 20자.

export const FILE_MAX = 500 * 1024 * 1024;
export const ATTACH_MAX = 50;
export const TITLE_MAX = 200;
export const TITLE_FROM_BODY_MAX = 40;
export const PLANET_NAME_MAX = 20;

export const URL_ERROR = '주소는 http로 시작해야 해요';
export const URL_REFUSED = '링크 주소를 다시 확인해 주세요';
export const TOO_BIG_TOAST = '500MB보다 큰 파일은 담을 수 없어요';
export const TOO_MANY_TOAST = '첨부는 50개까지 담을 수 있어요';
export const FOLDER_TOAST = '폴더는 담을 수 없어요. 파일만 놓아 주세요';
export const KEPT_TOAST = '이미 쓰던 내용이 있어 그대로 두었어요';
export const PASTED_IMAGE = '붙여넣은 이미지';

const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const str = (v) => (typeof v === 'string' ? v : '');
/**
 * 서버(server/stars.js isHttpUrl)와 똑같이 검사한 http(s) 주소: 앞뒤 공백을 떼고(String.prototype.trim),
 * http:// · https://로 시작하며 new URL()로 읽히고 호스트가 비어 있지 않으면 뗀 주소, 아니면 null.
 */
export function httpUrl(url) {
  const u = str(url).trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname ? u : null;
  } catch {
    return null;
  }
}

// 붙여넣기 · 끌어다 놓기에서 "주소 하나"로 볼 글: 공백 없이 주소만 있을 때(주소로 시작하는 문장은 글이다)
const linkOnly = (s) => (/\s/.test(str(s).trim()) ? null : httpUrl(s));

// 글 하나를 link(전체가 주소 하나) · text(그 밖의 비어 있지 않은 글) · null로 가른다.
function classifyText(text) {
  const raw = str(text);
  if (!raw.trim()) return null;
  const url = linkOnly(raw);
  return url ? { kind: 'link', url } : { kind: 'text', text: raw };
}

/**
 * 글 칸 밖에서 붙여넣은 것: { kind: 'files', files } | { kind: 'link', url } | { kind: 'text', text } | null.
 * 글과 함께 온 파일이 모두 이미지면 글을 쓴다(엑셀 · 워드 · 파워포인트에서 복사하면 글 옆에 그림이 같이 온다).
 */
export function classifyPaste({ files, text } = {}) {
  const list = Array.from(files ?? []);
  const found = classifyText(text);
  if (!list.length) return found;
  if (found && list.every((f) => str(f?.type).startsWith('image/'))) return found;
  return { kind: 'files', files: list };
}

/**
 * 끌어다 놓은 것. 파일이 있으면 files. 없으면 text/uri-list의 첫 http(s) 주소(#으로 시작하는 줄은 건너뛴다) → link,
 * 그것도 없으면 text/plain을 붙여넣기처럼 가른다. 쓸 것이 없으면 null.
 */
export function classifyDrop({ types, uriList, text, files } = {}) {
  const list = Array.from(files ?? []);
  if (list.length) return { kind: 'files', files: list };
  const kinds = Array.from(types ?? []);
  if (kinds.includes('text/uri-list')) {
    for (const line of str(uriList).split(/\r?\n/)) {
      const url = line.trim();
      if (url && !url.startsWith('#') && linkOnly(url)) return { kind: 'link', url };
    }
  }
  if (kinds.includes('text/plain')) return classifyText(text);
  return null;
}

/** 주소 칸 아래에 보일 글. 비어 있으면 null, http:// · https://로 시작하는 주소가 아니면 안내 문구. */
export function urlError(url) {
  if (!str(url).trim()) return null;
  return httpUrl(url) ? null : URL_ERROR;
}

/**
 * 주소 칸에 쳐 두고 아직 칩으로 더하지 않은 것. 저장하기 전에 본다.
 * 비어 있으면 null, 주소면 { url, dup }(dup: 이미 칩으로 있음), 아니면 { error }.
 */
export function pendingLink(raw, existing) {
  if (!str(raw).trim()) return null;
  const url = httpUrl(raw);
  if (!url) return { error: URL_ERROR };
  return { url, dup: Array.from(existing ?? []).includes(url) };
}

/** 서버가 받지 않을(400 invalid_url) 링크의 자리. */
export function badLinks(urls) {
  const out = [];
  Array.from(urls ?? []).forEach((u, i) => {
    if (!httpUrl(u)) out.push(i);
  });
  return out;
}

const INVISIBLE = /[\u0000-\u001f\u007f​-‍⁠﻿]/g;

/**
 * 새 행성 이름 칸에 둘 값. 서버처럼 NFC로 모으고 보이지 않는 글자를 뺀 뒤에 세어, 20자를 넘으면 앞의 20자만 남긴다.
 * 넘지 않으면 쓴 그대로 돌려준다(치는 중인 값을 건드리지 않는다). 풀어 쓴 한글(NFD)도 20자까지 들어간다.
 */
export function clampPlanetName(name) {
  const raw = str(name);
  const chars = [...raw.normalize('NFC').replace(INVISIBLE, '').trimStart()];
  return chars.length > PLANET_NAME_MAX ? chars.slice(0, PLANET_NAME_MAX).join('') : raw;
}

/** 서버가 행성 이름을 다듬는 방식 그대로: NFC, 보이지 않는 글자 제거, 앞뒤 공백 제거. */
export function cleanPlanetName(name) {
  return str(name).normalize('NFC').replace(INVISIBLE, '').trim();
}

/** 다듬은 행성 이름의 글자 수(코드 포인트). */
export function planetNameLength(name) {
  return [...cleanPlanetName(name)].length;
}

/** "별 띄우기"를 누를 수 있는지: 글이나 첨부(count개, 50개까지)가 있고 행성이 정해졌을 때. */
export function canSubmit({ text, count = 0, planetId, newPlanetName } = {}) {
  if (planetId === null || planetId === undefined || planetId === '') return false;
  if (planetId === 'new') {
    const n = planetNameLength(newPlanetName);
    if (n < 1 || n > PLANET_NAME_MAX) return false;
  }
  const n = Number(count) || 0;
  if (n > ATTACH_MAX) return false;
  return str(text).trim() !== '' || n > 0;
}

/**
 * 행성 칸의 기본값: 열려 있는 패널의 행성 → 마지막으로 저장한 행성 → 첫 행성. 행성이 하나도 없으면 'new'.
 * 돌려주는 id는 문자열이다(select의 value와 맞춘다).
 */
export function defaultPlanetId({ panelPlanetId, lastPlanetId, planets } = {}) {
  const ids = Array.from(planets ?? [], (p) => String(p.id));
  if (!ids.length) return 'new';
  for (const want of [panelPlanetId, lastPlanetId]) {
    if (want !== null && want !== undefined && ids.includes(String(want))) return String(want);
  }
  return ids[0];
}

/** 파일 이름에서 확장자를 뺀 것. 200자까지. */
export function fileStem(name) {
  const s = str(name).trim();
  const dot = s.lastIndexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  return [...stem].slice(0, TITLE_MAX).join('').trim();
}

/** 붙여넣은 클립보드 그림(이름이 늘 image.png 같은 것)의 제목 힌트. 아니면 null. */
export function pastedHint(file) {
  if (!str(file?.type).startsWith('image/')) return null;
  return /^image\.[a-z0-9]+$/i.test(str(file?.name)) ? PASTED_IMAGE : null;
}

function firstLine(text) {
  const line = str(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ? [...line].slice(0, TITLE_FROM_BODY_MAX).join('').trim() : '';
}

// 제목을 비웠을 때 쓰일 것과 그 출처
function autoSource({ text, files, links } = {}) {
  const fromBody = firstLine(text);
  if (fromBody) return { title: fromBody, hint: false };
  const first = Array.from(files ?? [])[0];
  if (first) return first.hint ? { title: first.hint, hint: true } : { title: fileStem(first.name), hint: false };
  const link = Array.from(links ?? [])[0];
  return { title: link ? str(link).trim() : '', hint: false };
}

/**
 * 제목을 비우면 쓰일 제목(제목 칸의 placeholder): 글 첫 줄(40자) → 첫 파일 이름(확장자 뺌) → 첫 링크 주소.
 * files = [{ name, hint? }], links = 주소 문자열 목록.
 */
export function autoTitle(parts) {
  return autoSource(parts).title;
}

/**
 * 서버에 보낼 제목. 쓴 것이 있으면 그것. 비웠으면 ''(서버가 같은 규칙으로 정한다).
 * 다만 붙여넣은 그림이 제목이 될 때는 서버가 모르는 힌트("붙여넣은 이미지")를 보낸다.
 */
export function submitTitle(typed, parts) {
  const t = str(typed).trim();
  if (t) return [...t].slice(0, TITLE_MAX).join('');
  const src = autoSource(parts);
  return src.hint ? src.title : '';
}

const fileKey = (f) => `${f?.name}\u0000${f?.size}\u0000${f?.lastModified}`;

/** incoming 가운데 새로 담을 것만. 이름 · 크기 · 수정 시각이 같은 파일은 다시 담지 않는다. */
export function dedupeFiles(existing, incoming) {
  const seen = new Set(Array.from(existing ?? [], fileKey));
  const out = [];
  for (const f of Array.from(incoming ?? [])) {
    const k = fileKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** max 바이트를 넘는 파일을 가른다. 딱 max인 파일과 0바이트 파일은 담는다. */
export function partitionBySize(files, max = FILE_MAX) {
  const ok = [];
  const tooBig = [];
  for (const f of Array.from(files ?? [])) (f.size > max ? tooBig : ok).push(f);
  return { ok, tooBig };
}

/**
 * 파일을 담을 계획. room은 남은 첨부 자리 수.
 * → { add: 담을 파일, tooBig: 500MB 초과 수, repeated: 이미 담긴 파일 수, overflow: 자리가 없어 못 담은 수 }
 */
export function planAdd({ existing, incoming, room = ATTACH_MAX } = {}) {
  const { ok, tooBig } = partitionBySize(incoming);
  const fresh = dedupeFiles(existing, ok);
  const n = Math.max(0, Number(room) || 0);
  return {
    add: fresh.slice(0, n),
    tooBig: tooBig.length,
    repeated: ok.length - fresh.length,
    overflow: Math.max(0, fresh.length - n),
  };
}

/**
 * 파일을 담을 때 빠진 것을 알리는 토스트 한 줄(planAdd의 결과). 알릴 것이 없으면 null.
 * 이유가 하나면 그 문구, 여럿이면 한 줄에 이유마다 개수를 적는다. 일부를 담았을 때 이미 담긴 파일만 빠진 것은 알리지 않는다.
 */
export function addToast(plan) {
  const { add = [], tooBig = 0, repeated = 0, overflow = 0 } = plan ?? {};
  const parts = [];
  if (tooBig) parts.push(`500MB보다 큰 파일 ${num(tooBig)}개`);
  if (repeated) parts.push(`이미 담긴 파일 ${num(repeated)}개`);
  if (overflow) parts.push(`${ATTACH_MAX}개를 넘은 파일 ${num(overflow)}개`);
  if (parts.length > 1) return `${add.length ? '일부만 담았어요' : '담지 못했어요'}. ${parts.join(' · ')}`;
  if (overflow) return TOO_MANY_TOAST;
  if (tooBig) return TOO_BIG_TOAST;
  if (repeated && !add.length) return '이미 담긴 파일이에요';
  return null;
}

/**
 * 놓은 것에서 파일만 꺼낸다. 폴더(webkitGetAsEntry()?.isDirectory)는 빼고 센다.
 * drop 이벤트 처리 안에서 바로 불러야 한다(끝나면 목록이 비워진다).
 */
export function splitDropped(items) {
  const files = [];
  let folders = 0;
  for (const item of Array.from(items ?? [])) {
    if (!item || item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      folders += 1;
      continue;
    }
    const f = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (f) files.push(f);
  }
  return { files, folders };
}

function countSkips(skipped) {
  let dup = 0;
  let big = 0;
  for (const s of Array.from(skipped ?? [])) {
    if (s?.reason === 'duplicate') dup += 1;
    else if (s?.reason === 'too_large') big += 1;
  }
  return { dup, big };
}

/** 별을 띄웠을 때(201)의 토스트. 빼고 저장한 파일이 있으면 함께 알린다. */
export function resultToast(skipped) {
  const { dup, big } = countSkips(skipped);
  const parts = [];
  if (dup) parts.push(`이미 있는 파일 ${num(dup)}개`);
  if (big) parts.push(`500MB보다 큰 파일 ${num(big)}개`);
  return parts.length ? `별을 띄웠어요. ${parts.join('와 ')}는 빼고 띄웠어요` : '별을 띄웠어요';
}

/** 뺀 뒤 남는 것이 없어 별을 만들지 않았을 때(409 nothing_to_save)의 한 줄. */
export function nothingToast(skipped) {
  const { dup, big } = countSkips(skipped);
  if (big && !dup) return TOO_BIG_TOAST;
  if (big && dup) return '띄울 것이 없어요. 이미 있거나 너무 큰 파일이에요';
  return '이미 있는 별이에요';
}

const FILE_NAME_MAX = 200;

/**
 * 서버가 저장하는 파일 이름(server/files.js parseFileName의 fileName과 같다): NFC, 제어 · 방향 문자 제거,
 * 경로의 마지막 조각, 비면 'untitled', 200자(코드 포인트)를 넘으면 확장자([a-z0-9]{1,10})를 남기고 자른다.
 */
export function serverFileName(raw) {
  const cleaned = str(raw)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  let name =
    cleaned
      .split(/[\\/]/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .pop() ?? '';
  if (name === '') name = 'untitled';
  let dot = name.lastIndexOf('.');
  if (!/^[a-z0-9]{1,10}$/.test(dot >= 0 ? name.slice(dot + 1).toLowerCase() : '')) dot = -1;
  const chars = [...name];
  if (chars.length <= FILE_NAME_MAX) return name;
  if (dot > 0) {
    const suffix = name.slice(dot);
    return [...name.slice(0, dot)].slice(0, FILE_NAME_MAX - [...suffix].length).join('') + suffix;
  }
  return chars.slice(0, FILE_NAME_MAX).join('');
}

/**
 * 서버가 뺀 파일(skipped)을 칩에 짝짓는다. 서버는 파일을 보낸 순서대로 다루므로 이름을 앞에서부터 짝짓는다.
 * → items와 같은 길이의 배열: 뺀 이유('duplicate' | 'too_large' | …) 또는 null.
 */
export function matchSkipped(items, skipped) {
  const list = Array.from(items ?? []);
  const out = list.map(() => null);
  for (const skip of Array.from(skipped ?? [])) {
    if (typeof skip?.file_name !== 'string') continue;
    const want = serverFileName(skip.file_name);
    const at = list.findIndex((it, i) => out[i] === null && it?.kind === 'file' && serverFileName(it.file?.name) === want);
    if (at >= 0) out[at] = typeof skip.reason === 'string' ? skip.reason : 'failed';
  }
  return out;
}

/** 서버가 뺀 칩 아래에 보일 짧은 말. */
export function skipNote(reason) {
  if (reason === 'duplicate') return '이미 있는 파일';
  if (reason === 'too_large') return '500MB보다 커서 뺐어요';
  return reason ? '저장하지 못한 파일' : '';
}

/** 저장 실패 때 발 위에 보일 한 줄. hasFiles는 파일을 함께 올리던 중인지. */
export function saveError(err, hasFiles = false) {
  switch (err?.code) {
    case 'offline':
      return '서버와 연결이 끊겨서 저장하지 못했어요. 서버를 켠 뒤 다시 눌러 주세요';
    case 'aborted':
      return '올리기를 멈췄어요';
    case 'stop_late':
      return '멈추기 전에 다 올라갔을 수 있어요. 목록을 확인해 주세요';
    case 'upload_failed':
      return '읽을 수 없는 파일이 있어요. 폴더는 담을 수 없어요';
    case 'upload_incomplete':
      return '파일을 다 받지 못했어요. 다시 눌러 주세요';
    case 'unknown_planet':
      return '그 행성이 사라졌어요. 다시 골라 주세요';
    case 'too_large':
      return hasFiles ? TOO_BIG_TOAST : '글이 너무 길어요';
    case 'invalid_body':
      return '글이 너무 길어요';
    case 'invalid_url':
    case 'invalid_links':
      return URL_REFUSED;
    case 'too_many_attachments':
      return TOO_MANY_TOAST;
    case 'invalid_name':
      return '행성 이름은 1~20자로 써 주세요';
    case 'empty_star':
      return '내용을 입력해 주세요';
    default:
      return '저장하지 못했어요. 다시 눌러 주세요';
  }
}
