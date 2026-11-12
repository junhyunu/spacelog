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
    const digest = hash.digest('hex');
    if (isDuplicate && isDuplicate(digest)) {
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
