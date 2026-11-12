// 파이썬 RAG 서버를 부르는 작은 클라이언트. 모든 요청에 토큰 헤더를 붙인다.
// 실패는 RagError { code: 'unavailable' | 'bad_response' | 'rag_error', status, detail }.

export class RagError extends Error {
  constructor(code, { status = null, detail = null } = {}) {
    super(`rag ${code}${status ? ` ${status}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'RagError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_000;

export function createRagClient({ baseUrl, token, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = String(baseUrl).replace(/\/+$/, '');

  function headers(extra = {}) {
    return { 'X-Spacelog-Token': token, ...extra };
  }

  async function send(method, route, body, { timeout = timeoutMs, signal } = {}) {
    const signals = [];
    if (timeout) signals.push(AbortSignal.timeout(timeout));
    if (signal) signals.push(signal);
    const init = {
      method,
      headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await fetch(`${root}${route}`, init);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new RagError('unavailable', { detail: err?.cause?.code ?? err?.name ?? 'fetch_failed' });
    }
  }

  async function errorFrom(res) {
    let detail = null;
    try {
      const data = await res.json();
      detail = typeof data?.error === 'string' ? data.error : null;
    } catch {
      // 본문이 JSON 이 아니면 상태 코드만 남긴다.
    }
    return new RagError('rag_error', { status: res.status, detail });
  }

  async function call(method, route, body, opts) {
    const res = await send(method, route, body, opts);
    if (!res.ok) throw await errorFrom(res);
    try {
      return await res.json();
    } catch {
      throw new RagError('bad_response', { status: res.status });
    }
  }

  async function* answer(body, { signal } = {}) {
    // 흘려 받는 답은 길 수 있으므로 시간 제한을 두지 않는다(멈추기는 signal 로).
    const res = await send('POST', '/answer', body, { timeout: 0, signal });
    if (!res.ok) throw await errorFrom(res);
    if (!res.body) throw new RagError('bad_response', { status: res.status });
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = (line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new RagError('bad_response', { status: res.status, detail: 'invalid_ndjson' });
      }
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield parse(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parse(buffer.trim());
  }

  return {
    health: () => call('GET', '/health', undefined, { timeout: HEALTH_TIMEOUT_MS }),
    indexStar: (payload, opts) => call('POST', '/index', payload, opts), // opts.timeout: 큰 파일은 오래 걸린다(sync 가 120초를 준다)
    removeStars: (ids) => call('POST', '/remove', { star_ids: ids }),
    reset: () => call('POST', '/reset', {}),
    stats: () => call('GET', '/stats'),
    answer,
  };
}
