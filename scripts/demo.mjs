// spaceLog 데모 실행기: 가짜 데이터가 든 별도 폴더로 진짜 서버를 띄워 화면 · 기능을 점검한다.
//   npm run demo             웹을 빌드하고 http://127.0.0.1:4848 에 띄운다(처음이면 데이터를 심는다)
//   npm run demo -- --reset  데모 폴더(~/spaceLog-demo)만 지우고 다시 심는다
// 실제 데이터 폴더(~/spaceLog)와 개발 포트(4747 · 4748 · 5173)는 건드리지 않는다.
// 챗봇은 저장소 루트 .env 의 같은 OpenAI 키를 쓴다(이 스크립트는 키를 읽지 않는다).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { CONVERSATIONS, MIME, PLANETS, STARS, makePng, plannedDate } from '../web/demo/seed.js';

// 심을 데이터(행성 · 별 · 대화 기록)는 web/demo/seed.js 에 있다. 체험판(서버 없는 빌드)과 같이 쓴다.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 4848;
const RAG_PORT = 4849;
const BASE = `http://${HOST}:${PORT}`;
const HOME = os.homedir();
const DEMO_DIR = path.join(HOME, 'spaceLog-demo');
const MARKER = path.join(DEMO_DIR, '.demo-seeded');
const reset = process.argv.includes('--reset');

const log = (...a) => console.log('[demo]', ...a);
const fail = (msg) => {
  console.error(`[demo] ${msg}`);
  process.exit(1);
};

// 데모 폴더만 지운다. 이름이 spaceLog-demo 가 아니거나 실제 데이터 폴더와 같으면 거절한다.
function removeDemoDir() {
  const target = path.resolve(DEMO_DIR);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const real = [path.join(HOME, 'spaceLog'), process.env.SPACELOG_DATA].filter(Boolean).map((p) => path.resolve(p));
  if (path.basename(target) !== 'spaceLog-demo' || real.some((r) => same(r, target)) || same(target, path.resolve(HOME))) {
    fail(`지우지 않아요: ${target} 는 데모 폴더가 아니거나 실제 데이터 폴더예요.`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}

function run(args, label) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 실패 (code ${code})\n${out}`))));
  });
}

// ── 서버 ──
// 진짜 server/index.js 를 자식 프로세스로 띄운다. Windows 에서는 신호를 보낼 수 없으므로 IPC 로 'stop' 을 보내면
// 자식이 스스로 SIGINT 처리(파이썬 끄기 · DB 닫기)를 돈다. 부모가 죽어 IPC 가 끊겨도 같은 처리를 한다.
let server = null;

function startServer() {
  const entry = pathToFileURL(path.join(ROOT, 'server', 'index.js')).href;
  const boot = `
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; process.emit('SIGINT', 'SIGINT'); } };
    process.on('SIGINT', () => { stopping = true; });
    process.on('SIGTERM', () => { stopping = true; });
    process.on('message', (m) => { if (m === 'stop') stop(); });
    process.on('disconnect', stop);
    await import(${JSON.stringify(entry)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SPACELOG_RAG_PORT: String(RAG_PORT), SPACELOG_DATA: DEMO_DIR },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    const onLine = (line, isErr) => {
      if (/spaceLog\s+http:\/\//.test(line)) resolve();
      if (line.trim()) (isErr ? console.error : console.log)(`  │ ${line}`);
    };
    for (const [stream, isErr] of [[child.stdout, false], [child.stderr, true]]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        rest += chunk;
        let nl;
        while ((nl = rest.indexOf('\n')) >= 0) {
          onLine(rest.slice(0, nl).replace(/\r$/, ''), isErr);
          rest = rest.slice(nl + 1);
        }
        buf = rest;
      });
    }
    exited.then((code) => reject(new Error(`서버가 시작하지 못하고 끝났어요 (code ${code}) ${buf}`)));
    setTimeout(() => reject(new Error('서버가 30초 안에 뜨지 않았어요')), 30_000).unref();
  });
  server = {
    child,
    exited,
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.send('stop'); } catch { /* 이미 끊김 */ }
      const t = setTimeout(() => child.kill(), 15_000); // 그래도 안 끝나면 자기가 띄운 자식만 끈다
      await exited;
      clearTimeout(t);
    },
  };
  return server;
}

