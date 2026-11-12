import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildSearchText } from './stars.js';

// PRAGMA user_version 으로 스키마 판을 적는다. 0 = 15600bb 까지(별 하나가 파일 · 링크를 직접 가졌다).
// 1 = 첨부 표(attachments). 별 하나에 첨부 여러 개(spec 6-9).
// 2 = 챗봇 표(rag_status · conversations · messages). 2차의 표를 한 번에 만든다.
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS planets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color_index INTEGER NOT NULL, deco TEXT NOT NULL, ring INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL);
-- url · link_title · file_* · vault_path · thumb_path 는 판 0 의 칸이다. 판 1 부터는 비워 두고 attachments 를 쓴다.
-- type 은 넣을 때 계산한 값을 적어 두지만, 응답은 첨부로 다시 계산한다.
CREATE TABLE IF NOT EXISTS stars (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('text','image','link','file')),
  title TEXT NOT NULL, body TEXT, url TEXT, link_title TEXT,
  file_name TEXT, file_ext TEXT, file_size INTEGER, file_hash TEXT,
  vault_path TEXT, thumb_path TEXT, memo TEXT NOT NULL DEFAULT '',
  planet_id TEXT NOT NULL REFERENCES planets(id), created_at TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS stars_planet_created ON stars(planet_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  star_id TEXT NOT NULL REFERENCES stars(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('image','file','link')),
  position INTEGER NOT NULL,
  file_name TEXT, file_ext TEXT, file_size INTEGER, file_hash TEXT,
  vault_path TEXT, thumb_path TEXT, url TEXT, link_title TEXT,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS attachments_star_position ON attachments(star_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS attachments_hash ON attachments(file_hash) WHERE file_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 판 2: 별마다 챗봇 색인 상태(server/rag/sync.js).
CREATE TABLE IF NOT EXISTS rag_status (
  star_id TEXT PRIMARY KEY REFERENCES stars(id) ON DELETE CASCADE,
  content_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed','skipped')),
  error TEXT, notes TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT, indexed_at TEXT);
-- 판 2: 챗봇 대화와 메시지(server/rag/chat.js).
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('running','done','stopped','failed')),
  error TEXT,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at);
