const TITLE_MAX = 200;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// 한 번만 훑으므로 '&amp;lt;' 는 '&lt;' 까지만 풀린다.
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? match;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

function decoderFor(contentType) {
  const charset = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // 모르는 문자 집합이면 UTF-8 로 읽는다.
    }
  }
  return new TextDecoder('utf-8');
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
    const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(decoderFor(contentType).decode(head));
    if (!match) return null;
    const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
    return title ? [...title].slice(0, TITLE_MAX).join('') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // 아직 열려 있는 연결(본문을 다 받지 않은 경우 포함)을 끊는다.
    controller.abort();
  }
}
