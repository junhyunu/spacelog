import { describe, expect, test } from 'vitest';
import { parseFileName } from '../../../server/files.js';
import { isHttpUrl } from '../../../server/stars.js';
import {
  ATTACH_MAX,
  FILE_MAX,
  addToast,
  autoTitle,
  badLinks,
  canSubmit,
  saveBlockHint,
  clampPlanetName,
  classifyDrop,
  classifyPaste,
  cleanPlanetName,
  dedupeFiles,
  defaultPlanetId,
  fileStem,
  httpUrl,
  matchSkipped,
  nothingToast,
  partitionBySize,
  pastedHint,
  pendingLink,
  planAdd,
  planetNameLength,
  resultToast,
  saveError,
  serverFileName,
  skipNote,
  splitDropped,
  submitTitle,
  urlError,
} from '../ui/saveLogic.js';

const file = (name, size = 10, lastModified = 1, type = '') => ({ name, size, lastModified, type });
const img = (name = 'image.png') => file(name, 10, 1, 'image/png');

describe('classifyPaste', () => {
  test('files → files', () => {
    const f = file('a.pdf', 1, 1, 'application/pdf');
    expect(classifyPaste({ files: [f], text: '' })).toEqual({ kind: 'files', files: [f] });
    expect(classifyPaste({ files: [f], text: 'x' })).toEqual({ kind: 'files', files: [f] });
  });
  test('one address → link', () => {
    expect(classifyPaste({ files: [], text: ' https://a.com/x ' })).toEqual({ kind: 'link', url: 'https://a.com/x' });
    expect(classifyPaste({ text: 'HTTPS://A.COM/Path\n' })).toEqual({ kind: 'link', url: 'HTTPS://A.COM/Path' });
  });
  test('any other text → text, own whitespace kept', () => {
    expect(classifyPaste({ text: '이것 봐 https://a.com/x' })).toEqual({ kind: 'text', text: '이것 봐 https://a.com/x' });
    expect(classifyPaste({ text: 'https://a.com https://b.com' }).kind).toBe('text');
    expect(classifyPaste({ text: 'https://' }).kind).toBe('text');
    expect(classifyPaste({ text: '첫 줄\n  둘째 줄\n' })).toEqual({ kind: 'text', text: '첫 줄\n  둘째 줄\n' });
  });
  test('text beside rendered images (Excel · Word) → the text wins', () => {
    expect(classifyPaste({ files: [img()], text: '이름\t점수\n가\t10' })).toEqual({ kind: 'text', text: '이름\t점수\n가\t10' });
    expect(classifyPaste({ files: [img(), img('b.png')], text: ' https://a.com/x ' })).toEqual({ kind: 'link', url: 'https://a.com/x' });
  });
  test('image without text → files; text + a non-image file → files', () => {
    const f = img();
    expect(classifyPaste({ files: [f], text: '  \n' })).toEqual({ kind: 'files', files: [f] });
    const pdf = file('a.pdf', 1, 1, 'application/pdf');
    expect(classifyPaste({ files: [f, pdf], text: 'x' })).toEqual({ kind: 'files', files: [f, pdf] });
  });
  test('empty → null', () => {
    expect(classifyPaste({ files: [], text: '' })).toBeNull();
    expect(classifyPaste({ text: '  \n ' })).toBeNull();
    expect(classifyPaste()).toBeNull();
  });
});

