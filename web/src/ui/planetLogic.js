// W-02 행성 패널 · 행성 꾸미기 창 · 행성 삭제 창의 순수 함수(DOM 없음).
// 문구는 스펙 6-6 · 6-7 그대로다. 조사는 "을(를)" · "(으)로"로 쓴다.
import { isUnsorted, periodName, shortDate } from '../util.js';

const TEXT_MAX = 20; // 이름 · 한 줄 설명
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const key = (v) => (v === null || v === undefined ? null : String(v));

// 직접 지정 기간의 날짜 표기: "11.20–11.26"(하루면 "11.20"). range.to는 끝 날 다음 자정이라 1ms 앞을 끝 날로 본다. 못 읽으면 ''
function rangeLabel(range) {
  const from = new Date(range?.from ?? '');
  const to = new Date(range?.to ?? '');
  if (!range?.from || !range?.to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '';
  const a = shortDate(from.toISOString());
  const b = shortDate(new Date(to.getTime() - 1).toISOString());
  return a === b ? a : `${a}–${b}`;
}

/**
 * 행성 패널 머리의 개수 줄. 위쪽 막대가 숨어도 무엇으로 걸렀는지 보이게 실제 기간을 쓴다.
 * 전체 기간이면 "전체 별 M개", 아니면 "오늘 별 N개 · 전체 M개"(이름은 periodName, 🕐 버튼과 같다).
 * 직접 지정은 실제 날짜 "11.20–11.26 별 N개 · 전체 M개"(range = store.state.range). 날짜를 못 읽으면 "직접 지정"
 */
export function panelCountText({ period, inPeriod, total, range } = {}) {
  if (period === 'all') return `전체 별 ${num(total)}개`;
  const name = (period === 'custom' && rangeLabel(range)) || periodName(period);
  return `${name} 별 ${num(inPeriod)}개 · 전체 ${num(total)}개`;
}

/* ---------- 행성 삭제 (스펙 6-7) ---------- */

/**
 * 삭제 확인 창의 세 경우.
 * 'empty' 별 0개 / 'choose' 별 있음 · 다른 행성 있음 / 'only' 별 있음 · 행성이 이것 하나뿐
 */
export function deleteMode({ countTotal, otherCount } = {}) {
  if (!(Number(countTotal) > 0)) return 'empty';
  return Number(otherCount) > 0 ? 'choose' : 'only';
}

export const deleteTitle = (name) => `행성 '${name}'을(를) 지울까요?`;
export const deleteWarning = (count) => `별 ${num(count)}개의 기록과 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.`;
export const moveLabel = (count) => `별 ${num(count)}개를 다른 행성으로 옮기고 지우기`;
export const removeLabel = (count) => `별 ${num(count)}개도 함께 지우기`;

/** 지운 뒤의 토스트. choice: 'move'면 옮기고 지움, 그 밖에는 그냥 지움. */
export function deleteToast({ name, choice, count, intoName } = {}) {
  if (choice === 'move') return `별 ${num(count)}개를 '${intoName}'(으)로 옮기고 지웠어요`;
  return `행성 '${name}'을(를) 지웠어요`;
}

/**
 * api.deletePlanet의 둘째 인자. 옮길 행성을 고르지 않았으면 null(보내지 않는다).
 * mode는 deleteMode()의 값, choice는 'move' | 'delete'(mode가 'choose'일 때만 본다).
 */
export function deleteRequest({ mode, choice, into } = {}) {
  if (mode === 'empty') return {};
  if (mode === 'only') return { stars: 'delete' };
  if (choice === 'delete') return { stars: 'delete' };
  return into ? { stars: 'move', into: String(into) } : null;
}

/* ---------- 행성 꾸미기 창 (스펙 6-6) ---------- */

/** 서버(server/planets.js의 clean)와 같은 정리: NFC로 맞추고, 보이지 않는 글자를 빼고, 앞뒤 공백을 뗀다. */
export const cleanText = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '')
    .trim();

/** 서버가 세는 글자 수(정리한 뒤의 코드 포인트 수). 이모지 하나는 1자, 풀어 쓴 한글(NFD)도 합쳐서 센다. */
export const textLength = (value) => [...cleanText(value)].length;

