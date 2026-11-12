import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import { insertStar } from './stars.js';
import { isOpenableExt, makeThumb, removeFiles, resolveThumb, resolveVault, saveUpload } from './vault.js';

const FILE_NAME_MAX = 200;
const FALLBACK_NAME = 'untitled';
const TITLE_MAX = 200;
const MEMO_MAX = 20000;
const FIELD_BYTES_MAX = 1024 * 1024;

// 이미지 별로 다루는(축소본을 만드는) 확장자. svg 는 스크립트를 담을 수 있어 파일 별로 둔다.
const RASTER_EXTS = new Set('png jpg jpeg gif webp bmp avif tif tiff heic'.split(' '));

// 브라우저가 보낸 MIME 과 확장자가 둘 다 이미지일 때만 이미지 별이다.
export function isImageUpload(mimetype, ext) {
  return String(mimetype ?? '').toLowerCase().startsWith('image/') && RASTER_EXTS.has(String(ext ?? '').toLowerCase());
}

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

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
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

// 받은 파일 이름을 정리한다. 경로가 섞여 있으면 마지막 조각만, 200자를 넘으면 확장자를 남기고 자른다.
// ext 는 보관함 파일 이름에 쓸 소문자 확장자([a-z0-9]{1,10})이고, 그 모양이 아니면 ''.
export function parseFileName(raw) {
  // 제어 문자(C0 · DEL · C1)와 글자 방향을 뒤집는 문자(이름 끝을 다른 확장자처럼 보이게 한다)를 뺀다.
  const cleaned = String(raw ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  let name = cleaned.split(/[\\/]/).map((s) => s.trim()).filter((s) => s !== '').pop() ?? '';
  if (name === '') name = FALLBACK_NAME;

  let dot = name.lastIndexOf('.');
  let ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!/^[a-z0-9]{1,10}$/.test(ext)) {
    ext = '';
    dot = -1;
  }

  const chars = [...name];
  if (chars.length > FILE_NAME_MAX) {
    if (dot > 0) {
      const suffix = name.slice(dot);
      name = [...name.slice(0, dot)].slice(0, FILE_NAME_MAX - [...suffix].length).join('') + suffix;
      dot = name.length - suffix.length;
    } else {
      name = chars.slice(0, FILE_NAME_MAX).join('');
    }
  }

  // '.gitignore' 처럼 앞이 비면 이름 전체를 제목으로 쓴다.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return { fileName: name, ext, stem };
}

// titles 필드(JSON 문자열 배열)를 읽어 파일 순서대로의 제목을 돌려준다. 각 제목은 앞뒤 공백을 떼고 200자로 자른다.
function parseTitles(raw, wasTruncated) {
  if (wasTruncated) throw new ApiError(400, 'invalid_titles');
  if (raw === undefined) return [];
  let titles;
  try {
    titles = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'invalid_titles');
  }
  if (!Array.isArray(titles) || titles.some((t) => t !== null && typeof t !== 'string')) {
    throw new ApiError(400, 'invalid_titles');
  }
  return titles.map((t) => (typeof t === 'string' ? [...t.trim()].slice(0, TITLE_MAX).join('').trim() : ''));
}

