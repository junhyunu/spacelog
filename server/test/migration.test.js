import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import { buildApp } from '../app.js';
import { SCHEMA_VERSION, openDb } from '../db.js';

const HOST = { host: '127.0.0.1:4747' };

// 15600bb 까지의 스키마(user_version 0). 별 하나가 파일 · 링크 정보를 직접 가졌다.
const OLD_SCHEMA = `
CREATE TABLE planets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color_index INTEGER NOT NULL, deco TEXT NOT NULL, ring INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL);
CREATE TABLE stars (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('text','image','link','file')),
  title TEXT NOT NULL, body TEXT, url TEXT, link_title TEXT,
  file_name TEXT, file_ext TEXT, file_size INTEGER, file_hash TEXT,
  vault_path TEXT, thumb_path TEXT, memo TEXT NOT NULL DEFAULT '',
  planet_id TEXT NOT NULL REFERENCES planets(id), created_at TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '');
CREATE INDEX stars_planet_created ON stars(planet_id, created_at);
CREATE UNIQUE INDEX stars_hash ON stars(file_hash) WHERE file_hash IS NOT NULL;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const IDS = {
  planet: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  text: '11111111-1111-4111-8111-111111111111',
  link: '22222222-2222-4222-8222-222222222222',
  image: '33333333-3333-4333-8333-333333333333',
  file: '44444444-4444-4444-8444-444444444444',
};

const dirs = [];
const apps = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spacelog-migrate-'));
  dirs.push(dir);
  return dir;
}

// 옛 서버가 남긴 모양 그대로 DB 와 보관함 파일을 만든다.
async function makeOldData(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
  fs.writeFileSync(path.join(dataDir, 'vault', `${IDS.image}.png`), png);
  await sharp(png).webp().toFile(path.join(dataDir, 'thumbs', `${IDS.image}.webp`));
  fs.writeFileSync(path.join(dataDir, 'vault', `${IDS.file}.pdf`), '%PDF-1.4 old');

  const db = new Database(path.join(dataDir, 'spacelog.db'));
  db.pragma('journal_mode = WAL');
  db.exec(OLD_SCHEMA);
  db.prepare("INSERT INTO planets VALUES (?, '행성', '', 1, 'town', 0, 0, '2026-11-01T00:00:00.000Z')").run(IDS.planet);
  const ins = db.prepare(`INSERT INTO stars (id, type, title, body, url, link_title, file_name, file_ext, file_size, file_hash,
    vault_path, thumb_path, memo, planet_id, created_at, search_text)
    VALUES (@id, @type, @title, @body, @url, @link_title, @file_name, @file_ext, @file_size, @file_hash,
    @vault_path, @thumb_path, @memo, @planet_id, @created_at, 'old')`);
  const base = {
    body: null, url: null, link_title: null, file_name: null, file_ext: null, file_size: null, file_hash: null,
    vault_path: null, thumb_path: null, memo: '', planet_id: IDS.planet,
  };
  ins.run({ ...base, id: IDS.text, type: 'text', title: '글', body: '본문', created_at: '2026-11-02T00:00:00.000Z' });
  ins.run({
    ...base, id: IDS.link, type: 'link', title: '링크', url: 'https://example.com/a', link_title: '예시',
    memo: '링크 메모', created_at: '2026-11-03T00:00:00.000Z',
  });
  ins.run({
    ...base, id: IDS.image, type: 'image', title: '사진', file_name: '사진.png', file_ext: 'PNG', file_size: png.length,
    file_hash: 'hash-image', vault_path: `vault/${IDS.image}.png`, thumb_path: `thumbs/${IDS.image}.webp`,
    created_at: '2026-11-04T00:00:00.000Z',
  });
  ins.run({
    ...base, id: IDS.file, type: 'file', title: '문서', file_name: '문서.pdf', file_ext: 'PDF', file_size: 12,
    file_hash: 'hash-file', vault_path: `vault/${IDS.file}.pdf`, created_at: '2026-11-05T00:00:00.000Z',
  });
  // 체크포인트 전의 쓰기가 WAL 에만 있도록 연결을 닫지 않고 둔다 → 백업이 WAL 을 합쳐야 한다.
  return db;
}

async function start(dataDir) {
  const app = buildApp({ dataDir, opener: { open() {}, reveal() {} }, fetchTitle: async () => null });
  apps.push(app);
  await app.ready();
  return app;
}

test('a fresh data folder gets the new schema at the current version and no backup', () => {
  const dataDir = tempDir();
  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(SCHEMA_VERSION).toBe(6);
  const cols = db.prepare("SELECT name FROM pragma_table_info('attachments')").all().map((r) => r.name);
  expect(cols).toEqual([
    'id', 'star_id', 'kind', 'position', 'file_name', 'file_ext', 'file_size', 'file_hash',
    'vault_path', 'thumb_path', 'url', 'link_title', 'created_at',
  ]);
  const indexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attachments' AND sql IS NOT NULL")
    .all();
  expect(indexes.map((i) => i.name).sort()).toEqual(['attachments_hash', 'attachments_star_position']);
  expect(indexes.find((i) => i.name === 'attachments_hash').sql).toMatch(/UNIQUE[\s\S]*WHERE file_hash IS NOT NULL/);
  db.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual([]);
});

test('old database: backup first, one attachment per file/image/link star, files untouched, served by the new routes', async () => {
  const dataDir = tempDir();
  const old = await makeOldData(dataDir);
  old.close(); // 닫으면 WAL 이 합쳐질 수 있으므로, WAL 을 남긴 경우는 아래 별도 테스트에서 본다.
  const vaultBefore = fs.readdirSync(path.join(dataDir, 'vault')).sort();

  const app = await start(dataDir);
  const db = app.db;
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

  // 백업은 옮기기 전의 모습(첨부 표 없음, 별이 파일 정보를 가짐)이다.
  const bakPath = path.join(dataDir, 'spacelog.db.bak-1');
  expect(fs.existsSync(bakPath)).toBe(true);
  const bak = new Database(bakPath, { readonly: true });
  expect(bak.pragma('user_version', { simple: true })).toBe(0);
  expect(bak.prepare("SELECT name FROM sqlite_master WHERE name = 'attachments'").get()).toBeUndefined();
  expect(bak.prepare('SELECT vault_path FROM stars WHERE id = ?').get(IDS.file).vault_path).toBe(`vault/${IDS.file}.pdf`);
  bak.close();

  const atts = db.prepare('SELECT * FROM attachments ORDER BY created_at').all();
  expect(atts.map((a) => [a.id, a.star_id, a.kind, a.position])).toEqual([
    [IDS.link, IDS.link, 'link', 0],
    [IDS.image, IDS.image, 'image', 0],
    [IDS.file, IDS.file, 'file', 0],
  ]);
  const [link, image, file] = atts;
  expect(link).toMatchObject({ url: 'https://example.com/a', link_title: '예시', vault_path: null, file_hash: null });
  expect(image).toMatchObject({
    file_name: '사진.png', file_ext: 'PNG', file_hash: 'hash-image',
    vault_path: `vault/${IDS.image}.png`, thumb_path: `thumbs/${IDS.image}.webp`, created_at: '2026-11-04T00:00:00.000Z',
  });
  expect(file).toMatchObject({ file_name: '문서.pdf', file_ext: 'PDF', file_size: 12, file_hash: 'hash-file', vault_path: `vault/${IDS.file}.pdf` });

  // 별 행의 옛 칸은 비워지고, 표는 다시 만들지 않는다(칸은 남는다).
  for (const row of db.prepare('SELECT * FROM stars').all()) {
    for (const col of ['url', 'link_title', 'file_name', 'file_ext', 'file_size', 'file_hash', 'vault_path', 'thumb_path']) {
      expect(row[col], `${row.id} ${col}`).toBeNull();
    }
  }
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'stars_hash'").get()).toBeUndefined();
  const search = Object.fromEntries(db.prepare('SELECT id, search_text FROM stars').all().map((r) => [r.id, r.search_text]));
  expect(search[IDS.text]).toBe('글\n본문');
  expect(search[IDS.link]).toBe('링크\n링크 메모\n예시\nhttps://example.com/a');
  expect(search[IDS.image]).toBe('사진\n사진.png');
  expect(search[IDS.file]).toBe('문서\n문서.pdf');

  // 파일은 옮기지 않는다.
  expect(fs.readdirSync(path.join(dataDir, 'vault')).sort()).toEqual(vaultBefore);

  const list = (await app.inject({ url: '/api/stars', headers: HOST })).json();
  expect(list.map((s) => [s.id, s.type, s.attachment_count])).toEqual([
    [IDS.file, 'file', 1], [IDS.image, 'image', 1], [IDS.link, 'link', 1], [IDS.text, 'text', 0],
  ]);
  const img = list.find((s) => s.id === IDS.image);
  expect(img.has_thumb).toBe(true);
  expect(img.thumb_attachment_id).toBe(IDS.image);

  const pdf = await app.inject({ url: `/api/attachments/${IDS.file}/file`, headers: HOST });
  expect(pdf.statusCode).toBe(200);
  expect(pdf.body).toBe('%PDF-1.4 old');
  const thumb = await app.inject({ url: `/api/attachments/${IDS.image}/thumb`, headers: HOST });
  expect(thumb.statusCode).toBe(200);
  expect(thumb.headers['content-type']).toBe('image/webp');

  // 옛 파일과 같은 내용은 이제 첨부 기준으로 중복이다.
  expect(db.prepare("SELECT 1 FROM attachments WHERE file_hash = 'hash-file'").get()).toBeDefined();
});

test('backup includes writes still sitting in the WAL', async () => {
  const dataDir = tempDir();
  const old = await makeOldData(dataDir);
  // 옛 연결을 열어 둔 채(=WAL 이 합쳐지지 않은 채) 새 서버가 연다.
  expect(fs.existsSync(path.join(dataDir, 'spacelog.db-wal'))).toBe(true);
  const app = await start(dataDir);
  old.close();
  const bak = new Database(path.join(dataDir, 'spacelog.db.bak-1'), { readonly: true });
  expect(bak.prepare('SELECT COUNT(*) AS c FROM stars').get().c).toBe(4);
  bak.close();
  expect(app.db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c).toBe(3);
});

test('re-opening a migrated database does not migrate or back up again', async () => {
  const dataDir = tempDir();
  (await makeOldData(dataDir)).close();
  const first = await start(dataDir);
  await first.close();
  apps.splice(apps.indexOf(first), 1);

  const bakPath = path.join(dataDir, 'spacelog.db.bak-1');
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(bakPath, stamp, stamp);

  const second = await start(dataDir);
  expect(second.db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c).toBe(3);
  expect(fs.statSync(bakPath).mtime.toISOString()).toBe(stamp.toISOString());
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-1']);
});

test('a migration that fails part-way leaves the old database untouched (one transaction) and retries next time', async () => {
  const dataDir = tempDir();
  const old = await makeOldData(dataDir);
  // 옮기는 도중 실패하게 한다: 이미지 별의 첨부를 넣을 때 막는다.
  old.exec(`CREATE TABLE attachments (id TEXT PRIMARY KEY, star_id TEXT NOT NULL REFERENCES stars(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('image','file','link')), position INTEGER NOT NULL,
    file_name TEXT, file_ext TEXT, file_size INTEGER, file_hash TEXT, vault_path TEXT, thumb_path TEXT,
    url TEXT, link_title TEXT, created_at TEXT NOT NULL);
    CREATE TRIGGER boom BEFORE INSERT ON attachments WHEN NEW.kind = 'image' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  old.close();

  expect(() => openDb(dataDir)).toThrow(/boom/);
  const check = new Database(path.join(dataDir, 'spacelog.db'));
  expect(check.pragma('user_version', { simple: true })).toBe(0);
  expect(check.prepare('SELECT COUNT(*) AS c FROM attachments').get().c).toBe(0);
  expect(check.prepare('SELECT vault_path FROM stars WHERE id = ?').get(IDS.file).vault_path).toBe(`vault/${IDS.file}.pdf`);
  check.exec('DROP TRIGGER boom');
  check.close();

  const app = await start(dataDir);
  expect(app.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(app.db.prepare('SELECT COUNT(*) AS c FROM attachments').get().c).toBe(3);
});