/** 칸 옆의 "n/20". */
export const counterText = (value, max = TEXT_MAX) => `${textLength(value)}/${max}`;

/** 확정 버튼을 누를 수 있는지: 정리한 이름이 1~20자이고 설명이 20자 이하. */
export function canSubmitPlanet({ name, description } = {}) {
  const n = textLength(name);
  return n >= 1 && n <= TEXT_MAX && textLength(description) <= TEXT_MAX;
}

/**
 * 이름 칸 아래의 흐린 안내: 이름이 비어 있을 때만(만들기 · 저장하기가 잠긴 까닭). 적었으면 ''.
 * 빨간 오류가 아니다: 창을 열자마자 보이므로 혼내는 말투를 쓰지 않는다.
 */
export const planetNameHint = (name, editing = false) =>
  textLength(name) === 0 ? `이름을 적으면 ${editing ? '저장할' : '만들'} 수 있어요` : '';

/** 쓰는 중에 보일 글자 수 안내. 넘지 않았으면 ''. */
export function planetFieldError({ name, description } = {}) {
  if (textLength(name) > TEXT_MAX) return '이름은 20자까지 쓸 수 있어요';
  if (textLength(description) > TEXT_MAX) return '설명은 20자까지 쓸 수 있어요';
  return '';
}

/** 저장 실패 때 창 안에 보일 글. */
export function planetSaveError(err) {
  if (err?.code === 'offline') return '서버와 연결이 끊겨서 저장하지 못했어요';
  if (err?.status === 400 && err.code === 'invalid_name') return '이름은 1~20자로 써 주세요';
  if (err?.status === 400 && err.code === 'invalid_description') return '설명은 20자까지 쓸 수 있어요';
  if (err?.status === 400 && err.code === 'invalid_look') return '색이나 장식을 다시 골라 주세요';
  return '저장하지 못했어요. 다시 눌러 주세요';
}

/** 꾸미던 행성이 그사이 지워졌는지(고칠 때의 404). */
export const planetGone = (err, editing) => Boolean(editing) && err?.status === 404;

export const STALE_TOAST = '그사이 내용이 바뀌었어요. 다시 확인해 주세요';

/**
 * 행성 삭제가 실패한 까닭.
 * 'gone' 이미 지워짐(404) / 'stale' 그사이 별이 생겼거나 옮길 행성이 사라짐 / 'offline' / 'error'
 */
export function deleteFailure(err) {
  if (err?.status === 404) return 'gone';
  if ((err?.status === 409 && err.code === 'not_empty') || (err?.status === 400 && err.code === 'invalid_target')) return 'stale';
  return err?.code === 'offline' ? 'offline' : 'error';
}

export const deleteErrorText = (kind) =>
  kind === 'offline' ? '서버와 연결이 끊겨서 지우지 못했어요' : '지우지 못했어요. 다시 눌러 주세요';

/** 합치기가 실패한 까닭. 'stale' 두 행성 중 하나가 사라짐 / 'offline' / 'error' */
export function mergeFailure(err) {
  if (err?.status === 404 || (err?.status === 400 && err.code === 'invalid_target')) return 'stale';
  return err?.code === 'offline' ? 'offline' : 'error';
}

export function mergeErrorText(kind) {
  if (kind === 'stale') return STALE_TOAST;
  return kind === 'offline' ? '서버와 연결이 끊겨서 합치지 못했어요' : '합치지 못했어요. 다시 눌러 주세요';
}

export function planetSavedToast({ created, name } = {}) {
  return created ? `행성 '${name}'을(를) 만들었어요` : '행성을 꾸몄어요';
}

/** "다른 행성과 합치기" 확인 창의 설명. */
export const mergeDesc = (count, intoName) =>
  `별 ${num(count)}개가 '${intoName}'(으)로 옮겨가고 이 행성은 사라져요. 되돌릴 수 없어요.`;

/**
 * 색 원 · 장식 칩 묶음 안에서 화살표 키로 옮겨 갈 자리. 옮기는 키가 아니면 null.
 * 좌우는 처음과 끝이 이어지고, 위아래는 cols칸씩 움직이되 줄이 없으면 그대로 있는다.
 * cols를 주지 않으면(줄바꿈 배치) 위아래도 좌우처럼 움직인다.
 */