async function api(method, p, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, init); // Host 는 127.0.0.1:4848 로 나간다
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// 파일 · 날짜 만들기는 web/demo/seed.js(makePng · plannedDate). PNG 는 예전처럼 zlib 로 압축한다.
const deflate = (raw) => zlib.deflateSync(raw);

// ── 심기 ──
async function seedViaApi() {
  const planetId = { unsorted: 'unsorted' };
  for (const p of PLANETS) {
    const { key, ...body } = p;
    planetId[key] = (await api('POST', '/api/planets', body)).id;
  }
  const created = []; // { spec, star }
  for (const [i, s] of STARS.entries()) {
    const fields = { planet_id: planetId[s.p ?? 'unsorted'] };
    if (s.title) fields.title = s.title;
    if (s.body) fields.body = s.body;
    let res;
    if (s.files?.length) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (s.links?.length) form.append('links', JSON.stringify(s.links));
      for (const f of s.files) {
        const ext = f.name.split('.').pop().toLowerCase();
        const data = f.png ? makePng(f.png, deflate) : Buffer.from(f.text, 'utf8');
        form.append('files', new Blob([data], { type: MIME[ext] ?? 'application/octet-stream' }), f.name);
      }
      res = await api('POST', '/api/stars', form);
    } else {
      if (s.links?.length) fields.links = s.links;
      res = await api('POST', '/api/stars', fields);
    }
    if (res.skipped?.length) throw new Error(`별 ${i} 첨부를 건너뜀: ${JSON.stringify(res.skipped)}`);
    if (s.fav) await api('PATCH', `/api/stars/${res.star.id}`, { fav: true });
    created.push({ spec: s, star: res.star, index: i });
    process.stdout.write(`\r[demo] 별 ${i + 1}/${STARS.length}`);
  }
  process.stdout.write('\n');
  return { planetId, created };
}

