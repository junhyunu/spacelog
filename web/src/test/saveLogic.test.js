import { describe, expect, test } from 'vitest';
import {
  FILE_MAX,
  FILES_MAX,
  canSubmit,
  clampPlanetName,
  classifyDrop,
  classifyPaste,
  cleanPlanetName,
  dedupeFiles,
  defaultPlanetId,
  fileStem,
  partitionBySize,
  pastedTitle,
  planetNameLength,
  remainingAfterUpload,
  remainingMessage,
  resultToast,
  saveError,
  splitDropped,
  urlError,
} from '../ui/saveLogic.js';

const file = (name, size = 10, lastModified = 1) => ({ name, size, lastModified, type: '' });

describe('classifyPaste', () => {
  test('classifyPaste: files win', () => {
    const f = file('a.png');
    expect(classifyPaste({ files: [f], text: 'x' })).toEqual({ tab: 'file', files: [f] });
  });
  test('classifyPaste: single url → link', () => {
    expect(classifyPaste({ files: [], text: ' https://a.com/x ' })).toEqual({ tab: 'link', url: 'https://a.com/x' });
    expect(classifyPaste({ files: [], text: 'HTTP://a.com\n' })).toEqual({ tab: 'link', url: 'HTTP://a.com' });
  });
  test('classifyPaste: url inside a sentence → text', () => {
    expect(classifyPaste({ files: [], text: '이것 봐 https://a.com/x' })).toEqual({ tab: 'text', text: '이것 봐 https://a.com/x' });
    expect(classifyPaste({ files: [], text: 'https://a.com https://b.com' }).tab).toBe('text');
    expect(classifyPaste({ files: [], text: 'https://' }).tab).toBe('text');
  });
  test('classifyPaste: text keeps its own whitespace', () => {
    expect(classifyPaste({ files: [], text: '첫 줄\n  둘째 줄\n' })).toEqual({ tab: 'text', text: '첫 줄\n  둘째 줄\n' });
  });
  test('classifyPaste: empty → null', () => {
    expect(classifyPaste({ files: [], text: '' })).toBeNull();
    expect(classifyPaste({ files: [], text: '  \n ' })).toBeNull();
    expect(classifyPaste({})).toBeNull();
    expect(classifyPaste()).toBeNull();
  });
});

test('urlError', () => {
  expect(urlError('')).toBeNull();
  expect(urlError('   ')).toBeNull();
  expect(urlError('naver.com')).toBe('주소는 http로 시작해야 해요');
  expect(urlError('ftp://a.com')).toBe('주소는 http로 시작해야 해요');
  expect(urlError('https://a.com')).toBeNull();
  expect(urlError(' http://a.com ')).toBeNull();
  expect(urlError('HTTPS://A.COM')).toBeNull();
  expect(urlError('https://')).toBe('주소는 http로 시작해야 해요');
  expect(urlError('https://a b')).toBe('주소는 http로 시작해야 해요');
});

