// 화면 공통 도우미. 불러올 때 DOM을 건드리지 않는다(테스트는 node 환경).

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 사용자 입력을 HTML에 넣기 전에 반드시 거친다. */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
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
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
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
 */
export function periodRange(period, custom, now = new Date()) {
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

/** '2026-11-11 · 0일 전' */
export function fullDate(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '날짜 미확인';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} · ${daysAgo(iso, now)}일 전`;
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