describe('classifyDrop', () => {
  test('files win over text', () => {
    const f = file('a.txt');
    expect(classifyDrop({ types: ['Files', 'text/uri-list'], uriList: 'https://a.com', files: [f] })).toEqual({ kind: 'files', files: [f] });
  });
  test('uri-list: first http(s) address, comment lines skipped', () => {
    expect(
      classifyDrop({ types: ['text/uri-list', 'text/plain'], uriList: '# 설명\r\nhttps://a.com/x\r\nhttps://b.com', text: 'https://a.com/x' }),
    ).toEqual({ kind: 'link', url: 'https://a.com/x' });
  });
  test('uri-list without an http address falls back to the text', () => {
    expect(classifyDrop({ types: ['text/uri-list', 'text/plain'], uriList: 'javascript:alert(1)', text: 'https://a.com' })).toEqual({
      kind: 'link',
      url: 'https://a.com',
    });
    expect(classifyDrop({ types: ['text/uri-list'], uriList: 'file:///C:/a.txt' })).toBeNull();
    expect(classifyDrop({ types: ['text/uri-list', 'text/plain'], uriList: 'javascript:alert(1)', text: 'javascript:alert(1)' })).toEqual({
      kind: 'text',
      text: 'javascript:alert(1)',
    });
  });
  test('plain text: one address → link, anything else → text', () => {
    expect(classifyDrop({ types: ['text/plain'], text: ' https://a.com/x\n' })).toEqual({ kind: 'link', url: 'https://a.com/x' });
    expect(classifyDrop({ types: ['text/plain'], text: '끌어온 글' })).toEqual({ kind: 'text', text: '끌어온 글' });
  });
  test('nothing usable → null', () => {
    expect(classifyDrop({ types: ['text/plain'], text: '  ' })).toBeNull();
    expect(classifyDrop({ types: ['text/html'] })).toBeNull();
    expect(classifyDrop()).toBeNull();
  });
});

// 서버(server/stars.js isHttpUrl)와 같은 표로 검사한다. 서버는 앞뒤 공백을 뗀 뒤 검사한다.
describe('httpUrl mirrors the server isHttpUrl', () => {
  const table = [
    ['https://a.com', 'https://a.com'],
    ['HTTP://A.COM', 'HTTP://A.COM'],
    ['  https://a.com  ', 'https://a.com'],
    ['　https://a.com ', 'https://a.com'],
    ['https://例え.jp', 'https://例え.jp'],
    ['https://a.com/x y', 'https://a.com/x y'],
    ['http://a.com:8080/p?q=1#h', 'http://a.com:8080/p?q=1#h'],
    ['http://:80', null],
    ['http://%zz', null],
    ['http://[x', null],
    ['https://', null],
    ['https://a b.com', null],
    ['http:/a.com', null],
    ['javascript:alert(1)', null],
    ['ftp://a.com', null],
    ['naver.com', null],
    ['', null],
    ['   ', null],
  ];
  test.each(table)('%j → %j', (raw, want) => {
    expect(httpUrl(raw)).toBe(want);
    expect(isHttpUrl(raw.trim())).toBe(want !== null);
  });
  test('non-strings', () => {
    expect(httpUrl(null)).toBeNull();
    expect(httpUrl(undefined)).toBeNull();
    expect(httpUrl(42)).toBeNull();
  });
});

describe('pendingLink (typed but not yet added)', () => {
  test('empty → null', () => {
    expect(pendingLink('', [])).toBeNull();
    expect(pendingLink('  ', [])).toBeNull();
    expect(pendingLink(undefined)).toBeNull();
  });
  test('valid → url to add, already there → dup', () => {
    expect(pendingLink(' https://a.com ', [])).toEqual({ url: 'https://a.com', dup: false });
    expect(pendingLink('https://a.com', ['https://a.com'])).toEqual({ url: 'https://a.com', dup: true });
  });
  test('invalid → the url error', () => {
    expect(pendingLink('naver.com', [])).toEqual({ error: '주소는 http로 시작해야 해요' });
    expect(pendingLink('http://[x', [])).toEqual({ error: '주소는 http로 시작해야 해요' });
  });
});

test('badLinks: indexes the server would refuse', () => {
  expect(badLinks(['https://a.com', 'http://[x', 'ftp://b'])).toEqual([1, 2]);
  expect(badLinks([])).toEqual([]);
  expect(badLinks()).toEqual([]);
});

