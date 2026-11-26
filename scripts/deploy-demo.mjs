// 체험판(서버 없는 빌드)을 Vercel 프로젝트 spacelog에 다시 올린다: npm run deploy:demo
//   1. npm run build:demo → dist-demo/
//   2. dist-demo를 Vercel 프로젝트 spacelog에 연결(빌드가 폴더를 비우므로 매번)
//   3. 연결할 때 Vercel이 만드는 .env.local(접속 토큰)과 .gitignore를 지우고, .env* · .vercel을 올리지 않게 .vercelignore를 둔다
//   4. 운영(production)으로 배포 → 공개 주소가 체험판 제목을 돌려주는지 확인
// 이 컴퓨터의 Vercel CLI가 로그인돼 있어야 한다(npx vercel whoami).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'spacelog';
const PUBLIC_URL = 'https://spacelog-eta.vercel.app';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-demo');
const win = process.platform === 'win32';

function run(cmd, args, cwd = root) {
  console.log(`\n[deploy:demo] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: win });
  if (r.status !== 0) {
    console.error(`[deploy:demo] 실패: ${cmd} ${args.join(' ')} (코드 ${r.status})`);
    process.exit(r.status || 1);
  }
}

// 0. 로그인 확인
const who = spawnSync('npx', ['--yes', 'vercel', 'whoami'], { cwd: root, encoding: 'utf8', shell: win });
if (who.status !== 0) {
  console.error('[deploy:demo] Vercel에 로그인돼 있지 않아요. 터미널에서 npx vercel login 을 먼저 해 주세요.');
  process.exit(1);
}

// 1. 빌드
run('npm', ['run', 'build:demo']);

// 2. 연결
run('npx', ['--yes', 'vercel', 'link', '--yes', '--project', PROJECT], out);

// 3. 토큰 파일 지우기 + 올리지 않을 목록
for (const f of ['.env.local', '.gitignore']) fs.rmSync(path.join(out, f), { force: true });
fs.writeFileSync(path.join(out, '.vercelignore'), '.env*\n.vercel\n');
const leftover = fs.readdirSync(out).filter((n) => n.startsWith('.env'));
if (leftover.length) {
  console.error(`[deploy:demo] 올리면 안 되는 파일이 남아 있어요: ${leftover.join(', ')} — 멈춰요.`);
  process.exit(1);
}

// 4. 배포 + 확인
run('npx', ['--yes', 'vercel', 'deploy', '--prod', '--yes'], out);
try {
  const res = await fetch(`${PUBLIC_URL}/?v=${Date.now()}`);
  const html = await res.text();
  const ok = res.ok && html.includes('spaceLog 체험판');
  console.log(ok ? `\n[deploy:demo] 완료: ${PUBLIC_URL}` : `\n[deploy:demo] 배포는 끝났지만 ${PUBLIC_URL} 확인에 실패했어요(상태 ${res.status}). 잠시 뒤 다시 열어 보세요.`);
} catch (err) {
  console.log(`\n[deploy:demo] 배포는 끝났어요. ${PUBLIC_URL} 확인 중 오류: ${err.message}`);
}
