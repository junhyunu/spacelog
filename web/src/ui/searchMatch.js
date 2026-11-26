// 홈 목록 검색과 우주 별 찾기가 함께 쓰는 검색 규칙(DOM 없음).
// 비교 전 NFC + 소문자 · 띄어쓰기 무시 · 낱말 순서 무관 · 1글자 낱말은 앞 낱말에 붙인다.
import { esc } from '../util.js';

/** NFC + 소문자. */
export const normText = (s) => String(s ?? '').normalize('NFC').toLowerCase();

/** 검색어를 낱말로 나눈다(정규화 · 공백 없음). 1글자 낱말은 앞 낱말에(맨 앞이면 다음 낱말에) 붙인다. 비면 []. */
export function queryTerms(q) {
  const words = normText(q).split(/\s+/).filter(Boolean);
  const out = [];
  let pendingHead = '';
  for (const w of words) {
    if ([...w].length === 1) {
      if (out.length) out[out.length - 1] += w;
      else pendingHead += w;
    } else {
      out.push(pendingHead + w);
      pendingHead = '';
    }
  }
  if (pendingHead) out.push(pendingHead);
  return out;
}

/** 공백을 뺀 소문자 글(강조 위치용)과, 그 글자들의 NFC 글 안 원래 위치. markRanges 전용(느리다). */
function compact(text) {
  const s = String(text ?? '').normalize('NFC'); // 보여 줄 글(대소문자 유지)
  const low = s.toLowerCase(); // normText와 같은 소문자(문맥 따라 달라지는 글자도 같게)
  // 길이가 같으면 글자마다 1:1 대응. 달라지면(드문 경우) 글자별로 소문자로 바꿔 같은 원래 위치에 매핑한다
  const sameLen = low.length === s.length;
  let flat = '';
  const pos = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue;
    const c = sameLen ? low[i] : s[i].toLowerCase();
    for (let k = 0; k < c.length; k++) pos.push(i);
    flat += c;
  }
  return { s, flat, pos };
}

/** 모든 낱말이 texts 중 어딘가에 있으면 true(띄어쓰기 무시). terms가 비면 true. */
export function matchesText(texts, terms) {
  if (!terms?.length) return true;
  const flats = (texts ?? []).map((t) => normText(t).replace(/\s+/g, ''));
  return terms.every((t) => flats.some((f) => f.includes(t)));
}

/** NFC 글(대소문자 유지) 기준 강조 구간 [start, end)(끝 제외), 정렬 · 합침. */
export function markRanges(text, terms) {
  const { flat, pos } = compact(text);
  const raw = [];
  for (const t of terms ?? []) {
    if (!t) continue;
    let i = 0;
    let j;
    while ((j = flat.indexOf(t, i)) !== -1) {
      raw.push([pos[j], pos[j + t.length - 1] + 1]);
      i = j + 1;
    }
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function htmlFor(text, terms) {
  const s = String(text ?? '').normalize('NFC');
  let out = '';
  let i = 0;
  for (const [a, b] of markRanges(s, terms)) {
    out += `${esc(s.slice(i, a))}<mark>${esc(s.slice(a, b))}</mark>`;
    i = b;
  }
  return out + esc(s.slice(i));
}

/** 찾은 낱말을 <mark>로 감싼 HTML(정규화한 글을 보여 준다). 검색어가 비면 esc만. */
export function markHtml(text, q) {
  return htmlFor(text, queryTerms(q));
}

/**
 * 줄바꿈 · 여러 칸을 한 칸으로 만든 글에서 처음 나온 낱말 앞 before자부터(잘렸으면 "…") 강조 HTML.
 * 낱말이 여럿이면 가장 먼저 나온 곳 기준. 못 찾으면 null.
 */
export function snipAround(text, q, before = 12) {
  const terms = queryTerms(q);
  if (!terms.length) return null;
  const flat = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const ranges = markRanges(flat, terms);
  if (!ranges.length) return null;
  const from = Math.max(0, ranges[0][0] - before);
  return (from ? '…' : '') + htmlFor(flat.slice(from), terms);
}
