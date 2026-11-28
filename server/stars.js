import crypto from 'node:crypto';
import { recordRemovals } from './rag/sync.js';

const TITLE_FROM_BODY_MAX = 40;
const TITLE_MAX = 200;

// 앞뒤 공백을 떼고 200자(코드 포인트)로 자른다(자른 뒤 끝에 남은 공백도 뗀다). 만들기 · 고치기 공통.
export const cutTitle = (s) => [...s.trim()].slice(0, TITLE_MAX).join('').trim();

/** 메모 글자 수(코드 포인트) 한도. 파일 올리기(files.js) · 화면(detailLogic.js)의 한도와 같다. */
export const MEMO_MAX = 20000;

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const STAR_COLUMNS = ['id', 'type', 'title', 'body', 'memo', 'planet_id', 'created_at', 'search_text', 'seen_at'];

// 잠든 별 블랙홀(server/remind.js)이 보는 칸. 이 칸만 바꾸는 고치기는 챗봇 색인과 상관없다.
const INDEX_FREE_KEYS = new Set(['fav', 'seen_at', 'remind_off']);
const ATTACHMENT_COLUMNS = [
  'id', 'star_id', 'kind', 'position', 'file_name', 'file_ext', 'file_size', 'file_hash',
  'vault_path', 'thumb_path', 'url', 'link_title', 'created_at',
];

const byPosition = (a, b) => a.position - b.position;

// 첨부 행을 응답 모양으로 바꾼다. vault_path · thumb_path · file_hash 는 내보내지 않는다.
export function toAttachmentJson(row) {
  return {
    id: row.id,
    kind: row.kind,
    position: row.position,
    file_name: row.file_name ?? null,
    file_ext: row.file_ext ?? null,
    file_size: row.file_size ?? null,
    url: row.url ?? null,
    link_title: row.link_title ?? null,
    has_thumb: Boolean(row.thumb_path),
  };
}

// 별의 type 은 계산한 값이다: 첨부가 없으면 text, 있으면 첫 첨부의 kind.
export function starType(attachments) {
  return attachments.length ? attachments[0].kind : 'text';
}

// 별 행과 그 첨부 행들을 응답 모양으로 바꾼다. search_text 와 보관함 경로는 내보내지 않는다.
export function toStarJson(row, attachments = []) {
  const atts = [...attachments].sort(byPosition);
  const thumb = atts.find((a) => a.kind === 'image' && a.thumb_path);
  return {
    id: row.id,
    type: starType(atts),
    title: row.title,
    body: row.body ?? null,
    memo: row.memo ?? '',
    fav: row.fav === 1 || row.fav === true, // 자주 찾음(홈 목록의 ☆)
    planet_id: row.planet_id,
    created_at: row.created_at,
    seen_at: row.seen_at ?? row.created_at, // 마지막으로 본 때(잠든 별 블랙홀)
    remind_off: Boolean(row.remind_off_at), // 알림을 끈 별(잠든 별 블랙홀에 모으지 않는다)
    has_thumb: Boolean(thumb),
    thumb_attachment_id: thumb ? thumb.id : null,
    attachment_count: atts.length,
    attachments: atts.map(toAttachmentJson),
  };
}

// 제목 · 본문 · 메모, 그리고 첨부마다 파일 이름 · 링크 제목 · 주소 중 있는 것을 줄바꿈으로 합친다.
export function buildSearchText(star, attachments = []) {
  const parts = [star.title, star.body, star.memo];
  for (const a of [...attachments].sort(byPosition)) parts.push(a.file_name, a.link_title, a.url);
  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n');
}

// 여러 별의 첨부를 질의 한 번으로 읽는다(목록이 별마다 따로 묻지 않도록). → Map<star_id, 행[]>(position 순)
export function attachmentsByStar(db, starIds) {
  const map = new Map(starIds.map((id) => [id, []]));
  if (starIds.length === 0) return map;
  const rows = db
    .prepare('SELECT * FROM attachments WHERE star_id IN (SELECT value FROM json_each(?)) ORDER BY star_id, position')
    .all(JSON.stringify(starIds));
  for (const row of rows) map.get(row.star_id)?.push(row);
  return map;
}

