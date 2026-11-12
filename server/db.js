import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS planets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  color_index INTEGER NOT NULL, deco TEXT NOT NULL, ring INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stars (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('text','image','link','file')),
  title TEXT NOT NULL, body TEXT, url TEXT, link_title TEXT,
  file_name TEXT, file_ext TEXT, file_size INTEGER, file_hash TEXT,
  vault_path TEXT, thumb_path TEXT, memo TEXT NOT NULL DEFAULT '',
  planet_id TEXT NOT NULL REFERENCES planets(id), created_at TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS stars_planet_created ON stars(planet_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS stars_hash ON stars(file_hash) WHERE file_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// dataDir, vault/, thumbs/ 를 만들고 스키마를 적용한 DB 핸들을 돌려준다.
export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true });
  const db = new Database(path.join(dataDir, 'spacelog.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
