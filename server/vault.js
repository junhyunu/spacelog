import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

// Windows 에서 sharp 가 원본 파일을 붙잡고 있으면 별을 지울 때 사본이 안 지워진다.
sharp.cache(false);

const THUMB_SIZE = 320;

const EXECUTABLE_EXTS = new Set(
  'exe bat cmd com msi lnk ps1 vbs js jse wsf scr pif cpl reg hta jar sh app command'.split(' '),
);

// 열면 실행되는 종류인가. 이런 파일은 "원본 열기"가 폴더에서 보기로 바뀐다.
export function isExecutableExt(ext) {
  return typeof ext === 'string' && EXECUTABLE_EXTS.has(ext.toLowerCase());
}

// 기본 프로그램으로 바로 열어도 되는 종류만 적어 둔다. 여기 없는 것(확장자 없음 · svg · html · url · lnk ·
// 매크로 문서 · 스크립트 · 실행 파일 등)은 "원본 열기"가 폴더에서 보기로 바뀐다.
const OPENABLE_EXTS = new Set([
  'png jpg jpeg gif webp bmp tif tiff heic avif ico',
  'pdf txt md csv log json rtf doc docx xls xlsx ppt pptx hwp hwpx odt ods odp epub',
  'mp3 wav m4a flac ogg aac mp4 mov mkv webm avi m4v',
  'zip 7z rar tar gz',
].join(' ').split(' '));

export function isOpenableExt(ext) {
  return typeof ext === 'string' && OPENABLE_EXTS.has(ext.toLowerCase());
}

// dataDir 기준 상대 경로를 절대 경로로 바꾼다. 결과가 <dataDir>/<sub>/ 안이 아니면 throw.
function resolveIn(dataDir, sub, relPath) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) {
    throw new Error(`invalid ${sub} path`);
  }
  const base = path.resolve(dataDir, sub);
  const abs = path.resolve(dataDir, relPath);
  if (!abs.startsWith(base + path.sep) || abs.length <= base.length + 1) {
    throw new Error(`path escapes ${sub}/`);
  }
  return abs;
}

export function resolveVault(dataDir, relPath) {
  return resolveIn(dataDir, 'vault', relPath);
}

export function resolveThumb(dataDir, relPath) {
  return resolveIn(dataDir, 'thumbs', relPath);
}

async function unlinkQuiet(abs) {
  try {
    await fs.promises.unlink(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// 스트림을 vault/.tmp-<id> 에 쓰면서 SHA-256 을 계산하고, 끝나면 vault/<id>[.<ext>] 로 옮긴다.
// maxBytes 를 넘으면(또는 multipart 가 잘랐으면) 임시 파일을 지우고 { tooLarge: true }.
// isDuplicate(hash) 가 참이면 임시 파일을 지우고 { duplicate: true, hash }.
// 빈 파일(0바이트)은 내용으로 구별할 수 없으므로 중복을 따지지 않고 hash 를 null 로 돌려준다.
// 그 밖의 오류는 임시 파일을 지우고 다시 던진다.
export async function saveUpload(dataDir, stream, { id, ext = '', maxBytes = Infinity, isDuplicate } = {}) {
  const vaultPath = ext ? `vault/${id}.${ext}` : `vault/${id}`;
  const finalAbs = resolveVault(dataDir, vaultPath);
  const tmpAbs = resolveVault(dataDir, `vault/.tmp-${id}`);

  const hash = crypto.createHash('sha256');
  let size = 0;
  let over = false;
  const tap = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) {
        // 더 쓰지 않고 흘려보내기만 한다. 뒤의 파일을 계속 읽을 수 있어야 한다.
        over = true;
        return done();
      }
      hash.update(chunk);
      return done(null, chunk);
    },
  });

  try {
    await pipeline(stream, tap, fs.createWriteStream(tmpAbs));
    if (over || stream.truncated) {
      await unlinkQuiet(tmpAbs);
      return { tooLarge: true };
    }
    const digest = size === 0 ? null : hash.digest('hex');
    if (digest !== null && isDuplicate && isDuplicate(digest)) {
      await unlinkQuiet(tmpAbs);
      return { duplicate: true, hash: digest };
    }
    await fs.promises.rename(tmpAbs, finalAbs);
    return { vaultPath, size, hash: digest };
  } catch (err) {
    await unlinkQuiet(tmpAbs).catch(() => {});
    throw err;
  }
}