// 여러 별을 다루는 요청의 ids 검사: 문자열 배열, 1~500개.
function checkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((v) => typeof v === 'string')) {
    throw new ApiError(400, 'invalid_ids');
  }
}

export function attachmentsOf(db, starId) {
  return db.prepare('SELECT * FROM attachments WHERE star_id = ? ORDER BY position').all(starId);
}

// 별 행 목록 → 응답 목록. 첨부는 한 번에 읽는다.
export function starsToJson(db, rows) {
  const atts = attachmentsByStar(db, rows.map((r) => r.id));
  return rows.map((row) => toStarJson(row, atts.get(row.id)));
}

// 별 하나와 첨부들을 한 트랜잭션으로 넣는다. id · created_at 이 없으면 만들고, search_text 는 항상 새로 만든다.
// fields.attachments 의 순서가 position 이 된다. 값은 이미 검사된 것으로 본다(라우트가 검사한다).
// planet_id 가 없는 행성이거나 같은 파일(file_hash)이 이미 있으면 DB 가 거절하고 아무것도 남지 않는다.
export function insertStar(db, fields) {
  const created = fields.created_at ?? new Date().toISOString();
  const id = fields.id ?? crypto.randomUUID();
  const atts = (fields.attachments ?? []).map((a, position) => ({
    file_name: null, file_ext: null, file_size: null, file_hash: null,
    vault_path: null, thumb_path: null, url: null, link_title: null,
    ...a,
    id: a.id ?? crypto.randomUUID(),
    star_id: id,
    position,
    created_at: created,
  }));
  const row = {
    id,
    type: starType(atts),
    title: fields.title,
    body: fields.body ?? null,
    memo: fields.memo ?? '',
    planet_id: fields.planet_id,
    created_at: created,
    seen_at: fields.seen_at ?? created, // 새 별은 넣은 때부터 센다
  };
  row.search_text = buildSearchText(row, atts);
  const insStar = db.prepare(
    `INSERT INTO stars (${STAR_COLUMNS.join(', ')}) VALUES (${STAR_COLUMNS.map((c) => `@${c}`).join(', ')})`,
  );
  const insAtt = db.prepare(
    `INSERT INTO attachments (${ATTACHMENT_COLUMNS.join(', ')}) VALUES (${ATTACHMENT_COLUMNS.map((c) => `@${c}`).join(', ')})`,
  );
  db.transaction(() => {
    insStar.run(row);
    for (const a of atts) insAtt.run(Object.fromEntries(ATTACHMENT_COLUMNS.map((c) => [c, a[c]])));
  })();
  return toStarJson(row, atts);
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM stars WHERE id = ?').get(id);
}

export function planetExists(db, id) {
  return typeof id === 'string' && id !== '' && db.prepare('SELECT 1 FROM planets WHERE id = ?').get(id) !== undefined;
}

// from 포함, to 미포함. 빈 값은 조건에서 뺀다.
function periodCond(query, cond, params) {
  const { from, to } = query;
  if (typeof from === 'string' && from) {
    cond.push('created_at >= @from');
    params.from = from;
  }
  if (typeof to === 'string' && to) {
    cond.push('created_at < @to');
    params.to = to;
  }
}

// 문자열이 아니거나 한도를 넘는 메모는 받지 않는다. 글자 수는 코드 포인트로 센다.
export function checkMemo(memo) {
  if (typeof memo !== 'string') throw new ApiError(400, 'invalid_memo');
  if (memo.length > MEMO_MAX && [...memo].length > MEMO_MAX) throw new ApiError(400, 'invalid_memo');
  return memo;
}

// 본문(화면의 "메모"). 문자열이 아니거나 한도(메모와 같은 2만 자, 코드 포인트)를 넘으면 받지 않는다. 공백뿐이면 null.
export function checkBody(body) {
  if (typeof body !== 'string') throw new ApiError(400, 'invalid_body');
  if (body.length > MEMO_MAX && [...body].length > MEMO_MAX) throw new ApiError(400, 'invalid_body');
  return body.trim() === '' ? null : body;
}

// 본문의 비어 있지 않은 첫 줄, 40자까지.
export function firstLine(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return [...line].slice(0, TITLE_FROM_BODY_MAX).join('');
}