describe('addToast (files left out when adding)', () => {
  const plan = (o) => ({ add: [], tooBig: 0, repeated: 0, overflow: 0, ...o });
  test('nothing left out → null', () => {
    expect(addToast(plan({ add: [1] }))).toBeNull();
    expect(addToast(plan({}))).toBeNull();
  });
  test('one reason keeps its own line', () => {
    expect(addToast(plan({ overflow: 2 }))).toBe('첨부는 50개까지 담을 수 있어요');
    expect(addToast(plan({ tooBig: 1 }))).toBe('500MB보다 큰 파일은 담을 수 없어요');
    expect(addToast(plan({ repeated: 1 }))).toBe('이미 담긴 파일이에요');
    expect(addToast(plan({ add: [1], repeated: 1 }))).toBeNull();
  });
  test('several reasons → one line listing each', () => {
    expect(addToast(plan({ add: [1], tooBig: 1, overflow: 2 }))).toBe(
      '일부만 담았어요. 500MB보다 큰 파일 1개 · 50개를 넘은 파일 2개',
    );
    expect(addToast(plan({ tooBig: 1, repeated: 3, overflow: 1 }))).toBe(
      '담지 못했어요. 500MB보다 큰 파일 1개 · 이미 담긴 파일 3개 · 50개를 넘은 파일 1개',
    );
  });
});

test('urlError · httpUrl', () => {
  expect(urlError('')).toBeNull();
  expect(urlError('naver.com')).toBe('주소는 http로 시작해야 해요');
  expect(urlError('ftp://a.com')).toBe('주소는 http로 시작해야 해요');
  expect(urlError('https://')).toBe('주소는 http로 시작해야 해요');
  expect(urlError('https://a b')).toBe('주소는 http로 시작해야 해요');
  expect(urlError(' HTTP://a.com ')).toBeNull();
  expect(httpUrl(' https://a.com/x ')).toBe('https://a.com/x');
  expect(httpUrl('naver.com')).toBeNull();
  expect(httpUrl(null)).toBeNull();
});

describe('saveBlockHint', () => {
  test('says why 별 띄우기 is locked, one reason at a time', () => {
    expect(saveBlockHint({ text: '  \n', count: 0, planetId: '1' })).toBe('메모를 쓰거나 파일·링크를 넣으면 띄울 수 있어요');
    expect(saveBlockHint({ text: '', count: 0, planetId: 'new', newPlanetName: '' })).toBe('메모를 쓰거나 파일·링크를 넣으면 띄울 수 있어요');
    expect(saveBlockHint({ text: '글', planetId: 'new', newPlanetName: '  ' })).toBe('새 행성 이름을 적으면 띄울 수 있어요');
    expect(saveBlockHint({ text: '', count: 1, planetId: 'new', newPlanetName: '' })).toBe('새 행성 이름을 적으면 띄울 수 있어요');
  });
  test('empty when it can be sent, or when an over-limit error already explains it', () => {
    expect(saveBlockHint({ text: '글', planetId: '1' })).toBe('');
    expect(saveBlockHint({ text: '', count: 2, planetId: 'new', newPlanetName: '운동' })).toBe('');
    expect(saveBlockHint({ text: '', count: 51, planetId: '1' })).toBe('');
    expect(saveBlockHint({ text: '가'.repeat(20001), planetId: '1' })).toBe('');
  });
});

describe('canSubmit', () => {
  test('body text or at least one attachment, and a planet', () => {
    expect(canSubmit({ text: '  \n', count: 0, planetId: '1' })).toBe(false);
    expect(canSubmit({ text: '글', count: 0, planetId: '1' })).toBe(true);
    expect(canSubmit({ text: '', count: 1, planetId: '1' })).toBe(true);
    expect(canSubmit({ text: '글', planetId: null })).toBe(false);
    expect(canSubmit({ text: '글', planetId: '' })).toBe(false);
    expect(canSubmit({ text: '글', planetId: 3 })).toBe(true);
    expect(canSubmit()).toBe(false);
  });
  test('new planet needs a 1–20 character name (code points, like the server)', () => {
    expect(canSubmit({ text: '글', planetId: 'new', newPlanetName: '' })).toBe(false);
    expect(canSubmit({ text: '글', planetId: 'new', newPlanetName: '  ' })).toBe(false);
    expect(canSubmit({ text: '글', planetId: 'new', newPlanetName: '공부' })).toBe(true);
    expect(canSubmit({ text: '글', planetId: 'new', newPlanetName: '가'.repeat(21) })).toBe(false);
    const twenty = '가나다라마바사아자차카타파하거너더러머버'.normalize('NFD');
    expect(canSubmit({ text: 'x', planetId: 'new', newPlanetName: twenty })).toBe(true);
  });
  test('memo text over 20,000 characters is false, even with attachments (code points)', () => {
    expect(canSubmit({ text: '😀'.repeat(20000), planetId: '1' })).toBe(true);
    expect(canSubmit({ text: '가'.repeat(20001), planetId: '1' })).toBe(false);
    expect(canSubmit({ text: '가'.repeat(20001), count: 2, planetId: '1' })).toBe(false);
  });
  test('more than 50 attachments is false', () => {
    expect(canSubmit({ count: ATTACH_MAX, planetId: '1' })).toBe(true);
    expect(canSubmit({ count: ATTACH_MAX + 1, planetId: '1' })).toBe(false);
  });
});

