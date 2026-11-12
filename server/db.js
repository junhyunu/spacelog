import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildSearchText } from './stars.js';

// PRAGMA user_version 으로 스키마 판을 적는다. 0 = 15600bb 까지(별 하나가 파일 · 링크를 직접 가졌다).
// 1 = 첨부 표(attachments). 별 하나에 첨부 여러 개(spec 6-9).
export const SCHEMA_VERSION = 1;

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
`;

const LEGACY_COLUMNS = ['url', 'link_title', 'file_name', 'file_ext', 'file_size', 'file_hash', 'vault_path', 'thumb_path'];

// 판 0 → 1. 파일 · 이미지 · 링크 별마다 첨부 1개(position 0)를 만든다. 첨부 id 는 별 id 와 같게 한다.
// 그러면 보관함 파일 이름(vault/<별 id>.<ext>, thumbs/<별 id>.webp)이 "첨부 id" 규칙과 그대로 맞고 파일을 옮기지 않아도 된다.
// 호출하는 쪽이 트랜잭션으로 감싼다.
function migrateTo1(db) {
  db.exec(`
    INSERT INTO attachments (id, star_id, kind, position, file_name, file_ext, file_size, file_hash,
                             vault_path, thumb_path, url, link_title, created_at)
    SELECT s.id, s.id, s.type, 0, s.file_name, s.file_ext, s.file_size, s.file_hash,
           s.vault_path, s.thumb_path, s.url, s.link_title, s.created_at
      FROM stars s
     WHERE s.type IN ('image', 'file', 'link')
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.star_id = s.id);
    UPDATE stars SET ${LEGACY_COLUMNS.map((c) => `${c} = NULL`).join(', ')}
     WHERE type IN ('image', 'file', 'link');
    UPDATE stars SET file_hash = NULL WHERE file_hash IS NOT NULL;
    DROP INDEX IF EXISTS stars_hash;
  `);
  const attsOf = db.prepare('SELECT * FROM attachments WHERE star_id = ? ORDER BY position');
  const setText = db.prepare('UPDATE stars SET search_text = ? WHERE id = ?');
  for (const star of db.prepare('SELECT id, title, body, memo FROM stars').all()) {
    setText.run(buildSearchText(star, attsOf.all(star.id)), star.id);
  }
}

// 옮기기 전의 DB 를 spacelog.db.bak-1 로 남긴다. VACUUM INTO 는 WAL 에만 있는 쓰기까지 담은 한 파일을 만든다.
// 임시 이름으로 만든 뒤 바꿔 달아, 복사가 중간에 끊겨도 반쪽짜리 백업이 남지 않게 한다.
// 옮기기는 한 트랜잭션이라 실패하면 DB 가 그대로 남으므로, 다시 켤 때 백업을 새로 만들어도 같은 내용이다.
function backup(db, dbPath, version) {
  const bak = `${dbPath}.bak-${version}`;
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
      if (!fresh) backup(db, dbPath, SCHEMA_VERSION);
      db.transaction(() => {
        db.exec(SCHEMA);
        if (!fresh) migrateTo1(db);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).immediate();
    }
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
