// POST /api/stars — 글 + 첨부 파일 + 링크 → 별 하나 (spec 6-9)
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPlanet } from '../planets.js';
import { insertStar } from '../stars.js';
import { cleanup, makeApp, multipartBody } from './helpers.js';

const HOST = { host: '127.0.0.1:4747' };

let app;
let dataDir;
let planet;
let opened;
let fetched;
let titleFor;
const extra = [];

beforeEach(async () => {
  opened = [];
  fetched = [];
  titleFor = (url) => `제목 ${url}`;
  ({ app, dataDir } = await makeApp({
    opener: { open: (p) => { opened.push(['open', p]); }, reveal: (p) => { opened.push(['reveal', p]); } },
    fetchTitle: async (url) => {
      fetched.push(url);
      return titleFor(url);
    },
  }));
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

const file = (filename, content = 'hello', mime = 'application/octet-stream') => ['file', 'files', filename, mime, content];
const png = (color = '#ff0000', size = 1) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 글 필드를 먼저, 파일을 뒤에 둔 multipart 조각들.
function partsOf(fields, files) {
  const parts = [];
  const all = { planet_id: planet.id, ...fields };
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined) continue;
    parts.push(['field', k, k === 'links' && typeof v !== 'string' ? JSON.stringify(v) : v]);
  }
  parts.push(...files);
  return parts;
}

function send(fields, files = [], { target = app, end = true } = {}) {
  const { payload, contentType } = multipartBody(partsOf(fields, files), { end });
  return target.inject({ method: 'POST', url: '/api/stars', headers: { ...HOST, 'content-type': contentType }, payload });
}

// 실제 소켓(임시 포트)으로 보내되 본문을 끝내지 않는다(inject 는 본문을 다 모은 뒤에야 넘긴다).
// 서버가 남은 본문을 기다리지 않고 바로 답해야 응답이 온다. → { statusCode, body }
async function sendUnfinished(fields, files = []) {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const { payload, contentType } = multipartBody(partsOf(fields, files), { end: false });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/stars', agent: false,
      headers: { ...HOST, 'content-type': contentType },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        req.destroy();
        resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('no response while the body was still open: the server waited for the rest'));
    }, 3000);
    req.on('error', () => {});
    req.write(payload); // req.end() 는 부르지 않는다.
  });
}

