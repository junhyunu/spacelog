import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp, DEFAULT_PORT } from './app.js';
import { createRag, DEFAULT_RAG_PORT } from './rag/process.js';

const HOST = '127.0.0.1';
const port = Number(process.env.PORT) || DEFAULT_PORT;
const ragPort = Number(process.env.SPACELOG_RAG_PORT) || DEFAULT_RAG_PORT;
const dataDir = process.env.SPACELOG_DATA || path.join(os.homedir(), 'spaceLog');
// 개발용 주소(Vite 5173)는 `npm run dev` 가 --dev 를 줄 때만 허용한다.
const dev = process.argv.includes('--dev');

// 파이썬 RAG 서버. 여기서는 만들기만 하고, 포트를 잡은 뒤에 띄운다.
const rag = createRag({ dataDir, port: ragPort });

const app = buildApp({
  dataDir,
  port,
  allowedOrigins: dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
  rag,
});

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
}

try {
  await app.listen({ host: HOST, port });
  app.sweep();
  console.log(`spaceLog  http://${HOST}:${port}  (data: ${dataDir})`);
  // 같은 폴더 · 포트로 서버를 한 번 더 띄웠을 때 파이썬을 겹쳐 띄우지 않도록 listen 이 성공한 뒤에 켠다.
  rag.start();
  if (rag.status().state === 'missing') {
    console.log('[rag] 챗봇용 파이썬 환경이 없어요. npm run rag:setup 을 실행하면 챗봇을 쓸 수 있어요.');
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}

// Node 가 끝날 때 자기가 띄운 파이썬만 끈다. 'exit' 에서는 기다릴 수 없으므로 kill 만 보낸다.
process.on('exit', () => {
  rag.stop();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await rag.stop();
    await app.close();
    process.exit(0);
  });
}
