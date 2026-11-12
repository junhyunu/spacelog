import crypto from 'node:crypto';
import { attachmentsByStar } from './stars.js';

export const DECOS = ['town', 'crystal', 'forest', 'rock', 'ice', 'volcano', 'mushroom', 'cactus', 'flower', 'cloud'];
export const COLOR_COUNT = 16;

const NAME_MAX = 20;
const DESCRIPTION_MAX = 20;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const len = (s) => [...s].length;
// 보이지 않는 글자(제로 폭 · 제어 문자)를 빼고 NFC 로 맞춘 뒤 앞뒤 공백을 뗀다.
const clean = (s) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g, '').trim();

// 들어온 값 중 있는 것만 검사해 정리한 값을 돌려준다. 벗어나면 ApiError(400).
function parseFields(body, { requireName }) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};

  if (src.name !== undefined || requireName) {
    if (typeof src.name !== 'string') throw new ApiError(400, 'invalid_name');
    const name = clean(src.name);
    if (len(name) < 1 || len(name) > NAME_MAX) throw new ApiError(400, 'invalid_name');
    out.name = name;
  }
  if (src.description !== undefined) {
    if (typeof src.description !== 'string') throw new ApiError(400, 'invalid_description');
    const description = clean(src.description);
    if (len(description) > DESCRIPTION_MAX) throw new ApiError(400, 'invalid_description');
    out.description = description;
  }
  if (src.color_index !== undefined) {
    if (!Number.isInteger(src.color_index) || src.color_index < 1 || src.color_index > COLOR_COUNT) {
      throw new ApiError(400, 'invalid_look');
    }
    out.color_index = src.color_index;
  }
  if (src.deco !== undefined) {
    if (!DECOS.includes(src.deco)) throw new ApiError(400, 'invalid_look');
    out.deco = src.deco;
  }
  if (src.ring !== undefined) {
    if (typeof src.ring !== 'boolean') throw new ApiError(400, 'invalid_look');
    out.ring = src.ring;
  }
  return out;
}

function getSeq(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'planet_seq'").get();
  const n = row ? Number.parseInt(row.value, 10) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// n 번째(0부터)로 만드는 행성의 자동 배정 모습.
function lookFor(n) {
  return { color_index: (n % COLOR_COUNT) + 1, deco: DECOS[n % DECOS.length], ring: n % 3 === 1 };
}

function lowestFreeSlot(db) {
  const used = db.prepare('SELECT slot FROM planets ORDER BY slot').all();
  let slot = 0;
  for (const row of used) {
    if (row.slot !== slot) break;
    slot += 1;
  }
  return slot;
}

function toPlanetJson(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color_index: row.color_index,
    deco: row.deco,
    ring: row.ring === 1,
    slot: row.slot,
    count_in_period: row.count_in_period,
    count_total: row.count_total,
  };
}

// 행성 목록(또는 id 하나)을 별 개수와 함께 읽는다. from 포함, to 미포함.
function selectPlanets(db, { from, to, id } = {}) {
  const cond = [];
  const params = {};
  if (from) {
    cond.push('s.created_at >= @from');
    params.from = from;
  }
  if (to) {
    cond.push('s.created_at < @to');
    params.to = to;
  }
  const inPeriod = cond.length
    ? `(SELECT COUNT(*) FROM stars s WHERE s.planet_id = p.id AND ${cond.join(' AND ')})`
    : '(SELECT COUNT(*) FROM stars s WHERE s.planet_id = p.id)';
  let where = '';
  if (id !== undefined) {
    where = 'WHERE p.id = @id';
    params.id = id;
  }
  const rows = db
    .prepare(
      `SELECT p.*,
              ${inPeriod} AS count_in_period,
              (SELECT COUNT(*) FROM stars s WHERE s.planet_id = p.id) AS count_total
         FROM planets p ${where}
        ORDER BY p.slot`,
    )
    .all(params);
  return rows.map(toPlanetJson);
}

function getPlanet(db, id) {
  return selectPlanets(db, { id })[0] ?? null;
}

function exists(db, id) {
  return db.prepare('SELECT 1 FROM planets WHERE id = ?').get(id) !== undefined;
}