describe('autoTitle · submitTitle', () => {
  test('body first line (40) → first file name without extension → first link address', () => {
    expect(autoTitle({ text: '\n  첫 줄  \n둘째', files: [{ name: 'a.pdf' }], links: ['https://a.com'] })).toBe('첫 줄');
    expect(autoTitle({ text: '가'.repeat(50) })).toBe('가'.repeat(40));
    expect(autoTitle({ text: '  ', files: [{ name: '보고서 최종.pdf' }], links: ['https://a.com'] })).toBe('보고서 최종');
    expect(autoTitle({ files: [], links: ['https://a.com/x', 'https://b.com'] })).toBe('https://a.com/x');
    expect(autoTitle({})).toBe('');
    expect(autoTitle()).toBe('');
  });
  test('a pasted image uses its hint', () => {
    expect(autoTitle({ files: [{ name: 'image.png', hint: '붙여넣은 이미지' }] })).toBe('붙여넣은 이미지');
  });
  test('submitTitle: what was typed, else only a hint the server cannot know, else empty', () => {
    expect(submitTitle(' 내 제목 ', { text: '본문' })).toBe('내 제목');
    expect(submitTitle('', { text: '본문' })).toBe('');
    expect(submitTitle('  ', { files: [{ name: 'a.pdf' }] })).toBe('');
    expect(submitTitle('', { files: [{ name: 'image.png', hint: '붙여넣은 이미지' }] })).toBe('붙여넣은 이미지');
    expect(submitTitle('', { text: '본문', files: [{ name: 'image.png', hint: '붙여넣은 이미지' }] })).toBe('');
  });
});

describe('planAdd', () => {
  test('too big, already there and over the limit are left out', () => {
    const a = file('a', 1, 1);
    const big = file('big', FILE_MAX + 1);
    const b = file('b', 1, 1);
    const c = file('c', 1, 1);
    expect(planAdd({ existing: [a], incoming: [file('a', 1, 1), big, b, c], room: 1 })).toEqual({
      add: [b],
      tooBig: 1,
      repeated: 1,
      overflow: 1,
    });
  });
  test('nothing left out', () => {
    const a = file('a');
    expect(planAdd({ existing: [], incoming: [a], room: 50 })).toEqual({ add: [a], tooBig: 0, repeated: 0, overflow: 0 });
    expect(planAdd()).toEqual({ add: [], tooBig: 0, repeated: 0, overflow: 0 });
  });
});

describe('resultToast (201)', () => {
  test('saved, nothing left out', () => {
    expect(resultToast([])).toBe('별을 띄웠어요');
    expect(resultToast()).toBe('별을 띄웠어요');
  });
  test('duplicates and too large files are counted', () => {
    expect(resultToast([{ file_name: 'a', reason: 'duplicate' }])).toBe('별을 띄웠어요. 이미 있는 파일 1개는 빼고 띄웠어요');
    expect(resultToast([{ reason: 'too_large' }, { reason: 'too_large' }])).toBe('별을 띄웠어요. 500MB보다 큰 파일 2개는 빼고 띄웠어요');
    expect(resultToast([{ reason: 'duplicate' }, { reason: 'too_large' }])).toBe(
      '별을 띄웠어요. 이미 있는 파일 1개와 500MB보다 큰 파일 1개는 빼고 띄웠어요',
    );
    expect(resultToast(Array(1200).fill({ reason: 'duplicate' }))).toBe('별을 띄웠어요. 이미 있는 파일 1,200개는 빼고 띄웠어요');
  });
});

