// W-05 저장 창 · 끌어다 놓기 · 붙여넣기의 순수 함수(DOM 없음). 문구는 스펙 6-3 · 6-4와 계획 Task 11 그대로다.
// 한도는 서버와 같다: 파일 하나 500MB, 한 번에 500개, 메모 20,000자, 제목 200자, 행성 이름 20자.

export const FILE_MAX = 500 * 1024 * 1024;
export const FILES_MAX = 500;
export const MEMO_MAX = 20000;
export const TITLE_MAX = 200;
export const PLANET_NAME_MAX = 20;

export const URL_ERROR = '주소는 http로 시작해야 해요';
export const TOO_BIG_TOAST = '500MB보다 큰 파일은 담을 수 없어요';
export const TOO_MANY_TOAST = '한 번에 500개까지 띄울 수 있어요';
export const FOLDER_TOAST = '폴더는 담을 수 없어요. 파일만 놓아 주세요';

const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const str = (v) => (typeof v === 'string' ? v : '');
// 공백 없는 http(s) 주소 하나. 호스트가 한 글자는 있어야 한다.
const HTTP_URL = /^https?:\/\/[^\s/]\S*$/i;

// 글 하나를 link(전체가 공백 없는 http(s) 주소 하나) · text(그 밖의 비어 있지 않은 글) · null로 가른다.
function classifyText(text) {
  const raw = str(text);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (HTTP_URL.test(trimmed)) return { tab: 'link', url: trimmed };
  return { tab: 'text', text: raw };
}

/**
 * 붙여넣은 것을 어느 탭으로 열지 정한다.
 * 파일이 있으면 file, 글 전체가 공백 없는 http(s) 주소 하나면 link, 그 밖의 비어 있지 않은 글이면 text, 없으면 null.
 * 글과 함께 온 파일이 모두 이미지면 글을 쓴다(엑셀 · 워드 · 파워포인트에서 복사하면 글 옆에 그림이 같이 온다).
 */
export function classifyPaste({ files, text } = {}) {
  const list = Array.from(files ?? []);
  const found = classifyText(text);
  if (!list.length) return found;
  if (found && list.every((f) => str(f?.type).startsWith('image/'))) return found;
  return { tab: 'file', files: list };
}

/**
 * 끌어다 놓은 것을 어느 탭으로 열지 정한다. 파일이 있으면 file.
 * 없으면 text/uri-list의 첫 http(s) 주소(#으로 시작하는 줄은 설명이라 건너뛴다) → link,
 * 그것도 없으면 text/plain을 붙여넣기처럼 가른다(주소 하나면 link, 그 밖의 글이면 text). 쓸 것이 없으면 null.
 */
export function classifyDrop({ types, uriList, text, files } = {}) {
  const list = Array.from(files ?? []);
  if (list.length) return { tab: 'file', files: list };
  const kinds = Array.from(types ?? []);
  if (kinds.includes('text/uri-list')) {
    for (const line of str(uriList).split(/\r?\n/)) {
      const url = line.trim();
      if (url && !url.startsWith('#') && HTTP_URL.test(url)) return { tab: 'link', url };
    }
  }
  if (kinds.includes('text/plain')) return classifyText(text);
  return null;
}

/** 주소 칸 아래에 보일 글. 비어 있으면 null, http:// · https://로 시작하는 주소가 아니면 안내 문구. */
export function urlError(url) {
  const u = str(url).trim();
  if (!u) return null;
  return HTTP_URL.test(u) ? null : URL_ERROR;
}

const INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g;

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
  return str(name)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '')
    .trim();
}

/** 다듬은 행성 이름의 글자 수(코드 포인트). */
export function planetNameLength(name) {
  return [...cleanPlanetName(name)].length;
}

