// 로컬 서버(/api) 요청 래퍼. 실패하면 ApiError { status, code }를 던진다.
// 네트워크 실패(서버가 꺼짐)는 status 0, code 'offline'이고 store에 'offline'을 알린다.
import { store } from './store.js';

export class ApiError extends Error {
  /** data는 서버가 준 오류 본문 전체(예: 409 nothing_to_save의 skipped). */
  constructor(status, code, data = null) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function offline() {
  store.emit('offline');
  return new ApiError(0, 'offline');
}

const id = (v) => encodeURIComponent(String(v));

// 값이 있는 것만 쿼리 문자열로 만든다
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

// 서버의 오류는 항상 JSON { error }다. 5xx인데 그 모양이 아니면
// 서버가 아니라 개발용 프록시가 답한 것이므로(서버 꺼짐) 연결 끊김으로 본다.
function errorFrom(status, text) {
  let code = null;
  let data = null;
  try {
    data = JSON.parse(text);
    if (data && typeof data.error === 'string') code = data.error;
  } catch {
    /* JSON이 아님 */
  }
  if (code) return new ApiError(status, code, data);
  if (status >= 500) return offline();
  return new ApiError(status, 'unknown');
}

function parseOk(status, text) {
  if (status === 204 || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(status, 'bad_response');
  }
}

async function request(method, path, body, { signal } = {}) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (signal) init.signal = signal;
  let res;
  let text;
  try {
    res = await fetch(`/api${path}`, init);
    text = await res.text();
  } catch {
    // 멈춘 것은 연결 끊김으로 알리지 않는다
    if (signal?.aborted) throw new ApiError(0, 'aborted');
    throw offline();
  }
  if (!res.ok) throw errorFrom(res.status, text);
  if (store.state.offline && path !== '/health') store.emit('reachable');
  return parseOk(res.status, text);
}

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const api = {
  health: () => request('GET', '/health'),

  /** range = { from, to } (ISO). 없으면 전체. → { in_period, total, planets } */
  summary: (range) => request('GET', `/summary${qs({ from: range?.from, to: range?.to })}`),
  planets: (range) => request('GET', `/planets${qs({ from: range?.from, to: range?.to })}`),
  nextLook: () => request('GET', '/planets/next-look'),
  createPlanet: ({ name, description, color_index, deco, ring } = {}) =>
    request('POST', '/planets', { name, description, color_index, deco, ring }),
  patchPlanet: (planetId, patch) => request('PATCH', `/planets/${id(planetId)}`, patch),
  mergePlanet: (planetId, into) => request('POST', `/planets/${id(planetId)}/merge`, { into }),
  /** opts.stars: 'move'(into 필요) | 'delete'. 빈 행성은 opts 없이. */
  deletePlanet: (planetId, { stars, into } = {}) =>
    request('DELETE', `/planets/${id(planetId)}${qs({ stars, into: stars === 'move' ? into : undefined })}`),

  stars: ({ from, to, planet_id, limit } = {}) => request('GET', `/stars${qs({ from, to, planet_id, limit })}`),
  star: (starId) => request('GET', `/stars/${id(starId)}`),
  patchStar: (starId, patch) => request('PATCH', `/stars/${id(starId)}`, patch),
  deleteStar: (starId) => request('DELETE', `/stars/${id(starId)}`),

  /**
   * 별 하나를 만든다: 글 + 첨부 파일 + 링크(스펙 6-9). → { star, skipped: [{ file_name, reason }] }
   * 파일이 있으면 multipart(XHR, 진행률 · 멈추기). 글 칸을 파일보다 먼저 붙인다(서버가 그 순서로 읽는다).
   * 파일이 없으면 JSON. onProgress(pct)는 0~100 정수(파일이 있을 때만).
   * signal(AbortSignal)로 멈추면 ApiError(0, 'aborted')로 끝난다(연결 끊김으로 알리지 않는다).
   * onUploaded()는 파일 요청의 본문을 다 보낸 순간(xhr.upload.onload) 한 번 불린다. 그 뒤로는 서버가 어차피 저장하므로
   * signal을 더 듣지 않는다(멈추지 않고 응답을 기다린다). 다 보낸 바이트가 서버에 닿은 뒤 onload 직전에 멈춘 드문 경우는
   * 저장됐을 수 있으므로 'aborted'가 아니라 ApiError(0, 'stop_late')로 끝난다.
   * 남는 것이 없으면(같은 파일뿐) ApiError(409, 'nothing_to_save'), err.data.skipped에 뺀 파일이 있다.
   */
  createStar({ planet_id, title, body, links, files } = {}, onProgress, { signal, onUploaded } = {}) {
    const list = Array.from(files ?? []);
    const fields = {
      planet_id: String(planet_id ?? ''),
      title: typeof title === 'string' ? title : '',
      body: typeof body === 'string' ? body : '',
      links: Array.from(links ?? [], String),
    };
    if (!list.length) {
      if (signal?.aborted) return Promise.reject(new ApiError(0, 'aborted'));
      return request('POST', '/stars', fields, { signal });
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ApiError(0, 'aborted'));
        return;
      }
      const form = new FormData();
      form.append('planet_id', fields.planet_id);
      form.append('title', fields.title);
      form.append('body', fields.body);
      form.append('links', JSON.stringify(fields.links));
      for (const f of list) form.append('files', f, f.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/stars');
      xhr.setRequestHeader('Accept', 'application/json');
      let sentAll = false; // 본문의 마지막 바이트까지 보냈는지
      let uploaded = false; // xhr.upload.onload가 왔는지
      let stop = null;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0 && e.loaded >= e.total) sentAll = true;
        if (typeof onProgress === 'function' && e.lengthComputable && e.total > 0) {
          onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };
      xhr.upload.onload = () => {
        sentAll = true;
        uploaded = true;
        if (signal && stop) signal.removeEventListener('abort', stop); // 이제 멈추지 않는다
        if (typeof onUploaded === 'function') onUploaded();
      };
      xhr.onload = () => {
        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            if (store.state.offline) store.emit('reachable');
            resolve(parseOk(xhr.status, xhr.responseText));
          } else reject(errorFrom(xhr.status, xhr.responseText));
        } catch (err) {
          reject(err);
        }
      };
      // 읽을 수 없는 파일(폴더 등)도 여기로 온다. 서버가 살아 있으면 연결 끊김이 아니다.
      xhr.onerror = () => {
        request('GET', '/health').then(() => reject(new ApiError(0, 'upload_failed')), reject);
      };
      xhr.ontimeout = () => reject(offline());
      xhr.onabort = () => reject(new ApiError(0, sentAll ? 'stop_late' : 'aborted'));
      if (signal) {
        stop = () => {
          if (!uploaded) xhr.abort();
        };
        signal.addEventListener('abort', stop, { once: true });
        xhr.onloadend = () => signal.removeEventListener('abort', stop);
      }
      xhr.send(form);
    });
  },

  /** 오늘의 재발견 별. 없으면 null. 넣은 지 7일 이상 된 별만 대상이다. */
  rediscovery(now = new Date()) {
    const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).toISOString();
    return request('GET', `/rediscovery${qs({ today: localDay(now), before })}`);
  },

  /** 첨부의 보관함 사본을 기본 프로그램으로 연다(열면 안 되는 종류는 폴더에서 보여 준다). → { action: 'opened' | 'revealed' } */
  openAttachment: (attId) => request('POST', `/attachments/${id(attId)}/open`),
  revealAttachment: (attId) => request('POST', `/attachments/${id(attId)}/reveal`),
  attachmentFileUrl: (attId) => `/api/attachments/${id(attId)}/file`,
  attachmentThumbUrl: (attId) => `/api/attachments/${id(attId)}/thumb`,
};
