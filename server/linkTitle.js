const TITLE_MAX = 200;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// 한 번만 훑으므로 '&amp;lt;' 는 '&lt;' 까지만 풀린다.
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? match;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match; // 짝 없는 서러게이트
    return String.fromCodePoint(code);
  });
}

function tryDecoder(charset) {
  if (!charset) return null;
  try {
    return new TextDecoder(charset);
  } catch {
    return null; // 모르는 문자 집합
  }
}

// 문자 집합: 머리글 → 앞부분의 <meta charset> → UTF-8(많이 깨지면 EUC-KR) 순서.
function decodeHtml(bytes, contentType) {
  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  const sniff = bytes.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]{0,200}?charset\s*=\s*["']?([\w-]{1,40})/i.exec(sniff)?.[1];
  const named = tryDecoder(fromHeader) ?? tryDecoder(fromMeta);
  if (named) return named.decode(bytes);

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // maxBytes 에서 잘리면 마지막 글자 하나쯤은 깨질 수 있다. 여러 군데가 깨졌을 때만 EUC-KR 로 본다.
  const broken = utf8.split('�').length - 1;
  return broken > 3 ? new TextDecoder('euc-kr').decode(bytes) : utf8;
}

const MAX_CANDIDATES = 8;

// <title>…</title> 안의 글. 되돌아가는 정규식 없이 indexOf 로만 찾아 입력 길이에 비례한다.
// <svg> 안이나 주석 안의 <title> 은 건너뛴다.
export function extractTitle(html) {
  const lower = html.toLowerCase();
  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const start = lower.indexOf('<title', from);
    if (start === -1) return null;
    from = start + 6;
    const next = lower[start + 6];
    if (next !== '>' && !/\s/.test(next ?? '')) continue; // <titlebar> 같은 다른 태그
    const open = lower.indexOf('>', start);
    if (open === -1) return null;
    const close = lower.indexOf('</title', open);
    if (close === -1) return null;
    const inSvg = lower.lastIndexOf('<svg', start) > lower.lastIndexOf('</svg', start);
    const inComment = lower.lastIndexOf('<!--', start) > lower.lastIndexOf('-->', start);
    if (inSvg || inComment) {
      from = close;
      continue;
    }
    return html.slice(open + 1, close);
  }
  return null;
}

// 본문을 maxBytes 까지만 읽고 나머지는 받지 않는다.
async function readHead(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

// 주소를 한 번 열어 <title> 을 가져온다. 제한 시간은 머리글과 본문을 모두 덮는다.
// 못 가져오면(시간 초과, HTML 아님, 제목 없음, 그 밖의 어떤 오류든) null.
export async function fetchLinkTitle(url, { timeoutMs = 3000, maxBytes = 262144 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !res.body || !/^\s*text\/html\b/i.test(contentType)) return null;

    const head = await readHead(res.body, maxBytes);
    const raw = extractTitle(decodeHtml(head, contentType));
    if (raw === null) return null;
    const title = decodeEntities(raw)
      // 제어 문자와 글 방향을 뒤집는 문자는 공백으로 바꾼다.
      .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return title ? [...title].slice(0, TITLE_MAX).join('') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // 아직 열려 있는 연결(본문을 다 받지 않은 경우 포함)을 끊는다.
    controller.abort();
  }
}