async function sendOk(fields, files, opts) {
  const res = await send(fields, files, opts);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function postJson(body, target = app) {
  return target.inject({ method: 'POST', url: '/api/stars', headers: HOST, payload: body });
}

function call(method, url, target = app) {
  return target.inject({ method, url, headers: HOST });
}

const count = (table, target = app) => target.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
const attRows = (starId) => app.db.prepare('SELECT * FROM attachments WHERE star_id = ? ORDER BY position').all(starId);
const vaultFiles = (dir = dataDir) => fs.readdirSync(path.join(dir, 'vault')).sort();
const thumbFiles = (dir = dataDir) => fs.readdirSync(path.join(dir, 'thumbs')).sort();

test('body + 2 files + 1 link → one star with 3 attachments: files in upload order, then links', async () => {
  const img = await png();
  const { star, skipped } = await sendOk(
    { body: '오늘 회의\n둘째 줄', links: ['https://example.com/a'], memo: '메모' },
    [file('사진.png', img, 'image/png'), file('보고서.pdf', '%PDF-1.4', 'application/pdf')],
  );
  expect(skipped).toEqual([]);
  expect(star.title).toBe('오늘 회의');
  expect(star.body).toBe('오늘 회의\n둘째 줄');
  expect(star.memo).toBe('메모');
  expect(star.type).toBe('image');
  expect(star.attachment_count).toBe(3);
  expect(star.attachments.map((a) => [a.kind, a.position, a.file_name ?? a.url])).toEqual([
    ['image', 0, '사진.png'],
    ['file', 1, '보고서.pdf'],
    ['link', 2, 'https://example.com/a'],
  ]);
  const [image, pdf, link] = star.attachments;
  expect(image).toMatchObject({ file_ext: 'PNG', file_size: img.length, has_thumb: true, url: null, link_title: null });
  expect(pdf).toMatchObject({ file_ext: 'PDF', file_size: 8, has_thumb: false });
  expect(link).toMatchObject({ link_title: '제목 https://example.com/a', file_name: null, file_size: null, has_thumb: false });
  expect(star.has_thumb).toBe(true);
  expect(star.thumb_attachment_id).toBe(image.id);
  for (const leaked of ['vault_path', 'thumb_path', 'file_hash', 'search_text']) {
    expect(JSON.stringify(star)).not.toContain(leaked);
  }

  // 보관함 이름은 <첨부 id>.<ext>, 축소본은 thumbs/<첨부 id>.webp
  expect(vaultFiles()).toEqual([`${image.id}.png`, `${pdf.id}.pdf`].sort());
  expect(thumbFiles()).toEqual([`${image.id}.webp`]);
  const rows = attRows(star.id);
  expect(rows.map((r) => r.vault_path)).toEqual([`vault/${image.id}.png`, `vault/${pdf.id}.pdf`, null]);
  expect(rows[1].file_hash).toBe(sha256(Buffer.from('%PDF-1.4')));
  expect(rows.every((r) => r.created_at === star.created_at)).toBe(true);
  const row = app.db.prepare('SELECT * FROM stars WHERE id = ?').get(star.id);
  expect(row.search_text).toBe('오늘 회의\n오늘 회의\n둘째 줄\n메모\n사진.png\n보고서.pdf\n제목 https://example.com/a\nhttps://example.com/a');
  expect(row.type).toBe('image');

  // 목록과 하나 읽기도 같은 모양
  expect((await call('GET', `/api/stars/${star.id}`)).json()).toEqual(star);
  expect((await call('GET', '/api/stars')).json()).toEqual([star]);
  expect(count('stars')).toBe(1);
});

test('multipart text fields get CRLF line breaks (form encoding) normalised to LF like JSON', async () => {
  const { star } = await sendOk({ title: '제목', body: '첫 줄\r\n둘째 줄\r\n', memo: '메모\r\n끝' });
  expect(star.body).toBe('첫 줄\n둘째 줄\n');
  expect(star.memo).toBe('메모\n끝');
});

test('multipart with only text, or only links, works; files without body take their title from the first file', async () => {
  const text = await sendOk({ body: '글만' });
  expect(text.star).toMatchObject({ type: 'text', title: '글만', attachment_count: 0, attachments: [] });

  const links = await sendOk({ links: ['https://example.com/1', 'http://example.com/2'] });
  expect(links.star.type).toBe('link');
  expect(links.star.title).toBe('제목 https://example.com/1');
  expect(links.star.body).toBeNull();
  expect(links.star.attachments.map((a) => a.url)).toEqual(['https://example.com/1', 'http://example.com/2']);

  const files = await sendOk({ links: ['https://example.com/3'] }, [file('21일차 과제.pdf', 'x', 'application/pdf'), file('b.txt', 'y')]);
  expect(files.star.title).toBe('21일차 과제');
  expect(files.star.type).toBe('file');

  const given = await sendOk({ title: `  ${'별'.repeat(250)}  `, body: '본문' });
  expect(given.star.title).toBe('별'.repeat(200));
});

test('JSON create: { planet_id, title?, body?, links?, memo? } → 201 { star, skipped }', async () => {
  const res = await postJson({ planet_id: planet.id, body: '첫 줄\n둘째', links: ['https://example.com/x'], memo: 'm' });
  expect(res.statusCode, res.body).toBe(201);
  const { star, skipped } = res.json();
  expect(skipped).toEqual([]);
  expect(star).toMatchObject({ type: 'link', title: '첫 줄', body: '첫 줄\n둘째', memo: 'm', attachment_count: 1 });
  expect(star.attachments[0]).toMatchObject({ kind: 'link', position: 0, url: 'https://example.com/x', link_title: '제목 https://example.com/x' });

  const onlyLinks = (await postJson({ planet_id: planet.id, links: ['https://example.com/y'] })).json();
  expect(onlyLinks.star.title).toBe('제목 https://example.com/y');

  for (const body of [{ planet_id: planet.id }, { planet_id: planet.id, body: '  \n ' }, { planet_id: planet.id, links: [] }]) {
    const empty = await postJson(body);
    expect(empty.statusCode, JSON.stringify(body)).toBe(400);
    expect(empty.json()).toEqual({ error: 'empty_star' });
  }
  const emptyMultipart = await send({});
  expect(emptyMultipart.statusCode).toBe(400);
  expect(emptyMultipart.json()).toEqual({ error: 'empty_star' });
  expect(count('stars')).toBe(2);
});

test('title fallback: link title fetch failure → URL; title rules in order', async () => {
  titleFor = () => null;
  const a = (await postJson({ planet_id: planet.id, links: ['https://example.com/fail'] })).json().star;
  expect(a.title).toBe('https://example.com/fail');
  expect(a.attachments[0].link_title).toBeNull();

  titleFor = () => { throw new Error('offline'); };
  const b = await sendOk({ links: ['https://example.com/throw'] });
  expect(b.star.title).toBe('https://example.com/throw');
  expect(b.star.attachments[0].link_title).toBeNull();

  const long = `https://example.com/${'a'.repeat(300)}`;
  const c = (await postJson({ planet_id: planet.id, links: [long] })).json().star;
  expect(c.title).toBe(long.slice(0, 200));
  expect(c.attachments[0].url).toBe(long);
});

test('link titles are fetched concurrently and before the DB write', async () => {
  let active = 0;
  let peak = 0;
  titleFor = async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;
    return `t ${url}`;
  };
  const urls = ['https://example.com/1', 'https://example.com/2', 'https://example.com/3'];
  const { star } = await sendOk({ links: urls }, [file('a.txt', 'a')]);
  expect(peak).toBe(3);
  expect(star.attachments.slice(1).map((a) => a.link_title)).toEqual(urls.map((u) => `t ${u}`));
});

