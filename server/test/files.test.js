import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildApp } from '../app.js';
import { isImageUpload, parseFileName, parseRange } from '../files.js';
import { defaultOpener, openerCommand, windowsOpenCommand, windowsRevealCommand } from '../opener.js';
import { createPlanet } from '../planets.js';
import { insertStar } from '../stars.js';
import { isExecutableExt, isOpenableExt, makeThumb, removeFiles, resolveVault, saveUpload, sweepVault } from '../vault.js';
import { cleanup, makeApp } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };
const STAR_KEYS = [
  'id', 'type', 'title', 'body', 'url', 'link_title', 'file_name', 'file_ext', 'file_size',
  'memo', 'planet_id', 'created_at', 'has_thumb',
].sort();

let app;
let dataDir;
let planet;
let opened;
const extra = [];

// 실제 프로그램을 열지 않는다. 호출만 적어 둔다.
function fakeOpener(log) {
  return {
    open: (p) => { log.push(['open', p]); },
    reveal: (p) => { log.push(['reveal', p]); },
  };
}

beforeEach(async () => {
  opened = [];
  ({ app, dataDir } = await makeApp({ opener: fakeOpener(opened) }));
  planet = createPlanet(app.db, { name: '행성' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  cleanup(dataDir);
  for (const other of extra.splice(0)) {
    await other.app.close();
    cleanup(other.dataDir);
  }
});

// multipart 본문을 직접 만든다. parts: ['field', name, value] | ['file', name, filename, mime, content]
function multipart(parts) {
  const boundary = `----spacelog${crypto.randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    if (part[0] === 'field') {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part[1]}"\r\n\r\n${part[2]}\r\n`));
    } else {
      const [, name, filename, mime, content] = part;
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ));
      chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { ...HOST, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const file = (filename, content = 'hello', mime = 'application/octet-stream') => ['file', 'files', filename, mime, content];

// 글 필드를 먼저, 파일을 뒤에 보낸다.
function upload(files, { planet_id = planet.id, memo, titles, target = app } = {}) {
  const parts = [];
  if (planet_id !== null) parts.push(['field', 'planet_id', planet_id]);
  if (memo !== undefined) parts.push(['field', 'memo', memo]);
  if (titles !== undefined) parts.push(['field', 'titles', typeof titles === 'string' ? titles : JSON.stringify(titles)]);
  parts.push(...files);
  const { payload, headers } = multipart(parts);
  return target.inject({ method: 'POST', url: '/api/stars/upload', headers, payload });
}

async function uploadOk(files, opts) {
  const res = await upload(files, opts);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function call(method, url, target = app) {
  return target.inject({ method, url, headers: HOST });
}

const dbRow = (id, target = app) => target.db.prepare('SELECT * FROM stars WHERE id = ?').get(id);
const starCount = (target = app) => target.db.prepare('SELECT COUNT(*) AS c FROM stars').get().c;
const vaultFiles = (dir = dataDir) => fs.readdirSync(path.join(dir, 'vault')).sort();
const thumbFiles = (dir = dataDir) => fs.readdirSync(path.join(dir, 'thumbs')).sort();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// dataDir 바로 위 폴더까지 포함해, 보관함 밖에 생긴 것이 없는지 본다.
function listOutsideVault() {
  return {
    data: fs.readdirSync(dataDir).filter((n) => !n.startsWith('spacelog.db')).sort(),
    evil: fs.readdirSync(path.dirname(dataDir)).filter((n) => n.includes('evil')),
    evilUp: fs.readdirSync(path.dirname(path.dirname(dataDir))).filter((n) => n === 'evil.txt'),
  };
}

const png = () => sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();

test('uploads two files → two stars sharing planet and memo', async () => {
  const { created, skipped } = await uploadOk([file('a.txt', 'aaa'), file('b.txt', 'bbb')], { memo: '같이 쓴 메모' });
  expect(skipped).toEqual([]);
  expect(created).toHaveLength(2);
  expect(created.map((s) => s.file_name)).toEqual(['a.txt', 'b.txt']);
  expect(created[0].id).not.toBe(created[1].id);
  for (const star of created) {
    expect(Object.keys(star).sort()).toEqual(STAR_KEYS);
    expect(star.planet_id).toBe(planet.id);
    expect(star.memo).toBe('같이 쓴 메모');
    expect(star.type).toBe('file');
    expect(star.file_size).toBe(3);
    expect(star.body).toBeNull();
    expect(star.url).toBeNull();
    expect(new Date(star.created_at).toISOString()).toBe(star.created_at);
  }
  expect(vaultFiles()).toEqual(created.map((s) => `${s.id}.txt`).sort());
  const row = dbRow(created[0].id);
  expect(row.vault_path).toBe(`vault/${created[0].id}.txt`);
  expect(row.thumb_path).toBeNull();
  expect(row.file_hash).toBe(sha256(Buffer.from('aaa')));
  expect(row.search_text).toBe('a\n같이 쓴 메모\na.txt');
  expect(fs.readFileSync(path.join(dataDir, row.vault_path), 'utf8')).toBe('aaa');

  const list = await call('GET', '/api/stars');
  expect(list.json().map((s) => s.id).sort()).toEqual(created.map((s) => s.id).sort());
  expect(list.body).not.toContain('vault/');
});

test('png becomes image star with thumb', async () => {
  const buf = await png();
  const { created } = await uploadOk([file('빨강.png', buf, 'image/png')]);
  expect(created).toHaveLength(1);
  const star = created[0];
  expect(star.type).toBe('image');
  expect(star.file_ext).toBe('PNG');
  expect(star.has_thumb).toBe(true);
  expect(dbRow(star.id).thumb_path).toBe(`thumbs/${star.id}.webp`);
  expect(thumbFiles()).toEqual([`${star.id}.webp`]);

  const thumb = await call('GET', `/api/stars/${star.id}/thumb`);
  expect(thumb.statusCode).toBe(200);
  expect(thumb.headers['content-type']).toBe('image/webp');
  expect(thumb.headers['x-content-type-options']).toBe('nosniff');
  const meta = await sharp(thumb.rawPayload).metadata();
  expect(meta.format).toBe('webp');
  expect(meta.width).toBe(1); // 키우지 않는다

  const full = await call('GET', `/api/stars/${star.id}/file`);
  expect(full.statusCode).toBe(200);
  expect(full.headers['content-type']).toBe('image/png');
  expect(full.headers['content-disposition']).toMatch(/^inline;/);
  expect(full.rawPayload.equals(buf)).toBe(true);
});

test('large image thumb fits inside 320x320', async () => {
  const big = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#224466' } }).jpeg().toBuffer();
  const { created } = await uploadOk([file('big.JPG', big, 'image/jpeg')]);
  expect(created[0].type).toBe('image');
  expect(created[0].file_ext).toBe('JPG');
  expect(vaultFiles()).toEqual([`${created[0].id}.jpg`]);
  const thumb = await call('GET', `/api/stars/${created[0].id}/thumb`);
  const meta = await sharp(thumb.rawPayload).metadata();
  expect([meta.width, meta.height]).toEqual([320, 160]);
});

test('non-image becomes file star, ext uppercased', async () => {
  const { created } = await uploadOk([file('a.pdf', '%PDF-1.4', 'application/pdf')]);
  const star = created[0];
  expect(star.type).toBe('file');
  expect(star.file_ext).toBe('PDF');
  expect(star.title).toBe('a');
  expect(star.file_name).toBe('a.pdf');
  expect(star.file_size).toBe(8);
  expect(star.has_thumb).toBe(false);
  expect(vaultFiles()).toEqual([`${star.id}.pdf`]);
  expect(thumbFiles()).toEqual([]);
  const thumb = await call('GET', `/api/stars/${star.id}/thumb`);
  expect(thumb.statusCode).toBe(404);
  expect(thumb.json()).toEqual({ error: 'not_found' });
});

test('titles[] overrides file name', async () => {
  const { created } = await uploadOk(
    [file('a.txt', '1'), file('b.txt', '2'), file('c.txt', '3'), file('d.txt', '4')],
    { titles: ['  첫 제목  ', '', '<b>셋</b>'] },
  );
  expect(created.map((s) => s.title)).toEqual(['첫 제목', 'b', '<b>셋</b>', 'd']);
  expect(created.map((s) => s.file_name)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  expect(dbRow(created[0].id).search_text).toBe('첫 제목\na.txt');
});

test('titles that is not a JSON string array → 400 invalid_titles, nothing written', async () => {
  for (const titles of ['not json', '{"a":1}', '"text"', '[1,2]']) {
    const res = await upload([file('a.txt', '1')], { titles });
    expect(res.statusCode, titles).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_titles' });
  }
  expect(starCount()).toBe(0);
  expect(vaultFiles()).toEqual([]);
});

test('korean file name with spaces is preserved', async () => {
  const { created } = await uploadOk([file('21일차 과제 안내.pdf', 'pdf', 'application/pdf')]);
  expect(created[0].file_name).toBe('21일차 과제 안내.pdf');
  expect(created[0].title).toBe('21일차 과제 안내');
  expect(created[0].file_ext).toBe('PDF');
  expect(vaultFiles()).toEqual([`${created[0].id}.pdf`]);
  expect((await call('GET', `/api/stars/${created[0].id}`)).json().file_name).toBe('21일차 과제 안내.pdf');
});

test('path traversal name is reduced to last segment and stays in vault', async () => {
  const before = listOutsideVault();
  const { created } = await uploadOk([
    file('..\\..\\evil.txt', 'one'),
    file('../../evil2.txt', 'two'),
    file('C:\\Windows\\..\\evil3.txt', 'three'),
    file('a/b\\..\\evil4.TXT', 'four'),
  ]);
  expect(created.map((s) => s.file_name)).toEqual(['evil.txt', 'evil2.txt', 'evil3.txt', 'evil4.TXT']);
  expect(created.map((s) => s.title)).toEqual(['evil', 'evil2', 'evil3', 'evil4']);
  expect(vaultFiles()).toEqual(created.map((s) => `${s.id}.txt`).sort());
  for (const star of created) {
    const abs = path.resolve(dataDir, dbRow(star.id).vault_path);
    expect(path.dirname(abs)).toBe(path.resolve(dataDir, 'vault'));
    expect(fs.existsSync(abs)).toBe(true);
  }
  expect(listOutsideVault()).toEqual(before);
});

test('odd extensions never reach the vault file name', async () => {
  const { created } = await uploadOk([
    file('메모.한글', '1'),
    file('a.b c', '2'),
    file('x.averyveryverylongext', '3'),
    file('archive.tar.GZ', '4'),
    file('.gitignore', '5'),
    file('끝점.', '6'),
  ]);
  expect(created.map((s) => s.file_ext)).toEqual(['', '', '', 'GZ', 'GITIGNORE', '']);
  expect(created.map((s) => s.title)).toEqual(['메모.한글', 'a.b c', 'x.averyveryverylongext', 'archive.tar', '.gitignore', '끝점.']);
  expect(created.map((s) => s.file_name)).toEqual(['메모.한글', 'a.b c', 'x.averyveryverylongext', 'archive.tar.GZ', '.gitignore', '끝점.']);
  expect(vaultFiles()).toEqual(
    [created[0].id, created[1].id, created[2].id, `${created[3].id}.gz`, `${created[4].id}.gitignore`, created[5].id].sort(),
  );
});

test('no extension', async () => {
  const { created } = await uploadOk([file('README', 'read me')]);
  expect(created).toHaveLength(1);
  expect(created[0].file_ext).toBe('');
  expect(created[0].file_name).toBe('README');
  expect(created[0].title).toBe('README');
  expect(vaultFiles()).toEqual([created[0].id]);
  expect(dbRow(created[0].id).vault_path).toBe(`vault/${created[0].id}`);
  const res = await call('GET', `/api/stars/${created[0].id}/file`);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  expect(res.body).toBe('read me');
});

test('200+ char name is truncated', async () => {
  const long = `${'가'.repeat(250)}.pdf`;
  const { created } = await uploadOk([file(long, 'x', 'application/pdf'), file('나'.repeat(300), 'y')]);
  // 확장자는 남기고 앞쪽 이름을 자른다.
  expect([...created[0].file_name]).toHaveLength(200);
  expect(created[0].file_name).toBe(`${'가'.repeat(196)}.pdf`);
  expect(created[0].file_ext).toBe('PDF');
  expect(created[0].title).toBe('가'.repeat(196));
  expect(created[1].file_name).toBe('나'.repeat(200));
  expect(vaultFiles()).toEqual([`${created[0].id}.pdf`, created[1].id].sort());
});

test('zero-byte file is saved', async () => {
  const { created, skipped } = await uploadOk([file('empty.txt', '')]);
  expect(skipped).toEqual([]);
  expect(created).toHaveLength(1);
  expect(created[0].file_size).toBe(0);
  expect(fs.statSync(path.join(dataDir, 'vault', `${created[0].id}.txt`)).size).toBe(0);
  const res = await call('GET', `/api/stars/${created[0].id}/file`);
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('');
});

test('duplicate of existing star → skipped duplicate, no new vault file', async () => {
  const first = await uploadOk([file('a.txt', 'same bytes')]);
  expect(first.created).toHaveLength(1);
  const filesBefore = vaultFiles();

  const second = await uploadOk([file('다른 이름.txt', 'same bytes'), file('new.txt', 'new bytes')]);
  expect(second.skipped).toEqual([{ file_name: '다른 이름.txt', reason: 'duplicate' }]);
  expect(second.created.map((s) => s.file_name)).toEqual(['new.txt']);
  expect(vaultFiles()).toEqual([...filesBefore, `${second.created[0].id}.txt`].sort());
  expect(starCount()).toBe(2);
});

test('same file twice in one request → one created, one skipped', async () => {
  const { created, skipped } = await uploadOk([file('a.txt', 'twin'), file('b.txt', 'twin')]);
  expect(created.map((s) => s.file_name)).toEqual(['a.txt']);
  expect(skipped).toEqual([{ file_name: 'b.txt', reason: 'duplicate' }]);
  expect(vaultFiles()).toEqual([`${created[0].id}.txt`]);
  expect(starCount()).toBe(1);
});

test('titles stay aligned with file order when a file is skipped', async () => {
  const { created, skipped } = await uploadOk(
    [file('a.txt', 'twin'), file('b.txt', 'twin'), file('c.txt', 'other')],
    { titles: ['하나', '둘', '셋'] },
  );
  expect(skipped).toHaveLength(1);
  expect(created.map((s) => s.title)).toEqual(['하나', '셋']);
});

test('over maxFileBytes → skipped too_large, temp file removed', async () => {
  const small = await makeApp({ maxFileBytes: 10, opener: fakeOpener([]) });
  extra.push(small);
  const p = createPlanet(small.app.db, { name: 'p' });
  const res = await upload(
    [file('big.txt', '12345678901'), file('exact.txt', '1234567890'), file('small.txt', 'abc')],
    { planet_id: p.id, target: small.app },
  );
  expect(res.statusCode, res.body).toBe(200);
  const { created, skipped } = res.json();
  expect(skipped).toEqual([{ file_name: 'big.txt', reason: 'too_large' }]);
  expect(created.map((s) => [s.file_name, s.file_size])).toEqual([['exact.txt', 10], ['small.txt', 3]]);
  expect(vaultFiles(small.dataDir)).toEqual(created.map((s) => `${s.id}.txt`).sort());
  expect(starCount(small.app)).toBe(2);
});

test('upload is not capped by the default 1 MB body limit', async () => {
  const big = crypto.randomBytes(3 * 1024 * 1024);
  const { created, skipped } = await uploadOk([file('big.bin', big)]);
  expect(skipped).toEqual([]);
  expect(created[0].file_size).toBe(big.length);
  expect(dbRow(created[0].id).file_hash).toBe(sha256(big));
  const res = await call('GET', `/api/stars/${created[0].id}/file`);
  expect(res.rawPayload.equals(big)).toBe(true);
  expect(res.headers['content-length']).toBe(String(big.length));
});

test('unknown planet → 400 and nothing written', async () => {
  for (const planet_id of ['nope', '', null]) { // null: 필드를 보내지 않는다
    const res = await upload([file('a.txt', 'aaa'), file('b.txt', 'bbb')], { planet_id });
    expect(res.statusCode, String(planet_id)).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_planet' });
  }
  expect(starCount()).toBe(0);
  expect(vaultFiles()).toEqual([]);
  expect(thumbFiles()).toEqual([]);
});

test('no files → 400 no_files; non-multipart body → 400', async () => {
  const res = await upload([], { memo: '메모만' });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'no_files' });

  // 다른 이름의 파일 필드는 받지 않는다.
  const wrongField = await upload([['file', 'other', 'a.txt', 'text/plain', 'aaa']]);
  expect(wrongField.statusCode).toBe(400);
  expect(wrongField.json()).toEqual({ error: 'no_files' });

  const json = await app.inject({ method: 'POST', url: '/api/stars/upload', headers: HOST, payload: { planet_id: planet.id } });
  expect(json.statusCode).toBe(400);
  expect(json.json()).toEqual({ error: 'not_multipart' });
  expect(starCount()).toBe(0);
  expect(vaultFiles()).toEqual([]);
});

test('GET file streams the copy with original name', async () => {
  const { created } = await uploadOk([file('21일차 과제 (최종)\'s.pdf', '%PDF-1.4 body', 'application/pdf')]);
  const res = await call('GET', `/api/stars/${created[0].id}/file`);
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('%PDF-1.4 body');
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-length']).toBe('13');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  const disposition = res.headers['content-disposition'];
  expect(disposition).toMatch(/^inline; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/);
  expect(decodeURIComponent(disposition.split("''")[1])).toBe('21일차 과제 (최종)\'s.pdf');

  const missing = await call('GET', '/api/stars/nope/file');
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'not_found' });
});

