import Fastify from 'fastify';
import { registerAttachments } from './attachments.js';
import { registerCharacter } from './character.js';
import { openDb } from './db.js';
import { registerFiles } from './files.js';
import { registerGuard } from './guard.js';
import { fetchLinkTitle } from './linkTitle.js';
import { defaultOpener } from './opener.js';
import { registerPlanets } from './planets.js';
import { registerChat } from './rag/chat.js';
import { createSync } from './rag/sync.js';
import { registerStars } from './stars.js';
import { sweepVault } from './vault.js';

export const DEFAULT_PORT = 4747;
export const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 500;

// 서버를 만든다. 테스트는 임시 dataDir 와 가짜 fetchTitle · opener 를 넣는다.
export function buildApp({
  dataDir,
  allowedOrigins = [],
  fetchTitle = fetchLinkTitle,
  opener = defaultOpener,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  port = DEFAULT_PORT,
  // 파이썬 RAG 서버({ status(), client }). index.js 가 createRag 로 만든 것을, 테스트는 가짜를 넣는다.
  rag = null,
  // 색인 맞추기 옵션(테스트가 가짜 시계 · 타이머를 넣는다). server/rag/sync.js 의 createSync 참고.
  ragSync: ragSyncOptions = {},
  // 답 작업 옵션(테스트가 시계 · 저장 간격 · 하트비트 간격을 넣는다). server/rag/chat.js 의 registerChat 참고.
  chat: chatOptions = {},
} = {}) {
  if (!dataDir) throw new Error('buildApp: dataDir is required');

  // 잘못된 주소는 DB 를 열기 전에 걸러 낸다.
  for (const origin of allowedOrigins) new URL(origin);

  const app = Fastify({ logger: false });
  const db = openDb(dataDir);

  app.decorate('db', db);
  app.decorate('dataDir', dataDir);
  // 받다가 끊긴 임시 파일을 지우고 주인 없는 사본을 orphans/ 로 옮긴다. 실패해도 서버는 계속 돈다.
  // 포트를 잡는 데 성공한 뒤에 부른다(index.js). 같은 폴더로 서버를 한 번 더 띄웠을 때
  // 먼저 돌던 서버가 받고 있는 임시 파일을 지우지 않기 위해서다.
  app.decorate('sweep', () => {
    try {
      // 보관함 파일 이름은 <첨부 id>.<ext> 다. 옮기기 전 이름(<별 id>.<ext>)도 주인이 있는 것으로 본다.
      const hasAttachment = db.prepare('SELECT 1 FROM attachments WHERE id = ?');
      const hasStar = db.prepare('SELECT 1 FROM stars WHERE id = ?');
      return sweepVault(dataDir, (id) => hasAttachment.get(id) !== undefined || hasStar.get(id) !== undefined);
    } catch (err) {
      console.error('sweep failed', err);
      return { tmp: 0, orphans: 0 };
    }
  });
  app.decorate('config', { fetchTitle, opener, maxFileBytes, maxFiles, port });
  app.decorate('rag', rag);
  // 파이썬이 있을 때만 색인 맞추기를 돌린다. 없으면 app.ragSync 가 없고 변경 알림은 아무 일도 하지 않는다.
  const ragSync = rag ? createSync({ db, dataDir, rag, ...ragSyncOptions }) : null;
  if (ragSync) app.decorate('ragSync', ragSync);
  app.addHook('onClose', async () => {
    if (ragSync) {
      ragSync.stop();
      // 하던 요청은 잠깐만 기다린다(색인 하나는 오래 걸릴 수 있다).
      let t;
      await Promise.race([ragSync.idle(), new Promise((r) => { t = setTimeout(r, 1_000); t.unref?.(); })]);
      clearTimeout(t);
    }
    db.close();
  });
  ragSync?.start();

  registerGuard(app, { port, allowedOrigins });

  // 라우트 밖에서 난 오류(너무 큰 본문, 깨진 JSON 등)도 { error: code } 모양으로 맞춘다.
  app.setErrorHandler((err, req, reply) => {
    // 라우트가 던진 ApiError(status, code)
    if (Number.isInteger(err.status) && typeof err.code === 'string' && err.statusCode === undefined) {
      return reply.code(err.status).send({ error: err.code });
    }
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      console.error(err);
      return reply.code(status).send({ error: 'server_error' });
    }
    const code = status === 413 ? 'too_large' : err instanceof SyntaxError || /JSON/i.test(err.code ?? '') ? 'invalid_json' : 'bad_request';
    return reply.code(status).send({ error: code });
  });

  // 시각 쿼리(from · to · before)는 여기서 한 번만 검사해 UTC ISO 로 맞춘다.
  // DB 의 created_at 과 글자 비교를 하므로 형식이 다르면 조용히 틀린 결과가 나온다.
  app.addHook('preHandler', async (req, reply) => {
    const q = req.query;
    if (!q || typeof q !== 'object') return;
    for (const key of ['from', 'to', 'before']) {
      const v = q[key];
      if (v === undefined) continue;
      if (v === '') { delete q[key]; continue; }
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      if (Number.isNaN(t)) return reply.code(400).send({ error: 'invalid_period' });
      q[key] = new Date(t).toISOString();
    }
  });

  app.get('/api/health', async () => ({ ok: true }));
  registerPlanets(app);
  registerStars(app);
  // registerPlanets 가 만든 removeStarFiles 를 바꾸므로 그 뒤에 둔다.
  registerFiles(app);
  registerAttachments(app);
  registerCharacter(app);
  registerChat(app, chatOptions);

  return app;
}
