import { ApiError, starsToJson } from './stars.js';

// 잠든 별 블랙홀(리마인드). 마지막으로 본 때(seen_at)부터 정한 날수가 지났고 알림을 끄지 않은 별을 모은다.
//   GET  /api/remind?limit=20     → { days, total, stars }   오래 안 본 순. days 0(끄기)이면 늘 빈 목록
//   GET  /api/remind/off          → { stars }                 알림 끈 별, 최근에 끈 순
//   POST /api/remind/off { ids, off } → { changed }           off: true = 알림 끄기, false = 다시 알림 받기(다시 날짜를 센다)
//   GET  /api/remind/settings     → { days }                  7 · 14 · 30, 0 = 끄기. 기본 14
//   PUT  /api/remind/settings { days }                        잘못된 값은 400 invalid_remind_settings
// 나중에 다시 = POST /api/stars/:id/seen(본 때를 지금으로). 되돌리기 = PATCH /api/stars/:id { seen_at | remind_off }

export const REMIND_DAYS = Object.freeze([0, 7, 14, 30]);
export const DEFAULT_REMIND_DAYS = 14;
export const REMIND_LIMIT_MAX = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export function readRemindSettings(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'remind'").get();
  try {
    const days = row ? JSON.parse(row.value).days : DEFAULT_REMIND_DAYS;
    return { days: REMIND_DAYS.includes(days) ? days : DEFAULT_REMIND_DAYS };
  } catch {
    return { days: DEFAULT_REMIND_DAYS };
  }
}

/** 지금(now, ms)과 날수로 기준 시각(이보다 먼저 본 별이 잠든 별) → ISO. days 0 이면 null. */
export function remindCutoff(now, days) {
  return days > 0 ? new Date(now - days * DAY_MS).toISOString() : null;
}

function checkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((v) => typeof v === 'string')) {
    throw new ApiError(400, 'invalid_ids');
  }
}

export function registerRemind(app, { now = () => Date.now() } = {}) {
  const { db } = app;
  const fail = (reply, err) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code });
    throw err;
  };

  app.get('/api/remind', async (req, reply) => {
    const { limit } = req.query ?? {};
    let n = 20;
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > REMIND_LIMIT_MAX) {
        return reply.code(400).send({ error: 'invalid_query' });
      }
      n = Number(limit);
    }
    const { days } = readRemindSettings(db);
    const cutoff = remindCutoff(now(), days);
    if (!cutoff) return { days, total: 0, stars: [] };
    const where = 'WHERE remind_off_at IS NULL AND COALESCE(seen_at, created_at) < @cutoff';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM stars ${where}`).get({ cutoff }).c;
    const rows = db
      .prepare(`SELECT * FROM stars ${where} ORDER BY COALESCE(seen_at, created_at) ASC, rowid ASC LIMIT @n`)
      .all({ cutoff, n });
    return { days, total, stars: starsToJson(db, rows) };
  });

  app.get('/api/remind/off', async () => ({
    stars: starsToJson(db, db.prepare('SELECT * FROM stars WHERE remind_off_at IS NOT NULL ORDER BY remind_off_at DESC, rowid DESC').all()),
  }));

  app.post('/api/remind/off', async (req, reply) => {
    try {
      const { ids, off } = req.body && typeof req.body === 'object' ? req.body : {};
      checkIds(ids);
      if (typeof off !== 'boolean') throw new ApiError(400, 'invalid_off');
      const at = new Date(now()).toISOString();
      // 끄기: 끈 때를 적는다. 다시 받기: 끈 때를 지우고 본 때를 지금으로(바로 다시 블랙홀로 가지 않게)
      const upd = off
        ? db.prepare('UPDATE stars SET remind_off_at = @at WHERE id = @id')
        : db.prepare('UPDATE stars SET remind_off_at = NULL, seen_at = @at WHERE id = @id AND remind_off_at IS NOT NULL');
      const changed = db.transaction(() => [...new Set(ids)].filter((id) => upd.run({ id, at }).changes > 0).length)();
      return { changed };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/remind/settings', async () => readRemindSettings(db));

  app.put('/api/remind/settings', async (req, reply) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    const keys = body ? Object.keys(body) : [];
    if (!body || keys.length !== 1 || keys[0] !== 'days' || !REMIND_DAYS.includes(body.days)) {
      return reply.code(400).send({ error: 'invalid_remind_settings' });
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('remind', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify({ days: body.days }),
    );
    return { days: body.days };
  });
}