// 행성 하나를 만든다. 빠진 모습 값은 planet_seq 로 자동 배정하고, 가장 작은 빈 자리를 준다.
// 값은 이미 검사된 것으로 본다(라우트는 parseFields 를 거친다).
export function createPlanet(db, { name, description = '', color_index, deco, ring } = {}) {
  const run = db.transaction(() => {
    const n = getSeq(db);
    const auto = lookFor(n);
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO planets (id, name, description, color_index, deco, ring, slot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      description,
      color_index ?? auto.color_index,
      deco ?? auto.deco,
      (ring ?? auto.ring) ? 1 : 0,
      lowestFreeSlot(db),
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('planet_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(n + 1));
    return id;
  });
  return getPlanet(db, run.immediate());
}

// 별을 into 로 옮기고 원본 행성을 지운다. 옮긴 별 수를 돌려준다.
function moveStarsAndDelete(db, id, into) {
  return db.transaction(() => {
    const moved = db.prepare('UPDATE stars SET planet_id = ? WHERE planet_id = ?').run(into, id).changes;
    db.prepare('DELETE FROM planets WHERE id = ?').run(id);
    return moved;
  })();
}

export function registerPlanets(app) {
  const db = app.db;

  // files.js 가 보관함 정리로 바꾼다. star 는 별 행에 attachments(첨부 행 목록)를 붙인 것이다.
  app.decorate('removeStarFiles', () => {});

  const fail = (reply, err) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  app.get('/api/planets', async (req) => {
    const { from, to } = req.query;
    return selectPlanets(db, {
      from: typeof from === 'string' && from ? from : undefined,
      to: typeof to === 'string' && to ? to : undefined,
    });
  });

  // 고정 경로라 '/api/planets/:id' 보다 먼저 맞는다.
  app.get('/api/planets/next-look', async () => lookFor(getSeq(db)));

  app.post('/api/planets', async (req, reply) => {
    try {
      const fields = parseFields(req.body, { requireName: true });
      return reply.code(201).send(createPlanet(db, fields));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/api/planets/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      if (!exists(db, id)) throw new ApiError(404, 'not_found');
      const fields = parseFields(req.body, { requireName: false });
      if ('ring' in fields) fields.ring = fields.ring ? 1 : 0;
      const keys = Object.keys(fields);
      if (keys.length) {
        const sets = keys.map((k) => `${k} = @${k}`).join(', ');
        db.prepare(`UPDATE planets SET ${sets} WHERE id = @id`).run({ ...fields, id });
      }
      return getPlanet(db, id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/planets/:id/merge', async (req, reply) => {
    try {
      const { id } = req.params;
      const into = req.body && typeof req.body === 'object' ? req.body.into : undefined;
      if (!exists(db, id)) throw new ApiError(404, 'not_found');
      if (typeof into !== 'string' || !into || into === id) throw new ApiError(400, 'invalid_target');
      if (!exists(db, into)) throw new ApiError(404, 'not_found');
      return { moved: moveStarsAndDelete(db, id, into) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/planets/:id', async (req, reply) => {
    try {
      const { id } = req.params;
      const { stars: mode, into } = req.query;
      if (!exists(db, id)) throw new ApiError(404, 'not_found');

      if (mode === 'move') {
        if (typeof into !== 'string' || !into || into === id || !exists(db, into)) {
          throw new ApiError(400, 'invalid_target');
        }
        moveStarsAndDelete(db, id, into);
        return reply.code(204).send();
      }

      if (mode === 'delete') {
        const removed = db.transaction(() => {
          const rows = db.prepare('SELECT * FROM stars WHERE planet_id = ?').all(id);
          // 첨부 행은 별과 함께 지워지므로 먼저 한 번에 읽어 둔다.
          const atts = attachmentsByStar(db, rows.map((r) => r.id));
          for (const row of rows) row.attachments = atts.get(row.id);
          db.prepare('DELETE FROM stars WHERE planet_id = ?').run(id);
          db.prepare('DELETE FROM planets WHERE id = ?').run(id);
          return rows;
        })();
        // DB 가 확정된 뒤에 파일을 지운다. 파일 정리가 실패해도 삭제는 이미 끝난 것이다.
        for (const star of removed) {
          try {
            await app.removeStarFiles(star);
          } catch (err) {
            // logger: false 라 app.log 는 아무것도 남기지 않는다.
            console.error(`removeStarFiles failed for star ${star.id}`, err);
          }
        }
        return reply.code(204).send();
      }

      const deleted = db.transaction(() => {
        const { c } = db.prepare('SELECT COUNT(*) AS c FROM stars WHERE planet_id = ?').get(id);
        if (c > 0) return false;
        db.prepare('DELETE FROM planets WHERE id = ?').run(id);
        return true;
      })();
      if (!deleted) throw new ApiError(409, 'not_empty');
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });
}