export function moveIndex(index, keyName, count, cols) {
  if (!(count > 0)) return null;
  const wrap = (i) => ((i % count) + count) % count;
  switch (keyName) {
    case 'ArrowRight':
      return wrap(index + 1);
    case 'ArrowLeft':
      return wrap(index - 1);
    case 'ArrowDown':
      if (!cols) return wrap(index + 1);
      return index + cols < count ? index + cols : index;
    case 'ArrowUp':
      if (!cols) return wrap(index - 1);
      return index - cols >= 0 ? index - cols : index;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/* ---------- 행성 패널 (DESIGN.md W-02) ---------- */

/**
 * 별 상세를 다시 그려야 하는지 가르는 열쇠. 메모 칸의 글(본문 body, 옛 memo)은 뺀다(메모 칸은 상세가 쥐고 있고,
 * 자동 저장 뒤의 'data'가 쓰던 글을 건드리지 않게). 글이 있는지만 본다("종류"의 "글"이 달라진다).
 * 행성은 이름 · 색까지 본다(옮기기 목록에 보인다).
 */
export function detailKey(star, planets) {
  const { memo: _memo, body, ...rest } = star ?? {};
  const hasBody = typeof body === 'string' && body.trim() !== '';
  return JSON.stringify([rest, hasBody, (planets ?? []).map((p) => [String(p.id), p.name, p.color_index])]);
}

/**
 * 목록 썸네일의 종류(스펙 6-9). 'thumb'이면 첫 이미지 첨부의 축소본(api.attachmentThumbUrl(star.thumb_attachment_id)),
 * 그 밖에는 type 아이콘 이름. 이미지인데 축소본이 없으면 'image' 아이콘.
 */
export function thumbKind(star) {
  if (star?.thumb_attachment_id !== null && star?.thumb_attachment_id !== undefined && star.thumb_attachment_id !== '') return 'thumb';
  const type = star?.type;
  if (type === 'image') return 'image';
  if (type === 'link') return 'link';
  if (type === 'file') return 'file-text';
  return 'type';
}

/**
 * 그 행성의 별을 최신순으로. range({ from, to } ISO, from 포함 · to 미포함)를 주면 그 안의 별만.
 * 받은 배열은 바꾸지 않는다.
 */
export function panelStars(stars, planetId, range) {
  const pid = key(planetId);
  if (pid === null || !Array.isArray(stars)) return [];
  const from = range?.from ? Date.parse(range.from) : null;
  const to = range?.to ? Date.parse(range.to) : null;
  const time = (s) => Date.parse(s.created_at) || 0;
  return stars
    .filter((s) => {
      if (key(s?.planet_id) !== pid) return false;
      const t = time(s);
      if (from !== null && t < from) return false;
      if (to !== null && t >= to) return false;
      return true;
    })
    .sort((a, b) => time(b) - time(a));
}

/** 잠긴 행성(미분류)인가. 꾸미기 · 합치기 · 지우기를 막을 때 UI는 이것만 본다. */
export function planetLocked(planet) {
  return !!planet && isUnsorted(planet);
}

/* ---------- 여러 개 골라 옮기기 (우주 행성 패널 · 홈 별 목록) ---------- */

/**
 * 고른 별들을 옮길 수 있는 행성. 모두 한 행성의 별이면 그 행성을 뺀 목록, 섞였으면 전체(이미 그 행성에 있는 별은 서버가 건너뛴다).
 * 받은 배열은 바꾸지 않는다.
 */
export function moveTargets(pickedStars, planets) {
  const list = Array.isArray(planets) ? planets : [];
  const homes = new Set((pickedStars ?? []).map((s) => key(s?.planet_id)));
  if (homes.size !== 1) return [...list];
  const [only] = homes;
  return list.filter((p) => key(p.id) !== only);
}

/** 고른 것 중 지금 목록에 남은 것만(새 Set). 목록이 다시 그려질 때 사라진 별을 선택에서 뺀다. */
export function keepPicked(picked, stars) {
  const ids = new Set((Array.isArray(stars) ? stars : []).map((s) => key(s?.id)));
  return new Set([...(picked ?? [])].filter((id) => ids.has(key(id))));
}

/** "N개를 어느 행성으로 옮길까요?" 확인 창의 내용(ask() 인자). others = moveTargets()의 값(하나 이상). */
export function moveManyCopy(n, others) {
  const count = num(n);
  return {
    title: `${count}개를 어느 행성으로 옮길까요?`,
    desc: '옮기면 우주에서도 그 행성으로 날아가요.',
    confirmLabel: `${count}개 옮기기`,
    confirmKind: 'yellow',
    select: { options: others.map((p) => ({ value: p.id, label: p.name })), value: others[0].id, label: '옮길 행성' },
  };
}

/** 여러 개 옮긴 뒤의 토스트. moved = 서버가 실제로 옮긴 수(이미 그 행성에 있던 별 · 지워진 별은 빠진다). 0이면 옮긴 것이 없다. gone = 고른 별이 모두 그사이 지워졌다(0일 때만 뜻이 있다). */
export function moveManyToast(moved, name, { gone = false } = {}) {
  const n = Number(moved) || 0;
  if (n > 0) return `${num(n)}개를 '${name}'(으)로 옮겼어요`;
  return gone ? '그 별들은 지워졌어요' : '이미 그 행성에 있어요';
}

/* 고르기 버튼 · 아래 바의 마크업과 문구(두 화면이 같은 것을 쓴다). focusAttr = 다시 그릴 때 초점을 되찾는 속성(패널 'data-focus' · 홈 'data-fk') */

/** 목록 위의 "여러 개 고르기" 버튼. 고르는 중이면 같은 자리가 "취소", 고를 수 없으면(canPick false) ''. */
export function pickButtonHtml({ picking = false, canPick = false, focusAttr = 'data-focus' } = {}) {
  if (!picking && !canPick) return '';
  return `<button type="button" class="pickbtn" data-act="pick" ${focusAttr}="pick">${picking ? '취소' : '여러 개 고르기'}</button>`;
}

/**
 * 고르는 중의 아래 바: "N개 골랐어요" + 오른쪽에 "행성 옮기기" · "지우기". 좁은 자리에서는 CSS가 두 줄로 놓는다.
 * 0개면 둘 다 잠긴다. canMove가 false(옮길 행성이 없다: moveTargets()가 빈 목록)면 "행성 옮기기"만 잠긴다.
 */
export function pickBarHtml({ count = 0, canMove = true, focusAttr = 'data-focus' } = {}) {
  const n = Number(count) || 0;
  const off = n ? '' : ' disabled';
  const moveOff = n && canMove ? '' : ' disabled';
  return (
    `<div class="pickbar"><span class="pk-n"><b>${num(n)}</b>개 골랐어요</span><span class="pk-acts">` +
    `<button type="button" class="btn sm" data-act="movePicked" ${focusAttr}="pickbar"${moveOff}>행성 옮기기</button>` +
    `<button type="button" class="btn sm pkdel" data-act="pickdel" ${focusAttr}="pickdel"${off}>지우기</button></span></div>`
  );
}

/** 머리의 전체 선택 체크칸이 보일 상태. 보이는 것만 센다(보이는 것이 0개면 'none'). */
export function pickAllState(pickedIds, visibleIds) {
  const visible = (visibleIds ?? []).map(String);
  if (!visible.length) return 'none';
  const picked = new Set([...(pickedIds ?? [])].map(String));
  const n = visible.filter((id) => picked.has(id)).length;
  if (n === 0) return 'none';
  return n === visible.length ? 'all' : 'some';
}

/** 전체 선택 체크칸을 눌렀을 때의 새 Set: 모두 골라져 있으면 비우고, 아니면 보이는 것 전부(보이지 않는 고른 것은 남기지 않는다). */
export function toggleAll(pickedIds, visibleIds) {
  if (pickAllState(pickedIds, visibleIds) === 'all') return new Set();
  return new Set((visibleIds ?? []).map(String));
}

const PICK_ALL_CHECKED = { all: 'true', some: 'mixed', none: 'false' };

/** 머리의 전체 선택 체크칸(행 체크칸과 같은 .cb 모양, 일부만 골랐으면 '−'). */
export function pickAllHtml({ state = 'none', focusAttr = 'data-focus' } = {}) {
  const checked = PICK_ALL_CHECKED[state] ?? 'false';
  return (
    `<button type="button" class="pickcb pickall" data-act="pickall" ${focusAttr}="pickall" role="checkbox" aria-checked="${checked}" aria-label="보이는 별 모두 고르기">` +
    `<span class="cb" aria-hidden="true">${checked === 'mixed' ? '−' : ''}</span></button>`
  );
}

/**
 * 고른 별들의 보관함 복사본 수(파일 · 이미지 첨부, detailLogic.deleteCopy와 같은 셈). n = 고른 수.
 * 고른 별이 목록에 다 있지 않거나 첨부 목록(attachments)이 없는 별이 있으면 셀 수 없어 null.
 */
export function vaultCopies(pickedStars, n) {
  const stars = Array.isArray(pickedStars) ? pickedStars : [];
  if (stars.length < (Number(n) || 0) || !stars.every((s) => Array.isArray(s?.attachments))) return null;
  return stars.reduce((sum, s) => sum + s.attachments.filter((a) => a?.kind === 'file' || a?.kind === 'image').length, 0);
}

/** "N개를 지울까요?" 확인 창의 내용(ask() 인자). copies = vaultCopies()의 값(null이면 수를 말하지 않는다). */
export function deleteManyCopy(n, copies) {
  const count = num(n);
  let desc;
  if (copies === null || copies === undefined) desc = `기록 ${count}개와 첨부 파일의 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.`;
  else if (Number(copies) > 0) desc = `기록과 첨부 파일 ${num(copies)}개의 보관함 복사본이 함께 지워져요. 되돌릴 수 없어요.`;
  else desc = `기록 ${count}개가 지워져요. 되돌릴 수 없어요.`;
  return { title: `${count}개를 지울까요?`, desc, confirmLabel: `${count}개 지우기`, confirmKind: 'pink' };
}

/** 여러 개 지운 뒤의 토스트. deleted = 서버가 실제로 지운 수. */
export function deleteManyToast(deleted) {
  const n = Number(deleted) || 0;
  return n > 0 ? `${num(n)}개를 지웠어요` : '그 별들은 이미 지워졌어요';
}

/** 여러 별 요청 한 번에 보낼 수 있는 id 수(server/stars.js checkIds와 같다). */
export const BATCH_MAX = 500;

/** 배열을 size개씩 끊은 새 배열들(받은 배열은 바꾸지 않는다). 빈 배열이면 []. */
export function chunk(list, size = BATCH_MAX) {
  const arr = Array.isArray(list) ? list : [];
  const n = Math.max(1, Math.floor(Number(size)) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * 500개씩 끊어 차례로 보낸다. send(batch) → 그 묶음에서 처리한 수(숫자가 아니면 0).
 * 중간 묶음이 실패하면 거기서 멈춘다(뒤 묶음은 보내지 않는다). 앞 묶음은 이미 처리됐으니 부르는 쪽이 doneIds로 화면을 고친다.
 * @returns {Promise<{ count: number, doneIds: any[], error: any }>} error는 실패가 없으면 null
 */
export async function runBatches(ids, send, size = BATCH_MAX) {
  let count = 0;
  const doneIds = [];
  for (const batch of chunk(ids, size)) {
    try {
      count += Number(await send(batch)) || 0;
    } catch (error) {
      return { count, doneIds, error };
    }
    doneIds.push(...batch);
  }
  return { count, doneIds, error: null };
}

/** 앞 묶음은 처리됐고 뒤 묶음이 실패했을 때의 토스트. kind: 'move' | 'delete', n = 처리된 수. */
export function partialFailToast(kind, n) {
  return kind === 'move' ? `${num(n)}개는 옮겼고 나머지는 옮기지 못했어요` : `${num(n)}개는 지웠고 나머지는 지우지 못했어요`;
}

/** 고른 것에서 id 하나를 넣거나 뺀 새 Set(받은 것은 바꾸지 않는다). */
export function togglePickedId(pickedIds, id) {
  const next = new Set(pickedIds ?? []);
  const k = String(id);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
}