// --- 검토에서 나온 경우들 ---
test('a file star written in the old shape after migration (old server still running) is adopted on next start', async () => {
  const dataDir = tempDir();
  (await makeOldData(dataDir)).close();
  openDb(dataDir).close(); // 옮긴다
  // 옛 서버가 옛 모양으로 하나 더 쓴다
  const late = '55555555-5555-4555-8555-555555555555';
  fs.writeFileSync(path.join(dataDir, 'vault', `${late}.pdf`), '%PDF-1.4 late');
  const raw = new Database(path.join(dataDir, 'spacelog.db'));
  raw.prepare(`INSERT INTO stars (id, type, title, file_name, file_ext, file_size, file_hash, vault_path, memo, planet_id, created_at, search_text)
    VALUES (?, 'file', '늦은 파일', '늦은.pdf', 'PDF', 13, 'latehash', ?, '', ?, '2026-11-12T00:00:00.000Z', '')`)
    .run(late, `vault/${late}.pdf`, IDS.planet);
  raw.close();

  const db = openDb(dataDir);
  const atts = db.prepare('SELECT * FROM attachments WHERE star_id = ?').all(late);
  expect(atts).toHaveLength(1);
  expect(atts[0]).toMatchObject({ id: late, kind: 'file', vault_path: `vault/${late}.pdf`, file_hash: 'latehash' });
  const star = db.prepare('SELECT vault_path, file_hash, search_text FROM stars WHERE id = ?').get(late);
  expect(star.vault_path).toBeNull();
  expect(star.file_hash).toBeNull();
  expect(star.search_text).toContain('늦은.pdf');
  db.close();
});

