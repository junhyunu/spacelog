import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from './stars.js';
import { isOpenableExt, resolveThumb, resolveVault } from './vault.js';

// /file 응답이 문서로 열렸을 때의 정책. <img> · <video> 로 불러 쓸 때는 적용되지 않는다(CSP 는 문서에만 걸린다).
// 내려받기와 text/plain: 스크립트 · 플러그인 · 하위 자원을 모두 막는다.
const CSP_LOCKED = "sandbox; default-src 'none'";
// 새 탭에서 바로 여는 이미지 · 소리 · 영상 · PDF: 브라우저가 만드는 보기 화면(이미지 문서, 미디어 문서,
// PDF 보기)이 같은 주소의 자원을 다시 불러 쓰므로 그것만 허용한다. sandbox 는 PDF 보기를 막으므로 뺀다.
// script-src 는 열지 않으므로 스크립트는 여전히 돌지 않는다.
const CSP_MEDIA = "default-src 'none'; img-src 'self'; media-src 'self'; object-src 'self'; style-src 'unsafe-inline'";

// Range 헤더를 읽는다. 범위 하나(bytes=a-b · bytes=a- · bytes=-n)만 받는다.
// 돌려주는 값: { start, end }(끝 포함) | 'unsatisfiable'(416) | null(무시하고 전체를 보낸다 — 여러 범위 · 틀린 모양).
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const first = m[1] === '' ? null : Number(m[1]);
  const last = m[2] === '' ? null : Number(m[2]);
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) {
    // 뒤에서 last 바이트
    if (last === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (last !== null && last < first) return null;
  if (first >= size) return 'unsatisfiable';
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

// 브라우저 안에서 바로 보여 줘도 되는 종류. 여기 없는 확장자는 내려받기(attachment)로만 준다.
// HTML · SVG 처럼 스크립트가 돌 수 있는 것은 넣지 않는다.
const INLINE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
};
// <img> 로는 보이지만(스크립트는 돌지 않는다) 주소로 직접 열면 내려받게 한다.
const ATTACHMENT_TYPES = { svg: 'image/svg+xml' };

// RFC 5987 ext-value. encodeURIComponent 가 남기는 ' ( ) * 도 바꾼다.
function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// 첨부의 보관함 사본 · 축소본을 내주고, 기본 프로그램 · 탐색기로 연다. 요청은 id 만 받고 경로는 DB 에서 읽는다.
export function registerAttachments(app) {
  const db = app.db;
  const dataDir = app.dataDir;

  const fail = (reply, err) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  const getAttachment = (id) => {
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'not_found');
    return row;
  };

  // 첨부의 보관함 사본 절대 경로. 사본이 없는 종류(링크)면 400 no_file, 디스크에 없거나 보관함 밖이면 404 file_missing.
  async function vaultCopy(att) {
    if (!att.vault_path) throw new ApiError(400, 'no_file');
    let abs;
    let stat;
    try {
      abs = resolveVault(dataDir, att.vault_path);
      stat = await fs.promises.stat(abs);
    } catch {
      throw new ApiError(404, 'file_missing');
    }
    if (!stat.isFile()) throw new ApiError(404, 'file_missing');
    return { abs, size: stat.size };
  }

  async function sendFile(req, reply, att) {
    const { abs, size } = await vaultCopy(att);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const inlineType = Object.hasOwn(INLINE_TYPES, ext) ? INLINE_TYPES[ext] : null;
    const type = inlineType ?? (Object.hasOwn(ATTACHMENT_TYPES, ext) ? ATTACHMENT_TYPES[ext] : 'application/octet-stream');
    const name = encodeRfc5987(att.file_name || 'file');
    reply
      .header('Content-Type', type)
      .header('Content-Disposition', `${inlineType ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', inlineType && !inlineType.startsWith('text/') ? CSP_MEDIA : CSP_LOCKED)
      .header('Accept-Ranges', 'bytes');

    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      return reply
        .code(416)
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', 'inline')
        .header('Content-Range', `bytes */${size}`)
        .send({ error: 'range_not_satisfiable' });
    }
    if (range) {
      return reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(fs.createReadStream(abs, range));
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(abs));
  }

  async function sendThumb(req, reply, att) {
    if (!att.thumb_path) throw new ApiError(404, 'not_found');
    let abs;
    let stat;
    try {
      abs = resolveThumb(dataDir, att.thumb_path);
      stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw new ApiError(404, 'file_missing');
    }
    return reply
      .header('Content-Type', 'image/webp')
      .header('Content-Length', stat.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(abs));
  }

  // 열어도 되는 종류(허용 목록)만 기본 프로그램으로 연다. 나머지는 폴더에서 보여 준다.
  // 링크 첨부는 사본이 없으므로 400 no_file(링크는 브라우저가 새 탭으로 연다).
  async function launch(att, wanted) {
    const { abs } = await vaultCopy(att);
    const kind = wanted === 'open' && isOpenableExt(path.extname(abs).slice(1)) ? 'open' : 'reveal';
    try {
      await app.config.opener[kind](abs);
    } catch (err) {
      console.error(`opener.${kind} failed for attachment ${att.id}`, err);
      throw new ApiError(500, 'open_failed');
    }
    return { action: kind === 'open' ? 'opened' : 'revealed' };
  }

  const route = (handler) => async (req, reply) => {
    try {
      return await handler(req, reply, getAttachment(req.params.id));
    } catch (err) {
      return fail(reply, err);
    }
  };

  app.get('/api/attachments/:id/file', route(sendFile));
  app.get('/api/attachments/:id/thumb', route(sendThumb));
  app.post('/api/attachments/:id/open', route((req, reply, att) => launch(att, 'open')));
  app.post('/api/attachments/:id/reveal', route((req, reply, att) => launch(att, 'reveal')));
}
