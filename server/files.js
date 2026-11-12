import crypto from 'node:crypto';
import multipart from '@fastify/multipart';
import { ApiError, checkMemo, cutTitle, firstLine, insertStar, isHttpUrl, planetExists } from './stars.js';
import { makeThumb, removeFiles, saveUpload } from './vault.js';

export { parseRange } from './attachments.js';

const FILE_NAME_MAX = 200;
const FALLBACK_NAME = 'untitled';
/** 본문 상한(UTF-8 바이트). multipart 글 필드 하나의 상한도 이것이다. */
export const BODY_MAX_BYTES = 1024 * 1024;
// JSON 만들기 요청의 본문 상한. 본문 한도를 조금 넘는 글이 413 이 아니라 라우트의 검사(400 invalid_body)를 받도록
// 본문 한도보다 넉넉히 잡는다. 이보다 큰 JSON 은 읽기 전에 413 too_large.
const JSON_BODY_LIMIT = Math.floor(BODY_MAX_BYTES * 1.5);
/** 별 하나의 첨부(파일 + 링크) 상한. */
export const MAX_ATTACHMENTS = 50;

// 이미지 첨부로 다루는(축소본을 만드는) 확장자. svg 는 스크립트를 담을 수 있어 파일로 둔다.
const RASTER_EXTS = new Set('png jpg jpeg gif webp bmp avif tif tiff heic'.split(' '));

// 브라우저가 보낸 MIME 과 확장자가 둘 다 이미지일 때만 이미지다.
export function isImageUpload(mimetype, ext) {
  return String(mimetype ?? '').toLowerCase().startsWith('image/') && RASTER_EXTS.has(String(ext ?? '').toLowerCase());
}

