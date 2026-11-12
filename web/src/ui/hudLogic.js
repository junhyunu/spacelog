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
 * - 'empty'         별도 행성도 없다: 빈 우주 말풍선(emptyHint)이 대신 안내한다
 * - 'emptyPlanets'  별은 없지만 빈 행성이 있다: 행성 · 목록은 그대로, 말풍선만
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

const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/**
 * 다시 그릴 때 손님 별을 어떻게 할지. guest = { id, planet_id }, planets · stars = 지금 기간으로 받은 것.
 * - 'none'      손님 별이 없다
 * - 'gone'      손님 별의 행성이 사라졌다 → 내린다
 * - 'inPeriod'  기간이 바뀌어 그 별이 이제 기간 안에 있다 → 손님이 아니다(보통 별로 그려진다)
 * - 'keep'
 */
export function guestVerdict({ guest, planets, stars } = {}) {
  if (!guest) return 'none';
  if (!(planets || []).some((p) => sameId(p?.id, guest.planet_id))) return 'gone';
  if ((stars || []).some((s) => sameId(s?.id, guest.id))) return 'inPeriod';
  return 'keep';
}

/** 서버에서 다시 받은 별(지워졌으면 null)을 보고, 손님 별이 지워졌거나 다른 행성으로 옮겨졌는지. */
export function guestMoved(guest, star) {
  if (!guest) return false;
  return !star || !sameId(star.planet_id, guest.planet_id);
}

/**
 * 기간 바꾸기가 실패했을 때 되돌아갈 곳. 마지막으로 받는 데 성공한 기간(loaded)으로 간다.
 * 더 새로운 바꾸기가 진행 중이거나(isLatest가 아님) 연결이 끊긴 것이면 되돌리지 않는다(null).
 */
export function revertTarget({ isLatest, offline, loaded } = {}) {
  if (!isLatest || offline || !loaded?.period) return null;
  return loaded;
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

/**
 * 빈 우주 말풍선(스펙 6-8): 기록하기 버튼 바로 위. 띄울 문구 { title, body }, 띄우지 않으면 null.
 * total = 전체 별 수(기간과 상관없이), planets = 행성 수, dismissed = ✕로 껐는지(브라우저에 기억),
 * offline = 연결 실패 카드가 떠 있는지. 별이 하나라도 있으면 스스로 사라진다.
 */
export function emptyHint({ total, planets, dismissed, offline } = {}) {
  if (dismissed || offline || n(total) > 0) return null;
  return {
    title: '아직 별이 없어요',
    body: n(planets) > 0 ? '기록하기를 누르거나 파일을 끌어다 놓아 보세요' : '+ 새 행성으로 첫 행성을 만들거나 기록하기를 눌러 보세요',
  };
}

/**
 * 왼쪽 패널의 처음 상태(스펙 6-8). 접혀 있으면 true.
 * stored = 브라우저에 기억한 값('open' | 'closed', 없거나 모르는 값이면 처음 열기 = 펼침),
 * narrow = 760px 이하. 좁으면 기억한 값보다 우선해 접는다.
 */
export function initialSideCollapsed({ stored, narrow } = {}) {
  if (narrow) return true;
  return stored === 'closed';
}