export function isHttpUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

// 수정 요청에서 있는 것만 검사한다. 빈 제목은 받지 않는다(400 invalid_title), 긴 제목은 만들 때처럼 200자로 자른다.
// 본문은 비울 수 있다(null). 첨부는 고치지 않는다.
function parsePatch(db, body) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  if (src.body !== undefined) out.body = checkBody(src.body);
  if (src.title !== undefined) {
    if (typeof src.title !== 'string' || src.title.trim() === '') throw new ApiError(400, 'invalid_title');
    out.title = cutTitle(src.title);
  }
  if (src.memo !== undefined) out.memo = checkMemo(src.memo);
  if (src.fav !== undefined) {
    if (typeof src.fav !== 'boolean') throw new ApiError(400, 'invalid_fav');
    out.fav = src.fav ? 1 : 0;
  }
  if (src.planet_id !== undefined) {
    if (!planetExists(db, src.planet_id)) throw new ApiError(400, 'unknown_planet');
    out.planet_id = src.planet_id;
  }
  // 잠든 별 화면의 되돌리기가 쓴다: 본 때를 이전 값으로, 알림 끄기를 이전 상태로
  if (src.seen_at !== undefined) out.seen_at = checkTime(src.seen_at, 'invalid_seen_at');
  if (src.remind_off !== undefined) {
    if (typeof src.remind_off !== 'boolean') throw new ApiError(400, 'invalid_remind_off');
    out.remind_off_at = src.remind_off ? new Date().toISOString() : null;
  }
  return out;
}

// 시각 문자열 → ISO. 읽을 수 없으면 400.
export function checkTime(value, code) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) throw new ApiError(400, code);
  return new Date(t).toISOString();
}

