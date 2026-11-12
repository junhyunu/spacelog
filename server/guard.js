// Host · Origin 검사. 다른 사이트가 이 로컬 서버를 부르거나(CSRF),
// 이름만 바꿔 접근하는 것(DNS rebinding)을 막는다.
export function registerGuard(app, { port = 4747, allowedOrigins = [] } = {}) {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    origins.add(url.origin);
    hosts.add(url.host);
  }

  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
  });
}
