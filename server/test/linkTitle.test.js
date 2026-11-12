import http from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { fetchLinkTitle } from '../linkTitle.js';

const servers = [];

// 포트 0 으로 로컬 서버를 띄우고 주소를 돌려준다.
function serve(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

function html(res, body, type = 'text/html; charset=utf-8') {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reads <title> and decodes entities', async () => {
  const url = await serve((req, res) => html(res, '<html><head><title> A &amp; B </title></head><body>x</body></html>'));
  expect(await fetchLinkTitle(url)).toBe('A & B');
});

test('decodes the listed entities once and collapses whitespace', async () => {
  const url = await serve((req, res) =>
    html(res, '<TITLE lang="ko">\n  &lt;b&gt;  &quot;한글&quot;\n\t&#39;제목&#39; &amp;lt;  </TITLE>'),
  );
  expect(await fetchLinkTitle(url)).toBe('<b> "한글" \'제목\' &lt;');
});

test('cuts the title to 200 chars', async () => {
  const url = await serve((req, res) => html(res, `<title>${'가'.repeat(300)}</title>`));
  expect(await fetchLinkTitle(url)).toBe('가'.repeat(200));
});

test('no <title> or empty <title> → null', async () => {
  const none = await serve((req, res) => html(res, '<html><body>no title</body></html>'));
  expect(await fetchLinkTitle(none)).toBeNull();
  const empty = await serve((req, res) => html(res, '<title>   </title>'));
  expect(await fetchLinkTitle(empty)).toBeNull();
});

test('non-html content-type → null', async () => {
  const json = await serve((req, res) => html(res, '<title>A</title>', 'application/json'));
  expect(await fetchLinkTitle(json)).toBeNull();
  const missing = await serve((req, res) => {
    res.writeHead(200);
    res.end('<title>A</title>');
  });
  expect(await fetchLinkTitle(missing)).toBeNull();
});

test('error status → null', async () => {
  const url = await serve((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<title>Not Found</title>');
  });
  expect(await fetchLinkTitle(url)).toBeNull();
});

test('server that never responds → null within timeout', async () => {
  const url = await serve(() => {});
  const started = Date.now();
  expect(await fetchLinkTitle(url, { timeoutMs: 200 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
});

test('headers arrive but body stalls → null within timeout', async () => {
  const url = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><head>');
  });
  const started = Date.now();
  expect(await fetchLinkTitle(url, { timeoutMs: 200 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
});

test('stops reading after maxBytes', async () => {
  let written = 0;
  const url = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = Buffer.alloc(512, 'x');
    const timer = setInterval(() => {
      written += chunk.length;
      res.write(chunk);
    }, 5);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  expect(await fetchLinkTitle(url, { maxBytes: 1024, timeoutMs: 5000 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
  // 응답을 끝까지 받지 않고 끊었다.
  const afterReturn = written;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(written - afterReturn).toBeLessThanOrEqual(1024);
});

test('title past maxBytes is not read', async () => {
  const url = await serve((req, res) => html(res, `${' '.repeat(4096)}<title>늦은 제목</title>`));
  expect(await fetchLinkTitle(url, { maxBytes: 1024 })).toBeNull();
  expect(await fetchLinkTitle(url)).toBe('늦은 제목');
});

test('connection refused → null', async () => {
  const url = await serve(() => {});
  const server = servers.pop();
  await new Promise((resolve) => server.close(resolve));
  expect(await fetchLinkTitle(url)).toBeNull();
});

test('malformed url → null', async () => {
  expect(await fetchLinkTitle('not a url')).toBeNull();
  expect(await fetchLinkTitle(undefined)).toBeNull();
});

// --- 검토에서 나온 경우들 ---
import { extractTitle } from '../linkTitle.js';

test('extractTitle is linear on pathological input', () => {
  const started = Date.now();
  expect(extractTitle('<title '.repeat(40000))).toBeNull();
  expect(extractTitle('<title>'.repeat(40000))).toBeNull();
  expect(Date.now() - started).toBeLessThan(200);
});

test('extractTitle skips svg and commented titles', () => {
  expect(extractTitle('<svg><title>icon</title></svg><title>진짜</title>')).toBe('진짜');
  expect(extractTitle('<!-- <title>옛 제목</title> --><TITLE lang="ko">새 제목</TITLE>')).toBe('새 제목');
  expect(extractTitle('<svg><title>icon</title></svg>')).toBeNull();
  expect(extractTitle('<titlebar>x</titlebar>')).toBeNull();
});

const EUC_KR_HANGUL = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // '한글'

test('charset from <meta> when the header has none', async () => {
  const body = Buffer.concat([Buffer.from('<meta charset="euc-kr"><title>'), EUC_KR_HANGUL, Buffer.from('</title>')]);
  const url = await serve((req, res) => html(res, body, 'text/html'));
  expect(await fetchLinkTitle(url)).toBe('한글');
});

test('euc-kr page with no charset anywhere is still readable', async () => {
  const many = Buffer.concat([EUC_KR_HANGUL, EUC_KR_HANGUL, EUC_KR_HANGUL]);
  const body = Buffer.concat([Buffer.from('<title>'), many, Buffer.from('</title>')]);
  const url = await serve((req, res) => html(res, body, 'text/html'));
  expect(await fetchLinkTitle(url)).toBe('한글한글한글');
});

test('control and bidi characters from entities are dropped', async () => {
  const url = await serve((req, res) => html(res, '<title>a&#1;b&#x202e;c&#xD800;</title>'));
  expect(await fetchLinkTitle(url)).toBe('a b c&#xD800;');
});