test('an existing bak-1 is never overwritten', async () => {
  const dataDir = tempDir();
  (await makeOldData(dataDir)).close();
  const bak = path.join(dataDir, 'spacelog.db.bak-1');
  fs.writeFileSync(bak, 'older real backup');
  openDb(dataDir).close();
  expect(fs.readFileSync(bak, 'utf8')).toBe('older real backup');
  const extra = fs.readdirSync(dataDir).filter((n) => n.startsWith('spacelog.db.bak-1-'));
  expect(extra).toHaveLength(1);
});

// --- 판 1 → 2 (챗봇 표) ---
const V2_TABLES = ['conversations', 'messages', 'rag_status'];

// 판 1 DB 를 만든다: 지금 스키마로 만든 뒤 판 2 의 표를 지우고 user_version 을 1 로 되돌린다.
function makeV1(dataDir) {
  const db = openDb(dataDir);
  db.prepare("INSERT INTO planets VALUES (?, '행성', '', 1, 'town', 0, 0, '2026-11-01T00:00:00.000Z')").run(IDS.planet);
  db.prepare(`INSERT INTO stars (id, type, title, body, memo, planet_id, created_at, search_text)
    VALUES (?, 'text', '글', '본문', '', ?, '2026-11-02T00:00:00.000Z', '글\n본문')`).run(IDS.text, IDS.planet);
  db.exec('DROP INDEX messages_conversation_created; DROP TABLE messages; DROP TABLE conversations; DROP TABLE rag_status;');
  db.pragma('user_version = 1');
  db.close();
}