export function registerStars(app) {
  const db = app.db;

  const fail = (reply, err) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  app.get('/api/stars', async (req) => {
    const cond = [];
    const params = {};
    periodCond(req.query, cond, params);
    const { planet_id: planetId, limit, fav } = req.query;
    // fav=1: 자주 찾음만. 그 밖의 값은 받지 않는다(안 보내면 모두)
    if (fav !== undefined) {
      if (fav !== '1') throw new ApiError(400, 'invalid_query');
      cond.push('fav = 1');
    }
    if (planetId !== undefined && typeof planetId !== 'string') throw new ApiError(400, 'invalid_query');
    if (typeof planetId === 'string' && planetId) {
      cond.push('planet_id = @planet_id');
      params.planet_id = planetId;
    }
    let tail = '';
    if (typeof limit === 'string' && /^[1-9]\d{0,8}$/.test(limit)) {
      tail = 'LIMIT @limit';
      params.limit = Number(limit);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return starsToJson(db, db.prepare(`SELECT * FROM stars ${where} ORDER BY created_at DESC, rowid DESC ${tail}`).all(params));
  });

  app.get('/api/stars/:id', async (req, reply) => {
    const row = getRow(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return toStarJson(row, attachmentsOf(db, row.id));
  });

  app.patch('/api/stars/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const updated = db.transaction(() => {
        const row = getRow(db, id);
        if (!row) throw new ApiError(404, 'not_found');
        const next = { ...row, ...parsePatch(db, req.body) };
        next.attachments = attachmentsOf(db, id);
        next.search_text = buildSearchText(next, next.attachments);
        db.prepare(
          'UPDATE stars SET title = @title, body = @body, memo = @memo, fav = @fav, planet_id = @planet_id, search_text = @search_text, seen_at = @seen_at, remind_off_at = @remind_off_at WHERE id = @id',
        ).run({
          id, title: next.title, body: next.body ?? null, memo: next.memo, fav: next.fav ? 1 : 0, planet_id: next.planet_id,
          search_text: next.search_text, seen_at: next.seen_at ?? null, remind_off_at: next.remind_off_at ?? null,
        });
        return next;
      })();
      // 자주 찾음 · 본 때 · 알림 끄기만 바꾼 요청은 챗봇 색인과 상관없다(글 · 제목 · 행성이 그대로다)
      const keys = Object.keys(req.body && typeof req.body === 'object' ? req.body : {});
      if (!(keys.length > 0 && keys.every((k) => INDEX_FREE_KEYS.has(k)))) app.ragSync?.markStars([id], 'patch');
      return toStarJson(updated, updated.attachments);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 봤음: 상세를 열거나 챗봇 출처를 누르면 화면이 보낸다. 시각은 서버 시계로 적는다(잠든 별 블랙홀의 기준).
  app.post('/api/stars/:id/seen', async (req, reply) => {
    const seenAt = new Date().toISOString();
    const res = db.prepare('UPDATE stars SET seen_at = ? WHERE id = ?').run(seenAt, req.params.id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { id: req.params.id, seen_at: seenAt };
  });

  // 별 여러 개를 한꺼번에 지운다. 없는 별 · 중복은 건너뛰고 실제로 지운 수를 돌려준다.
  app.post('/api/stars/delete', async (req, reply) => {
    try {
      const { ids } = req.body && typeof req.body === 'object' ? req.body : {};
      checkIds(ids);
      const inFlight = app.ragSync?.inFlight?.() ?? null;
      const rows = db.transaction(() => {
        const found = [];
        for (const id of new Set(ids)) {
          const row = getRow(db, id);
          if (!row) continue;
          row.attachments = attachmentsOf(db, id);
          found.push(row);
        }
        if (found.length) {
          const gone = found.map((r) => r.id);
          recordRemovals(db, gone, inFlight);
          const del = db.prepare('DELETE FROM stars WHERE id = ?');
          for (const id of gone) del.run(id);
        }
        return found;
      })();
      if (rows.length) app.ragSync?.markStars(rows.map((r) => r.id), 'delete');
      for (const row of rows) {
        try {
          await app.removeStarFiles(row);
        } catch (err) {
          console.error(`removeStarFiles failed for star ${row.id}`, err);
        }
      }
      return { deleted: rows.length };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 별 여러 개를 한 행성으로 옮긴다. 없는 별 · 중복 · 이미 그 행성에 있는 별은 건너뛰고 실제로 옮긴 수를 돌려준다.
  app.post('/api/stars/move', async (req, reply) => {
    try {
      const { ids, planet_id: planetId } = req.body && typeof req.body === 'object' ? req.body : {};
      checkIds(ids);
      if (!planetExists(db, planetId)) throw new ApiError(400, 'unknown_planet');
      const upd = db.prepare('UPDATE stars SET planet_id = ? WHERE id = ? AND planet_id <> ?');
      const moved = db.transaction(() => [...new Set(ids)].filter((id) => upd.run(planetId, id, planetId).changes > 0))();
      if (moved.length) app.ragSync?.markStars(moved, 'patch');
      return { moved: moved.length };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/stars/:id', async (req, reply) => {
    // 첨부 행은 별과 함께(ON DELETE CASCADE) 지워지므로 지우기 전에 읽어 둔다.
    const inFlight = app.ragSync?.inFlight?.() ?? null;
    const row = db.transaction(() => {
      const found = getRow(db, req.params.id);
      if (!found) return null;
      found.attachments = attachmentsOf(db, found.id);
      // 챗봇 색인에서 지울 목록도 같은 트랜잭션에서(rag_status 행이 함께 지워지기 전에) 적는다.
      recordRemovals(db, [found.id], inFlight);
      db.prepare('DELETE FROM stars WHERE id = ?').run(found.id);
      return found;
    })();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    app.ragSync?.markStars([row.id], 'delete');
    // DB 가 확정된 뒤에 파일을 지운다. 파일 정리가 실패해도 삭제는 이미 끝난 것이다.
    try {
      await app.removeStarFiles(row);
    } catch (err) {
      // logger: false 라 app.log 는 아무것도 남기지 않는다.
      console.error(`removeStarFiles failed for star ${row.id}`, err);
    }
    return reply.code(204).send();
  });

  app.get('/api/summary', async (req) => {
    const cond = [];
    const params = {};
    periodCond(req.query, cond, params);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return {
      in_period: db.prepare(`SELECT COUNT(*) AS c FROM stars ${where}`).get(params).c,
      total: db.prepare('SELECT COUNT(*) AS c FROM stars').get().c,
      planets: db.prepare('SELECT COUNT(*) AS c FROM planets').get().c,
    };
  });
}