describe('canSubmit', () => {
  test('canSubmit: needs content and a planet', () => {
    expect(canSubmit({ tab: 'text', text: '  \n', planetId: '1' })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', planetId: '1' })).toBe(true);
    expect(canSubmit({ tab: 'file', files: [], planetId: '1' })).toBe(false);
    expect(canSubmit({ tab: 'file', files: [file('a')], planetId: '1' })).toBe(true);
    expect(canSubmit({ tab: 'text', text: '글', planetId: 'new', newPlanetName: '' })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', planetId: 'new', newPlanetName: '  ' })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', planetId: 'new', newPlanetName: '공부' })).toBe(true);
    expect(canSubmit({ tab: 'text', text: '글', planetId: null })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', planetId: '' })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', planetId: 3 })).toBe(true);
    expect(canSubmit()).toBe(false);
  });
  test('canSubmit: link with invalid url is false', () => {
    expect(canSubmit({ tab: 'link', url: 'naver.com', planetId: '1' })).toBe(false);
    expect(canSubmit({ tab: 'link', url: '', planetId: '1' })).toBe(false);
    expect(canSubmit({ tab: 'link', url: ' https://naver.com ', planetId: '1' })).toBe(true);
  });
  test('canSubmit: only the active tab counts', () => {
    expect(canSubmit({ tab: 'link', text: '글', url: '', files: [file('a')], planetId: '1' })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', url: 'naver.com', planetId: '1' })).toBe(true);
  });
  test('canSubmit: new planet name is counted like the server (20 code points)', () => {
    expect(canSubmit({ tab: 'text', text: '글', planetId: 'new', newPlanetName: '가'.repeat(20) })).toBe(true);
    expect(canSubmit({ tab: 'text', text: '글', planetId: 'new', newPlanetName: '가'.repeat(21) })).toBe(false);
    expect(canSubmit({ tab: 'text', text: '글', planetId: 'new', newPlanetName: '​​' })).toBe(false);
  });
  test('canSubmit: too many files is false', () => {
    const many = Array.from({ length: FILES_MAX + 1 }, (_, i) => file(`f${i}`));
    expect(canSubmit({ tab: 'file', files: many, planetId: '1' })).toBe(false);
    expect(canSubmit({ tab: 'file', files: many.slice(0, FILES_MAX), planetId: '1' })).toBe(true);
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
  const planets = [{ id: 1 }, { id: 2 }, { id: 3 }];
  test('defaultPlanetId: panel planet first, then last saved, then new', () => {
    expect(defaultPlanetId({ panelPlanetId: 2, lastPlanetId: '3', planets })).toBe('2');
    expect(defaultPlanetId({ panelPlanetId: null, lastPlanetId: '3', planets })).toBe('3');
    expect(defaultPlanetId({ panelPlanetId: null, lastPlanetId: null, planets: [] })).toBe('new');
  });
  test('defaultPlanetId: last saved planet that no longer exists → first planet', () => {
    expect(defaultPlanetId({ panelPlanetId: null, lastPlanetId: '9', planets })).toBe('1');
    expect(defaultPlanetId({ panelPlanetId: 9, lastPlanetId: null, planets })).toBe('1');
    expect(defaultPlanetId({ panelPlanetId: 9, lastPlanetId: '2', planets })).toBe('2');
  });
  test('defaultPlanetId: planets but nothing saved yet → first planet', () => {
    expect(defaultPlanetId({ panelPlanetId: null, lastPlanetId: null, planets })).toBe('1');
  });
  test('defaultPlanetId: no planets → "new"', () => {
    expect(defaultPlanetId({ panelPlanetId: 1, lastPlanetId: '1', planets: [] })).toBe('new');
    expect(defaultPlanetId()).toBe('new');
  });
});

describe('resultToast', () => {
  test('resultToast: all saved', () => expect(resultToast({ created: [1, 2], skipped: [] })).toBe('별 2개를 띄웠어요'));
  test('resultToast: partial', () =>
    expect(resultToast({ created: [1], skipped: [{ reason: 'duplicate' }] })).toBe('별 1개를 띄웠어요. 1개는 이미 있거나 너무 커서 빼놨어요'));
  test('resultToast: single duplicate', () => expect(resultToast({ created: [], skipped: [{ reason: 'duplicate' }] })).toBe('이미 있는 별이에요'));
  test('resultToast: single too large', () =>
    expect(resultToast({ created: [], skipped: [{ reason: 'too_large' }] })).toBe('500MB보다 큰 파일은 담을 수 없어요'));
  test('resultToast: nothing saved, several', () =>
    expect(resultToast({ created: [], skipped: [{ reason: 'duplicate' }, { reason: 'too_large' }] })).toBe(
      '띄운 별이 없어요. 이미 있거나 너무 큰 파일이에요',
    ));
  test('resultToast: too many', () => {
    expect(resultToast({ created: [1, 2], skipped: [{ reason: 'too_many' }, { reason: 'too_many' }] })).toBe(
      '별 2개를 띄웠어요. 한 번에 500개까지 띄울 수 있어요',
    );
    expect(resultToast({ created: [1], skipped: [{ reason: 'duplicate' }, { reason: 'too_many' }] })).toBe(
      '별 1개를 띄웠어요. 1개는 이미 있거나 너무 커서 빼놨어요. 한 번에 500개까지 띄울 수 있어요',
    );
  });
  test('resultToast: failed', () => {
    expect(resultToast({ created: [1], skipped: [{ reason: 'failed' }, { reason: 'failed' }] })).toBe('별 1개를 띄웠어요. 2개는 저장하지 못했어요');
    expect(resultToast({ created: [], skipped: [{ reason: 'failed' }] })).toBe('띄운 별이 없어요. 1개는 저장하지 못했어요');
    expect(resultToast({ created: [], skipped: [{ reason: 'duplicate' }, { reason: 'failed' }] })).toBe(
      '띄운 별이 없어요. 1개는 이미 있거나 너무 컸고, 1개는 저장하지 못했어요',
    );
    // 모르는 이유는 저장 실패로 센다
    expect(resultToast({ created: [1], skipped: [{ reason: 'weird' }] })).toBe('별 1개를 띄웠어요. 1개는 저장하지 못했어요');
  });
  test('resultToast: nothing at all', () => {
    expect(resultToast({ created: [], skipped: [] })).toBe('띄운 별이 없어요');
    expect(resultToast()).toBe('띄운 별이 없어요');
  });
  test('resultToast: numbers get separators', () => {
    expect(resultToast({ created: Array(1200).fill(0), skipped: [] })).toBe('별 1,200개를 띄웠어요');
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

describe('file titles', () => {
  test('fileStem: name without its extension', () => {
    expect(fileStem('보고서 최종.pdf')).toBe('보고서 최종');
    expect(fileStem('a.tar.gz')).toBe('a.tar');
    expect(fileStem('README')).toBe('README');
    expect(fileStem('.gitignore')).toBe('.gitignore');
    expect(fileStem('끝점.')).toBe('끝점');
    expect(fileStem('')).toBe('');
    expect(fileStem(null)).toBe('');
  });
  test('fileStem: cut to 200 characters', () => {
    expect([...fileStem(`${'가'.repeat(250)}.txt`)]).toHaveLength(200);
  });
  test('pastedTitle: screenshots get a readable title', () => {
    expect(pastedTitle({ name: 'image.png', type: 'image/png' })).toBe('붙여넣은 이미지');
    expect(pastedTitle({ name: '휴가.png', type: 'image/png' })).toBe('휴가');
    expect(pastedTitle({ name: 'image.png', type: '' })).toBe('image');
  });
});

describe('saveError', () => {
  const E = (status, code) => ({ status, code });
  test('each failure has its own line', () => {
    expect(saveError(E(0, 'offline'))).toBe('서버와 연결이 끊겨서 저장하지 못했어요. 서버를 켠 뒤 다시 눌러 주세요');
    expect(saveError(E(0, 'upload_failed'))).toBe('읽을 수 없는 파일이 있어요. 폴더는 담을 수 없어요');
    expect(saveError(E(400, 'unknown_planet'))).toBe('그 행성이 사라졌어요. 다시 골라 주세요');
    expect(saveError(E(413, 'too_large'))).toBe('글이 너무 길어요');
    expect(saveError(E(413, 'too_large'), 'text')).toBe('글이 너무 길어요');
    expect(saveError(E(413, 'too_large'), 'file')).toBe('500MB보다 큰 파일은 담을 수 없어요');
    expect(saveError(E(400, 'invalid_memo'))).toBe('메모가 너무 길어요');
    expect(saveError(E(400, 'invalid_url'))).toBe('주소는 http로 시작해야 해요');
    expect(saveError(E(400, 'invalid_name'))).toBe('행성 이름은 1~20자로 써 주세요');
    expect(saveError(E(400, 'empty_body'))).toBe('내용을 입력해 주세요');
    expect(saveError(E(400, 'no_files'))).toBe('담긴 파일이 없어요');
    expect(saveError(E(0, 'aborted'), 'file')).toBe('올리기를 멈췄어요');
  });
  test('anything else is the general line', () => {
    expect(saveError(E(500, 'server_error'))).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(saveError(new Error('x'))).toBe('저장하지 못했어요. 다시 눌러 주세요');
    expect(saveError(null)).toBe('저장하지 못했어요. 다시 눌러 주세요');
  });
});

describe('classifyPaste: text beside rendered images (Excel · Word · PowerPoint)', () => {
  const img = (name = 'image.png') => ({ name, size: 10, lastModified: 1, type: 'image/png' });
  test('text + image files → the text wins', () => {
    expect(classifyPaste({ files: [img()], text: '이름\t점수\n가\t10' })).toEqual({ tab: 'text', text: '이름\t점수\n가\t10' });
    expect(classifyPaste({ files: [img(), img('b.png')], text: ' https://a.com/x ' })).toEqual({ tab: 'link', url: 'https://a.com/x' });
  });
  test('image without text, or blank text → files', () => {
    const f = img();
    expect(classifyPaste({ files: [f], text: '' })).toEqual({ tab: 'file', files: [f] });
    expect(classifyPaste({ files: [f], text: '  \n' })).toEqual({ tab: 'file', files: [f] });
    expect(classifyPaste({ files: [f] })).toEqual({ tab: 'file', files: [f] });
  });
  test('text + a file that is not an image → files', () => {
    const pdf = { name: 'a.pdf', size: 1, lastModified: 1, type: 'application/pdf' };
    const f = img();
    expect(classifyPaste({ files: [f, pdf], text: 'x' })).toEqual({ tab: 'file', files: [f, pdf] });
    expect(classifyPaste({ files: [file('a.txt')], text: 'x' }).tab).toBe('file');
  });
});

describe('classifyDrop', () => {
  test('uri-list: first http(s) address, comment lines skipped', () => {
    expect(
      classifyDrop({ types: ['text/uri-list', 'text/plain'], uriList: '# 설명\r\nhttps://a.com/x\r\nhttps://b.com', text: 'https://a.com/x' }),
    ).toEqual({ tab: 'link', url: 'https://a.com/x' });
    expect(classifyDrop({ types: ['text/uri-list'], uriList: 'HTTP://A.com/\n' })).toEqual({ tab: 'link', url: 'HTTP://A.com/' });
  });
  test('uri-list without an http address falls back to the text', () => {
    expect(classifyDrop({ types: ['text/uri-list', 'text/plain'], uriList: 'javascript:alert(1)', text: 'https://a.com' })).toEqual({
      tab: 'link',
      url: 'https://a.com',
    });
    expect(classifyDrop({ types: ['text/uri-list'], uriList: 'file:///C:/a.txt\nmailto:a@b.c' })).toBeNull();
    expect(classifyDrop({ types: ['text/uri-list', 'text/plain'], uriList: 'javascript:alert(1)', text: 'javascript:alert(1)' })).toEqual({
      tab: 'text',
      text: 'javascript:alert(1)',
    });
  });
  test('plain text: one address → link, anything else → text', () => {
    expect(classifyDrop({ types: ['text/plain'], text: ' https://a.com/x\n' })).toEqual({ tab: 'link', url: 'https://a.com/x' });
    expect(classifyDrop({ types: ['text/plain'], text: '끌어온 글 https://a.com' })).toEqual({ tab: 'text', text: '끌어온 글 https://a.com' });
  });
  test('files win over text', () => {
    const f = file('a.txt');
    expect(classifyDrop({ types: ['Files', 'text/uri-list'], uriList: 'https://a.com', files: [f] })).toEqual({ tab: 'file', files: [f] });
  });
  test('nothing usable → null', () => {
    expect(classifyDrop({ types: ['text/plain'], text: '  ' })).toBeNull();
    expect(classifyDrop({ types: ['text/html'] })).toBeNull();
    expect(classifyDrop({})).toBeNull();
    expect(classifyDrop()).toBeNull();
  });
});

describe('remainingAfterUpload', () => {
  const item = (name) => ({ id: name, file: { name } });
  const names = (list) => list.map((it) => it.file.name);
  const star = (file_name) => ({ id: file_name, file_name });
  test('failed files stay, saved and final skips go', () => {
    const items = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(item);
    const out = remainingAfterUpload(items, {
      created: [star('a.txt'), star('d.txt')],
      skipped: [
        { file_name: 'b.txt', reason: 'failed' },
        { file_name: 'c.txt', reason: 'duplicate' },
      ],
    });
    expect(names(out)).toEqual(['b.txt']);
    expect(out[0]).toBe(items[1]);
  });
  test('same name twice is matched in order', () => {
    const items = ['a.txt', 'a.txt', 'a.txt'].map(item);
    const out = remainingAfterUpload(items, {
      created: [star('a.txt')],
      skipped: [
        { file_name: 'a.txt', reason: 'failed' },
        { file_name: 'a.txt', reason: 'too_large' },
      ],
    });
    expect(out).toEqual([items[1]]);
    expect(out[0]).toBe(items[1]);
  });
  test('too_many (no name): everything after the last accounted file stays', () => {
    const items = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(item);
    const out = remainingAfterUpload(items, {
      created: [star('a.txt'), star('c.txt')],
      skipped: [
        { file_name: 'b.txt', reason: 'duplicate' },
        { file_name: null, reason: 'too_many' },
      ],
    });
    expect(names(out)).toEqual(['d.txt', 'e.txt']);
  });
  test('request cut short (failed, no name) keeps named failures and the tail', () => {
    const items = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(item);
    const out = remainingAfterUpload(items, {
      created: [star('b.txt')],
      skipped: [
        { file_name: 'a.txt', reason: 'failed' },
        { file_name: null, reason: 'failed' },
      ],
    });
    expect(names(out)).toEqual(['a.txt', 'c.txt', 'd.txt']);
  });
  test('nameless skip with nothing accounted keeps everything', () => {
    const items = ['a.txt', 'b.txt'].map(item);
    expect(remainingAfterUpload(items, { created: [], skipped: [{ file_name: null, reason: 'failed' }] })).toEqual(items);
  });
  test('names are compared the way the server stores them (NFC)', () => {
    const items = [item('가나.txt'.normalize('NFD')), item('b.txt')];
    const out = remainingAfterUpload(items, {
      created: [star('b.txt')],
      skipped: [{ file_name: '가나.txt'.normalize('NFC'), reason: 'failed' }],
    });
    expect(out).toEqual([items[0]]);
  });
  test('unknown reasons count as failed; nothing to keep → empty; inputs untouched', () => {
    const items = ['a.txt', 'b.txt'].map(item);
    const copy = [...items];
    expect(remainingAfterUpload(items, { created: [star('a.txt')], skipped: [{ file_name: 'b.txt', reason: 'weird' }] })).toEqual([items[1]]);
    expect(remainingAfterUpload(items, { created: [star('a.txt'), star('b.txt')], skipped: [] })).toEqual([]);
    expect(remainingAfterUpload(items, { created: [star('a.txt')], skipped: [{ file_name: 'b.txt', reason: 'duplicate' }] })).toEqual([]);
    expect(remainingAfterUpload(items)).toEqual([]);
    expect(remainingAfterUpload()).toEqual([]);
    expect(items).toEqual(copy);
  });
});

test('remainingMessage', () => {
  expect(remainingMessage(2, [{ reason: 'failed' }])).toBe('2개는 저장하지 못했어요. 다시 눌러 주세요');
  expect(remainingMessage(1200, [{ reason: 'duplicate' }, { reason: 'too_many' }])).toBe(
    '한 번에 500개까지 띄울 수 있어요. 남은 1,200개를 이어서 띄워 주세요',
  );
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

describe('review additions', () => {
  test('uppercase HTTP:// is accepted', () => {
    expect(urlError('HTTP://a.com/x')).toBeNull();
    expect(canSubmit({ tab: 'link', url: 'HTTP://A.COM', planetId: '1' })).toBe(true);
    expect(classifyPaste({ text: 'HTTPS://A.COM/Path' })).toEqual({ tab: 'link', url: 'HTTPS://A.COM/Path' });
  });
  test('NFD planet names are cleaned and counted as NFC', () => {
    const name = '공부하는 행성';
    const twenty = '가나다라마바사아자차카타파하거너더러머버'.normalize('NFD');
    expect(cleanPlanetName(name.normalize('NFD'))).toBe(name);
    expect(planetNameLength(name.normalize('NFD'))).toBe(7);
    expect(canSubmit({ tab: 'text', text: 'x', planetId: 'new', newPlanetName: twenty })).toBe(true);
    expect(canSubmit({ tab: 'text', text: 'x', planetId: 'new', newPlanetName: twenty + '서'.normalize('NFD') })).toBe(false);
  });
});
