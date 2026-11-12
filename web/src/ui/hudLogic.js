// W-01 조작 UI의 판단만 모은 순수 함수(DOM 없음). 그리는 쪽은 hud.js.

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pad2 = (v) => String(v).padStart(2, '0');
const dayString = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// 'YYYY-MM-DD'가 달력에 있는 날짜인지
function validDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/**
 * 우주 화면의 상태(DESIGN.md W-01 상태 표).
 * - 'empty'         별도 행성도 없다: 가운데 카드만
 * - 'emptyPlanets'  별은 없지만 빈 행성이 있다: 행성 · 목록은 그대로, 작은 안내만
 * - 'cap'           기간 안의 별이 상한(2,000개)을 넘는다: 띠 배너. todayButton은 "오늘만 보기"를 넣을지
 * - 'normal'
 * total = 전체 별 수, inPeriod = 기간 안의 별 수, planets = 행성 수.
 */
export function worldStateOf({ total, inPeriod, planets, period, cap = 2000 } = {}) {
  if (n(inPeriod) > cap) return { kind: 'cap', todayButton: period !== 'today' };
  if (n(total) <= 0) return { kind: n(planets) > 0 ? 'emptyPlanets' : 'empty', todayButton: false };
  return { kind: 'normal', todayButton: false };
}

/** 우주에 들어온 직후: 기간이 오늘인데 오늘 별이 없고 전체는 1개 이상이면 이번 주로 넓힌다. */
export function shouldWiden({ period, inPeriod, total } = {}) {
  return period === 'today' && n(inPeriod) === 0 && n(total) >= 1;
}

/**
 * 그 별이 지금 기간 밖인지(밖이면 재발견 "손님 별"로 그 별만 잠시 보여 준다).
 * range = { from(포함), to(미포함) } ISO. 한쪽이 없으면 그쪽은 보지 않는다. 날짜를 못 읽으면 false.
 */
export function isOutsidePeriod(star, range) {
  const at = Date.parse(star?.created_at);
  if (Number.isNaN(at)) return false;
  const from = Date.parse(range?.from);
  const to = Date.parse(range?.to);
  if (!Number.isNaN(from) && at < from) return true;
  if (!Number.isNaN(to) && at >= to) return true;
  return false;
}

/** "직접 지정"의 처음 값: 오늘 포함 최근 30일. { from, to } 'YYYY-MM-DD'(현지 날짜). */
export function defaultCustom(now = new Date()) {
  return {
    from: dayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)),
    to: dayString(now),
  };
}

/**
 * 날짜 칸이 바뀐 뒤의 "직접 지정" 값. 비었거나 달력에 없는 날짜면 전 값을 그대로 두고,
 * 시작이 끝보다 뒤면 둘을 바꾼다.
 */
export function nextCustom(prev, patch = {}) {
  let from = validDay(patch.from) ? patch.from : prev.from;
  let to = validDay(patch.to) ? patch.to : prev.to;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
