import crypto from 'node:crypto';

const TITLE_FROM_BODY_MAX = 40;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const COLUMNS = [
  'id', 'type', 'title', 'body', 'url', 'link_title', 'file_name', 'file_ext', 'file_size', 'file_hash',
  'vault_path', 'thumb_path', 'memo', 'planet_id', 'created_at', 'search_text',
];

// DB 행을 응답 모양으로 바꾼다. vault_path · thumb_path · file_hash · search_text 는 내보내지 않는다.
export function toStarJson(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    url: row.url ?? null,
    link_title: row.link_title ?? null,
    file_name: row.file_name ?? null,
    file_ext: row.file_ext ?? null,
    file_size: row.file_size ?? null,
    memo: row.memo ?? '',
    planet_id: row.planet_id,
    created_at: row.created_at,
    has_thumb: Boolean(row.thumb_path),
  };
}

// 제목 · 본문 · 메모 · 링크 제목 · 주소 · 파일 이름 중 있는 것을 줄바꿈으로 합친다.
export function buildSearchText(star) {
  return [star.title, star.body, star.memo, star.link_title, star.url, star.file_name]
    .filter((part) => typeof part === 'string' && part !== '')
    .join('\n');
}

// 별 하나를 넣는다. id · created_at 이 없으면 만들고, search_text 는 항상 새로 만든다.
// 값은 이미 검사된 것으로 본다(라우트가 검사한다). planet_id 가 없는 행성이면 DB 가 거절한다.
export function insertStar(db, fields) {
  const row = {
    body: null,
    url: null,
    link_title: null,
    file_name: null,
    file_ext: null,
    file_size: null,
    file_hash: null,
    vault_path: null,
    thumb_path: null,
    ...fields,
    id: fields.id ?? crypto.randomUUID(),
    memo: fields.memo ?? '',
    created_at: fields.created_at ?? new Date().toISOString(),
  };
  row.search_text = buildSearchText(row);
  db.prepare(
    `INSERT INTO stars (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`,
  ).run(Object.fromEntries(COLUMNS.map((c) => [c, row[c]])));
  return toStarJson(row);
}

function getRow(db, id) {
  return db.prepare('SELECT * FROM stars WHERE id = ?').get(id);
}

function planetExists(db, id) {
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

function firstLine(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return [...line].slice(0, TITLE_FROM_BODY_MAX).join('');
}

function isHttpUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

// 글 · 링크 별 만들기 요청을 검사해 정리한 값을 돌려준다. 벗어나면 ApiError(400).
function parseCreate(db, body) {
  const src = body && typeof body === 'object' ? body : {};
  if (src.type !== 'text' && src.type !== 'link') throw new ApiError(400, 'invalid_type');

  const out = { type: src.type, title: '', memo: '' };
  if (src.title !== undefined && src.title !== null) {
    if (typeof src.title !== 'string') throw new ApiError(400, 'invalid_title');
    out.title = src.title.trim();
  }
  if (src.memo !== undefined && src.memo !== null) {
    if (typeof src.memo !== 'string') throw new ApiError(400, 'invalid_memo');
    out.memo = src.memo;
  }

  if (src.type === 'text') {
    if (typeof src.body !== 'string' || src.body.trim() === '') throw new ApiError(400, 'empty_body');
    out.body = src.body;
  } else {
    const url = typeof src.url === 'string' ? src.url.trim() : '';
    if (!isHttpUrl(url)) throw new ApiError(400, 'invalid_url');
    out.url = url;
  }

  if (!planetExists(db, src.planet_id)) throw new ApiError(400, 'unknown_planet');
  out.planet_id = src.planet_id;
  return out;
}

// 수정 요청에서 있는 것만 검사한다. 빈 제목은 받지 않는다(400 invalid_title).
function parsePatch(db, body) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  if (src.title !== undefined) {
    if (typeof src.title !== 'string' || src.title.trim() === '') throw new ApiError(400, 'invalid_title');
    out.title = src.title.trim();
  }
  if (src.memo !== undefined) {
    if (typeof src.memo !== 'string') throw new ApiError(400, 'invalid_memo');
    out.memo = src.memo;
  }
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

  // 링크 제목을 못 가져오면(오류 포함) null. 저장은 그래도 된다.
  async function linkTitleFor(url) {
    try {
      const title = await app.config.fetchTitle(url);
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
    } catch {
      return null;
    }
  }

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
    return db
      .prepare(`SELECT * FROM stars ${where} ORDER BY created_at DESC, id DESC ${tail}`)
      .all(params)
      .map(toStarJson);
  });

  app.get('/api/stars/:id', async (req, reply) => {
    const row = getRow(db, req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return toStarJson(row);
  });

  app.post('/api/stars', async (req, reply) => {
    try {
      const fields = parseCreate(db, req.body);
      if (fields.type === 'text') {
        if (!fields.title) fields.title = firstLine(fields.body);
      } else {
        fields.link_title = await linkTitleFor(fields.url);
        if (!fields.title) fields.title = fields.link_title ?? fields.url;
        // 제목을 가져오는 사이 행성이 지워졌을 수 있다.
        if (!planetExists(db, fields.planet_id)) throw new ApiError(400, 'unknown_planet');
      }
      return reply.code(201).send(insertStar(db, fields));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/api/stars/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const updated = db.transaction(() => {
        const row = getRow(db, id);
        if (!row) throw new ApiError(404, 'not_found');
        const next = { ...row, ...parsePatch(db, req.body) };
        next.search_text = buildSearchText(next);
        db.prepare(
          'UPDATE stars SET title = @title, memo = @memo, planet_id = @planet_id, search_text = @search_text WHERE id = @id',
        ).run({ id, title: next.title, memo: next.memo, planet_id: next.planet_id, search_text: next.search_text });
        return next;
      })();
      return toStarJson(updated);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/stars/:id', async (req, reply) => {
    const row = getRow(db, req.params.id);
    if (!row || db.prepare('DELETE FROM stars WHERE id = ?').run(row.id).changes === 0) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // DB 가 확정된 뒤에 파일을 지운다. 파일 정리가 실패해도 삭제는 이미 끝난 것이다.
    try {
      await app.removeStarFiles(row);
    } catch (err) {
      app.log.error(err);
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
      star = row ? toStarJson(row) : null;
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