test('nothingToast (409)', () => {
  expect(nothingToast([{ reason: 'duplicate' }, { reason: 'duplicate' }])).toBe('이미 있는 별이에요');
  expect(nothingToast([])).toBe('이미 있는 별이에요');
  expect(nothingToast([{ reason: 'too_large' }])).toBe('500MB보다 큰 파일은 담을 수 없어요');
  expect(nothingToast([{ reason: 'duplicate' }, { reason: 'too_large' }])).toBe('띄울 것이 없어요. 이미 있거나 너무 큰 파일이에요');
});

describe('matchSkipped', () => {
  const item = (name) => ({ kind: 'file', file: { name } });
  test('marks skipped files in order, links and saved files stay null', () => {
    const items = [item('a.txt'), { kind: 'link', url: 'https://a.com' }, item('b.txt'), item('a.txt')];
    expect(
      matchSkipped(items, [
        { file_name: 'a.txt', reason: 'duplicate' },
        { file_name: 'b.txt', reason: 'too_large' },
      ]),
    ).toEqual(['duplicate', null, 'too_large', null]);
  });
  test('names are compared the way the server stores them', () => {
    const items = [item('가나.txt'.normalize('NFD')), item('C:\\x\\b.txt')];
    expect(matchSkipped(items, [{ file_name: '가나.txt', reason: 'duplicate' }, { file_name: 'b.txt', reason: 'duplicate' }])).toEqual([
      'duplicate',
      'duplicate',
    ]);
  });
  test('long names are cut like the server (200 code points, extension kept)', () => {
    const long = `${'가'.repeat(250)}.pdf`;
    const stored = parseFileName(long).fileName;
    expect(matchSkipped([item(long)], [{ file_name: stored, reason: 'duplicate' }])).toEqual(['duplicate']);
    expect(matchSkipped([item('')], [{ file_name: 'untitled', reason: 'duplicate' }])).toEqual(['duplicate']);
  });
  test('serverFileName matches the server parseFileName', () => {
    const names = [
      'a.txt',
      'C:\\x\\b.txt',
      '/x/y/',
      '',
      '   ',
      '가나.txt'.normalize('NFD'),
      'evil\u202Etxt.exe',
      'tab\there.txt',
      `${'가'.repeat(250)}.pdf`,
      `${'😀'.repeat(210)}`,
      `${'a'.repeat(300)}.verylongextension`,
      `.${'b'.repeat(250)}`,
    ];
    for (const n of names) expect(serverFileName(n)).toBe(parseFileName(n).fileName);
  });
  test('nameless skips mark nothing', () => {
    expect(matchSkipped([item('a')], [{ file_name: null, reason: 'duplicate' }])).toEqual([null]);
    expect(matchSkipped(undefined, undefined)).toEqual([]);
  });
});

test('skipNote', () => {
  expect(skipNote('duplicate')).toBe('이미 있는 파일');
  expect(skipNote('too_large')).toBe('500MB보다 커서 뺐어요');
  expect(skipNote(null)).toBe('');
});

describe('file names', () => {
  test('fileStem: name without its extension', () => {
    expect(fileStem('보고서 최종.pdf')).toBe('보고서 최종');
    expect(fileStem('a.tar.gz')).toBe('a.tar');
    expect(fileStem('README')).toBe('README');
    expect(fileStem('.gitignore')).toBe('.gitignore');
    expect(fileStem('')).toBe('');
    expect(fileStem(null)).toBe('');
    expect([...fileStem(`${'가'.repeat(250)}.txt`)]).toHaveLength(200);
  });
  test('pastedHint: clipboard images get a readable title hint', () => {
    expect(pastedHint({ name: 'image.png', type: 'image/png' })).toBe('붙여넣은 이미지');
    expect(pastedHint({ name: 'image.jpeg', type: 'image/jpeg' })).toBe('붙여넣은 이미지');
    expect(pastedHint({ name: '휴가.png', type: 'image/png' })).toBeNull();
    expect(pastedHint({ name: 'image.png', type: '' })).toBeNull();
  });
});