test('invalid links → 400 invalid_url / invalid_links, nothing written, nothing fetched', async () => {
  for (const links of [['ftp://example.com'], ['javascript:alert(1)'], ['https://ok.example', 'example.com'], ['']]) {
    for (const res of [await postJson({ planet_id: planet.id, body: '본문', links }), await send({ body: '본문', links }, [file('a.txt', 'a')])]) {
      expect(res.statusCode, JSON.stringify(links)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_url' });
    }
  }
  for (const links of ['https://example.com', 5, [5], { a: 1 }]) {
    const res = await postJson({ planet_id: planet.id, body: '본문', links });
    expect(res.statusCode, JSON.stringify(links)).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_links' });
  }
  for (const links of ['not json', '{"a":1}', '"https://example.com"', '[1]']) {
    const res = await send({ body: '본문', links }, [file('a.txt', 'a')]);
    expect(res.statusCode, links).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_links' });
  }
  expect(fetched).toEqual([]);
  expect(count('stars')).toBe(0);
  expect(vaultFiles()).toEqual([]);
});

test('more than 50 attachments (files + links) → 400 too_many_attachments, nothing written; exactly 50 is fine', async () => {
  const links = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
  const files41 = Array.from({ length: 41 }, (_, i) => file(`f${i}.txt`, `content ${i}`));
  const over = await send({ body: '본문', links }, files41);
  expect(over.statusCode).toBe(400);
  expect(over.json()).toEqual({ error: 'too_many_attachments' });
  expect(count('stars')).toBe(0);
  expect(count('attachments')).toBe(0);
  expect(vaultFiles()).toEqual([]);

  const jsonOver = await postJson({ planet_id: planet.id, links: Array.from({ length: 51 }, (_, i) => `https://example.com/${i}`) });
  expect(jsonOver.statusCode).toBe(400);
  expect(jsonOver.json()).toEqual({ error: 'too_many_attachments' });

  const ok = await sendOk({ links }, files41.slice(0, 40));
  expect(ok.star.attachment_count).toBe(50);
  expect(vaultFiles()).toHaveLength(40);
});

test('the attachment that goes over 50 stops the upload at once: 400 too_many_attachments without reading the rest', async () => {
  const cases = [
    [{ body: '본문' }, Array.from({ length: 51 }, (_, i) => file(`f${i}.txt`, `c${i}`))],
    [{ links: Array.from({ length: 45 }, (_, i) => `https://example.com/${i}`) }, Array.from({ length: 6 }, (_, i) => file(`g${i}.txt`, `d${i}`))],
  ];
  for (const [fields, files] of cases) {
    // 51번째 첨부 뒤에도 본문이 끝나지 않는다. 서버는 기다리지 않고 답한다.
    const res = await sendUnfinished(fields, files);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'too_many_attachments' });
    expect(count('stars')).toBe(0);
    expect(count('attachments')).toBe(0);
    expect(vaultFiles()).toEqual([]);
    expect(thumbFiles()).toEqual([]);
  }
});