test('GET file: html and svg are attachments, text is inline text/plain', async () => {
  const { created } = await uploadOk([
    file('page.html', '<script>alert(1)</script>', 'text/html'),
    file('pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'),
    file('note.txt', '메모', 'text/plain'),
    file('song.mp3', 'ID3', 'audio/mpeg'),
    file('clip.mp4', 'ftyp', 'video/mp4'),
    file('doc.docx', 'PK', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  ]);
  const head = async (i) => (await call('GET', `/api/stars/${created[i].id}/file`)).headers;

  const html = await head(0);
  expect(html['content-type']).toBe('application/octet-stream');
  expect(html['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''page\.html$/);
  expect(html['x-content-type-options']).toBe('nosniff');

  const svg = await head(1);
  expect(svg['content-type']).toBe('image/svg+xml');
  expect(svg['content-disposition']).toMatch(/^attachment;/);
  expect(svg['x-content-type-options']).toBe('nosniff');

  const txt = await head(2);
  expect(txt['content-type']).toBe('text/plain; charset=utf-8');
  expect(txt['content-disposition']).toMatch(/^inline;/);

  expect((await head(3))['content-type']).toBe('audio/mpeg');
  expect((await head(3))['content-disposition']).toMatch(/^inline;/);
  expect((await head(4))['content-type']).toBe('video/mp4');
  expect((await head(4))['content-disposition']).toMatch(/^inline;/);
  expect((await head(5))['content-type']).toBe('application/octet-stream');
  expect((await head(5))['content-disposition']).toMatch(/^attachment;/);
});

test('open calls opener.open for pdf', async () => {
  const { created } = await uploadOk([file('a.pdf', 'pdf', 'application/pdf')]);
  const abs = path.join(dataDir, 'vault', `${created[0].id}.pdf`);
  const res = await call('POST', `/api/stars/${created[0].id}/open`);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toEqual({ action: 'opened' });
  expect(opened).toEqual([['open', abs]]);

  const reveal = await call('POST', `/api/stars/${created[0].id}/reveal`);
  expect(reveal.statusCode).toBe(200);
  expect(reveal.json()).toEqual({ action: 'revealed' });
  expect(opened).toEqual([['open', abs], ['reveal', abs]]);

  for (const action of ['open', 'reveal']) {
    const missing = await call('POST', `/api/stars/nope/${action}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  }
  expect(opened).toHaveLength(2);
});

test('open on .exe calls opener.reveal instead', async () => {
  const { created } = await uploadOk([
    file('setup.EXE', 'MZ'),
    file('run.bat', '@echo off'),
    file('script.js', 'alert(1)', 'text/javascript'),
    file('link.lnk', 'L'),
  ]);
  for (const star of created) {
    const ext = star.file_ext.toLowerCase();
    const res = await call('POST', `/api/stars/${star.id}/open`);
    expect(res.statusCode, ext).toBe(200);
    expect(res.json()).toEqual({ action: 'revealed' });
    expect(opened.at(-1)).toEqual(['reveal', path.join(dataDir, 'vault', `${star.id}.${ext}`)]);
  }
  expect(opened.filter(([kind]) => kind === 'open')).toEqual([]);
});

test('isExecutableExt covers the listed extensions, any case', () => {
  const list = 'exe bat cmd com msi lnk ps1 vbs js jse wsf scr pif cpl reg hta jar sh app command'.split(' ');
  for (const ext of list) {
    expect(isExecutableExt(ext), ext).toBe(true);
    expect(isExecutableExt(ext.toUpperCase()), ext).toBe(true);
  }
  for (const ext of ['pdf', 'txt', 'png', '', 'json', 'docx', undefined, null]) {
    expect(isExecutableExt(ext), String(ext)).toBe(false);
  }
});

test('open on text or link star → 400 no_file', async () => {
  const text = insertStar(app.db, { type: 'text', title: '글', body: '본문', planet_id: planet.id });
  const link = insertStar(app.db, { type: 'link', title: '링크', url: 'https://example.com', planet_id: planet.id });
  for (const star of [text, link]) {
    for (const [method, action] of [['POST', 'open'], ['POST', 'reveal'], ['GET', 'file']]) {
      const res = await call(method, `/api/stars/${star.id}/${action}`);
      expect(res.statusCode, `${star.type} ${action}`).toBe(400);
      expect(res.json()).toEqual({ error: 'no_file' });
    }
  }
  expect(opened).toEqual([]);
});

test('vault copy deleted from disk → file/open/reveal 404 file_missing', async () => {
  const buf = await png();
  const { created } = await uploadOk([file('a.png', buf, 'image/png')]);
  const { id } = created[0];
  fs.unlinkSync(path.join(dataDir, 'vault', `${id}.png`));
  fs.unlinkSync(path.join(dataDir, 'thumbs', `${id}.webp`));

  for (const [method, action] of [['GET', 'file'], ['POST', 'open'], ['POST', 'reveal'], ['GET', 'thumb']]) {
    const res = await call(method, `/api/stars/${id}/${action}`);
    expect(res.statusCode, action).toBe(404);
    expect(res.json()).toEqual({ error: 'file_missing' });
  }
  expect(opened).toEqual([]);
  // 별 자체는 그대로 있고, 지울 수도 있다.
  expect((await call('GET', `/api/stars/${id}`)).statusCode).toBe(200);
  expect((await call('DELETE', `/api/stars/${id}`)).statusCode).toBe(204);
  expect(dbRow(id)).toBeUndefined();
});

test('a stored vault_path that points outside the vault is never served, opened or deleted', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // 실패 기록은 화면에 남기지 않는다
  const outside = path.join(dataDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const star = insertStar(app.db, {
    type: 'file', title: '밖', file_name: 'secret.txt', file_ext: 'TXT', file_size: 6,
    vault_path: '../' + path.basename(dataDir) + '/secret.txt', planet_id: planet.id,
  });
  const other = insertStar(app.db, {
    type: 'file', title: '밖2', file_name: 'x.db', file_ext: 'DB', file_size: 1,
    vault_path: 'vault/../spacelog.db', thumb_path: 'vault/../secret.txt', planet_id: planet.id,
  });
  for (const id of [star.id, other.id]) {
    for (const [method, action] of [['GET', 'file'], ['POST', 'open'], ['POST', 'reveal']]) {
      const res = await call(method, `/api/stars/${id}/${action}`);
      expect(res.statusCode, action).toBe(404);
      expect(res.json()).toEqual({ error: 'file_missing' });
      expect(res.body).not.toContain('secret');
    }
  }
  expect((await call('GET', `/api/stars/${other.id}/thumb`)).statusCode).toBe(404);
  expect(opened).toEqual([]);
  expect((await call('DELETE', `/api/stars/${star.id}`)).statusCode).toBe(204);
  expect((await call('DELETE', `/api/stars/${other.id}`)).statusCode).toBe(204);
  expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
  expect(fs.existsSync(path.join(dataDir, 'spacelog.db'))).toBe(true);
});

test('resolveVault throws when the path escapes vault/', () => {
  const ok = resolveVault(dataDir, 'vault/abc.pdf');
  expect(ok).toBe(path.join(path.resolve(dataDir), 'vault', 'abc.pdf'));
  for (const bad of [
    '../x', 'vault/../spacelog.db', 'vault/../../x', 'thumbs/x.webp', 'vault', 'vault/', '', 'spacelog.db',
    'vault\\..\\spacelog.db', path.resolve(dataDir, 'spacelog.db'), 'C:\\Windows\\win.ini', '/etc/passwd',
    'vaultx/a', null, undefined, 5,
  ]) {
    expect(() => resolveVault(dataDir, bad), String(bad)).toThrow();
  }
});

test('saveUpload hashes while writing and reports too large', async () => {
  const body = Buffer.from('stream body');
  const saved = await saveUpload(dataDir, Readable.from([body.subarray(0, 4), body.subarray(4)]), { id: 'id1', ext: 'txt', maxBytes: 100 });
  expect(saved).toEqual({ vaultPath: 'vault/id1.txt', size: body.length, hash: sha256(body) });
  expect(fs.readFileSync(path.join(dataDir, 'vault', 'id1.txt')).equals(body)).toBe(true);

  const noExt = await saveUpload(dataDir, Readable.from([Buffer.from('x')]), { id: 'id2', ext: '', maxBytes: 100 });
  expect(noExt.vaultPath).toBe('vault/id2');

  const big = await saveUpload(dataDir, Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), { id: 'id3', ext: 'bin', maxBytes: 10 });
  expect(big).toEqual({ tooLarge: true });
  expect(vaultFiles()).toEqual(['id1.txt', 'id2']);

  const broken = new Readable({ read() { this.destroy(new Error('boom')); } });
  await expect(saveUpload(dataDir, broken, { id: 'id4', ext: 'bin', maxBytes: 10 })).rejects.toThrow('boom');
  expect(vaultFiles()).toEqual(['id1.txt', 'id2']);
});

test('makeThumb returns null for non-images; removeFiles tolerates missing files', async () => {
  fs.writeFileSync(path.join(dataDir, 'vault', 'junk.png'), 'not an image');
  expect(await makeThumb(dataDir, 'vault/junk.png', 'junk')).toBeNull();
  expect(thumbFiles()).toEqual([]);

  fs.writeFileSync(path.join(dataDir, 'vault', 'ok.png'), await png());
  expect(await makeThumb(dataDir, 'vault/ok.png', 'ok')).toBe('thumbs/ok.webp');
  await removeFiles(dataDir, { vault_path: 'vault/ok.png', thumb_path: 'thumbs/ok.webp' });
  expect(vaultFiles()).toEqual(['junk.png']);
  expect(thumbFiles()).toEqual([]);
  await removeFiles(dataDir, { vault_path: 'vault/ok.png', thumb_path: 'thumbs/ok.webp' });
  await removeFiles(dataDir, { vault_path: null, thumb_path: null });
});

test('delete star removes vault copy and thumb; still 204 when copy already gone', async () => {
  const buf = await png();
  const { created } = await uploadOk([file('a.png', buf, 'image/png'), file('b.pdf', 'pdf', 'application/pdf'), file('keep.txt', 'keep')]);
  const [img, pdf, keep] = created;
  expect(vaultFiles()).toHaveLength(3);
  expect(thumbFiles()).toEqual([`${img.id}.webp`]);

  expect((await call('DELETE', `/api/stars/${img.id}`)).statusCode).toBe(204);
  expect(vaultFiles()).toEqual([`${pdf.id}.pdf`, `${keep.id}.txt`].sort());
  expect(thumbFiles()).toEqual([]);

  fs.unlinkSync(path.join(dataDir, 'vault', `${pdf.id}.pdf`));
  expect((await call('DELETE', `/api/stars/${pdf.id}`)).statusCode).toBe(204);
  expect(dbRow(pdf.id)).toBeUndefined();
  expect(vaultFiles()).toEqual([`${keep.id}.txt`]);

  // 지운 파일은 다시 담을 수 있다.
  const again = await uploadOk([file('a.png', buf, 'image/png')]);
  expect(again.skipped).toEqual([]);
  expect(again.created).toHaveLength(1);
});

test('deleting a planet with stars=delete removes their vault copies and thumbs', async () => {
  const other = createPlanet(app.db, { name: '남는 행성' });
  const buf = await png();
  const gone = await uploadOk([file('a.png', buf, 'image/png'), file('b.pdf', 'pdf', 'application/pdf')]);
  const kept = await uploadOk([file('keep.txt', 'keep')], { planet_id: other.id });
  expect(vaultFiles()).toHaveLength(3);
  expect(thumbFiles()).toHaveLength(1);

  const res = await call('DELETE', `/api/planets/${planet.id}?stars=delete`);
  expect(res.statusCode, res.body).toBe(204);
  expect(vaultFiles()).toEqual([`${kept.created[0].id}.txt`]);
  expect(thumbFiles()).toEqual([]);
  for (const star of gone.created) expect(dbRow(star.id)).toBeUndefined();
  expect(dbRow(kept.created[0].id)).toBeDefined();
});

test('corrupt image still saves without thumb', async () => {
  const { created, skipped } = await uploadOk([file('broken.png', 'this is not a png at all', 'image/png')]);
  expect(skipped).toEqual([]);
  expect(created).toHaveLength(1);
  expect(created[0].type).toBe('image');
  expect(created[0].has_thumb).toBe(false);
  expect(dbRow(created[0].id).thumb_path).toBeNull();
  expect(vaultFiles()).toEqual([`${created[0].id}.png`]);
  expect(thumbFiles()).toEqual([]);
  const thumb = await call('GET', `/api/stars/${created[0].id}/thumb`);
  expect(thumb.statusCode).toBe(404);
});

test('no temp files are left behind after uploads', async () => {
  await uploadOk([file('a.txt', 'a'), file('b.txt', 'a'), file('c.png', 'junk', 'image/png')]);
  await upload([file('d.txt', 'd')], { planet_id: 'nope' });
  expect(vaultFiles().filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  expect(vaultFiles()).toHaveLength(2);
});

test('opener defaults to defaultOpener, which exposes open and reveal', async () => {
  const other = await makeApp();
  extra.push(other);
  expect(other.app.config.opener).toBe(defaultOpener);
  expect(typeof defaultOpener.open).toBe('function');
  expect(typeof defaultOpener.reveal).toBe('function');
});

test('opener failure → 500 open_failed, server keeps working', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // 실패 기록은 화면에 남기지 않는다
  const failing = await makeApp({
    opener: {
      open: () => { throw new Error('boom'); },
      reveal: async () => { throw new Error('boom'); },
    },
  });
  extra.push(failing);
  const p = createPlanet(failing.app.db, { name: 'p' });
  const { created } = (await upload([file('a.pdf', 'pdf')], { planet_id: p.id, target: failing.app })).json();
  for (const action of ['open', 'reveal']) {
    const res = await call('POST', `/api/stars/${created[0].id}/${action}`, failing.app);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'open_failed' });
  }
  expect((await call('GET', '/api/health', failing.app)).statusCode).toBe(200);
});

test('parseFileName keeps only the last path segment and a safe extension', () => {
  expect(parseFileName('..\\..\\evil.txt')).toEqual({ fileName: 'evil.txt', ext: 'txt', stem: 'evil' });
  expect(parseFileName('/etc/../passwd')).toEqual({ fileName: 'passwd', ext: '', stem: 'passwd' });
  expect(parseFileName('dir/')).toEqual({ fileName: 'dir', ext: '', stem: 'dir' });
  expect(parseFileName('a\u0000b\r\n.PDF')).toEqual({ fileName: 'ab.PDF', ext: 'pdf', stem: 'ab' });
  expect(parseFileName('x.p/f')).toEqual({ fileName: 'f', ext: '', stem: 'f' });
  for (const empty of ['', '///', '\\\\', undefined, null]) {
    expect(parseFileName(empty), String(empty)).toEqual({ fileName: 'untitled', ext: '', stem: 'untitled' });
  }
  // macOS 가 보내는 풀어 쓴 한글(NFD)은 합쳐서 저장한다.
  expect(parseFileName('한글.txt'.normalize('NFD')).fileName).toBe('한글.txt'.normalize('NFC'));
});

test('openerCommand never goes through a shell and keeps odd paths as one argument', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const odd = 'C:\\Users\\전 현우\\a&b %PATH% ^x\\vault\\id.pdf';
  expect(openerCommand('open', odd, 'win32', env)).toEqual({
    cmd: 'C:\\Windows\\explorer.exe',
    args: [`"${odd}"`],
    options: { windowsVerbatimArguments: true },
  });
  expect(openerCommand('reveal', odd, 'win32', env)).toEqual({
    cmd: 'C:\\Windows\\explorer.exe',
    args: [`/select,"${odd}"`],
    options: { windowsVerbatimArguments: true },
  });
  expect(() => openerCommand('reveal', 'C:\\a" /root,"C:\\b', 'win32', env)).toThrow();
  expect(openerCommand('open', '/tmp/a b.pdf', 'darwin')).toEqual({ cmd: 'open', args: ['/tmp/a b.pdf'], options: {} });
  expect(openerCommand('reveal', '/tmp/a b.pdf', 'darwin')).toEqual({ cmd: 'open', args: ['-R', '/tmp/a b.pdf'], options: {} });
  expect(openerCommand('open', '/tmp/a b.pdf', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/tmp/a b.pdf'], options: {} });
  expect(openerCommand('reveal', '/tmp/a b.pdf', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/tmp'], options: {} });
  for (const bad of ['', null, undefined, 'a\u0000b']) {
    expect(() => openerCommand('open', bad, 'win32', env), String(bad)).toThrow();
  }
});

// ---- 열기 허용 목록 ----

test('open uses an allowlist: only known document/media/archive types open, the rest are revealed', async () => {
  const table = [
    ['A.PDF', 'open'], ['사진.png', 'open'], ['notes.md', 'open'], ['보고서.hwp', 'open'], ['clip.MKV', 'open'],
    ['pack.zip', 'open'], ['archive.tar.gz', 'open'], ['sheet.xlsx', 'open'],
    ['a.pdf.exe', 'reveal'], ['README', 'reveal'], ['macro.docm', 'reveal'], ['site.url', 'reveal'],
    ['page.html', 'reveal'], ['pic.svg', 'reveal'], ['x.htm', 'reveal'], ['data.xml', 'reveal'], ['s.lnk', 'reveal'],
    ['disk.iso', 'reveal'], ['run.py', 'reveal'], ['run.ps1', 'reveal'], ['book.xlsm', 'reveal'], ['이름.한글', 'reveal'],
    ['help.chm', 'reveal'], ['unknown.xyz', 'reveal'],
  ];
  const { created } = await uploadOk(table.map(([name], i) => file(name, `content ${i}`)));
  expect(created).toHaveLength(table.length);
  for (const [i, [name, expected]] of table.entries()) {
    const res = await call('POST', `/api/stars/${created[i].id}/open`);
    expect(res.statusCode, name).toBe(200);
    expect(res.json(), name).toEqual({ action: expected === 'open' ? 'opened' : 'revealed' });
    expect(opened.at(-1)[0], name).toBe(expected);
    expect(opened.at(-1)[1], name).toBe(path.join(dataDir, dbRow(created[i].id).vault_path));
  }
  expect(opened).toHaveLength(table.length);
});

test('isOpenableExt lists exactly the allowed extensions, any case', () => {
  const allowed = [
    'png jpg jpeg gif webp bmp tif tiff heic avif ico',
    'pdf txt md csv log json rtf doc docx xls xlsx ppt pptx hwp hwpx odt ods odp epub',
    'mp3 wav m4a flac ogg aac mp4 mov mkv webm avi m4v',
    'zip 7z rar tar gz',
  ].join(' ').split(' ');
  for (const ext of allowed) {
    expect(isOpenableExt(ext), ext).toBe(true);
    expect(isOpenableExt(ext.toUpperCase()), ext).toBe(true);
  }
  const denied = 'svg html htm xml url lnk scf chm docm xlsm pptm iso img js py ps1 exe bat cmd msi jar sh vbs hta reg'.split(' ');
  for (const ext of [...denied, '', 'pdf ', '.pdf', 'constructor', 'toString', undefined, null, 5]) {
    expect(isOpenableExt(ext), String(ext)).toBe(false);
  }
});

// ---- 올리기 상한 · 부분 성공 ----

test('file-count limit → 200 with what was saved and a too_many entry', async () => {
  const small = await makeApp({ maxFiles: 3, opener: fakeOpener([]) });
  extra.push(small);
  const p = createPlanet(small.app.db, { name: 'p' });
  const res = await upload(
    [file('1.txt', 'one'), file('2.txt', 'two'), file('3.txt', 'three'), file('4.txt', 'four'), file('5.txt', 'five')],
    { planet_id: p.id, target: small.app },
  );
  expect(res.statusCode, res.body).toBe(200);
  const { created, skipped } = res.json();
  expect(created.map((s) => s.file_name)).toEqual(['1.txt', '2.txt', '3.txt']);
  expect(skipped).toEqual([{ file_name: null, reason: 'too_many' }]);
  expect(starCount(small.app)).toBe(3);
  expect(vaultFiles(small.dataDir)).toEqual(created.map((s) => `${s.id}.txt`).sort());

  // 꼭 상한만큼이면 걸리지 않는다.
  const exact = await upload([file('6.txt', 'six'), file('7.txt', 'seven'), file('8.txt', 'eight')], { planet_id: p.id, target: small.app });
  expect(exact.json().skipped).toEqual([]);
  expect(exact.json().created).toHaveLength(3);
});

test('default file-count limit is 500', async () => {
  expect(app.config.maxFiles).toBe(500);
});

// 이름이 boom 으로 시작하는 파일은 DB 에 넣을 때 실패하게 한다.
function failInsertsNamedBoom(target = app) {
  target.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON stars WHEN NEW.file_name LIKE 'boom%'
    BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
}

test('unexpected error after some files were saved → 200, failed file listed, later files still saved', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  failInsertsNamedBoom();
  const res = await upload([file('a.txt', 'aaa'), file('boom.txt', 'bbb'), file('c.txt', 'ccc')]);
  expect(res.statusCode, res.body).toBe(200);
  const { created, skipped } = res.json();
  expect(created.map((s) => s.file_name)).toEqual(['a.txt', 'c.txt']);
  expect(skipped).toEqual([{ file_name: 'boom.txt', reason: 'failed' }]);
  expect(starCount()).toBe(2);
  // 실패한 파일의 사본은 남지 않는다.
  expect(vaultFiles()).toEqual(created.map((s) => `${s.id}.txt`).sort());
  expect(errors).toHaveBeenCalled();
  expect(String(errors.mock.calls[0][0])).toContain('boom.txt');
});

test('unexpected error with nothing saved → 500 server_error, nothing left in the vault', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  failInsertsNamedBoom();
  const res = await upload([file('boom.txt', 'bbb'), file('boom2.png', await png(), 'image/png')]);
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({ error: 'server_error' });
  expect(starCount()).toBe(0);
  expect(vaultFiles()).toEqual([]);
  expect(thumbFiles()).toEqual([]);
  expect(errors).toHaveBeenCalled();
  // 서버는 계속 돈다.
  expect((await uploadOk([file('ok.txt', 'ok')])).created).toHaveLength(1);
});

test('memo over 20000 characters or truncated → 400 invalid_memo before any file is written', async () => {
  const ok = await uploadOk([file('ok.txt', 'ok')], { memo: '가'.repeat(20000) });
  expect(ok.created[0].memo).toBe('가'.repeat(20000));

  for (const memo of ['가'.repeat(20001), 'x'.repeat(1024 * 1024 + 10)]) {
    const res = await upload([file('a.txt', 'aaa'), file('b.txt', 'bbb')], { memo });
    expect(res.statusCode, String(memo.length)).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_memo' });
  }
  expect(starCount()).toBe(1);
  expect(vaultFiles()).toHaveLength(1);
});

test('titles are trimmed and cut to 200 characters; truncated titles field → 400 invalid_titles', async () => {
  const { created } = await uploadOk(
    [file('a.txt', '1'), file('b.txt', '2'), file('c.txt', '3')],
    { titles: [`  ${'별'.repeat(250)}  `, '   ', `${'x'.repeat(199)} 뒤`] },
  );
  expect(created[0].title).toBe('별'.repeat(200));
  expect(created[1].title).toBe('b');
  expect(created[2].title).toBe('x'.repeat(199)); // 자른 뒤 끝에 남은 공백도 뗀다

  const huge = JSON.stringify(['y'.repeat(1024 * 1024 + 10)]);
  const res = await upload([file('d.txt', '4')], { titles: huge });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_titles' });
  expect(starCount()).toBe(3);
  expect(vaultFiles()).toHaveLength(3);
});

// ---- Range ----

function getRange(id, range) {
  return app.inject({ method: 'GET', url: `/api/stars/${id}/file`, headers: { ...HOST, range } });
}

test('GET file supports a single byte range', async () => {
  const { created } = await uploadOk([file('clip.mp4', '0123456789', 'video/mp4')]);
  const { id } = created[0];

  const full = await call('GET', `/api/stars/${id}/file`);
  expect(full.statusCode).toBe(200);
  expect(full.headers['accept-ranges']).toBe('bytes');
  expect(full.headers['content-range']).toBeUndefined();

  const cases = [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=0-0', '0', 'bytes 0-0/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-100', '0123456789', 'bytes 0-9/10'],
    ['bytes=5-999', '56789', 'bytes 5-9/10'],
    ['bytes=0-', '0123456789', 'bytes 0-9/10'],
  ];
  for (const [range, body, contentRange] of cases) {
    const res = await getRange(id, range);
    expect(res.statusCode, range).toBe(206);
    expect(res.body, range).toBe(body);
    expect(res.headers['content-range'], range).toBe(contentRange);
    expect(res.headers['content-length'], range).toBe(String(body.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
  }
});

test('GET file: unsatisfiable range → 416 with Content-Range: bytes */size', async () => {
  const { created } = await uploadOk([file('clip.mp4', '0123456789', 'video/mp4'), file('empty.mp4', '', 'video/mp4')]);
  for (const range of ['bytes=10-', 'bytes=10-20', 'bytes=999-', 'bytes=-0']) {
    const res = await getRange(created[0].id, range);
    expect(res.statusCode, range).toBe(416);
    expect(res.headers['content-range'], range).toBe('bytes */10');
    expect(res.json()).toEqual({ error: 'range_not_satisfiable' });
  }
  const empty = await getRange(created[1].id, 'bytes=0-');
  expect(empty.statusCode).toBe(416);
  expect(empty.headers['content-range']).toBe('bytes */0');
});

test('GET file: multi-range or malformed Range is ignored → 200 full body', async () => {
  const { created } = await uploadOk([file('clip.mp4', '0123456789', 'video/mp4')]);
  for (const range of ['bytes=0-1,3-4', 'bytes=5-2', 'bytes=-', 'bytes=abc', 'items=0-3', 'bytes=1-2-3', '', 'bytes=99999999999999999999-']) {
    const res = await getRange(created[0].id, range);
    expect(res.statusCode, range).toBe(200);
    expect(res.body, range).toBe('0123456789');
    expect(res.headers['content-length'], range).toBe('10');
    expect(res.headers['content-range'], range).toBeUndefined();
  }
});

test('parseRange', () => {
  expect(parseRange(undefined, 10)).toBeNull();
  expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
  expect(parseRange(' bytes=4- ', 10)).toEqual({ start: 4, end: 9 });
  expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
  expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
  expect(parseRange('bytes=0-1, 2-3', 10)).toBeNull();
});

// ---- 시작할 때 청소 ----

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

function put(sub, name, { ageMs = 0 } = {}) {
  const abs = path.join(dataDir, sub, name);
  fs.writeFileSync(abs, 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(abs, t, t);
  return abs;
}

const HOURS = 60 * 60 * 1000;

test('startup removes leftover vault/.tmp-* files', async () => {
  await app.close();
  put('vault', `.tmp-${UUID_A}`);
  put('vault', '.tmp-old', { ageMs: 30 * HOURS });
  put('vault', 'tmp-not-ours.txt', { ageMs: 30 * HOURS });
  put('thumbs', '.tmp-in-thumbs', { ageMs: 30 * HOURS });
  fs.mkdirSync(path.join(dataDir, 'vault', '.tmp-folder'));

  app = buildApp({ dataDir, opener: fakeOpener(opened) });
  await app.ready();
  expect(vaultFiles()).toEqual(['.tmp-folder', 'tmp-not-ours.txt']);
  expect(thumbFiles()).toEqual(['.tmp-in-thumbs']);
});

test('startup removes only old orphans that match the vault naming pattern', async () => {
  const buf = await png();
  const { created } = await uploadOk([file('keep.png', buf, 'image/png'), file('keep', 'no ext')]);
  const [img, bare] = created;
  await app.close();

  // 별이 있는 파일은 오래됐어도 남는다.
  const old = new Date(Date.now() - 48 * HOURS);
  for (const rel of [`vault/${img.id}.png`, `thumbs/${img.id}.webp`, `vault/${bare.id}`]) {
    fs.utimesSync(path.join(dataDir, rel), old, old);
  }
  const kept = [
    put('vault', 'notes.txt', { ageMs: 48 * HOURS }), // 사용자가 넣어 둔 파일
    put('vault', `${UUID_A}.pdf.bak`, { ageMs: 48 * HOURS }), // 모양이 다르다
    put('vault', `x${UUID_A}.pdf`, { ageMs: 48 * HOURS }),
    put('vault', `copy of ${UUID_A}.pdf`, { ageMs: 48 * HOURS }),
    put('vault', `${UUID_B}.pdf`, { ageMs: 10 * 60 * 1000 }), // 주인이 없지만 1시간이 안 됐다
    put('thumbs', `${UUID_B}.webp`),
    put('thumbs', `${UUID_A}.png`, { ageMs: 48 * HOURS }), // thumbs 는 .webp 만
    put('thumbs', 'notes.txt', { ageMs: 48 * HOURS }),
  ];
  fs.mkdirSync(path.join(dataDir, 'vault', UUID_C)); // 폴더는 건드리지 않는다
  fs.utimesSync(path.join(dataDir, 'vault', UUID_C), old, old);
  const gone = [
    put('vault', `${UUID_A}.pdf`, { ageMs: 2 * HOURS }),
    put('vault', UUID_B, { ageMs: 48 * HOURS }),
    put('thumbs', `${UUID_A}.webp`, { ageMs: 2 * HOURS }),
  ];

  app = buildApp({ dataDir, opener: fakeOpener(opened) });
  await app.ready();
  for (const abs of kept) expect(fs.existsSync(abs), abs).toBe(true);
  for (const abs of gone) expect(fs.existsSync(abs), abs).toBe(false);
  expect(fs.existsSync(path.join(dataDir, 'vault', UUID_C))).toBe(true);
  for (const rel of [`vault/${img.id}.png`, `thumbs/${img.id}.webp`, `vault/${bare.id}`]) {
    expect(fs.existsSync(path.join(dataDir, rel)), rel).toBe(true);
  }
  expect((await call('GET', `/api/stars/${img.id}/file`)).statusCode).toBe(200);
});

test('sweepVault reports what it removed and survives a missing folder', () => {
  put('vault', '.tmp-x');
  put('vault', `${UUID_A}.txt`, { ageMs: 2 * HOURS });
  put('vault', `${UUID_B}.txt`, { ageMs: 2 * HOURS });
  expect(sweepVault(dataDir, (id) => id === UUID_B)).toEqual({ tmp: 1, orphans: 1 });
  expect(vaultFiles()).toEqual([`${UUID_B}.txt`]);

  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(sweepVault(path.join(dataDir, 'nope'), () => false)).toEqual({ tmp: 0, orphans: 0 });
  expect(errors).toHaveBeenCalled();
});

// ---- 빈 파일 ----

test('empty files are never duplicates: two empty files → two stars with no hash', async () => {
  const { created, skipped } = await uploadOk([file('empty1.txt', ''), file('empty2.log', '')]);
  expect(skipped).toEqual([]);
  expect(created.map((s) => [s.file_name, s.file_size])).toEqual([['empty1.txt', 0], ['empty2.log', 0]]);
  for (const star of created) expect(dbRow(star.id).file_hash).toBeNull();

  const again = await uploadOk([file('empty3.txt', '')]);
  expect(again.skipped).toEqual([]);
  expect(again.created).toHaveLength(1);
  expect(starCount()).toBe(3);
  expect(vaultFiles()).toHaveLength(3);
});

// ---- Windows 열기 명령 ----

test('windows open/reveal commands quote the path verbatim and reject double quotes', () => {
  const env = { SystemRoot: 'D:\\WinDir' };
  const paths = [
    'C:\\data\\a,b.pdf',
    'C:\\Users\\전 현우\\spaceLog\\vault\\id.pdf',
    'C:\\a&b\\100%done (final)\\%PATH%\\^x,y.png',
    'C:\\한글,쉼표\\파일 (1).hwp',
  ];
  for (const p of paths) {
    expect(windowsOpenCommand(p, env)).toEqual({
      cmd: 'D:\\WinDir\\explorer.exe',
      args: [`"${p}"`],
      options: { windowsVerbatimArguments: true },
    });
    expect(windowsRevealCommand(p, env)).toEqual({
      cmd: 'D:\\WinDir\\explorer.exe',
      args: [`/select,"${p}"`],
      options: { windowsVerbatimArguments: true },
    });
    expect(openerCommand('open', p, 'win32', env)).toEqual(windowsOpenCommand(p, env));
    expect(openerCommand('reveal', p, 'win32', env)).toEqual(windowsRevealCommand(p, env));
  }
  expect(windowsOpenCommand('C:\\a.pdf', {}).cmd).toBe('C:\\Windows\\explorer.exe');
  for (const bad of ['C:\\a" /root,"C:\\b', '"', '', null, undefined, 'a\u0000b']) {
    expect(() => windowsOpenCommand(bad, env), String(bad)).toThrow();
    expect(() => windowsRevealCommand(bad, env), String(bad)).toThrow();
    expect(() => openerCommand('open', bad, 'win32', env), String(bad)).toThrow();
  }
});

// ---- 내보내기 정책 · 이름 ----

test('GET file sends a Content-Security-Policy: locked down for attachments and text, media-only for viewable types', async () => {
  const { created } = await uploadOk([
    file('page.html', '<script>alert(1)</script>', 'text/html'),
    file('pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'),
    file('note.txt', '메모', 'text/plain'),
    file('data.json', '{}', 'application/json'),
    file('bin', 'raw'),
    file('a.pdf', '%PDF-1.4', 'application/pdf'),
    file('a.png', await png(), 'image/png'),
    file('a.mp3', 'ID3', 'audio/mpeg'),
    file('a.mp4', 'ftyp', 'video/mp4'),
  ]);
  const csp = async (i, range) => (await (range ? getRange(created[i].id, range) : call('GET', `/api/stars/${created[i].id}/file`)))
    .headers['content-security-policy'];
  for (const i of [0, 1, 2, 3, 4]) {
    expect(await csp(i), created[i].file_name).toBe("sandbox; default-src 'none'");
  }
  for (const i of [5, 6, 7, 8]) {
    const value = await csp(i);
    expect(value, created[i].file_name).toMatch(/^default-src 'none';/);
    expect(value).not.toMatch(/sandbox/);
    expect(value).not.toMatch(/script-src|unsafe-eval|\*|https?:/);
  }
  expect(await csp(8, 'bytes=0-1')).toMatch(/^default-src 'none';/);
  expect(await csp(0, 'bytes=0-1')).toBe("sandbox; default-src 'none'");
});

test('parseFileName strips bidi controls and C1 control characters', () => {
  // U+202E 로 뒤집어 "exe.pdf" 가 "fdp.exe" 처럼 보이게 하는 이름
  expect(parseFileName('invoice\u202Efdp.exe')).toEqual({ fileName: 'invoicefdp.exe', ext: 'exe', stem: 'invoicefdp' });
  const all = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u0080\u0085\u009F';
  expect(parseFileName(`a${all}b.t${all}xt`)).toEqual({ fileName: 'ab.txt', ext: 'txt', stem: 'ab' });
  expect(parseFileName(all)).toEqual({ fileName: 'untitled', ext: '', stem: 'untitled' });
  // 보이는 글자는 그대로
  expect(parseFileName('한글 ü é.pdf').fileName).toBe('한글 ü é.pdf');
});

test('image star only when both the MIME type and the extension say raster image', async () => {
  const buf = await png();
  const { created } = await uploadOk([
    file('h.html', buf, 'image/png'),
    file('pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'),
    file('noext', Buffer.concat([buf, Buffer.from('1')]), 'image/png'),
    file('photo.png', Buffer.concat([buf, Buffer.from('2')]), 'application/octet-stream'),
    file('real.PNG', Buffer.concat([buf, Buffer.from('3')]), 'IMAGE/PNG'),
  ]);
  expect(created.map((s) => [s.file_name, s.type, s.has_thumb])).toEqual([
    ['h.html', 'file', false],
    ['pic.svg', 'file', false],
    ['noext', 'file', false],
    ['photo.png', 'file', false],
    ['real.PNG', 'image', true],
  ]);
  expect(thumbFiles()).toEqual([`${created[4].id}.webp`]);

  for (const ext of 'png jpg jpeg gif webp bmp avif tif tiff heic'.split(' ')) {
    expect(isImageUpload('image/whatever', ext), ext).toBe(true);
    expect(isImageUpload('application/octet-stream', ext), ext).toBe(false);
  }
  for (const ext of ['svg', 'ico', 'html', '', undefined]) expect(isImageUpload('image/png', ext), String(ext)).toBe(false);
});

// ---- 정리 실패 기록 ----

test('a failing vault cleanup is logged with the star id and the delete still succeeds', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const other = createPlanet(app.db, { name: '지울 행성' });
  const one = (await uploadOk([file('a.txt', 'aaa')])).created[0];
  const two = (await uploadOk([file('b.txt', 'bbb'), file('c.txt', 'ccc')], { planet_id: other.id })).created;
  app.removeStarFiles = async () => { throw new Error('disk says no'); };

  expect((await call('DELETE', `/api/stars/${one.id}`)).statusCode).toBe(204);
  expect(dbRow(one.id)).toBeUndefined();
  expect(errors).toHaveBeenCalledTimes(1);
  expect(String(errors.mock.calls[0][0])).toContain(one.id);
  expect(errors.mock.calls[0][1]).toBeInstanceOf(Error);

  expect((await call('DELETE', `/api/planets/${other.id}?stars=delete`)).statusCode).toBe(204);
  expect(errors).toHaveBeenCalledTimes(3);
  const logged = errors.mock.calls.slice(1).map((c) => String(c[0])).join('\n');
  for (const star of two) expect(logged).toContain(star.id);
});