describe('saveError', () => {
  const E = (status, code) => ({ status, code });
  test('each failure has its own line', () => {
    expect(saveError(E(0, 'offline'))).toBe('서버와 연결이 끊겨서 저장하지 못했어요. 서버를 켠 뒤 다시 눌러 주세요');
    expect(saveError(E(0, 'upload_failed'))).toBe('읽을 수 없는 파일이 있어요. 폴더는 담을 수 없어요');
    expect(saveError(E(0, 'aborted'))).toBe('올리기를 멈췄어요');
    expect(saveError(E(400, 'unknown_planet'))).toBe('그 행성이 사라졌어요. 다시 골라 주세요');
    expect(saveError(E(413, 'too_large'))).toBe('글이 너무 길어요');
    expect(saveError(E(413, 'too_large'), true)).toBe('500MB보다 큰 파일은 담을 수 없어요');
    expect(saveError(E(400, 'invalid_body'))).toBe('글이 너무 길어요');
    expect(saveError(E(400, 'invalid_url'))).toBe('링크 주소를 다시 확인해 주세요');
    expect(saveError(E(400, 'invalid_links'))).toBe('링크 주소를 다시 확인해 주세요');
    expect(saveError(E(0, 'stop_late'))).toBe('멈추기 전에 다 올라갔을 수 있어요. 목록을 확인해 주세요');
    expect(saveError(E(400, 'too_many_attachments'))).toBe('첨부는 50개까지 담을 수 있어요');
    expect(saveError(E(400, 'empty_star'))).toBe('내용을 입력해 주세요');
    expect(saveError(E(400, 'upload_incomplete'))).toBe('파일을 다 받지 못했어요. 다시 눌러 주세요');
    expect(saveError(E(400, 'invalid_name'))).toBe('행성 이름은 1~20자로 써 주세요');
  });
  test('anything else is the general line', () => {
    expect(saveError(E(500, 'server_error'))).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(saveError(new Error('x'))).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(saveError(null)).toBe('저장하지 못했어요. 다시 눌러 주세요');
  });
});

describe('planet name', () => {
  test('cleanPlanetName: NFC, invisible characters removed, trimmed', () => {
    expect(cleanPlanetName('  공부 ​')).toBe('공부');
    expect(cleanPlanetName('가')).toBe('가');
    expect(cleanPlanetName('a﻿b⁠c\u0007')).toBe('abc');
    expect(cleanPlanetName(null)).toBe('');
  });
  test('planetNameLength counts code points', () => {
    expect(planetNameLength('𝒜𝒜')).toBe(2);
    expect(planetNameLength(' 가나 ')).toBe(2);
  });
});

describe('defaultPlanetId', () => {
  const ps = [{ id: 'unsorted' }, { id: 'a' }, { id: 'b' }];
  test('defaultPlanetId: panel planet first, then unsorted', () => {
    expect(defaultPlanetId({ panelPlanetId: 'b', planets: ps })).toBe('b');
    expect(defaultPlanetId({ panelPlanetId: null, planets: ps })).toBe('unsorted');
    expect(defaultPlanetId({ panelPlanetId: 'gone', planets: ps })).toBe('unsorted');
  });
  test('defaultPlanetId: lastPlanetId is not used', () => {
    expect(defaultPlanetId({ panelPlanetId: null, lastPlanetId: 'b', planets: ps })).toBe('unsorted');
  });
  test('defaultPlanetId: numeric panel id matches as a string', () => {
    expect(defaultPlanetId({ panelPlanetId: 2, planets: [{ id: 'unsorted' }, { id: 2 }] })).toBe('2');
  });
  test('defaultPlanetId: old server without unsorted → first planet', () => {
    expect(defaultPlanetId({ planets: [{ id: 'a' }] })).toBe('a');
  });
  test('defaultPlanetId: no planets → "new"', () => {
    expect(defaultPlanetId({ planets: [] })).toBe('new');
    expect(defaultPlanetId({ panelPlanetId: 1, planets: [] })).toBe('new');
    expect(defaultPlanetId()).toBe('new');
  });
});

