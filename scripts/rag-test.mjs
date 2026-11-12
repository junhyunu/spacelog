// rag/.venv 의 파이썬으로 pytest 를 돌린다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvPython = process.platform === 'win32'
  ? path.join(root, 'rag', '.venv', 'Scripts', 'python.exe')
  : path.join(root, 'rag', '.venv', 'bin', 'python');

if (!fs.existsSync(venvPython)) {
  console.error('rag/.venv 가 없어요. 먼저 npm run rag:setup 을 실행해 주세요.');
  process.exit(1);
}

const r = spawnSync(venvPython, ['-m', 'pytest', 'rag/tests', '-q', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(r.status ?? 1);