test('duplicate links in one request (after trimming) are kept once, first one first', async () => {
  const links = ['https://example.com/a', ' https://example.com/a ', 'https://example.com/b', 'https://example.com/a'];
  const json = await postJson({ planet_id: planet.id, links });
  expect(json.statusCode, json.body).toBe(201);
  expect(json.json().star.attachments.map((a) => [a.position, a.url])).toEqual([[0, 'https://example.com/a'], [1, 'https://example.com/b']]);
  const multi = await sendOk({ links }, [file('a.txt', 'a')]);
  expect(multi.star.attachments.map((a) => a.file_name ?? a.url)).toEqual(['a.txt', 'https://example.com/a', 'https://example.com/b']);
  expect(fetched).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/a', 'https://example.com/b']);
  // 같은 주소 51개는 첨부 하나다.
  const same = await postJson({ planet_id: planet.id, links: Array(51).fill('https://example.com/same') });
  expect(same.statusCode, same.body).toBe(201);
  expect(same.json().star.attachment_count).toBe(1);
});

test('a file already in another star is skipped as duplicate and the star still saves', async () => {
  const first = await sendOk({}, [file('a.txt', 'same bytes')]);
  const before = vaultFiles();
  const { star, skipped } = await sendOk({ body: '두 번째' }, [file('다른 이름.txt', 'same bytes'), file('new.txt', 'new bytes')]);
  expect(skipped).toEqual([{ file_name: '다른 이름.txt', reason: 'duplicate' }]);
  expect(star.attachments.map((a) => [a.file_name, a.position])).toEqual([['new.txt', 0]]);
  expect(vaultFiles()).toEqual([...before, `${star.attachments[0].id}.txt`].sort());
  expect(first.star.attachments).toHaveLength(1);

  // 본문이 있으면 첨부가 다 빠져도 글 별로 남는다.
  const textOnly = await sendOk({ body: '글은 남는다' }, [file('again.txt', 'same bytes')]);
  expect(textOnly.skipped).toEqual([{ file_name: 'again.txt', reason: 'duplicate' }]);
  expect(textOnly.star).toMatchObject({ type: 'text', attachment_count: 0 });
});

test('nothing left after skipping (all duplicates or too large, no body) → 409 nothing_to_save, nothing written', async () => {
  await sendOk({}, [file('a.txt', 'aaa'), file('b.txt', 'bbb')]);
  const stars = count('stars');
  const files = vaultFiles();
  const res = await send({ title: '제목만' }, [file('a2.txt', 'aaa'), file('b2.txt', 'bbb')]);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({
    error: 'nothing_to_save',
    skipped: [{ file_name: 'a2.txt', reason: 'duplicate' }, { file_name: 'b2.txt', reason: 'duplicate' }],
  });
  expect(count('stars')).toBe(stars);
  expect(count('attachments')).toBe(2);
  expect(vaultFiles()).toEqual(files);
  expect(vaultFiles().filter((n) => n.startsWith('.tmp-'))).toEqual([]);

  const small = await makeApp({ maxFileBytes: 4, opener: { open() {}, reveal() {} } });
  extra.push(small);
  const p = createPlanet(small.app.db, { name: 'p' });
  const big = await send({ planet_id: p.id }, [file('big.txt', '12345')], { target: small.app });
  expect(big.statusCode).toBe(409);
  expect(big.json()).toEqual({ error: 'nothing_to_save', skipped: [{ file_name: 'big.txt', reason: 'too_large' }] });
  expect(vaultFiles(small.dataDir)).toEqual([]);
});

test('over the per-file limit → that file skipped too_large, the rest saved', async () => {
  const small = await makeApp({ maxFileBytes: 10, opener: { open() {}, reveal() {} } });
  extra.push(small);
  const p = createPlanet(small.app.db, { name: 'p' });
  const res = await send({ planet_id: p.id }, [file('big.txt', '12345678901'), file('exact.txt', '1234567890')], { target: small.app });
  expect(res.statusCode, res.body).toBe(201);
  const { star, skipped } = res.json();
  expect(skipped).toEqual([{ file_name: 'big.txt', reason: 'too_large' }]);
  expect(star.attachments.map((a) => [a.file_name, a.file_size])).toEqual([['exact.txt', 10]]);
  expect(star.title).toBe('exact');
  expect(vaultFiles(small.dataDir)).toEqual([`${star.attachments[0].id}.txt`]);
});

test('the same file twice in one request is kept once (not reported); empty files are never duplicates', async () => {
  const { star, skipped } = await sendOk({}, [file('a.txt', 'twin'), file('b.txt', 'twin'), file('e1.txt', ''), file('e2.txt', '')]);
  expect(skipped).toEqual([]);
  expect(star.attachments.map((a) => [a.file_name, a.file_size])).toEqual([['a.txt', 4], ['e1.txt', 0], ['e2.txt', 0]]);
  expect(attRows(star.id).map((r) => r.file_hash)).toEqual([sha256(Buffer.from('twin')), null, null]);
  expect(vaultFiles()).toHaveLength(3);

  const again = await sendOk({}, [file('e3.txt', '')]);
  expect(again.skipped).toEqual([]);
  expect(again.star.attachments[0].file_size).toBe(0);
});