`;

const LEGACY_COLUMNS = ['url', 'link_title', 'file_name', 'file_ext', 'file_size', 'file_hash', 'vault_path', 'thumb_path'];

// 옛 모양(별 행에 파일 · 링크 정보가 직접 든 것)으로 남은 별을 첨부 1개짜리 별로 바꾼다. 바꾼 별 id 를 돌려준다.
// 판 0 → 1 옮기기에서 쓰고, 판 1 에서도 켤 때마다 한 번 돈다: 옮긴 뒤에도 옛 서버가 잠깐 더 돌며
// 옛 모양으로 쓴 별이 있으면 여기서 주워 담는다. 첨부 id 는 별 id 와 같게 한다.
// 그러면 보관함 파일 이름(vault/<별 id>.<ext>, thumbs/<별 id>.webp)이 "첨부 id" 규칙과 그대로 맞고 파일을 옮기지 않아도 된다.
// 같은 해시의 첨부가 이미 있으면(옛 서버는 중복을 첨부 표에서 찾지 못한다) 해시만 비우고 파일은 그대로 둔다.
// 호출하는 쪽이 트랜잭션으로 감싼다.
function adoptLegacyStars(db) {
  const ids = db
    .prepare(
      `SELECT s.id FROM stars s
        WHERE s.type IN ('image', 'file', 'link')
          AND (s.vault_path IS NOT NULL OR s.url IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.star_id = s.id)`,
    )
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const insert = db.prepare(`
    INSERT INTO attachments (id, star_id, kind, position, file_name, file_ext, file_size, file_hash,
                             vault_path, thumb_path, url, link_title, created_at)
    SELECT s.id, s.id, s.type, 0, s.file_name, s.file_ext, s.file_size,
           CASE WHEN s.file_hash IS NOT NULL
                 AND EXISTS (SELECT 1 FROM attachments x WHERE x.file_hash = s.file_hash) THEN NULL
                ELSE s.file_hash END,
           s.vault_path, s.thumb_path, s.url, s.link_title, s.created_at
      FROM stars s WHERE s.id = ?`);
  // 첨부가 실제로 생긴 별만 옛 칸을 비운다.
  const clear = db.prepare(`UPDATE stars SET ${LEGACY_COLUMNS.map((c) => `${c} = NULL`).join(', ')}
     WHERE id = ? AND EXISTS (SELECT 1 FROM attachments a WHERE a.star_id = stars.id)`);
  for (const id of ids) {
    insert.run(id);
    clear.run(id);
  }
  return ids;
}

function rebuildSearchText(db, ids) {
  const attsOf = db.prepare('SELECT * FROM attachments WHERE star_id = ? ORDER BY position');
  const setText = db.prepare('UPDATE stars SET search_text = ? WHERE id = ?');
  const starOf = db.prepare('SELECT id, title, body, memo FROM stars WHERE id = ?');
  for (const id of ids) {
    const star = starOf.get(id);
    if (star) setText.run(buildSearchText(star, attsOf.all(id)), id);
  }
}

// 판 0 → 1. 호출하는 쪽이 트랜잭션으로 감싼다.
function migrateTo1(db) {
  adoptLegacyStars(db);
  db.exec(`
    UPDATE stars SET file_hash = NULL WHERE file_hash IS NOT NULL;
    DROP INDEX IF EXISTS stars_hash;
  `);
  rebuildSearchText(db, db.prepare('SELECT id FROM stars').all().map((r) => r.id));
}

// 옮기기 전의 DB 를 spacelog.db.bak-<판> 으로 남긴다. VACUUM INTO 는 WAL 에만 있는 쓰기까지 담은 한 파일을 만든다.
// 임시 이름으로 만든 뒤 바꿔 달아, 복사가 중간에 끊겨도 반쪽짜리 백업이 남지 않게 한다.
// 옮기기는 한 트랜잭션이라 실패하면 DB 가 그대로 남으므로, 다시 켤 때는 같은 판의 백업을 그대로 쓴다.
// 백업 파일의 user_version. DB 가 아니거나 열 수 없으면 null.
function backupVersion(file) {
  let bak;
  try {
    bak = new Database(file, { readonly: true, fileMustExist: true });
    return bak.pragma('user_version', { simple: true });
  } catch {
    return null;
  } finally {
    bak?.close();
  }
}

function backup(db, dbPath, version, fromVersion) {
  // 옮기기가 실패해 다시 켤 때: 같은 판(fromVersion)의 백업이 이미 있으면 그것을 쓴다(켤 때마다 하나씩 쌓이지 않게).
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-${version}`;
  const existing = fs.readdirSync(dir)
    .filter((n) => (n === prefix || n.startsWith(`${prefix}-`)) && !n.endsWith('.tmp'))
    .sort();
  if (existing.some((n) => backupVersion(path.join(dir, n)) === fromVersion)) return;
  // 이미 있는 백업은 덮어쓰지 않는다(사용자가 되돌려 둔 옛 DB 의 진짜 백업일 수 있다).
  let bak = `${dbPath}.bak-${version}`;
  if (fs.existsSync(bak)) bak = `${bak}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const tmp = `${bak}.tmp`;
  fs.rmSync(tmp, { force: true });
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('VACUUM INTO ?').run(tmp);
  fs.renameSync(tmp, bak);
}

// dataDir, vault/, thumbs/ 를 만들고 스키마를 적용한 DB 핸들을 돌려준다. 옛 판이면 백업한 뒤 옮긴다.
export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true });
  const dbPath = path.join(dataDir, 'spacelog.db');
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const version = db.pragma('user_version', { simple: true });
    if (version > SCHEMA_VERSION) throw new Error(`spacelog.db is from a newer version (${version})`);
    if (version < SCHEMA_VERSION) {
      // 별 표가 없으면 방금 만든 빈 DB 다. 옮길 것도, 백업할 것도 없다.
      const fresh = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stars'").get() === undefined;
      // 백업 이름은 처음 밟는 판이다(0 → bak-1, 1 → bak-2). 0 에서 바로 2 로 가도 백업은 하나다.
      if (!fresh) backup(db, dbPath, version + 1, version);
      db.transaction(() => {
        db.exec(SCHEMA);
        if (!fresh && version < 1) migrateTo1(db);
        // 1 → 2 는 새 표만 더한다(위 SCHEMA 의 CREATE TABLE IF NOT EXISTS).
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).immediate();
    }
    db.exec(SCHEMA);
    // 옮긴 뒤에도 옛 서버가 옛 모양으로 쓴 별이 있으면 주워 담는다(없으면 아무 일도 없다).
    db.transaction(() => {
      const adopted = adoptLegacyStars(db);
      if (adopted.length) {
        db.exec('UPDATE stars SET file_hash = NULL WHERE file_hash IS NOT NULL');
        rebuildSearchText(db, adopted);
      }
    }).immediate();
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
