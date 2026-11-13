// 답 작업(스펙 5장 5항). 질문 하나에 답 메시지 하나를 running 으로 만들고, 파이썬에서 흘러오는 글자를
// 메모리에 이어 붙이며 0.5초마다 DB 에 저장하고, 구독자(SSE)에게 바로 넘긴다. 한 번에 하나만 돈다.
// 질문 · 답의 글은 로그에 남기지 않는다(오류 코드만).
import { RagError } from './client.js';
import { readSettings } from './sync.js';

export const PERSIST_MS = 500;
export const MAX_SOURCES = 50;
const PY_ERRORS = new Set(['key_missing', 'openai_error', 'too_broad', 'internal']);
const MAX_ID = 200;

// 파이썬 요청이 실패한 이유 → messages.error
export function answerErrorCode(err) {
  if (err instanceof RagError || err?.name === 'RagError') {
    if (err.code === 'unavailable') return 'rag_unavailable';
    if (err.code === 'rag_error' && err.status === 400) return 'bad_request';
    if (err.detail === 'key_missing') return 'key_missing';
    return 'internal';
  }
  // 흘려 받는 중에 연결이 끊겼다(파이썬이 죽었다).
  return 'rag_unavailable';
}

const optStr = (v) => (typeof v === 'string' && v.length <= MAX_ID ? v : null);