test('image vs file kind: MIME and raster extension must both say image; thumbnails fit 320', async () => {
  const big = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#224466' } }).jpeg().toBuffer();
  const { star } = await sendOk({}, [
    file('photo.JPG', big, 'image/jpeg'),
    file('fake.png', await png('#00ff00'), 'application/octet-stream'),
    file('pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'),
    file('broken.png', 'not a png', 'image/png'),
  ]);
  expect(star.attachments.map((a) => [a.kind, a.has_thumb])).toEqual([['image', true], ['file', false], ['file', false], ['image', false]]);
  const thumb = await call('GET', `/api/attachments/${star.attachments[0].id}/thumb`);
  expect(thumb.statusCode).toBe(200);
  const meta = await sharp(thumb.rawPayload).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(['webp', 320, 160]);
});

test('has_thumb / thumb_attachment_id point at the first image attachment that has a thumbnail', async () => {
  const { star } = await sendOk({}, [
    file('doc.pdf', 'pdf', 'application/pdf'),
    file('broken.png', 'not a png', 'image/png'),
    file('ok.png', await png('#0000ff'), 'image/png'),
    file('ok2.png', await png('#00ffff'), 'image/png'),
  ]);
  expect(star.type).toBe('file');
  expect(star.has_thumb).toBe(true);
  expect(star.thumb_attachment_id).toBe(star.attachments[2].id);
});

test('link first, image second → type link, but the thumbnail is the image attachment', async () => {
  // 만들기 경로는 파일을 링크보다 앞에 두므로 DB 에 직접 넣는다.
  const imageId = crypto.randomUUID();
  await sharp(await png('#123456', 8)).webp().toFile(path.join(dataDir, 'thumbs', `${imageId}.webp`));
  const made = insertStar(app.db, {
    title: '링크 먼저', planet_id: planet.id,
    attachments: [
      { kind: 'link', url: 'https://example.com', link_title: '예시' },
      { id: imageId, kind: 'image', file_name: 'p.png', file_ext: 'PNG', file_size: 1, vault_path: `vault/${imageId}.png`, thumb_path: `thumbs/${imageId}.webp` },
    ],
  });
  const star = (await call('GET', `/api/stars/${made.id}`)).json();
  expect(star.type).toBe('link');
  expect(star.attachments.map((a) => [a.kind, a.position, a.has_thumb])).toEqual([['link', 0, false], ['image', 1, true]]);
  expect(star.has_thumb).toBe(true);
  expect(star.thumb_attachment_id).toBe(imageId);
  expect((await call('GET', '/api/stars')).json()[0].thumb_attachment_id).toBe(imageId);
  const thumb = await call('GET', `/api/attachments/${star.thumb_attachment_id}/thumb`);
  expect(thumb.statusCode).toBe(200);
  expect(thumb.headers['content-type']).toBe('image/webp');
  expect((await sharp(thumb.rawPayload).metadata()).format).toBe('webp');
});

