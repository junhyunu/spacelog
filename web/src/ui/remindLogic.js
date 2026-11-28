// 잠든 별 블랙홀의 계산(화면 없이 테스트한다). remind.js · three/blackhole.js · home.js · account.js 가 쓴다.

export const REMIND_OPTIONS = Object.freeze([
  { days: 7, label: '7일' },
  { days: 14, label: '14일' },
  { days: 30, label: '30일' },
  { days: 0, label: '끄기' },
]);
export const REMIND_BATCH = 20; // 잠든 별 화면이 한 번에 받는 수(다 정리하면 다음 20개)
export const UNDO_MS = 5000; // 되돌리기 알림이 떠 있는 시간(지우기는 이 뒤에 실제로 지운다)
export const KEPT_INLINE_MAX = 5; // 설정 창에 바로 펼치는 알림 끈 별 수(넘으면 최근 3개 + 전체 보기)
export const KEPT_PREVIEW = 3;
export const SIZE_CAP = 20; // 블랙홀이 더 커지지 않는 잠든 별 수

const DAY_MS = 24 * 60 * 60 * 1000;

/** 잠든 별 수에 따른 블랙홀 크기 배율(1개 0.8 남짓 → 20개 이상 1.28). 0개면 0. */
export function holeScale(count) {
  const n = Number(count) || 0;
  if (n <= 0) return 0;
  return 0.78 + (0.5 * Math.min(n, SIZE_CAP)) / SIZE_CAP;
}

/** 마지막으로 본 때부터 지금까지 며칠(내림). 읽을 수 없으면 0. */
export function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** 카드 오른쪽 위 꼬리표. */
export function ageLabel(iso, now = Date.now()) {
  return `${daysSince(iso, now).toLocaleString('ko-KR')}일째 안 봤어요`;
}

/** 설정 창의 설명(문장마다 줄). → 줄 배열 */
export function remindHelp(days) {
  if (!days) return ['블랙홀을 만들지 않아요.', '홈 표시도 사라져요.'];
  return [`${days}일 동안 열어 보지 않은 별을 블랙홀에 모아요.`, '별을 열어 보면 처음부터 다시 세요.'];
}

/** 잠든 별 화면 위쪽의 설명 한 줄. */
export function remindSub(days) {
  return `${days}일 넘게 열어 보지 않은 별이에요`;
}

/** 줄에서 index 를 빼고, 다음에 볼 자리를 정한다(마지막이었으면 앞 칸). → { queue, index } */
export function removeAt(queue, index) {
  const next = queue.filter((_, i) => i !== index);
  return { queue: next, index: Math.max(0, Math.min(index, next.length - 1)) };
}

/** 되돌리기: 뺐던 별을 원래 자리(줄이 짧아졌으면 끝)에 다시 넣고 그 별을 보인다. → { queue, index } */
export function insertAt(queue, index, item) {
  const at = Math.max(0, Math.min(index, queue.length));
  const next = [...queue.slice(0, at), item, ...queue.slice(at)];
  return { queue: next, index: at };
}

/** 넘기기: 줄 안에서만 움직인다. → 새 index(움직일 수 없으면 그대로) */
export function stepIndex(index, dir, length) {
  const next = index + dir;
  return next < 0 || next >= length ? index : next;
}

/** 밀기를 넘기기로 칠지: 가로로 threshold 이상, 세로보다 많이. → -1(다음) | 1(이전) | 0 */
export function swipeDir(dx, dy, threshold = 70) {
  if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx < 0 ? -1 : 1;
}

/** 설정 창 알림 끈 별: 다 펼칠지, 최근 몇 개만 보일지. → { shown, more } */
export function keptPreview(list) {
  if (list.length <= KEPT_INLINE_MAX) return { shown: list, more: 0 };
  return { shown: list.slice(0, KEPT_PREVIEW), more: list.length };
}

/** 전체 목록의 찾기(제목에 글자가 들어 있으면). 앞뒤 공백 무시, 대소문자 무시. */
export function filterKept(list, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => String(s.title ?? '').toLowerCase().includes(q));
}

/** 홈 안내 문구(0이면 null → 원래 안내문). */
export function homeRemindText(total) {
  const n = Number(total) || 0;
  return n > 0 ? { count: n.toLocaleString('ko-KR') } : null;
}