const tablesOf = (db) => db
  .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${V2_TABLES.map(() => '?').join(', ')}) ORDER BY name`)
  .all(...V2_TABLES)
  .map((r) => r.name);

test('v1 → v2: creates rag_status, conversations and messages in one go, backs up to bak-2 first', () => {
  const dataDir = tempDir();
  makeV1(dataDir);
  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(tablesOf(db)).toEqual(V2_TABLES);
  expect(db.prepare("SELECT name FROM pragma_table_info('rag_status')").all().map((r) => r.name)).toEqual([
    'star_id', 'content_hash', 'status', 'error', 'notes', 'attempts', 'next_try_at', 'indexed_at',
  ]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_conversation_created'").get()).toBeDefined();
  // 별은 그대로, rag_status 는 별을 따라 지워진다.
  db.prepare("INSERT INTO rag_status (star_id, status) VALUES (?, 'done')").run(IDS.text);
  db.prepare('DELETE FROM stars WHERE id = ?').run(IDS.text);
  expect(db.prepare('SELECT COUNT(*) AS c FROM rag_status').get().c).toBe(0);
  db.close();

  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-2']);
  const bak = new Database(path.join(dataDir, 'spacelog.db.bak-2'), { readonly: true });
  expect(bak.pragma('user_version', { simple: true })).toBe(1);
  expect(tablesOf(bak)).toEqual([]);
  expect(bak.prepare('SELECT COUNT(*) AS c FROM stars').get().c).toBe(1);
  bak.close();
});

test('v1 → v2: re-opening is a no-op and an existing bak-2 is never overwritten', () => {
  const dataDir = tempDir();
  makeV1(dataDir);
  const bakPath = path.join(dataDir, 'spacelog.db.bak-2');
  fs.writeFileSync(bakPath, 'older real backup');
  openDb(dataDir).close();
  expect(fs.readFileSync(bakPath, 'utf8')).toBe('older real backup');
  const after = fs.readdirSync(dataDir).filter((n) => n.includes('bak')).sort();
  expect(after).toHaveLength(2);
  expect(after[1]).toMatch(/^spacelog\.db\.bak-2-/);

  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(tablesOf(db)).toEqual(V2_TABLES);
  db.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak')).sort()).toEqual(after);
});

test('v1 → v2 that fails and is retried reuses the bak-2 of the same version instead of making another', () => {
  const dataDir = tempDir();
  makeV1(dataDir);
  // 옮기기가 실패하게 한다: conversation_id 칸이 없는 messages 표 → 색인 만들기가 실패한다.
  const raw = new Database(path.join(dataDir, 'spacelog.db'));
  raw.exec('CREATE TABLE messages (id TEXT PRIMARY KEY)');
  raw.close();
  const baks = () => fs.readdirSync(dataDir).filter((n) => n.includes('bak')).sort();

  expect(() => openDb(dataDir)).toThrow();
  expect(baks()).toEqual(['spacelog.db.bak-2']);
  expect(() => openDb(dataDir)).toThrow();
  expect(() => openDb(dataDir)).toThrow();
  expect(baks()).toEqual(['spacelog.db.bak-2']);

  const fix = new Database(path.join(dataDir, 'spacelog.db'));
  fix.exec('DROP TABLE messages');
  fix.close();
  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  db.close();
  expect(baks()).toEqual(['spacelog.db.bak-2']);
  const bak = new Database(path.join(dataDir, 'spacelog.db.bak-2'), { readonly: true });
  expect(bak.pragma('user_version', { simple: true })).toBe(1);
  bak.close();
});

test('v0 straight to v2 makes one backup (bak-1) and has the chatbot tables', async () => {
  const dataDir = tempDir();
  (await makeOldData(dataDir)).close();
  const db = openDb(dataDir);
  expect(tablesOf(db)).toEqual(V2_TABLES);
  db.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-1']);
});

// --- 판 2 → 3 (메모를 본문으로 합친다) ---
const MEMO_IDS = { A: 'a0000000-0000-4000-8000-000000000001', B: 'a0000000-0000-4000-8000-000000000002', C: 'a0000000-0000-4000-8000-000000000003', D: 'a0000000-0000-4000-8000-000000000004' };

// 판 2 DB 를 만든다: 지금 스키마로 만든 뒤 별 넷을 넣고 user_version 을 2 로 되돌린다.
function makeV2(dataDir) {
  const db = openDb(dataDir);
  db.prepare("INSERT INTO planets VALUES (?, '행성', '', 1, 'town', 0, 0, '2026-11-01T00:00:00.000Z')").run(IDS.planet);
  const ins = db.prepare(`INSERT INTO stars (id, type, title, body, memo, planet_id, created_at, search_text)
    VALUES (?, 'text', '글', ?, ?, ?, '2026-11-02T00:00:00.000Z', '')`);
  ins.run(MEMO_IDS.A, '본문', '메모', IDS.planet);
  ins.run(MEMO_IDS.B, null, '메모만', IDS.planet);
  ins.run(MEMO_IDS.C, '본문만', '', IDS.planet);
  ins.run(MEMO_IDS.D, '  ', '메모', IDS.planet);
  db.pragma('user_version = 2');
  db.close();
}

const memoRow = (db, key) => db.prepare('SELECT body, memo, search_text FROM stars WHERE id = ?').get(MEMO_IDS[key]);

test('v2 → v3: memo is appended under body, then cleared; search_text keeps both; backs up to bak-3 first', () => {
  const dataDir = tempDir();
  makeV2(dataDir);
  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(memoRow(db, 'A')).toMatchObject({ body: '본문\n\n메모', memo: '' });
  expect(memoRow(db, 'B')).toMatchObject({ body: '메모만', memo: '' });
  expect(memoRow(db, 'C')).toMatchObject({ body: '본문만', memo: '' });
  expect(memoRow(db, 'D')).toMatchObject({ body: '메모', memo: '' });
  expect(memoRow(db, 'A').search_text).toBe('글\n본문\n\n메모');
  expect(memoRow(db, 'B').search_text).toBe('글\n메모만');
  db.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-3']);
  const bak = new Database(path.join(dataDir, 'spacelog.db.bak-3'), { readonly: true });
  expect(bak.pragma('user_version', { simple: true })).toBe(2);
  expect(bak.prepare('SELECT body, memo FROM stars WHERE id = ?').get(MEMO_IDS.A)).toEqual({ body: '본문', memo: '메모' });
  bak.close();
});

test('v2 → v3: re-opening does not append the memo twice', () => {
  const dataDir = tempDir();
  makeV2(dataDir);
  openDb(dataDir).close();
  const db = openDb(dataDir);
  expect(memoRow(db, 'A')).toMatchObject({ body: '본문\n\n메모', memo: '' });
  db.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-3']);
});

test('v2 → v3 that fails part-way leaves memo and body untouched and retries next time', () => {
  const dataDir = tempDir();
  makeV2(dataDir);
  const raw = new Database(path.join(dataDir, 'spacelog.db'));
  raw.exec("CREATE TRIGGER boom BEFORE UPDATE OF search_text ON stars BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  raw.close();
  expect(() => openDb(dataDir)).toThrow(/boom/);
  const check = new Database(path.join(dataDir, 'spacelog.db'));
  expect(check.pragma('user_version', { simple: true })).toBe(2);
  expect(check.prepare('SELECT body, memo FROM stars WHERE id = ?').get(MEMO_IDS.A)).toEqual({ body: '본문', memo: '메모' });
  check.exec('DROP TRIGGER boom');
  check.close();
  const db = openDb(dataDir);
  expect(memoRow(db, 'A')).toMatchObject({ body: '본문\n\n메모', memo: '' });
  db.close();
});

test('v0 straight to v3 folds an old memo into the body too', async () => {
  const dataDir = tempDir();
  const old = await makeOldData(dataDir);
  old.prepare("UPDATE stars SET memo = '옛 메모' WHERE id = ?").run(IDS.text);
  old.close();
  const db = openDb(dataDir);
  expect(db.prepare('SELECT body, memo FROM stars WHERE id = ?').get(IDS.text)).toEqual({ body: '본문\n\n옛 메모', memo: '' });
  db.close();
});

test('v2 → v3: a whitespace-only memo is dropped, not appended', () => {
  const dataDir = tempDir();
  makeV2(dataDir);
  const raw = new Database(path.join(dataDir, 'spacelog.db'));
  raw.prepare("UPDATE stars SET memo = ' ' || char(10) || char(9) WHERE id IN (?, ?)").run(MEMO_IDS.A, MEMO_IDS.B);
  raw.close();
  const db = openDb(dataDir);
  expect(memoRow(db, 'A')).toMatchObject({ body: '본문', memo: '' });
  expect(memoRow(db, 'B')).toMatchObject({ body: null, memo: '' });
  expect(memoRow(db, 'B').search_text).toBe('글');
  db.close();
});

test('a memo written after the migration (a tab still running the old page) is folded in on the next start', () => {
  const dataDir = tempDir();
  makeV2(dataDir);
  openDb(dataDir).close(); // 판 3
  const raw = new Database(path.join(dataDir, 'spacelog.db'));
  raw.prepare("UPDATE stars SET memo = '늦은 메모' WHERE id = ?").run(MEMO_IDS.C);
  raw.close();
  const db = openDb(dataDir);
  expect(memoRow(db, 'C')).toMatchObject({ body: '본문만\n\n늦은 메모', memo: '' });
  expect(memoRow(db, 'C').search_text).toBe('글\n본문만\n\n늦은 메모');
  expect(memoRow(db, 'A')).toMatchObject({ body: '본문\n\n메모', memo: '' });
  db.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-3']);
});

// --- 판 3 → 4 (답 → 띄운 별) ---
test('v3 → v4: messages get saved_star_id (null), existing messages are kept, re-opening is a no-op', () => {
  const dataDir = tempDir();
  const db0 = openDb(dataDir);
  db0.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', '대화', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')");
  db0.exec("INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES ('m1', 'c1', 'assistant', '답', 'done', '2026-11-01T00:00:00.000Z')");
  db0.exec('ALTER TABLE messages DROP COLUMN saved_star_id');
  db0.pragma('user_version = 3');
  db0.close();

  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  const cols = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
  expect(cols).toContain('saved_star_id');
  expect(db.prepare("SELECT content, saved_star_id FROM messages WHERE id = 'm1'").get()).toEqual({ content: '답', saved_star_id: null });
  db.close();
  openDb(dataDir).close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-4']);
});

// --- 판 4 → 5 (자주 찾음) ---
test('v4 → v5: stars get fav (0), existing stars are kept as they were, backs up to bak-5, re-opening is a no-op', () => {
  const dataDir = tempDir();
  const db0 = openDb(dataDir);
  db0.exec("INSERT INTO planets (id, name, color_index, deco, slot, created_at) VALUES ('p1', '행성', 1, 'town', 0, '2026-11-01T00:00:00.000Z')");
  db0.exec("INSERT INTO stars (id, type, title, body, planet_id, created_at, search_text) VALUES ('s1', 'text', '제목', '글', 'p1', '2026-11-02T00:00:00.000Z', '제목 글')");
  db0.exec('ALTER TABLE stars DROP COLUMN fav');
  db0.pragma('user_version = 4');
  db0.close();

  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(db.prepare("SELECT title, body, planet_id, created_at, search_text, fav FROM stars WHERE id = 's1'").get()).toEqual({
    title: '제목', body: '글', planet_id: 'p1', created_at: '2026-11-02T00:00:00.000Z', search_text: '제목 글', fav: 0,
  });
  db.close();
  openDb(dataDir).close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-5']);
  const bak = new Database(path.join(dataDir, 'spacelog.db.bak-5'), { readonly: true });
  expect(bak.pragma('user_version', { simple: true })).toBe(4);
  expect(bak.prepare("SELECT name FROM pragma_table_info('stars')").all().map((r) => r.name)).not.toContain('fav');
  bak.close();
});

// --- 판 5 → 6 (잠든 별 블랙홀) ---
test('v5 → v6: stars get seen_at (= migration time, not created_at) and remind_off_at (null), backs up to bak-6, re-opening is a no-op', () => {
  const dataDir = tempDir();
  const db0 = openDb(dataDir);
  db0.exec("INSERT INTO planets (id, name, color_index, deco, slot, created_at) VALUES ('p1', '행성', 1, 'town', 0, '2026-11-01T00:00:00.000Z')");
  db0.exec("INSERT INTO stars (id, type, title, body, planet_id, created_at, search_text, fav) VALUES ('s1', 'text', '제목', '글', 'p1', '2026-01-02T00:00:00.000Z', '제목 글', 1)");
  db0.exec('ALTER TABLE stars DROP COLUMN seen_at');
  db0.exec('ALTER TABLE stars DROP COLUMN remind_off_at');
  db0.pragma('user_version = 5');
  db0.close();

  const before = Date.now();
  const db = openDb(dataDir);
  expect(db.pragma('user_version', { simple: true })).toBe(6);
  const row = db.prepare("SELECT title, created_at, fav, seen_at, remind_off_at FROM stars WHERE id = 's1'").get();
  expect(row).toMatchObject({ title: '제목', created_at: '2026-01-02T00:00:00.000Z', fav: 1, remind_off_at: null });
  // 옛 별은 옮긴 때를 본 때로 친다(오래된 별이 업데이트 첫날 한꺼번에 블랙홀로 가지 않게)
  expect(Date.parse(row.seen_at)).toBeGreaterThanOrEqual(before - 1000);
  db.close();
  const again = openDb(dataDir);
  expect(again.prepare("SELECT seen_at FROM stars WHERE id = 's1'").get().seen_at).toBe(row.seen_at);
  again.close();
  expect(fs.readdirSync(dataDir).filter((n) => n.includes('bak'))).toEqual(['spacelog.db.bak-6']);
});

test('opening a database without the unsorted planet adds exactly one, and reopening keeps one', () => {
  const dataDir = tempDir();
  const first = openDb(dataDir);
  first.prepare("DELETE FROM planets WHERE id = 'unsorted'").run(); // 판 5 이지만 미분류가 없던 DB
  first.close();
  for (let i = 0; i < 2; i += 1) {
    const db = openDb(dataDir);
    const rows = db.prepare("SELECT id, name, slot FROM planets WHERE id = 'unsorted'").all();
    expect(rows).toEqual([{ id: 'unsorted', name: '미분류', slot: -1 }]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM planets').get().c).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  }
});