test('field checks: unknown planet, bad title/body/memo → 400 and nothing written', async () => {
  for (const planet_id of ['nope', '']) {
    const res = await send({ planet_id, body: '본문' }, [file('a.txt', 'a')]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unknown_planet' });
  }
  const noPlanet = await postJson({ body: '본문', links: ['https://example.com'] });
  expect(noPlanet.json()).toEqual({ error: 'unknown_planet' });

  const cases = [
    [{ planet_id: planet.id, body: 5 }, 'invalid_body'],
    [{ planet_id: planet.id, body: '본문', title: 5 }, 'invalid_title'],
    [{ planet_id: planet.id, body: '본문', memo: 'x'.repeat(20001) }, 'invalid_memo'],
  ];
  for (const [body, code] of cases) {
    const res = await postJson(body);
    expect(res.statusCode, code).toBe(400);
    expect(res.json()).toEqual({ error: code });
  }
  const longMemo = await send({ body: '본문', memo: '가'.repeat(20001) }, [file('a.txt', 'a')]);
  expect(longMemo.json()).toEqual({ error: 'invalid_memo' });
  expect(fetched).toEqual([]);
  expect(count('stars')).toBe(0);
  expect(vaultFiles()).toEqual([]);
});

test('a bad text field fails fast: answered before any file part is read, no file or temp file written', async () => {
  const writes = vi.spyOn(fs, 'createWriteStream');
  const cases = [
    [{ planet_id: 'nope', body: '본문' }, 'unknown_planet'],
    [{ body: '본문', links: 'not json' }, 'invalid_links'],
    [{ body: '본문', links: ['ftp://example.com'] }, 'invalid_url'],
    [{ body: 'a'.repeat(1024 * 1024 + 1) }, 'invalid_body'],
    [{ body: '본문', memo: '가'.repeat(20001) }, 'invalid_memo'],
    [{ links: Array.from({ length: 51 }, (_, i) => `https://example.com/${i}`) }, 'too_many_attachments'],
  ];
  for (const [fields, code] of cases) {
    const res = await sendUnfinished(fields, [file('a.txt', 'a'), file('b.png', 'not read', 'image/png')]);
    expect(res.statusCode, code).toBe(400);
    expect(res.body).toEqual({ error: code });
  }
  expect(writes).not.toHaveBeenCalled();
  expect(fetched).toEqual([]);
  expect(count('stars')).toBe(0);
  expect(vaultFiles()).toEqual([]);
});

test('body is limited to 1 MB of UTF-8 text', async () => {
  const exact = 'a'.repeat(1024 * 1024);
  const ok = await sendOk({ body: exact }, [file('a.txt', 'a')]);
  expect(ok.star.body).toHaveLength(exact.length);

  const over = await send({ body: `${exact}b` }, [file('b.txt', 'b')]);
  expect(over.statusCode).toBe(400);
  expect(over.json()).toEqual({ error: 'invalid_body' });
  const overNoFiles = await send({ body: '가'.repeat(400000) });
  expect(overNoFiles.json()).toEqual({ error: 'invalid_body' });
  expect(count('stars')).toBe(1);
  expect(vaultFiles()).toHaveLength(1);
});

test('upload cut off mid-file leaves no rows, no vault files and no temp files', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = await send({ body: '본문', links: ['https://example.com'] }, [file('a.txt', 'complete'), file('b.bin', crypto.randomBytes(200000))], { end: false });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'upload_incomplete' });
  expect(count('stars')).toBe(0);
  expect(count('attachments')).toBe(0);
  expect(vaultFiles()).toEqual([]);
  expect(thumbFiles()).toEqual([]);
  // 파일과 파일 사이(닫는 경계 없음)에서 끊긴 본문도 같다.
  const between = await send({ body: '본문' }, [file('a.txt', 'complete'), file('b.txt', 'also complete')], { end: false });
  expect(between.statusCode).toBe(400);
  expect(between.json()).toEqual({ error: 'upload_incomplete' });
  expect(count('stars')).toBe(0);
  expect(vaultFiles()).toEqual([]);
  // 서버는 계속 돈다.
  expect((await sendOk({ body: '다시' }, [file('a.txt', 'complete')])).star.attachment_count).toBe(1);
});

test('DB failure after the files are on disk removes them and writes nothing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  app.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON attachments WHEN NEW.kind = 'link'
    BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  const res = await send({ body: '본문', links: ['https://example.com'] }, [file('a.txt', 'aaa'), file('p.png', await png(), 'image/png')]);
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({ error: 'server_error' });
  expect(count('stars')).toBe(0);
  expect(count('attachments')).toBe(0);
  expect(vaultFiles()).toEqual([]);
  expect(thumbFiles()).toEqual([]);
});

test('a planet deleted while the upload runs → 400 unknown_planet and the new files are removed', async () => {
  const doomed = createPlanet(app.db, { name: '곧 사라짐' });
  titleFor = (url) => {
    app.db.prepare('DELETE FROM planets WHERE id = ?').run(doomed.id);
    return url;
  };
  const res = await send({ planet_id: doomed.id, links: ['https://example.com'] }, [file('a.txt', 'aaa')]);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'unknown_planet' });
  expect(count('stars')).toBe(0);
  expect(vaultFiles()).toEqual([]);
});

test('another request saving the same file first (UNIQUE race) → that attachment is skipped as duplicate, its copy removed', async () => {
  // 링크 제목을 가져오는 사이(파일은 이미 디스크에 있다) 다른 별이 같은 파일을 담는다.
  titleFor = (url) => {
    insertStar(app.db, {
      title: '먼저 온 별', planet_id: planet.id,
      attachments: [{ kind: 'file', file_name: 'x.txt', file_hash: sha256(Buffer.from('race')), vault_path: 'vault/other.txt' }],
    });
    return url;
  };
  const { star, skipped } = await sendOk({ body: '본문', links: ['https://example.com'] }, [file('race.txt', 'race'), file('keep.txt', 'keep')]);
  expect(skipped).toEqual([{ file_name: 'race.txt', reason: 'duplicate' }]);
  expect(star.attachments.map((a) => a.file_name ?? a.url)).toEqual(['keep.txt', 'https://example.com']);
  expect(vaultFiles()).toEqual([`${star.attachments[0].id}.txt`]);
});