describe('splitDropped', () => {
  test('splitDropped: skips directories and counts them', () => {
    const f = file('a.txt');
    const items = [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory: false }) },
    ];
    expect(splitDropped(items)).toEqual({ files: [f], folders: 1 });
  });
  test('splitDropped: ignores non-file items, missing entry api and null files', () => {
    const f = file('a.txt');
    const items = {
      length: 4,
      0: { kind: 'string', getAsFile: () => null },
      1: { kind: 'file', getAsFile: () => f },
      2: { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => null },
      3: { kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => null },
    };
    expect(splitDropped(items)).toEqual({ files: [f, f], folders: 0 });
  });
  test('splitDropped: zero-byte files stay', () => {
    const z = file('empty.txt', 0);
    expect(splitDropped([{ kind: 'file', getAsFile: () => z, webkitGetAsEntry: () => ({ isDirectory: false }) }]).files).toEqual([z]);
  });
  test('splitDropped: nothing', () => {
    expect(splitDropped(null)).toEqual({ files: [], folders: 0 });
    expect(splitDropped([])).toEqual({ files: [], folders: 0 });
  });
});

describe('dedupeFiles', () => {
  test('same name + size + lastModified is not added twice', () => {
    const a = file('a.txt', 3, 100);
    const again = file('a.txt', 3, 100);
    const newer = file('a.txt', 3, 200);
    const b = file('b.txt', 3, 100);
    expect(dedupeFiles([a], [again, newer, b])).toEqual([newer, b]);
  });
  test('duplicates inside the incoming list are dropped too', () => {
    const a = file('a.txt', 3, 100);
    expect(dedupeFiles([], [a, file('a.txt', 3, 100)])).toEqual([a]);
  });
  test('zero-byte files with different names both stay', () => {
    const x = file('x', 0, 1);
    const y = file('y', 0, 1);
    expect(dedupeFiles([], [x, y])).toEqual([x, y]);
  });
  test('does not change its inputs', () => {
    const existing = [file('a', 1, 1)];
    const incoming = [file('a', 1, 1)];
    dedupeFiles(existing, incoming);
    expect(existing).toHaveLength(1);
    expect(incoming).toHaveLength(1);
    expect(dedupeFiles(undefined, undefined)).toEqual([]);
  });
});

describe('partitionBySize', () => {
  test('files over the limit are split off; the limit itself is fine', () => {
    const ok = file('ok', FILE_MAX);
    const big = file('big', FILE_MAX + 1);
    const zero = file('zero', 0);
    expect(partitionBySize([ok, big, zero])).toEqual({ ok: [ok, zero], tooBig: [big] });
    expect(partitionBySize([ok, zero], 5)).toEqual({ ok: [zero], tooBig: [ok] });
    expect(partitionBySize()).toEqual({ ok: [], tooBig: [] });
  });
});

describe('clampPlanetName', () => {
  const nfd = (s) => s.normalize('NFD');
  const twentyHangul = '가나다라마바사아자차카타파하거너더러머버';
  test('decomposed Hangul is counted after NFC: 20 syllables are not cut', () => {
    expect([...nfd(twentyHangul)].length).toBeGreaterThan(20);
    expect(clampPlanetName(nfd(twentyHangul))).toBe(nfd(twentyHangul));
    expect(clampPlanetName(nfd(twentyHangul + '서'))).toBe(twentyHangul);
  });
  test('invisible characters are not counted', () => {
    const twenty = 'abcdefghijklmnopqrst';
    expect(clampPlanetName('\u200b' + twenty)).toBe('\u200b' + twenty);
    expect(clampPlanetName('\u200b' + twenty + 'u')).toBe(twenty);
  });
  test('over 20 code points is cut to 20; short names are returned as typed', () => {
    expect(clampPlanetName('a'.repeat(25))).toBe('a'.repeat(20));
    expect([...clampPlanetName('𝒜'.repeat(21))].length).toBe(20);
    expect(clampPlanetName('공부 ')).toBe('공부 ');
    expect(clampPlanetName('  ' + 'a'.repeat(20))).toBe('  ' + 'a'.repeat(20));
    expect(clampPlanetName(null)).toBe('');
  });
});
