// W-02 행성 패널 · 행성 꾸미기 창 · 행성 삭제 창의 순수 함수(DOM 없음).
// 문구는 스펙 6-6 · 6-7 그대로다. 조사는 "을(를)" · "(으)로"로 쓴다.

const NAME_MAX = 20;
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const key = (v) => (v === null || v === undefined ? null : String(v));

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

/** 확정 버튼을 누를 수 있는지: 앞뒤 공백을 뗀 이름이 1~20자. */
export function canSubmitPlanet({ name } = {}) {
  const n = [...String(name ?? '').trim()].length;
  return n >= 1 && n <= NAME_MAX;
}

/** 저장 실패 때 창 안에 보일 글. */
export function planetSaveError(err) {
  if (err?.status === 400 && err.code === 'invalid_name') return '이름은 1~20자로 써 주세요';
  if (err?.status === 400 && err.code === 'invalid_description') return '한 줄 설명은 20자까지 쓸 수 있어요';
  return '저장하지 못했어요. 다시 눌러 주세요';
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
 * 목록 썸네일의 종류. 'thumb'이면 실제 이미지 축소본(api.thumbUrl), 그 밖에는 아이콘 이름.
 * 이미지인데 축소본이 없으면 'image' 아이콘.
 */
export function thumbKind(star) {
  const type = star?.type;
  if (type === 'image') return star.has_thumb ? 'thumb' : 'image';
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
