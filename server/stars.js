import crypto from 'node:crypto';

const TITLE_FROM_BODY_MAX = 40;

/** 메모 글자 수(코드 포인트) 한도. 파일 올리기(files.js) · 화면(detailLogic.js)의 한도와 같다. */
export const MEMO_MAX = 20000;

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const STAR_COLUMNS = ['id', 'type', 'title', 'body', 'memo', 'planet_id', 'created_at', 'search_text'];
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
    planet_id: row.planet_id,
    created_at: row.created_at,
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

// 수정 요청에서 있는 것만 검사한다. 빈 제목은 받지 않는다(400 invalid_title). 본문 · 첨부는 고치지 않는다.
function parsePatch(db, body) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  if (src.title !== undefined) {
    if (typeof src.title !== 'string' || src.title.trim() === '') throw new ApiError(400, 'invalid_title');
    out.title = src.title.trim();
  }
  if (src.memo !== undefined) out.memo = checkMemo(src.memo);
  if (src.planet_id !== undefined) {
    if (!planetExists(db, src.planet_id)) throw new ApiError(400, 'unknown_planet');
    out.planet_id = src.planet_id;
  }
  return out;
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
    const { planet_id: planetId, limit } = req.query;
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
    return starsToJson(db, db.prepare(`SELECT * FROM stars ${where} ORDER BY created_at DESC, id DESC ${tail}`).all(params));
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
          'UPDATE stars SET title = @title, memo = @memo, planet_id = @planet_id, search_text = @search_text WHERE id = @id',
        ).run({ id, title: next.title, memo: next.memo, planet_id: next.planet_id, search_text: next.search_text });
        return next;
      })();
      return toStarJson(updated, updated.attachments);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/stars/:id', async (req, reply) => {
    // 첨부 행은 별과 함께(ON DELETE CASCADE) 지워지므로 지우기 전에 읽어 둔다.
    const row = db.transaction(() => {
      const found = getRow(db, req.params.id);
      if (!found) return null;
      found.attachments = attachmentsOf(db, found.id);
      db.prepare('DELETE FROM stars WHERE id = ?').run(found.id);
      return found;
    })();
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // DB 가 확정된 뒤에 파일을 지운다. 파일 정리가 실패해도 삭제는 이미 끝난 것이다.
    try {
      await app.removeStarFiles(row);
    } catch (err) {
      // logger: false 라 app.log 는 아무것도 남기지 않는다.
      console.error(`removeStarFiles failed for star ${row.id}`, err);
    }
    return reply.code(204).send();
  });

  // '/api/stars/:id' 와 겹치지 않도록 별도 경로에 둔다.
  app.get('/api/rediscovery', async (req, reply) => {
    const { today, before } = req.query;
    if (typeof today !== 'string' || !today || typeof before !== 'string' || !before) {
      return reply.code(400).send({ error: 'invalid_query' });
    }
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM stars WHERE created_at < ?').get(before);
    let star = null;
    if (c > 0) {
      let sum = 0;
      for (const ch of today) sum += ch.charCodeAt(0);
      const row = db
        .prepare('SELECT * FROM stars WHERE created_at < ? ORDER BY id LIMIT 1 OFFSET ?')
        .get(before, sum % c);
      star = row ? toStarJson(row, attachmentsOf(db, row.id)) : null;
    }
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(star));
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