// 이미지 사본으로 thumbs/<id>.webp 를 만든다. 못 만들면 null(별은 축소본 없이 저장된다).
export async function makeThumb(dataDir, vaultPath, id) {
  const thumbPath = `thumbs/${id}.webp`;
  let out;
  try {
    out = resolveThumb(dataDir, thumbPath);
    await sharp(resolveVault(dataDir, vaultPath))
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toFile(out);
    return thumbPath;
  } catch {
    if (out) await unlinkQuiet(out).catch(() => {});
    return null;
  }
}

// 별의 사본과 축소본을 지운다. 이미 없으면 넘어간다. 보관함 밖을 가리키는 경로는 건드리지 않는다.
export async function removeFiles(dataDir, star) {
  const targets = [];
  if (star?.vault_path) targets.push(() => resolveVault(dataDir, star.vault_path));
  if (star?.thumb_path) targets.push(() => resolveThumb(dataDir, star.thumb_path));
  let firstError = null;
  for (const target of targets) {
    try {
      await unlinkQuiet(target());
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VAULT_NAME = new RegExp(`^(${UUID})(?:\\.[a-z0-9]{1,10})?$`);
const THUMB_NAME = new RegExp(`^(${UUID})\\.webp$`);
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

// 시작할 때 한 번 부르는 보관함 청소. 지운 개수를 돌려준다.
// - vault/.tmp-* : 받다가 끊긴 임시 파일. 모두 지운다.
// - 주인 없는 사본 · 축소본: 이름이 정확히 <uuid>[.ext] (vault) / <uuid>.webp (thumbs) 이고,
//   그 uuid 의 별이 없고(hasStar), 만든 지 1시간이 넘은 것만 orphans/vault · orphans/thumbs 로 옮긴다(지우지 않는다).
// 그 밖의 이름(사용자가 넣어 둔 파일 등)과 폴더는 건드리지 않는다. 하나가 실패해도 나머지는 계속한다.
export function sweepVault(dataDir, hasStar, { now = Date.now(), minAgeMs = ORPHAN_MIN_AGE_MS } = {}) {
  const removed = { tmp: 0, orphans: 0 };
  const sweep = (sub, pattern) => {
    const dir = path.resolve(dataDir, sub);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      console.error(`sweep: cannot read ${sub}/`, err);
      return;
    }
    for (const name of names) {
      try {
        const isTmp = sub === 'vault' && name.startsWith('.tmp-');
        const match = isTmp ? null : pattern.exec(name);
        if (!isTmp && !match) continue;
        const abs = path.join(dir, name);
        const stat = fs.lstatSync(abs);
        if (!stat.isFile()) continue;
        if (!isTmp && (now - stat.mtimeMs <= minAgeMs || hasStar(match[1]))) continue;
        if (isTmp) {
          fs.unlinkSync(abs);
        } else {
          // 지우지 않는다. DB 만 옛 백업으로 되돌린 경우 등에는 이 파일들이 유일한 사본일 수 있다.
          const keep = path.resolve(dataDir, 'orphans', sub);
          fs.mkdirSync(keep, { recursive: true });
          fs.renameSync(abs, path.join(keep, name));
        }
        removed[isTmp ? 'tmp' : 'orphans'] += 1;
      } catch (err) {
        console.error(`sweep: cannot remove ${sub}/${name}`, err);
      }
    }
  };
  sweep('vault', VAULT_NAME);
  sweep('thumbs', THUMB_NAME);
  return removed;
}
