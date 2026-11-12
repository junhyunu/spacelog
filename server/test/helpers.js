import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';

// 테스트는 항상 임시 폴더를 쓴다. 실제 ~/spaceLog 는 건드리지 않는다.
export async function makeApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spacelog-test-'));
  const app = buildApp({ dataDir, ...overrides });
  await app.ready();
  return { app, dataDir };
}

export function cleanup(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