/** "별 띄우기"를 누를 수 있는지: 지금 탭에 내용이 있고 행성이 정해졌을 때. */
export function canSubmit({ tab, text, url, files, planetId, newPlanetName } = {}) {
  if (planetId === null || planetId === undefined || planetId === '') return false;
  if (planetId === 'new') {
    const n = planetNameLength(newPlanetName);
    if (n < 1 || n > PLANET_NAME_MAX) return false;
  }
  if (tab === 'text') return str(text).trim() !== '';
  if (tab === 'link') return str(url).trim() !== '' && urlError(url) === null;
  if (tab === 'file') {
    const n = Array.from(files ?? []).length;
    return n >= 1 && n <= FILES_MAX;
  }
  return false;
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

/** 저장 결과를 한 줄로. 하나도 저장되지 않았으면 창을 닫지 않는다(부르는 쪽이 본다). */
export function resultToast({ created, skipped } = {}) {
  const n = Array.from(created ?? []).length;
  const skips = Array.from(skipped ?? []);
  let dupBig = 0;
  let many = 0;
  let failed = 0;
  for (const s of skips) {
    if (s?.reason === 'duplicate' || s?.reason === 'too_large') dupBig += 1;
    else if (s?.reason === 'too_many') many += 1;
    else failed += 1;
  }
  if (n > 0) {
    let out = `별 ${num(n)}개를 띄웠어요`;
    if (dupBig) out += `. ${num(dupBig)}개는 이미 있거나 너무 커서 빼놨어요`;
    if (failed) out += `. ${num(failed)}개는 저장하지 못했어요`;
    if (many) out += `. ${TOO_MANY_TOAST}`;
    return out;
  }
  if (!skips.length) return '띄운 별이 없어요';
  if (skips.length === 1 && skips[0]?.reason === 'duplicate') return '이미 있는 별이에요';
  if (skips.length === 1 && skips[0]?.reason === 'too_large') return TOO_BIG_TOAST;
  if (failed && dupBig) return `띄운 별이 없어요. ${num(dupBig)}개는 이미 있거나 너무 컸고, ${num(failed)}개는 저장하지 못했어요`;
  if (failed) return `띄운 별이 없어요. ${num(failed)}개는 저장하지 못했어요`;
  if (dupBig) return '띄운 별이 없어요. 이미 있거나 너무 큰 파일이에요';
  return `띄운 별이 없어요. ${TOO_MANY_TOAST}`;
}

const FINAL_SKIP = new Set(['duplicate', 'too_large']);
const sameName = (v) => str(v).normalize('NFC').trim();

/**
 * 올린 뒤에도 목록에 남길 항목(저장되지 않아 다시 올릴 것)을 원래 순서대로 돌려준다.
 * 서버는 파일을 보낸 순서대로 다루므로 created · skipped의 file_name을 앞에서부터 짝짓는다.
 * 저장된 것 · duplicate · too_large는 끝난 것이라 빠지고, 그 밖의 이유(failed 등)는 남는다.
 * 이름 없는 건너뜀(too_many · 중간에 끊긴 failed)이 있으면 마지막으로 짝지은 항목 뒤의 것이 모두 남는다.
 * @param {{ file: { name: string } }[]} items
 */
export function remainingAfterUpload(items, { created, skipped } = {}) {
  const list = Array.from(items ?? []);
  const state = list.map(() => null); // null = 소식 없음, 'done' = 끝남, 'keep' = 다시 올릴 것
  const take = (fileName, mark) => {
    const want = sameName(fileName);
    const at = list.findIndex((it, i) => state[i] === null && sameName(it?.file?.name) === want);
    if (at >= 0) state[at] = mark;
  };
  let cut = false;
  for (const star of Array.from(created ?? [])) {
    if (typeof star?.file_name === 'string') take(star.file_name, 'done');
  }
  for (const skip of Array.from(skipped ?? [])) {
    if (typeof skip?.file_name === 'string') take(skip.file_name, FINAL_SKIP.has(skip.reason) ? 'done' : 'keep');
    else if (!FINAL_SKIP.has(skip?.reason)) cut = true;
  }
  const last = state.reduce((at, mark, i) => (mark === null ? at : i), -1);
  return list.filter((_, i) => state[i] === 'keep' || (cut && i > last));
}

/** 일부만 저장됐을 때 발 위에 보일 한 줄. n은 목록에 남은 파일 수. */
export function remainingMessage(n, skipped) {
  if (Array.from(skipped ?? []).some((s) => s?.reason === 'too_many')) return `${TOO_MANY_TOAST}. 남은 ${num(n)}개를 이어서 띄워 주세요`;
  return `${num(n)}개는 저장하지 못했어요. 다시 눌러 주세요`;
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

/** 파일 이름에서 확장자를 뺀 것(제목 기본값). 200자까지. */
export function fileStem(name) {
  const s = str(name).trim();
  const dot = s.lastIndexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  return [...stem].slice(0, TITLE_MAX).join('').trim();
}

/** 붙여넣은 파일의 제목. 화면 갈무리는 이름이 늘 image.png라서 따로 붙인다. */
export function pastedTitle(file) {
  if (file?.name === 'image.png' && str(file?.type).startsWith('image/')) return '붙여넣은 이미지';
  return fileStem(file?.name);
}

/** 저장 실패 때 발 위에 보일 한 줄. tab은 저장하던 탭('text' | 'link' | 'file'). */
export function saveError(err, tab) {
  switch (err?.code) {
    case 'offline':
      return '서버와 연결이 끊겨서 저장하지 못했어요. 서버를 켠 뒤 다시 눌러 주세요';
    case 'aborted':
      return '올리기를 멈췄어요';
    case 'upload_failed':
      return '읽을 수 없는 파일이 있어요. 폴더는 담을 수 없어요';
    case 'unknown_planet':
      return '그 행성이 사라졌어요. 다시 골라 주세요';
    case 'too_large':
      return tab === 'file' ? TOO_BIG_TOAST : '글이 너무 길어요';
    case 'invalid_memo':
      return '메모가 너무 길어요';
    case 'invalid_url':
      return URL_ERROR;
    case 'invalid_name':
      return '행성 이름은 1~20자로 써 주세요';
    case 'empty_body':
      return '내용을 입력해 주세요';
    case 'no_files':
      return '담긴 파일이 없어요';
    default:
      return '저장하지 못했어요. 다시 눌러 주세요';
  }
}
