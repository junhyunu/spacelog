// 챗봇 라우트. Task 1: 상태. Task 3: 설정 · 다시 읽기. Task 5: 대화 · 메시지 · 답 작업(answers.js) · 흘려 보내기(SSE).
import crypto from 'node:crypto';
import { createAnswers, PERSIST_MS } from './answers.js';
import { indexCounts, readSettings, readUsage, writeSettings } from './sync.js';

export const HEARTBEAT_MS = 15_000;
export const HISTORY_MAX = 6;
export const QUESTION_MAX = 2_000;
export const TITLE_MAX = 30;
const PREVIEW_MAX = 80;
const CONTEXT_KEYS = ['planet_id', 'planet_name', 'star_id'];
const CONTEXT_VALUE_MAX = 200;
const TZ_MAX = 14 * 60;

const chars = (s) => [...s];

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// 브라우저가 보내지 않았을 때: 서버의 현지 날짜 · 시차.
function serverLocal(ms) {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  return { today: new Date(ms + offset * 60_000).toISOString().slice(0, 10), tz_offset_min: offset };
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

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

export function registerChat(app, { now = Date.now, persistMs = PERSIST_MS, heartbeatMs = HEARTBEAT_MS, log = console } = {}) {
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

  registerConversations(app, { now, persistMs, heartbeatMs, log });
}

// --- 대화 · 메시지 · 답 작업 (Task 5) ---
function registerConversations(app, { now, persistMs, heartbeatMs, log }) {
  const db = app.db;
  const iso = () => new Date(now()).toISOString();

  // 서버를 켤 때: 지난번에 만들다 만 답은 끝나지 못한 것으로.
  db.prepare("UPDATE messages SET status = 'failed', error = 'interrupted' WHERE status = 'running'").run();

  const answers = createAnswers({ db, rag: app.rag, now, persistMs, log });
  const streams = new Set(); // 열려 있는 SSE

  const q = {
    conversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    conversations: db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    messages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid'),
    messageCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?'),
    history: db.prepare(`SELECT role, content FROM messages
      WHERE conversation_id = ? AND status != 'running' AND content != ''
      ORDER BY created_at DESC, rowid DESC LIMIT ${HISTORY_MAX}`),
    message: db.prepare('SELECT * FROM messages WHERE id = ?'),
    savedStar: db.prepare('SELECT id, planet_id, created_at FROM stars WHERE id = ?'),
    setSavedStar: db.prepare('UPDATE messages SET saved_star_id = ? WHERE id = ?'),
    insertConversation: db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, unread) VALUES (?, ?, ?, ?, 0)'),
    insertMessage: db.prepare(`INSERT INTO messages (id, conversation_id, role, content, sources, status, error, created_at)
      VALUES (@id, @conversation_id, @role, @content, '[]', @status, NULL, @created_at)`),
    retitle: db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?'),
    touch: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
    clearUnread: db.prepare('UPDATE conversations SET unread = 0 WHERE id = ?'),
    unreadCount: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE unread = 1'),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
    star: db.prepare('SELECT id, title, planet_id, created_at FROM stars WHERE id = ?'),
    planets: db.prepare('SELECT id, name FROM planets ORDER BY slot'),
    planet: db.prepare('SELECT id, name FROM planets WHERE id = ?'),
    meta: db.prepare("SELECT value FROM meta WHERE key = 'chat_usage'"),
    writeUsage: db.prepare("INSERT INTO meta (key, value) VALUES ('chat_usage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };

  // 저장한 출처 → 응답 모양. 그사이 지워진 별은 exists: false.
  function sourcesView(list) {
    return list.map((s) => {
      const star = q.star.get(s.star_id);
      return {
        star_id: s.star_id,
        attachment_id: s.attachment_id ?? null,
        file_name: s.file_name ?? null,
        exists: Boolean(star),
        title: star?.title ?? null,
        planet_id: star?.planet_id ?? null,
        created_at: star?.created_at ?? null,
      };
    });
  }

  // 메시지 응답 모양. 만드는 중이면 메모리의 최신 글을 쓴다.
  function messageJson(row) {
    const job = answers.jobFor(row.id);
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      role: row.role,
      content: job ? job.content : row.content,
      sources: sourcesView(job ? job.sources : parseJson(row.sources, [])),
      status: row.status,
      error: row.error ?? null,
      created_at: row.created_at,
      // "별로 저장"으로 띄운 별. 그 별이 지워졌으면 null(버튼이 다시 "별로 저장"이 된다)
      saved_star: row.saved_star_id ? (q.savedStar.get(row.saved_star_id) ?? null) : null,
    };
  }

  function conversationJson(row) {
    return { id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at, unread: row.unread === 1 };
  }

  function bumpUsage() {
    const month = new Date(now()).toISOString().slice(0, 7);
    const cur = readUsage(db, now);
    q.writeUsage.run(JSON.stringify({ month, requests: (cur.month === month ? cur.requests : 0) + 1 }));
  }

  const notFound = (reply) => reply.code(404).send({ error: 'not_found' });

  app.get('/api/chat/conversations', async () => {
    const job = answers.current();
    return q.conversations.all().map((c) => {
      const last = q.lastMessage.get(c.id);
      const content = last ? (answers.jobFor(last.id)?.content ?? last.content) : '';
      return {
        ...conversationJson(c),
        running: Boolean(job && !job.finished && job.conversationId === c.id),
        last: last ? { role: last.role, status: last.status, preview: chars(content.replace(/\s+/g, ' ').trim()).slice(0, PREVIEW_MAX).join('') } : null,
      };
    });
  });

  app.post('/api/chat/conversations', async (req, reply) => {
    const id = crypto.randomUUID();
    const t = iso();
    q.insertConversation.run(id, '새 대화', t, t);
    return reply.code(201).send({ conversation: conversationJson(q.conversation.get(id)), messages: [] });
  });

  app.get('/api/chat/conversations/:id', async (req, reply) => {
    const c = q.conversation.get(req.params.id);
    if (!c) return notFound(reply);
    if (c.unread) q.clearUnread.run(c.id);
    return { conversation: conversationJson({ ...c, unread: 0 }), messages: q.messages.all(c.id).map(messageJson) };
  });

  app.delete('/api/chat/conversations/:id', async (req, reply) => {
    const c = q.conversation.get(req.params.id);
    if (!c) return notFound(reply);
    answers.stopConversation(c.id); // 만들던 답이 있으면 먼저 멈춘다
    q.deleteConversation.run(c.id); // 메시지는 외래 키로 같이 지워진다
    return reply.code(204).send();
  });

  app.get('/api/chat/unread', async () => ({ count: q.unreadCount.get().n }));

  // { question, context?, today?, tz_offset_min? } → 202 { user_message, assistant_message }
  app.post('/api/chat/conversations/:id/messages', async (req, reply) => {
    const c = q.conversation.get(req.params.id);
    if (!c) return notFound(reply);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return reply.code(400).send({ error: 'invalid_question' });

    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const qLen = chars(question).length;
    if (qLen < 1 || qLen > QUESTION_MAX) return reply.code(400).send({ error: 'invalid_question' });

    let context = {};
    if (body.context !== undefined && body.context !== null) {
      if (typeof body.context !== 'object' || Array.isArray(body.context)) return reply.code(400).send({ error: 'invalid_context' });
      for (const k of CONTEXT_KEYS) {
        const v = body.context[k];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || v.length > CONTEXT_VALUE_MAX) return reply.code(400).send({ error: 'invalid_context' });
        context[k] = v;
      }
    }

    const local = serverLocal(now());
    const today = body.today ?? local.today;
    if (!validDate(today)) return reply.code(400).send({ error: 'invalid_today' });
    const tz = body.tz_offset_min ?? local.tz_offset_min;
    if (!Number.isInteger(tz) || Math.abs(tz) > TZ_MAX) return reply.code(400).send({ error: 'invalid_tz_offset' });

    const settings = readSettings(db);
    if (!settings.enabled) return reply.code(409).send({ error: 'chat_off' });
    if (answers.busy()) return reply.code(409).send({ error: 'busy' });
    if (!app.rag?.client || app.rag.status?.()?.state !== 'ready') return reply.code(503).send({ error: 'rag_unavailable' });

    // 빼 둔 행성은 이름도 파이썬(→ OpenAI)에 보내지 않는다. 맥락이 빼 둔 행성 · 그 별이면 맥락을 버린다.
    const excluded = new Set(settings.excluded_planets);
    if (context.planet_id) {
      const p = q.planet.get(context.planet_id);
      if (!p || excluded.has(p.id)) {
        delete context.planet_id;
        delete context.planet_name;
      } else {
        context.planet_name = p.name; // 이름은 DB 의 것을 쓴다
      }
    } else {
      delete context.planet_name;
    }
    if (context.star_id) {
      const s = q.star.get(context.star_id);
      if (!s || excluded.has(s.planet_id)) delete context.star_id;
    }

    // 앞 내용: 같은 대화의 마지막 6개(이번 질문 · 만들 답 제외, 빈 글 제외), 오래된 것부터.
    const history = q.history.all(c.id).reverse().map((m) => ({ role: m.role, content: m.content }));
    const planets = q.planets.all().filter((p) => !excluded.has(p.id)).map((p) => ({ id: p.id, name: p.name }));

    const t = iso();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    db.transaction(() => {
      if (q.messageCount.get(c.id).n === 0) {
        q.retitle.run(chars(question.replace(/\s+/g, ' ')).slice(0, TITLE_MAX).join('').trim(), t, c.id);
      } else {
        q.touch.run(t, c.id);
      }
      q.insertMessage.run({ id: userId, conversation_id: c.id, role: 'user', content: question, status: 'done', created_at: t });
      q.insertMessage.run({ id: assistantId, conversation_id: c.id, role: 'assistant', content: '', status: 'running', created_at: t });
      bumpUsage();
    })();

    answers.start({
      messageId: assistantId,
      conversationId: c.id,
      sourcesView,
      body: {
        question,
        history,
        context,
        today,
        tz_offset_min: tz,
        excluded_planets: settings.excluded_planets,
        planets,
      },
    });

    return reply.code(202).send({
      user_message: messageJson(q.message.get(userId)),
      assistant_message: messageJson(q.message.get(assistantId)),
    });
  });

  // 답을 "별로 저장"해 띄운 별을 그 답에 이어 둔다. → { message }
  app.put('/api/chat/messages/:id/saved-star', async (req, reply) => {
    const row = q.message.get(req.params.id);
    if (!row) return notFound(reply);
    if (row.role !== 'assistant') return reply.code(400).send({ error: 'not_an_answer' });
    const starId = req.body && typeof req.body === 'object' ? req.body.star_id : undefined;
    if (typeof starId !== 'string' || !starId) return reply.code(400).send({ error: 'invalid_star_id' });
    if (!q.savedStar.get(starId)) return reply.code(400).send({ error: 'unknown_star' });
    q.setSavedStar.run(starId, row.id);
    return { message: messageJson(q.message.get(row.id)) };
  });

  app.post('/api/chat/messages/:id/stop', async (req, reply) => {
    const row = q.message.get(req.params.id);
    if (!row) return notFound(reply);
    if (!answers.stop(row.id)) return reply.code(409).send({ error: 'not_running' });
    return { message: messageJson(q.message.get(row.id)) };
  });

  // SSE: snapshot { content, sources, status, error } 다음 token · replace · sources, 끝은 done { status, not_found } 또는 error { status, code }.
  app.get('/api/chat/messages/:id/stream', async (req, reply) => {
    const row = q.message.get(req.params.id);
    if (!row || row.role !== 'assistant') return notFound(reply);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });

    let open = true;
    let heartbeat = null;
    const write = (s) => {
      if (open && !raw.destroyed && !raw.writableEnded) raw.write(s);
    };
    const stream = {
      send: (type, data) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
      end: () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        streams.delete(stream);
        answers.current()?.subscribers.delete(stream);
        if (!raw.writableEnded) raw.end();
      },
    };
    raw.on('close', stream.end);

    // 스냅숏과 구독 등록은 같은 동기 구간에서 한다(사이에 들어온 토큰이 빠지거나 겹치지 않게).
    const job = answers.jobFor(row.id);
    if (job) {
      stream.send('snapshot', { content: job.content, sources: sourcesView(job.sources), status: 'running', error: null });
      job.subscribers.add(stream);
      streams.add(stream);
      heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
      heartbeat.unref?.();
      return reply;
    }

    const fresh = q.message.get(row.id) ?? row;
    const status = fresh.status === 'running' ? 'failed' : fresh.status; // 작업 없는 running 은 끝나지 못한 것
    const error = fresh.status === 'running' ? 'interrupted' : fresh.error ?? null;
    stream.send('snapshot', { content: fresh.content, sources: sourcesView(parseJson(fresh.sources, [])), status, error });
    if (status === 'failed') stream.send('error', { status, code: error ?? 'internal' });
    else stream.send('done', { status });
    stream.end();
    return reply;
  });

  // 서버가 꺼질 때: 하던 답은 failed / interrupted 로 적고(DB 가 닫히기 전), 열린 SSE 를 닫는다.
  app.addHook('preClose', async () => {
    await answers.close();
    for (const s of [...streams]) s.end();
  });

  app.decorate('chatAnswers', answers);
}