test('list routes read attachments with one query for all listed stars', async () => {
  for (let i = 0; i < 5; i++) await sendOk({ body: `별 ${i}`, links: [`https://example.com/${i}`] }, [file(`f${i}.txt`, `c${i}`)]);
  await sendOk({ body: '글만' });
  const spy = vi.spyOn(app.db, 'prepare');
  const list = (await call('GET', '/api/stars')).json();
  expect(list).toHaveLength(6);
  expect(list.map((s) => s.attachment_count)).toEqual([0, 2, 2, 2, 2, 2]);
  for (const s of list.slice(1)) {
    const n = s.body.slice(2);
    expect(s.attachments.map((a) => a.file_name ?? a.url)).toEqual([`f${n}.txt`, `https://example.com/${n}`]);
  }
  const attachmentQueries = spy.mock.calls.filter(([sql]) => /FROM attachments/.test(sql));
  expect(attachmentQueries).toHaveLength(1);
});

// ---- 첨부 경로 ----

test('attachment routes serve, open and reveal each attachment by its own id', async () => {
  const img = await png();
  const { star } = await sendOk({ links: ['https://example.com'] }, [
    file('a.pdf', '%PDF-1.4 body', 'application/pdf'),
    file('사진.png', img, 'image/png'),
    file('setup.exe', 'MZ'),
    file('clip.mp4', '0123456789', 'video/mp4'),
  ]);
  const [pdf, image, exe, clip, link] = star.attachments;

  const res = await call('GET', `/api/attachments/${pdf.id}/file`);
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('%PDF-1.4 body');
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''a.pdf");
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toMatch(/^default-src 'none';/);

  const exeFile = await call('GET', `/api/attachments/${exe.id}/file`);
  expect(exeFile.headers['content-disposition']).toMatch(/^attachment;/);
  expect(exeFile.headers['content-security-policy']).toBe("sandbox; default-src 'none'");

  const ranged = await app.inject({ method: 'GET', url: `/api/attachments/${clip.id}/file`, headers: { ...HOST, range: 'bytes=2-5' } });
  expect(ranged.statusCode).toBe(206);
  expect(ranged.body).toBe('2345');
  expect(ranged.headers['content-range']).toBe('bytes 2-5/10');

  const full = await call('GET', `/api/attachments/${image.id}/file`);
  expect(full.rawPayload.equals(img)).toBe(true);
  const thumb = await call('GET', `/api/attachments/${image.id}/thumb`);
  expect(thumb.statusCode).toBe(200);
  expect(thumb.headers['content-type']).toBe('image/webp');
  expect((await call('GET', `/api/attachments/${pdf.id}/thumb`)).json()).toEqual({ error: 'not_found' });

  const open = (id, action = 'open') => call('POST', `/api/attachments/${id}/${action}`);
  expect((await open(pdf.id)).json()).toEqual({ action: 'opened' });
  expect((await open(exe.id)).json()).toEqual({ action: 'revealed' });
  expect((await open(image.id, 'reveal')).json()).toEqual({ action: 'revealed' });
  expect(opened).toEqual([
    ['open', path.join(dataDir, 'vault', `${pdf.id}.pdf`)],
    ['reveal', path.join(dataDir, 'vault', `${exe.id}.exe`)],
    ['reveal', path.join(dataDir, 'vault', `${image.id}.png`)],
  ]);
  const linkOpen = await open(link.id);
  expect(linkOpen.statusCode).toBe(400);
  expect(linkOpen.json()).toEqual({ error: 'no_file' });

  for (const [method, action] of [['GET', 'file'], ['GET', 'thumb'], ['POST', 'open'], ['POST', 'reveal']]) {
    const missing = await call(method, `/api/attachments/nope/${action}`);
    expect(missing.statusCode, action).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
  }

  // 별 id 로 첨부를 다루던 옛 경로는 없다.
  for (const [method, action] of [['GET', 'file'], ['GET', 'thumb'], ['POST', 'open'], ['POST', 'reveal']]) {
    expect((await call(method, `/api/stars/${star.id}/${action}`)).statusCode, action).toBe(404);
  }
});