function writeDb({ planetId, created }) {
  const db = new Database(path.join(DEMO_DIR, 'spacelog.db'));
  try {
    db.pragma('foreign_keys = ON');
    const setStar = db.prepare('UPDATE stars SET created_at = ? WHERE id = ?');
    const setAtt = db.prepare('UPDATE attachments SET created_at = ? WHERE star_id = ?');
    const setPlanet = db.prepare('UPDATE planets SET created_at = ? WHERE id = ?');
    const byKey = new Map();
    let earliest = Date.now();
    db.transaction(() => {
      for (const c of created) {
        const at = plannedDate(c.spec.d, c.spec.t, c.index);
        earliest = Math.min(earliest, at.getTime());
        setStar.run(at.toISOString(), c.star.id);
        setAtt.run(at.toISOString(), c.star.id);
        if (c.spec.key) byKey.set(c.spec.key, c.star);
      }
      const planetAt = new Date(earliest - 86_400_000).toISOString();
      for (const id of Object.values(planetId)) setPlanet.run(planetAt, id);
    })();

    const insConv = db.prepare('INSERT INTO conversations (id, title, created_at, updated_at, unread) VALUES (?, ?, ?, ?, ?)');
    const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, role, content, sources, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, 'done', NULL, ?)`);
    const sourceOf = (ref) => {
      const key = typeof ref === 'string' ? ref : ref.key;
      const star = byKey.get(key);
      if (!star) throw new Error(`대화 출처 별이 없어요: ${key}`);
      const att = typeof ref === 'object' && ref.file ? star.attachments.find((a) => a.kind !== 'link') : null;
      return { star_id: star.id, attachment_id: att?.id ?? null, file_name: att?.file_name ?? null };
    };
    db.transaction(() => {
      for (const conv of CONVERSATIONS) {
        const id = crypto.randomUUID();
        let t = Date.now() - conv.ago * 3_600_000;
        const start = new Date(t).toISOString();
        const title = [...conv.messages[0].q.replace(/\s+/g, ' ')].slice(0, 30).join('').trim();
        const rows = [];
        for (const m of conv.messages) {
          rows.push([crypto.randomUUID(), id, 'user', m.q, '[]', new Date(t).toISOString()]);
          t += 9_000;
          rows.push([crypto.randomUUID(), id, 'assistant', m.a, JSON.stringify(m.sources.map(sourceOf)), new Date(t).toISOString()]);
          t += 4 * 60_000;
        }
        insConv.run(id, title, start, rows.at(-1)[5], conv.unread ? 1 : 0);
        for (const r of rows) insMsg.run(...r);
      }
    })();
  } finally {
    db.close();
  }
}

async function summary() {
  const [planets, stars, convs, settings] = await Promise.all([
    api('GET', '/api/planets'), api('GET', '/api/stars'), api('GET', '/api/chat/conversations'), api('GET', '/api/chat/settings'),
  ]);
  const fav = stars.filter((s) => s.fav).length;
  log(`행성 ${planets.length}개(미분류 포함) · 별 ${stars.length}개(☆ ${fav}) · 대화 ${convs.length}개 · 챗봇 ${settings.enabled ? '켜짐' : '꺼짐'}`);
}

async function main() {
  for (const p of [PORT, RAG_PORT]) {
    if (!(await portFree(p))) fail(`포트 ${p} 를 이미 쓰고 있어요. 데모가 이미 떠 있는지 확인하고, 그 프로그램을 닫은 뒤 다시 실행해 주세요.`);
  }
  if (reset || (fs.existsSync(DEMO_DIR) && !fs.existsSync(MARKER))) {
    if (fs.existsSync(DEMO_DIR)) log(reset ? `데모 폴더를 지워요: ${DEMO_DIR}` : '심다 만 데모 폴더라 지우고 다시 심어요');
    removeDemoDir();
  }

  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) fail('vite 가 없어요. 먼저 npm install 을 실행해 주세요.');
  log('웹을 빌드해요 (dist/)…');
  await run([vite, 'build'], 'vite build');

  let stopping = false;
  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    log('끄는 중…');
    await server?.stop();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (!fs.existsSync(MARKER)) {
    log(`데모 데이터를 심어요: ${DEMO_DIR}`);
    startServer();
    try {
      await server.ready;
      const seeded = await seedViaApi();
      await server.stop();
      writeDb(seeded); // 날짜 되돌리기 · 대화 기록은 서버를 끈 채로
      startServer();
      await server.ready;
      // 날짜를 맞춘 뒤에 챗봇을 켜서 색인을 한 번만 만든다
      await api('PUT', '/api/chat/settings', { consented: true, enabled: true });
      fs.writeFileSync(MARKER, `${new Date().toISOString()}\n`);
    } catch (err) {
      console.error(err);
      await server?.stop();
      fail('심기에 실패했어요. npm run demo -- --reset 으로 다시 해 주세요.');
    }
  } else {
    startServer();
    try {
      await server.ready;
    } catch (err) {
      fail(err.message);
    }
  }

  server.exited.then((code) => {
    if (!stopping) fail(`서버가 끝났어요 (code ${code})`);
  });
  await summary().catch(() => {});
  console.log(`
  spaceLog 데모: ${BASE}
  로그인: 첫 화면의 '로그인'을 누르고 아무 이메일(예: demo@example.com) · 비밀번호 · 이름으로 들어가요.
          (주소가 달라 4747에서 한 로그인과 따로예요)
  데이터: ${DEMO_DIR}  (실제 ~/spaceLog 와 별개)
  챗봇: 저장소 .env 의 같은 OpenAI 키를 써요. 색인은 켠 뒤 잠시 걸려요.
  끄기: Ctrl+C   처음 상태로: npm run demo -- --reset
`);
}

main().catch(async (err) => {
  console.error(err);
  await server?.stop();
  process.exit(1);
});
