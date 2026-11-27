// 화면 공통 도우미. 불러올 때 DOM을 건드리지 않는다(테스트는 node 환경).

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 사용자 입력을 HTML에 넣기 전에 반드시 거친다. */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** 기본 행성 '미분류'의 id. 서버의 UNSORTED_ID와 같다. */
export const UNSORTED_ID = 'unsorted';

/** 행성 객체 또는 id가 미분류인가. */
export function isUnsorted(planetOrId) {
  return String(planetOrId?.id ?? planetOrId) === UNSORTED_ID;
}

/* ---------- 아이콘 (Lucide, 인라인 SVG) ---------- */
const IC = {
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  'file-text':
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  square: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'trash-2':
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  'message-square-plus':
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
  house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'messages-square':
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  paperclip:
    '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
};

/** Lucide 아이콘의 SVG 문자열. 선 굵기 2.5, 색은 글자색을 따른다. */
export function ico(name, size = 18) {
  const z = Number(size) || 18;
  const body = Object.hasOwn(IC, name) ? IC[name] : '';
  return `<svg class="i" width="${z}" height="${z}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* ---------- 날짜 · 기간 ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const midnight = (d, addDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays);

// 'YYYY-MM-DD' → 그 날의 현지 자정. 달력에 없는 날짜면 null.
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * 기간을 서버에 보낼 ISO 범위로 바꾼다. from은 포함, to는 미포함.
 * - today: 오늘 현지 자정 ~ 내일 자정
 * - week: 오늘 포함 최근 7일
 * - custom: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } 끝 날짜 포함. 날짜가 없거나 틀리면 오늘.
 * - all: 빈 범위(서버는 조건 없이 모든 별을 준다)
 */
export function periodRange(period, custom, now = new Date()) {
  if (period === 'all') return { from: '', to: '' };
  let start = midnight(now);
  let end = midnight(now, 1);
  if (period === 'week') {
    start = midnight(now, -6);
  } else if (period === 'custom') {
    let a = parseDay(custom?.from);
    let b = parseDay(custom?.to);
    if (a && b) {
      if (a > b) [a, b] = [b, a];
      start = a;
      end = midnight(b, 1);
    }
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

const PERIOD_NAME = { all: '전체', today: '오늘', week: '이번 주', custom: '직접 지정' };

/** 기간 이름: 우주의 🕐 버튼(#wPeriodName)과 행성 패널 머리가 같은 이름을 쓴다. 모르는 값이면 '' */
export function periodName(period) {
  return PERIOD_NAME[period] ?? '';
}

/** 기간에 맞는 별 개수 말머리: 전체면 "전체 별", 아니면 "이 기간 별" */
export function periodCountLabel(period) {
  return period === 'all' ? '전체 별' : '이 기간 별';
}

/** '11.11' (현지 날짜) */
export function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

/** 현지 달력 기준으로 며칠 전인지. 앞날이면 0. */
export function daysAgo(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}

// 지난 날 수를 말로: 0 → 오늘, 1 → 어제, 그 밖은 n일 전
const agoText = (days) => (days === 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`);

/**
 * 목록의 날짜(홈 별 목록 · 행성 패널 · 챗봇 출처 카드). 현지 달력 기준.
 * 오늘 · 어제 · 2~6일 전은 "n일 전", 그 뒤로는 올해면 "11.11", 다른 해면 "25.11.11". 앞날(시계 차이)은 "오늘"
 */
export function listDate(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = daysAgo(iso, now);
  if (days < 7) return agoText(days);
  const md = `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${String(d.getFullYear()).slice(-2)}.${md}`;
}

/** '2026-11-11 · 오늘' · '2026-11-10 · 어제' · '2026-11-01 · 10일 전' (별 상세) */
export function fullDate(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '날짜 미확인';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} · ${agoText(daysAgo(iso, now))}`;
}

/* ---------- 행성 모습 ---------- */
// 1~8: DESIGN.md 3-1, 9~16: 스펙 6-6. face는 3D · 색 점, deep은 밝은 패널 위 글자 · 선.
export const PLANET_COLORS = Object.freeze({
  1: { name: '주황', face: '#ff7a59', deep: '#b23a1c' },
  2: { name: '하늘', face: '#5ec8ff', deep: '#0f6aa8' },
  3: { name: '연두', face: '#8fdc5a', deep: '#2f7a1e' },
  4: { name: '연보라', face: '#c29bff', deep: '#6a3fc8' },
  5: { name: '호박', face: '#ffb13b', deep: '#8f5a00' },
  6: { name: '분홍', face: '#ff6fb5', deep: '#b0246f' },
  7: { name: '청록', face: '#4fd1c5', deep: '#0d7068' },
  8: { name: '남보라', face: '#9aa7ff', deep: '#3f4fc0' },
  9: { name: '빨강', face: '#ff5a5a', deep: '#b3202a' },
  10: { name: '민트', face: '#7cf0b0', deep: '#157a4a' },
  11: { name: '파랑', face: '#4f8dff', deep: '#1f4fc0' },
  12: { name: '자주', face: '#d96bff', deep: '#8a22b8' },
  13: { name: '라임', face: '#c6e84a', deep: '#566e00' },
  14: { name: '살구', face: '#ffc9a3', deep: '#9a4a1c' },
  15: { name: '은회색', face: '#b9c6e0', deep: '#48587a' },
  16: { name: '코코아', face: '#c98a5a', deep: '#7a4520' },
});

/** 기본 행성 '미분류'의 색. 어떤 팔레트 색과도 겹치지 않는 슬레이트라서 "고르지 않은 곳"으로 읽힌다. */
export const UNSORTED_FACE = '#4c5b6b';
export const UNSORTED_DEEP = '#26303c';

/** 행성의 면 색(3D · 점 · 칩). 미분류는 슬레이트, 모르는 행성은 fallback. */
export function planetFace(planet, fallback = '#7a6cff') {
  if (isUnsorted(planet) && planet) return UNSORTED_FACE;
  return PLANET_COLORS[planet?.color_index]?.face ?? fallback;
}

/** 행성의 진한 색(밝은 패널 위 글자 · 선). */
export function planetDeep(planet, fallback = '') {
  if (isUnsorted(planet) && planet) return UNSORTED_DEEP;
  return PLANET_COLORS[planet?.color_index]?.deep ?? fallback;
}

export const DECO_NAMES = Object.freeze({
  town: '마을',
  crystal: '수정',
  forest: '숲',
  rock: '바위',
  ice: '얼음',
  volcano: '화산',
  mushroom: '버섯',
  cactus: '선인장',
  flower: '꽃',
  cloud: '구름',
});

/* ---------- 글자 ---------- */
/** '1.2MB'. 값을 모르면 '크기 미확인'. */
export function fileSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '크기 미확인';
  if (bytes < 1024) return `${Math.round(bytes).toLocaleString('en-US')}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  // 반올림해서 1024.0이 되는 값도 다음 단위로 넘긴다
  while (u < units.length - 1 && Math.round(v * 10) / 10 >= 1024) {
    v /= 1024;
    u += 1;
  }
  const n = Math.round(v * 10) / 10;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}${units[u]}`;
}

/** 비어 있지 않은 첫 줄을 다듬어 max자까지. */
export function firstLine(text, max = 40) {
  if (text === null || text === undefined) return '';
  const line = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!line) return '';
  return Array.from(line).slice(0, max).join('').trim();
}
