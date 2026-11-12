import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp, DEFAULT_PORT } from './app.js';

const HOST = '127.0.0.1';
const port = Number(process.env.PORT) || DEFAULT_PORT;
const dataDir = process.env.SPACELOG_DATA || path.join(os.homedir(), 'spaceLog');
// 개발용 주소(Vite 5173)는 `npm run dev` 가 --dev 를 줄 때만 허용한다.
const dev = process.argv.includes('--dev');

const app = buildApp({
  dataDir,
  port,
  allowedOrigins: dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
}

try {
  await app.listen({ host: HOST, port });
  console.log(`spaceLog  http://${HOST}:${port}  (data: ${dataDir})`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