// ---- 지우기 · 청소 ----

test('deleting a star removes every attachment copy and thumbnail; planet stars=delete too', async () => {
  const other = createPlanet(app.db, { name: '남는 행성' });
  const a = await sendOk({ links: ['https://example.com'] }, [file('a.png', await png('#111111'), 'image/png'), file('b.pdf', 'b')]);
  const b = await sendOk({}, [file('c.png', await png('#222222'), 'image/png'), file('d.txt', 'd')]);
  const keep = await sendOk({ planet_id: other.id }, [file('keep.txt', 'keep')]);
  expect(vaultFiles()).toHaveLength(5);
  expect(thumbFiles()).toHaveLength(2);

  expect((await call('DELETE', `/api/stars/${a.star.id}`)).statusCode).toBe(204);
  expect(count('attachments')).toBe(3);
  expect(vaultFiles()).toHaveLength(3);
  expect(thumbFiles()).toEqual([`${b.star.attachments[0].id}.webp`]);

  expect((await call('DELETE', `/api/planets/${planet.id}?stars=delete`)).statusCode).toBe(204);
  expect(vaultFiles()).toEqual([`${keep.star.attachments[0].id}.txt`]);
  expect(thumbFiles()).toEqual([]);
  expect(count('attachments')).toBe(1);

  // 지운 파일은 다시 담을 수 있다.
  expect((await sendOk({ planet_id: other.id }, [file('b.pdf', 'b')])).skipped).toEqual([]);
});

test('removeStarFiles receives the star with its attachment rows', async () => {
  const { star } = await sendOk({}, [file('a.txt', 'a'), file('b.txt', 'b')]);
  const seen = [];
  app.removeStarFiles = (s) => { seen.push([s.id, s.attachments.map((x) => x.vault_path)]); };
  expect((await call('DELETE', `/api/stars/${star.id}`)).statusCode).toBe(204);
  expect(seen).toEqual([[star.id, star.attachments.map((x) => `vault/${x.id}.txt`)]]);
});

test('sweep keeps files owned by an attachment (or a not-yet-migrated star id) and moves true orphans to orphans/', async () => {
  const { star } = await sendOk({ body: '본문' }, [file('a.png', await png(), 'image/png'), file('b.txt', 'b')]);
  const [img, txt] = star.attachments;
  const legacy = insertStar(app.db, { title: '옛 별', body: '본문', planet_id: planet.id });
  const orphan = crypto.randomUUID();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(dataDir, 'vault', `${legacy.id}.pdf`), 'legacy');
  fs.writeFileSync(path.join(dataDir, 'vault', `${orphan}.pdf`), 'orphan');
  fs.writeFileSync(path.join(dataDir, 'vault', `${star.id}.pdf`), 'named after the star, which has attachments');
  for (const rel of [`vault/${img.id}.png`, `thumbs/${img.id}.webp`, `vault/${txt.id}.txt`, `vault/${legacy.id}.pdf`, `vault/${orphan}.pdf`, `vault/${star.id}.pdf`]) {
    fs.utimesSync(path.join(dataDir, rel), old, old);
  }
  expect(app.sweep()).toEqual({ tmp: 0, orphans: 1 });
  expect(vaultFiles()).toEqual([`${img.id}.png`, `${txt.id}.txt`, `${legacy.id}.pdf`, `${star.id}.pdf`].sort());
  expect(thumbFiles()).toEqual([`${img.id}.webp`]);
  expect(fs.readFileSync(path.join(dataDir, 'orphans', 'vault', `${orphan}.pdf`), 'utf8')).toBe('orphan');
});

test('search_text: patching title or memo keeps the attachment names, URLs and link titles', async () => {
  const { star } = await sendOk({ body: '본문', links: ['https://example.com/s'] }, [file('파일.txt', 'x')]);
  const res = await app.inject({ method: 'PATCH', url: `/api/stars/${star.id}`, headers: HOST, payload: { title: '새 제목', memo: '새 메모' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().attachments).toEqual(star.attachments);
  const row = app.db.prepare('SELECT search_text FROM stars WHERE id = ?').get(star.id);
  expect(row.search_text).toBe('새 제목\n본문\n새 메모\n파일.txt\n제목 https://example.com/s\nhttps://example.com/s');
  // 본문은 고치지 않는다.
  const body = await app.inject({ method: 'PATCH', url: `/api/stars/${star.id}`, headers: HOST, payload: { body: '바꾸기' } });
  expect(body.json().body).toBe('본문');
});