// 받은 파일 이름을 정리한다. 경로가 섞여 있으면 마지막 조각만, 200자를 넘으면 확장자를 남기고 자른다.
// ext 는 보관함 파일 이름에 쓸 소문자 확장자([a-z0-9]{1,10})이고, 그 모양이 아니면 ''.
export function parseFileName(raw) {
  // 제어 문자(C0 · DEL · C1)와 글자 방향을 뒤집는 문자(이름 끝을 다른 확장자처럼 보이게 한다)를 뺀다.
  const cleaned = String(raw ?? '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
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

// 별 만들기의 글 필드를 검사해 정리한다(JSON · multipart 공통). 벗어나면 ApiError(400).
// src = { planet_id, title?, body?, memo?, links?: string[] }
function parseStarFields(db, src) {
  const out = { title: '', body: null, memo: '', links: [] };
  if (src.title !== undefined && src.title !== null) {
    if (typeof src.title !== 'string') throw new ApiError(400, 'invalid_title');
    out.title = cutTitle(src.title);
  }
  if (src.body !== undefined && src.body !== null) {
    if (typeof src.body !== 'string' || Buffer.byteLength(src.body, 'utf8') > BODY_MAX_BYTES) {
      throw new ApiError(400, 'invalid_body');
    }
    out.body = src.body.trim() === '' ? null : src.body;
  }
  if (src.memo !== undefined && src.memo !== null) out.memo = checkMemo(src.memo);
  if (src.links !== undefined && src.links !== null) {
    if (!Array.isArray(src.links) || src.links.some((u) => typeof u !== 'string')) throw new ApiError(400, 'invalid_links');
    // 같은 주소(앞뒤 공백을 뗀 뒤 똑같은 것)는 처음 것 하나만 남긴다(파일과 같다).
    out.links = [...new Set(src.links.map((u) => u.trim()))];
    if (out.links.some((u) => !isHttpUrl(u))) throw new ApiError(400, 'invalid_url');
    if (out.links.length > MAX_ATTACHMENTS) throw new ApiError(400, 'too_many_attachments');
  }
  if (!planetExists(db, src.planet_id)) throw new ApiError(400, 'unknown_planet');
  out.planet_id = src.planet_id;
  return out;
}

// multipart 글 필드(문자열) → parseStarFields 가 받는 모양. 잘린 필드는 받지 않는다.
function multipartFields(raw, truncated) {
  if (truncated.has('body')) throw new ApiError(400, 'invalid_body');
  if (truncated.has('memo')) throw new ApiError(400, 'invalid_memo');
  let links;
  if (raw.links !== undefined && raw.links !== '') {
    if (truncated.has('links')) throw new ApiError(400, 'invalid_links');
    try {
      links = JSON.parse(raw.links);
    } catch {
      throw new ApiError(400, 'invalid_links');
    }
    if (!Array.isArray(links)) throw new ApiError(400, 'invalid_links');
  }
  // multipart 는 글 칸의 줄바꿈을 CRLF 로 보낸다(폼 인코딩 규칙). JSON 으로 받은 글과 같게 LF 로 맞춘다.
  const lf = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n') : v);
  return { planet_id: raw.planet_id, title: lf(raw.title), body: lf(raw.body), memo: lf(raw.memo), links };
}

// 제목을 비웠을 때: 본문 첫 줄(40자) → 첫 파일 이름(확장자 뺌) → 첫 링크 제목 → 첫 주소.
function defaultTitle(body, attachments) {
  const fromBody = body ? firstLine(body) : '';
  if (fromBody) return fromBody;
  const file = attachments.find((a) => a.kind !== 'link');
  if (file) return cutTitle(file.stem);
  const link = attachments.find((a) => a.kind === 'link');
  return link ? cutTitle(link.link_title ?? link.url) : '';
}

export function registerFiles(app) {
  const db = app.db;
  const dataDir = app.dataDir;
  const maxBytes = app.config.maxFileBytes;

  // multipart 본문은 버퍼에 모으지 않고 흘려 읽으므로 Fastify 의 bodyLimit(1MB)에 걸리지 않는다.
  // 상한을 넘은 파일은 오류로 끊지 않고 file.truncated 로 알아내 그 파일만 건너뛴다.
  app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: maxBytes, files: app.config.maxFiles, parts: 1000, fields: 10, fieldSize: BODY_MAX_BYTES },
  });

  const removeQuiet = (att) => removeFiles(dataDir, att).catch((err) => {
    console.error(`cannot remove files of unsaved attachment ${att.id}`, err);
  });

  // 별 · 행성 삭제가 부르는 보관함 정리. star 는 별 행 + attachments(첨부 행들).
  // 모든 첨부를 지워 보고, 실패가 있으면 첫 오류를 던진다.
  app.removeStarFiles = async (star) => {
    let firstError = null;
    // 별 행 자체의 vault_path · thumb_path 는 옮기기 전(판 0) 칸이다. 옮긴 뒤에는 비어 있다.
    for (const target of [star, ...(star?.attachments ?? [])]) {
      try {
        await removeFiles(dataDir, target);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError) throw firstError;
  };

  const fail = (reply, err) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  const hashExists = (hash) => db.prepare('SELECT 1 FROM attachments WHERE file_hash = ?').get(hash) !== undefined;

  // 링크 제목을 못 가져오면(오류 포함) null. 저장은 그래도 된다.
  async function linkTitleFor(url) {
    try {
      const title = await app.config.fetchTitle(url);
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
    } catch {
      return null;
    }
  }

  // 파일 조각 하나를 보관함에 vault/<id>.<ext> 로 쓴다(흘려 쓰며 해시, 임시 파일은 saveUpload 가 치운다).
  // → { attachment, stem } | { reason: 'too_large' | 'duplicate', hash? }. attachment 를 돌려준 뒤에는 부르는 쪽이 파일을 책임진다.
  async function storePart(part, id, isDuplicate) {
    const name = parseFileName(part.filename);
    const saved = await saveUpload(dataDir, part.file, { id, ext: name.ext, maxBytes, isDuplicate });
    if (saved.tooLarge) return { name, reason: 'too_large' };
    if (saved.duplicate) return { name, reason: 'duplicate', hash: saved.hash };
    const kind = isImageUpload(part.mimetype, name.ext) ? 'image' : 'file';
    // makeThumb 는 실패해도 던지지 않는다(null).
    const thumbPath = kind === 'image' ? await makeThumb(dataDir, saved.vaultPath, id) : null;
    return {
      name,
      attachment: {
        id,
        kind,
        stem: name.stem,
        file_name: name.fileName,
        file_ext: name.ext.toUpperCase(),
        file_size: saved.size,
        file_hash: saved.hash,
        vault_path: saved.vaultPath,
        thumb_path: thumbPath,
      },
    };
  }

  // 파일이 모두 디스크에 있고 링크 제목도 다 받은 뒤 부른다. 별과 첨부를 한 트랜잭션으로 넣는다.
  // 그 사이 다른 요청이 같은 파일을 먼저 담았으면(UNIQUE) 그 첨부만 빼고 다시 넣는다.
  // → { star } | { nothing: true }. files 에서 뺀 첨부의 파일은 여기서 지운다.
  async function commit(fields, files, links, skipped) {
    for (;;) {
      const attachments = [...files, ...links];
      if (!fields.body && attachments.length === 0) return { nothing: true };
      try {
        const star = insertStar(db, {
          title: fields.title || defaultTitle(fields.body, attachments),
          body: fields.body,
          memo: fields.memo,
          planet_id: fields.planet_id,
          attachments: attachments.map(({ stem, ...a }) => a),
        });
        return { star };
      } catch (err) {
        if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new ApiError(400, 'unknown_planet');
        if (err?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
        const taken = files.filter((a) => a.file_hash && hashExists(a.file_hash));
        if (taken.length === 0) throw err;
        for (const att of taken) {
          files.splice(files.indexOf(att), 1);
          skipped.push({ file_name: att.file_name, reason: 'duplicate' });
          await removeQuiet(att);
        }
      }
    }
  }

  // POST /api/stars — 글 + 첨부 파일 + 링크 → 별 하나(spec 6-9).
  // JSON { planet_id, title?, body?, links?: string[], memo? } 또는
  // multipart(글 필드 planet_id · title · body · links(JSON 문자열 배열) · memo 를 먼저, 그다음 파일 조각 files 여러 개).
  // 첨부 순서: 파일(올린 순서) 다음 링크(준 순서). → 201 { star, skipped: [{ file_name, reason }] }
  // bodyLimit 은 JSON 본문에만 걸린다(multipart 는 흘려 읽는다).
  app.post('/api/stars', { bodyLimit: JSON_BODY_LIMIT }, async (req, reply) => {
    const files = []; // 디스크에 쓴 첨부. 별을 남기지 못하면 모두 지운다.
    let linkTitles = Promise.resolve([]);
    try {
      let fields;
      const skipped = [];
      if (!req.isMultipart()) {
        const src = req.body && typeof req.body === 'object' ? req.body : {};
        fields = parseStarFields(db, src);
        linkTitles = Promise.all(fields.links.map(linkTitleFor));
      } else {
        const raw = {};
        const truncated = new Set();
        const seen = new Set();
        let error = null;
        let fileCount = 0;
        const check = () => {
          fields = parseStarFields(db, multipartFields(raw, truncated));
          // 파일을 받는 동안 링크 제목을 함께 가져온다.
          linkTitles = Promise.all(fields.links.map(linkTitleFor));
        };
        // 더 읽을 필요가 없다(글 필드가 틀렸거나 첨부가 너무 많다). 남은 본문은 읽어서 버리기만 한다:
        // 조각 해석기를 떼어 내고 연결에서 오는 것을 흘려보내, 기다리지 않고 바로 답한다.
        const stopReading = (part) => {
          req.raw.unpipe();
          part.file.resume();
          req.raw.resume();
        };
        try {
          for await (const part of req.parts()) {
            if (part.type !== 'file') {
              // 글 필드는 파일보다 먼저 온다. 검사한 뒤(첫 파일 뒤)에 온 것은 쓰지 않는다.
              if (!fields && typeof part.value === 'string') {
                raw[part.fieldname] = part.value;
                if (part.valueTruncated) truncated.add(part.fieldname);
              }
              continue;
            }
            // 첫 파일 조각이 오면 글 필드는 다 왔다. 파일을 읽기 전에 검사한다.
            if (!fields) {
              try {
                check();
              } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                error = err;
                stopReading(part);
                break;
              }
            }
            if (part.fieldname !== 'files') {
              part.file.resume();
              continue;
            }
            fileCount += 1;
            if (fields.links.length + fileCount > MAX_ATTACHMENTS) {
              // 이미 쓴 파일은 아래 catch 에서 지운다.
              error = new ApiError(400, 'too_many_attachments');
              stopReading(part);
              break;
            }
            const res = await storePart(part, crypto.randomUUID(), (hash) => seen.has(hash) || hashExists(hash));
            if (res.attachment) {
              files.push(res.attachment);
              if (res.attachment.file_hash) seen.add(res.attachment.file_hash);
            } else if (!(res.reason === 'duplicate' && seen.has(res.hash))) {
              // 같은 요청 안에서 같은 파일을 또 넣은 것은 하나만 남기고 알리지 않는다.
              skipped.push({ file_name: res.name.fileName, reason: res.reason });
            }
          }
        } catch (err) {
          // 조각을 읽다가 끊겼다(연결이 끊김 · 깨진 본문 · 개수 상한). 남은 본문은 읽어서 버린다.
          req.raw.resume();
          if (error) throw error;
          // 본문이 파일 중간에서 끝났다(멈추기 · 연결 끊김). 이미 쓴 파일은 아래에서 지운다.
          if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || /unexpected end/i.test(err?.message ?? '')) {
            throw new ApiError(400, 'upload_incomplete');
          }
          throw err;
        }
        if (error) throw error;
        // 파일과 파일 사이에서 연결이 끊기면 조각 읽기가 오류 없이 끝날 수 있다. 받다 만 요청은 저장하지 않는다.
        if (req.raw.complete === false) throw new ApiError(400, 'upload_incomplete');
        if (!fields) check(); // 파일 조각이 없었다
      }

      const titles = await linkTitles;
      const links = fields.links.map((url, i) => ({ kind: 'link', url, link_title: titles[i] }));
      if (!fields.body && files.length === 0 && links.length === 0 && skipped.length === 0) {
        throw new ApiError(400, 'empty_star');
      }
      const result = await commit(fields, files, links, skipped);
      if (result.nothing) return reply.code(409).send({ error: 'nothing_to_save', skipped });
      app.ragSync?.markStars([result.star.id], 'create');
      return reply.code(201).send({ star: result.star, skipped });
    } catch (err) {
      await Promise.all(files.map(removeQuiet));
      // 끝나지 않은 링크 제목 요청이 남아 있어도 기다리지 않는다(각각 3초 안에 스스로 끝난다).
      linkTitles.catch(() => {});
      return fail(reply, err);
    }
  });
}
