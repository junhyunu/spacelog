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
  expect(SCHEMA_VERSION).toBe(1);
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
  expect(db.pragma('user_version', { simple: true })).toBe(1);

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
  expect(app.db.pragma('user_version', { simple: true })).toBe(1);
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
