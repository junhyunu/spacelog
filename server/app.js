import Fastify from 'fastify';
import { openDb } from './db.js';
import { registerGuard } from './guard.js';
import { fetchLinkTitle } from './linkTitle.js';
import { registerPlanets } from './planets.js';
import { registerStars } from './stars.js';

export const DEFAULT_PORT = 4747;
export const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;

// 서버를 만든다. 테스트는 임시 dataDir 와 가짜 fetchTitle · opener 를 넣는다.
// opener 의 기본값은 그것을 쓰는 태스크(4)에서 채운다.
export function buildApp({
  dataDir,
  allowedOrigins = [],
  fetchTitle = fetchLinkTitle,
  opener,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  port = DEFAULT_PORT,
} = {}) {
  if (!dataDir) throw new Error('buildApp: dataDir is required');

  // 잘못된 주소는 DB 를 열기 전에 걸러 낸다.
  for (const origin of allowedOrigins) new URL(origin);

  const app = Fastify({ logger: false });
  const db = openDb(dataDir);

  app.decorate('db', db);
  app.decorate('dataDir', dataDir);
  app.decorate('config', { fetchTitle, opener, maxFileBytes, port });
  app.addHook('onClose', async () => {
    db.close();
  });

  registerGuard(app, { port, allowedOrigins });

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

  return app;
}
