import crypto from 'node:crypto';
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

// multipart 본문을 직접 만든다. parts: ['field', name, value] | ['file', name, filename, mime, content]
// end: false 면 닫는 경계를 빼서 중간에 끊긴 본문을 만든다.
export function multipartBody(parts, { end = true } = {}) {
  const boundary = `----spacelog${crypto.randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    if (part[0] === 'field') {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part[1]}"\r\n\r\n${part[2]}\r\n`));
    } else {
      const [, name, filename, mime, content] = part;
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ));
      chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
      chunks.push(Buffer.from('\r\n'));
    }
  }
  if (end) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function cleanup(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
