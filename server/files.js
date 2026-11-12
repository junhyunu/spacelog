import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import { insertStar } from './stars.js';
import { isExecutableExt, makeThumb, removeFiles, resolveThumb, resolveVault, saveUpload } from './vault.js';

const FILE_NAME_MAX = 200;
const FALLBACK_NAME = 'untitled';

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
  const cleaned = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '');
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

function parseTitles(raw) {
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
  return titles;
}

export function registerFiles(app) {
  const db = app.db;
  const dataDir = app.dataDir;
  const maxBytes = app.config.maxFileBytes;

  // multipart 본문은 버퍼에 모으지 않고 흘려 읽으므로 Fastify 의 bodyLimit(1MB)에 걸리지 않는다.
  // 상한을 넘은 파일은 오류로 끊지 않고 file.truncated 로 알아내 그 파일만 건너뛴다.
  app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: maxBytes, fieldSize: 1024 * 1024, fields: 20, parts: 5000 },
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
    const created = [];
    const skipped = [];
    const seen = new Set();
    let titles = [];
    let checked = false;
    let fileCount = 0;
    // 한번 정해지면 남은 조각은 읽어서 버리기만 한다(연결이 깨끗이 끝나도록).
    let error = null;

    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        // 글 필드는 파일보다 먼저 온다. 파일이 시작된 뒤에 온 것은 쓰지 않는다.
        if (!checked && typeof part.value === 'string') fields[part.fieldname] = part.value;
        continue;
      }
      if (error || part.fieldname !== 'files') {
        part.file.resume();
        continue;
      }
      if (!checked) {
        checked = true;
        try {
          titles = parseTitles(fields.titles);
          if (!planetExists(fields.planet_id)) throw new ApiError(400, 'unknown_planet');
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          error = err;
          part.file.resume();
          continue;
        }
      }

      const index = fileCount++;
      const { fileName, ext, stem } = parseFileName(part.filename);
      const id = crypto.randomUUID();
      const saved = await saveUpload(dataDir, part.file, {
        id,
        ext,
        maxBytes,
        isDuplicate: (hash) => seen.has(hash) || hashExists(hash),
      });
      if (saved.tooLarge) {
        skipped.push({ file_name: fileName, reason: 'too_large' });
        continue;
      }
      if (saved.duplicate) {
        skipped.push({ file_name: fileName, reason: 'duplicate' });
        continue;
      }
      seen.add(saved.hash);

      const isImage = String(part.mimetype ?? '').toLowerCase().startsWith('image/');
      const thumbPath = isImage ? await makeThumb(dataDir, saved.vaultPath, id) : null;
      const given = typeof titles[index] === 'string' ? titles[index].trim() : '';
      try {
        // 파일을 받는 사이 행성이 지워졌을 수 있다.
        if (!planetExists(fields.planet_id)) throw new ApiError(400, 'unknown_planet');
        created.push(insertStar(db, {
          id,
          type: isImage ? 'image' : 'file',
          title: given || stem,
          file_name: fileName,
          file_ext: ext.toUpperCase(),
          file_size: saved.size,
          file_hash: saved.hash,
          vault_path: saved.vaultPath,
          thumb_path: thumbPath,
          memo: fields.memo ?? '',
          planet_id: fields.planet_id,
        }));
      } catch (err) {
        // 기록을 남기지 못했으면 방금 쓴 사본 · 축소본도 치운다.
        await removeFiles(dataDir, { vault_path: saved.vaultPath, thumb_path: thumbPath }).catch(() => {});
        if (err instanceof ApiError) {
          error = err;
        } else if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // 다른 요청이 같은 파일을 먼저 담았다.
          skipped.push({ file_name: fileName, reason: 'duplicate' });
        } else {
          throw err;
        }
      }
    }

    if (error) return fail(reply, error);
    if (fileCount === 0) return reply.code(400).send({ error: 'no_files' });
    return { created, skipped };
  });

  app.get('/api/stars/:id/file', async (req, reply) => {
    try {
      const { row, abs, size } = await vaultCopy(req.params.id);
      const ext = path.extname(abs).slice(1).toLowerCase();
      const inlineType = Object.hasOwn(INLINE_TYPES, ext) ? INLINE_TYPES[ext] : null;
      const type = inlineType ?? (Object.hasOwn(ATTACHMENT_TYPES, ext) ? ATTACHMENT_TYPES[ext] : 'application/octet-stream');
      const name = encodeRfc5987(row.file_name || row.title || 'file');
      return reply
        .header('Content-Type', type)
        .header('Content-Length', size)
        .header('Content-Disposition', `${inlineType ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(fs.createReadStream(abs));
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
      // 실행되는 종류는 열지 않고 폴더에서 보여 준다.
      const kind = wanted === 'open' && !isExecutableExt(path.extname(abs).slice(1)) ? 'open' : 'reveal';
      try {
        await app.config.opener[kind](abs);
      } catch (err) {
        app.log.error(err);
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
