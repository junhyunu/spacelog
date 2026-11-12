// 챗봇용 파이썬 환경을 만든다: 파이썬 3.11+ 찾기 → rag/.venv 만들기 → 패키지 설치.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(root, 'rag', '.venv');
const requirements = path.join(root, 'rag', 'requirements.txt');
const venvPython = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');

const CANDIDATES = [['python'], ['py', '-3'], ['python3']];

function versionOf([cmd, ...args]) {
  const r = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
  return m ? { major: Number(m[1]), minor: Number(m[2]), text: m[0] } : null;
}

function isSupported(v) {
  return v.major > 3 || (v.major === 3 && v.minor >= 11);
}

function run(cmd, args, label) {
  console.log(`- ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.error || r.status !== 0) {
    console.error(`실패했어요: ${label}`);
    if (r.error) console.error(`  원인: ${r.error.code ?? ''} ${r.error.message}`.trimEnd());
    else console.error(`  종료 코드: ${r.status ?? r.signal}`);
    process.exit(1);
  }
}

// 이미 있는 rag/.venv 의 파이썬이 실제로 돌고 3.11 이상인지 본다(파이썬을 지우거나 옮기면 venv 가 깨진다).
function checkExistingVenv() {
  const r = spawnSync(venvPython, ['--version'], { encoding: 'utf8' });
  const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  const v = m ? { major: Number(m[1]), minor: Number(m[2]), text: m[0] } : null;
  if (!r.error && r.status === 0 && v && isSupported(v)) {
    console.log(`- rag/.venv 가 이미 있어요 (${v.text}). 그대로 써요`);
    return;
  }
  console.error('rag/.venv 가 깨져 있거나 파이썬 버전이 맞지 않아요.');
  if (r.error) console.error(`  원인: ${r.error.code ?? ''} ${r.error.message}`.trimEnd());
  else if (v) console.error(`  rag/.venv 의 파이썬: ${v.text} (3.11 이상이 필요해요)`);
  else console.error(`  rag/.venv 의 파이썬이 실행되지 않아요 (종료 코드 ${r.status ?? r.signal})`);
  console.error('rag/.venv 폴더를 지운 뒤 npm run rag:setup 을 다시 실행해 주세요.');
  process.exit(1);
}

let found = null;
for (const candidate of CANDIDATES) {
  const v = versionOf(candidate);
  if (v && isSupported(v)) {
    found = { candidate, v };
    break;
  }
}

if (!found) {
  console.error('파이썬 3.11 이상을 찾지 못했어요.');
  console.error('https://www.python.org/downloads/ 에서 파이썬을 설치하고(설치할 때 "Add python.exe to PATH" 선택),');
  console.error('터미널을 다시 연 뒤 npm run rag:setup 을 다시 실행해 주세요.');
  process.exit(1);
}

console.log(`${found.v.text} 를 찾았어요 (${found.candidate.join(' ')}).`);

if (!fs.existsSync(venvPython)) {
  const [cmd, ...pre] = found.candidate;
  run(cmd, [...pre, '-m', 'venv', venv], 'rag/.venv 를 만드는 중이에요');
} else {
  checkExistingVenv();
}

run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], 'pip 를 최신으로 올리는 중이에요');
run(venvPython, ['-m', 'pip', 'install', '-r', requirements], '필요한 패키지를 설치하는 중이에요');

console.log('챗봇 준비가 끝났어요. 테스트는 npm run rag:test 로 돌릴 수 있어요.');