export function createAnswers({ db, rag, now = Date.now, persistMs = PERSIST_MS, log = console }) {
  let job = null; // { messageId, conversationId, abort, content, sources, subscribers, finished, dirty, timer, done }

  const iso = () => new Date(now()).toISOString();
  const q = {
    save: db.prepare('UPDATE messages SET content = ?, sources = ? WHERE id = ?'),
    finish: db.prepare('UPDATE messages SET content = ?, sources = ?, status = ?, error = ? WHERE id = ?'),
    touch: db.prepare('UPDATE conversations SET updated_at = ?, unread = CASE WHEN ? = 1 THEN 1 ELSE unread END WHERE id = ?'),
    planetOf: db.prepare('SELECT planet_id FROM stars WHERE id = ?'),
  };

  function persist(j) {
    if (j.finished || !j.dirty || !db.open) return;
    try {
      q.save.run(j.content, JSON.stringify(j.sources), j.messageId);
      j.dirty = false;
    } catch (err) {
      log.error?.(`[chat] save failed: ${err?.code ?? err?.name}`);
    }
  }

  function broadcast(j, type, data) {
    for (const s of [...j.subscribers]) {
      try {
        s.send(type, data);
      } catch {
        j.subscribers.delete(s);
      }
    }
  }

  // 출처: 지금 있는 별, 빼 둔 행성이 아닌 별만 남긴다(파이썬이 이미 걸렀어도 한 번 더).
  function cleanSources(stars) {
    if (!Array.isArray(stars)) return [];
    const excluded = new Set(readSettings(db).excluded_planets);
    const out = [];
    for (const s of stars) {
      if (!s || typeof s !== 'object') continue;
      const starId = optStr(s.star_id);
      if (!starId) continue;
      const row = q.planetOf.get(starId);
      if (!row || excluded.has(row.planet_id)) continue;
      out.push({ star_id: starId, attachment_id: optStr(s.attachment_id), file_name: typeof s.file_name === 'string' ? s.file_name : null });
      if (out.length >= MAX_SOURCES) break;
    }
    return out;
  }

  // status: 'done' | 'stopped' | 'failed'. 구독자에게 마지막 이벤트를 보내고 연결을 닫는다.
  function finish(j, status, { error = null, notFound = false } = {}) {
    if (j.finished) return;
    j.finished = true;
    clearInterval(j.timer);
    // 사용자가 직접 멈춘 답은 읽지 않음으로 두지 않는다.
    const watched = j.subscribers.size > 0 || status === 'stopped';
    if (db.open) {
      try {
        db.transaction(() => {
          q.finish.run(j.content, JSON.stringify(j.sources), status, error, j.messageId);
          // 아무도 보고 있지 않을 때 끝났으면 읽지 않음.
          q.touch.run(iso(), watched ? 0 : 1, j.conversationId);
        })();
      } catch (err) {
        log.error?.(`[chat] finish failed: ${err?.code ?? err?.name}`);
      }
    }
    if (job === j) job = null;
    const subs = [...j.subscribers];
    j.subscribers.clear();
    for (const s of subs) {
      try {
        if (status === 'failed') s.send('error', { status, code: error });
        else s.send('done', { status, not_found: notFound === true });
      } catch {
        // 이미 끊긴 연결
      }
      s.end();
    }
    // 흘려 받기를 끊는다(파이썬은 연결이 닫히면 만들기를 멈춘다). 정상 끝이면 아무 일도 없다.
    j.abort.abort();
  }

  function handle(j, ev, sourcesView) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'token':
        if (typeof ev.text !== 'string' || !ev.text) return;
        j.content += ev.text;
        j.dirty = true;
        broadcast(j, 'token', { text: ev.text });
        return;
      case 'replace':
        if (typeof ev.text !== 'string') return;
        j.content = ev.text;
        j.dirty = true;
        broadcast(j, 'replace', { text: ev.text });
        return;
      case 'sources':
        j.sources = cleanSources(ev.stars);
        j.dirty = true;
        broadcast(j, 'sources', { sources: sourcesView(j.sources) });
        return;
      case 'done':
        finish(j, 'done', { notFound: ev.not_found === true });
        return;
      case 'error':
        finish(j, 'failed', { error: PY_ERRORS.has(ev.code) ? ev.code : 'internal' });
        return;
      default:
        // plan · progress · 모르는 종류는 무시한다.
    }
  }

  async function run(j, body, sourcesView) {
    try {
      for await (const ev of rag.client.answer(body, { signal: j.abort.signal })) {
        if (j.finished) break;
        try {
          handle(j, ev, sourcesView);
        } catch (err) {
          log.error?.(`[chat] answer event failed: ${err?.code ?? err?.name}`);
          finish(j, 'failed', { error: 'internal' });
        }
        if (j.finished) break;
      }
      // done · error 없이 끝났다.
      if (!j.finished) finish(j, 'failed', { error: 'internal' });
    } catch (err) {
      if (j.finished) return;
      const code = answerErrorCode(err);
      log.error?.(`[chat] answer failed: ${code}`);
      finish(j, 'failed', { error: code });
    }
  }

  return {
    busy: () => job !== null,
    current: () => job,
    // 지금 이 메시지의 작업(끝났으면 null).
    jobFor: (messageId) => (job && job.messageId === messageId && !job.finished ? job : null),
    // sourcesView: 저장 모양 → 응답 모양(별 정보를 붙인다).
    start({ messageId, conversationId, body, sourcesView = (s) => s }) {
      if (job) throw new Error('busy');
      const j = {
        messageId,
        conversationId,
        abort: new AbortController(),
        content: '',
        sources: [],
        subscribers: new Set(),
        finished: false,
        dirty: false,
        timer: null,
        done: null,
      };
      job = j;
      j.timer = setInterval(() => persist(j), persistMs);
      j.timer.unref?.();
      j.done = run(j, body, sourcesView);
      return j;
    },
    // 멈추기. → false 면 이 메시지의 작업이 돌고 있지 않다.
    stop(messageId) {
      const j = job;
      if (!j || j.messageId !== messageId || j.finished) return false;
      finish(j, 'stopped');
      return true;
    },
    // 대화를 지우기 전에: 그 대화의 작업을 멈춘다.
    stopConversation(conversationId) {
      const j = job;
      if (j && j.conversationId === conversationId && !j.finished) finish(j, 'stopped');
    },
    // 서버가 꺼진다: 하던 작업은 failed / interrupted.
    async close() {
      const j = job;
      if (!j) return;
      finish(j, 'failed', { error: 'interrupted' });
      let t;
      await Promise.race([j.done, new Promise((r) => { t = setTimeout(r, 500); t.unref?.(); })]);
      clearTimeout(t);
    },
  };
}