export function registerFiles(app) {
  const db = app.db;
  const dataDir = app.dataDir;
  const maxBytes = app.config.maxFileBytes;

  // multipart 본문은 버퍼에 모으지 않고 흘려 읽으므로 Fastify 의 bodyLimit(1MB)에 걸리지 않는다.
  // 상한을 넘은 파일은 오류로 끊지 않고 file.truncated 로 알아내 그 파일만 건너뛴다.
  // 개수 상한(files · parts)에 걸리면 그때까지 담은 것은 남기고 나머지를 too_many 로 알린다.
  app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: maxBytes, files: app.config.maxFiles, parts: 1000, fields: 10, fieldSize: FIELD_BYTES_MAX },
  });

  // 별 · 행성 삭제가 부르는 보관함 정리.
  app.removeStarFiles = (star) => removeFiles(dataDir, star);

  const fail = (reply, err) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  const planetExists = (id) =>
    typeof id === 'string' && id !== '' && db.prepare('SELECT 1 FROM planets WHERE id = ?').get(id) !== undefined;
  const hashExists = (hash) => db.prepare('SELECT 1 FROM stars WHERE file_hash = ?').get(hash) !== undefined;

  // 별의 보관함 사본 절대 경로. 별이 없으면 404, 사본이 없는 종류면 400, 디스크에 없으면 404.
  async function vaultCopy(id) {
    const row = db.prepare('SELECT * FROM stars WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'not_found');
    if (!row.vault_path) throw new ApiError(400, 'no_file');
    let abs;
    let stat;
    try {
      abs = resolveVault(dataDir, row.vault_path);
      stat = await fs.promises.stat(abs);
    } catch {
      throw new ApiError(404, 'file_missing');
    }
    if (!stat.isFile()) throw new ApiError(404, 'file_missing');
    return { row, abs, size: stat.size };
  }

  app.post('/api/stars/upload', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'not_multipart' });

    const fields = {};
    const truncated = new Set();
    const created = [];
    const skipped = [];
    const seen = new Set();
    let titles = [];
    let checked = false;
    let fileCount = 0;
    // 한번 정해지면 남은 조각은 읽어서 버리기만 한다(연결이 깨끗이 끝나도록).
    let error = null;
    // 예상하지 못한 오류가 있었는가. 하나도 담지 못했을 때만 500 으로 알린다.
    let failed = false;

    // 파일 하나를 보관함에 쓰고 별로 남긴다. 건너뛴 이유가 있으면 skipped 에 적는다.
    async function store(part, index, { fileName, ext, stem }) {
      const id = crypto.randomUUID();
      const saved = await saveUpload(dataDir, part.file, {
        id,
        ext,
        maxBytes,
        isDuplicate: (hash) => seen.has(hash) || hashExists(hash),
      });
      if (saved.tooLarge) {
        skipped.push({ file_name: fileName, reason: 'too_large' });
        return;
      }
      if (saved.duplicate) {
        skipped.push({ file_name: fileName, reason: 'duplicate' });
        return;
      }

      let thumbPath = null;
      try {
        const isImage = isImageUpload(part.mimetype, ext);
        if (isImage) thumbPath = await makeThumb(dataDir, saved.vaultPath, id);
        // 파일을 받는 사이 행성이 지워졌을 수 있다.
        if (!planetExists(fields.planet_id)) throw new ApiError(400, 'unknown_planet');
        created.push(insertStar(db, {
          id,
          type: isImage ? 'image' : 'file',
          title: titles[index] || stem,
          file_name: fileName,
          file_ext: ext.toUpperCase(),
          file_size: saved.size,
          file_hash: saved.hash,
          vault_path: saved.vaultPath,
          thumb_path: thumbPath,
          memo: fields.memo ?? '',
          planet_id: fields.planet_id,
        }));
        // 빈 파일은 hash 가 null 이다(중복을 따지지 않는다).
        if (saved.hash) seen.add(saved.hash);
      } catch (err) {
        // 기록을 남기지 못했으면 방금 쓴 사본 · 축소본도 치운다.
        await removeFiles(dataDir, { vault_path: saved.vaultPath, thumb_path: thumbPath }).catch((cleanupErr) => {
          console.error(`upload: cannot remove files of unsaved star ${id}`, cleanupErr);
        });
        if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // 다른 요청이 같은 파일을 먼저 담았다.
          skipped.push({ file_name: fileName, reason: 'duplicate' });
          return;
        }
        throw err;
      }
    }

    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') {
          // 글 필드는 파일보다 먼저 온다. 파일이 시작된 뒤에 온 것은 쓰지 않는다.
          if (!checked && typeof part.value === 'string') {
            fields[part.fieldname] = part.value;
            if (part.valueTruncated) truncated.add(part.fieldname);
          }
          continue;
        }
        if (error || part.fieldname !== 'files') {
          part.file.resume();
          continue;
        }
        if (!checked) {
          // 첫 파일을 쓰기 전에 글 필드를 모두 검사한다.
          checked = true;
          try {
            titles = parseTitles(fields.titles, truncated.has('titles'));
            if (truncated.has('memo') || [...(fields.memo ?? '')].length > MEMO_MAX) throw new ApiError(400, 'invalid_memo');
            if (!planetExists(fields.planet_id)) throw new ApiError(400, 'unknown_planet');
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            error = err;
            part.file.resume();
            continue;
          }
        }

        const index = fileCount++;
        const name = parseFileName(part.filename);
        try {
          await store(part, index, name);
        } catch (err) {
          // 이미 담은 별이 있으면 오류 상태로 가리지 않는다. 이 파일만 실패로 적고 다음 파일로 간다.
          if (err instanceof ApiError && created.length === 0) {
            error = err;
          } else {
            failed = true;
            console.error(`upload: failed to store "${name.fileName}"`, err);
            skipped.push({ file_name: name.fileName, reason: 'failed' });
          }
          part.file.resume();
        }
      }
    } catch (err) {
      // 조각을 읽다가 끊겼다(개수 상한 또는 깨진 본문). 남은 본문은 읽어서 버린다.
      req.raw.resume();
      const limitHit = err?.code === 'FST_FILES_LIMIT' || err?.code === 'FST_PARTS_LIMIT';
      if (!error && limitHit && fileCount > 0) {
        // 상한 뒤의 파일은 읽지 않으므로 이름을 알 수 없다.
        skipped.push({ file_name: null, reason: 'too_many' });
      } else if (!error && created.length > 0) {
        console.error('upload: request ended early', err);
        skipped.push({ file_name: null, reason: 'failed' });
      } else if (!error) {
        throw err;
      }
    }

    if (error) return fail(reply, error);
    if (fileCount === 0) return reply.code(400).send({ error: 'no_files' });
    if (failed && created.length === 0) return reply.code(500).send({ error: 'server_error' });
    return { created, skipped };
  });

  app.get('/api/stars/:id/file', async (req, reply) => {
    try {
      const { row, abs, size } = await vaultCopy(req.params.id);
      const ext = path.extname(abs).slice(1).toLowerCase();
      const inlineType = Object.hasOwn(INLINE_TYPES, ext) ? INLINE_TYPES[ext] : null;
      const type = inlineType ?? (Object.hasOwn(ATTACHMENT_TYPES, ext) ? ATTACHMENT_TYPES[ext] : 'application/octet-stream');
      const name = encodeRfc5987(row.file_name || row.title || 'file');
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
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/stars/:id/thumb', async (req, reply) => {
    const row = db.prepare('SELECT thumb_path FROM stars WHERE id = ?').get(req.params.id);
    if (!row || !row.thumb_path) return reply.code(404).send({ error: 'not_found' });
    let abs;
    let stat;
    try {
      abs = resolveThumb(dataDir, row.thumb_path);
      stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return reply.code(404).send({ error: 'file_missing' });
    }
    return reply
      .header('Content-Type', 'image/webp')
      .header('Content-Length', stat.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(fs.createReadStream(abs));
  });

  // 요청은 별 id 만 받는다. 경로는 DB 에서 읽고 보관함 안인지 확인한 것만 넘긴다.
  async function launch(reply, id, wanted) {
    try {
      const { abs } = await vaultCopy(id);
      // 열어도 되는 종류(허용 목록)만 기본 프로그램으로 연다. 나머지는 폴더에서 보여 준다.
      const kind = wanted === 'open' && isOpenableExt(path.extname(abs).slice(1)) ? 'open' : 'reveal';
      try {
        await app.config.opener[kind](abs);
      } catch (err) {
        console.error(`opener.${kind} failed for star ${id}`, err);
        throw new ApiError(500, 'open_failed');
      }
      return { action: kind === 'open' ? 'opened' : 'revealed' };
    } catch (err) {
      return fail(reply, err);
    }
  }

  app.post('/api/stars/:id/open', async (req, reply) => launch(reply, req.params.id, 'open'));
  app.post('/api/stars/:id/reveal', async (req, reply) => launch(reply, req.params.id, 'reveal'));
}
