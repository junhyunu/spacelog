// 챗봇 라우트. Task 1: 상태. Task 3: 설정 · 다시 읽기. (대화는 Task 5 에서 여기에 더한다.)
import { indexCounts, readSettings, readUsage, writeSettings } from './sync.js';

function ragState(app) {
  const st = app.rag?.status?.() ?? { state: 'off' };
  return { state: st.state, reason: st.reason ?? null };
}

// 키 값은 절대 내보내지 않는다. 파이썬이 ready 일 때만 key(있다/없다)를 채운다.
async function keyPresence(app, state) {
  if (state !== 'ready') return null;
  try {
    const health = await app.rag.client.health();
    return typeof health?.key === 'boolean' ? health.key : null;
  } catch {
    return null;
  }
}

const SETTINGS_KEYS = new Set(['enabled', 'consented', 'excluded_planets']);

export function registerChat(app) {
  const db = app.db;

  app.get('/api/chat/status', async () => {
    const rag = ragState(app);
    return { rag, key: await keyPresence(app, rag.state) };
  });

  async function settingsJson() {
    const s = readSettings(db);
    const rag = ragState(app);
    return {
      enabled: s.enabled,
      consented: s.consented,
      excluded_planets: s.excluded_planets,
      // 동의 전에는 파이썬의 /health 도 부르지 않는다.
      key: s.consented ? await keyPresence(app, rag.state) : null,
      rag,
      index: app.ragSync ? app.ragSync.status() : indexCounts(db),
      usage: readUsage(db),
    };
  }

  app.get('/api/chat/settings', settingsJson);

  // { enabled?, consented?, excluded_planets? }. 켜기는 동의가 같은 요청이나 이전에 있어야 한다.
  app.put('/api/chat/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !SETTINGS_KEYS.has(k))) {
      return reply.code(400).send({ error: 'invalid_settings' });
    }
    for (const k of ['enabled', 'consented']) {
      if (body[k] !== undefined && typeof body[k] !== 'boolean') return reply.code(400).send({ error: 'invalid_settings' });
    }
    let excluded;
    if (body.excluded_planets !== undefined) {
      if (!Array.isArray(body.excluded_planets) || body.excluded_planets.some((x) => typeof x !== 'string')) {
        return reply.code(400).send({ error: 'invalid_settings' });
      }
      excluded = [...new Set(body.excluded_planets)];
      const exists = db.prepare('SELECT 1 FROM planets WHERE id = ?');
      if (excluded.some((id) => exists.get(id) === undefined)) return reply.code(400).send({ error: 'unknown_planet' });
    }

    const prev = readSettings(db);
    const next = { ...prev };
    if (body.consented !== undefined) next.consented = body.consented;
    if (body.enabled !== undefined) next.enabled = body.enabled;
    else if (body.consented === false) next.enabled = false; // 동의를 거두면 끈다
    if (excluded) next.excluded_planets = excluded;
    if (next.enabled && !next.consented) return reply.code(400).send({ error: 'consent_required' });

    writeSettings(db, next);
    const sync = app.ragSync;
    if (sync) {
      sync.settingsChanged();
      const before = new Set(prev.excluded_planets);
      const added = next.excluded_planets.filter((id) => !before.has(id));
      // 새로 뺀 행성의 조각은 바로 지운다(켜져 있고 파이썬이 ready 일 때. 아니면 켤 때).
      if (added.length) await sync.excludePlanets(added);
      // 켜져 있으면 늘 다시 맞춘다(켤 때 · 행성을 다시 넣을 때 · key_missing 뒤 다시 해 볼 때).
      if (next.enabled) void sync.reconcile();
    }
    return settingsJson();
  });

  // { scope: 'failed' | 'all' }. all 은 파이썬 색인을 비우고 처음부터 다시 읽는다.
  app.post('/api/chat/reindex', async (req, reply) => {
    const scope = req.body && typeof req.body === 'object' ? req.body.scope : undefined;
    if (scope !== 'failed' && scope !== 'all') return reply.code(400).send({ error: 'invalid_scope' });
    if (!readSettings(db).enabled) return reply.code(409).send({ error: 'chat_off' });
    const sync = app.ragSync;
    if (!sync || ragState(app).state !== 'ready') return reply.code(503).send({ error: 'rag_unavailable' });
    try {
      if (scope === 'all') await sync.reindexAll();
      else await sync.retryFailed();
    } catch {
      return reply.code(503).send({ error: 'rag_unavailable' });
    }
    return { index: sync.status() };
  });
}
