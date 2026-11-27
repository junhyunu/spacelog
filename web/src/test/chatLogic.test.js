import { describe, expect, test } from 'vitest';
import {
  ANNOUNCE_MAX,
  QUESTION_MAX,
  answerAnnouncement,
  askMeta,
  canSend,
  chatButtonLabel,
  chatButtonText,
  chatHintVisible,
  contextFor,
  counterText,
  errorMessage,
  failedLine,
  indexLine,
  nextRetryDelay,
  panelMode,
  quickQuestions,
  savedStarSource,
  relativeTime,
  shouldPollUnread,
  sourceCardModel,
  titleFrom,
  unavailableMessage,
} from '../ui/chatLogic.js';

const planets = [
  { id: 'p1', name: '운동 기록', color_index: 2 },
  { id: 'p2', name: '읽은 것들', color_index: 3 },
];

describe('contextFor', () => {
  test('nothing open → empty context', () => {
    expect(contextFor({ inWorld: true, panelPlanetId: null, detailStarId: null, planets })).toEqual({});
  });
  test('panel open → planet id and name', () => {
    expect(contextFor({ inWorld: true, panelPlanetId: 'p1', detailStarId: null, planets })).toEqual({ planet_id: 'p1', planet_name: '운동 기록' });
  });
  test('detail open → planet and star', () => {
    expect(contextFor({ inWorld: true, panelPlanetId: 'p2', detailStarId: 's9', planets })).toEqual({
      planet_id: 'p2',
      planet_name: '읽은 것들',
      star_id: 's9',
    });
  });
  test('on the home there is no context', () => {
    expect(contextFor({ inWorld: false, panelPlanetId: 'p1', detailStarId: 's9', planets })).toEqual({});
  });
  test('unknown planet → no planet context', () => {
    expect(contextFor({ inWorld: true, panelPlanetId: 'gone', detailStarId: null, planets })).toEqual({});
  });
});

describe('quickQuestions', () => {
  test('three questions without a panel', () => {
    const q = quickQuestions({ inWorld: true, panelPlanetId: null, planets });
    expect(q).toHaveLength(3);
    expect(q.slice(0, 2)).toEqual(['오늘 띄운 별 요약해 줘', '이번 주 기록 정리해 줘']);
  });
  test('open panel → third asks about that planet', () => {
    expect(quickQuestions({ inWorld: true, panelPlanetId: 'p2', planets })[2]).toBe("'읽은 것들' 행성 요약해 줘");
  });
  test('no exclamation marks or banned words', () => {
    for (const s of quickQuestions({ inWorld: false, planets })) expect(s).not.toMatch(/[!]|보내기|전송|발사/);
  });
});

describe('indexLine', () => {
  const now = new Date(2026, 10, 13, 18, 0);
  test('done line with last time (today → time only)', () => {
    const at = new Date(2026, 10, 13, 15, 20).toISOString();
    expect(indexLine({ total: 132, done: 130, failed: 2, pending: 0, skipped: 0, indexing: false, last_indexed_at: at }, now)).toBe(
      '챗봇이 읽은 기록: 별 132개 중 130개 · 마지막으로 읽은 시각 오후 3:20',
    );
  });
  test('skipped stars are not counted', () => {
    expect(indexLine({ total: 10, done: 4, failed: 0, pending: 0, skipped: 6, indexing: false, last_indexed_at: null }, now)).toBe(
      '챗봇이 읽은 기록: 별 4개 중 4개 · 마지막으로 읽은 시각 미확인',
    );
  });
  test('another day shows the date', () => {
    const at = new Date(2026, 10, 12, 9, 5).toISOString();
    expect(indexLine({ total: 1, done: 1, failed: 0, pending: 0, skipped: 0, last_indexed_at: at }, now)).toBe(
      '챗봇이 읽은 기록: 별 1개 중 1개 · 마지막으로 읽은 시각 11.12 오전 9:05',
    );
  });
  test('indexing → progress', () => {
    expect(indexLine({ total: 132, done: 45, failed: 0, pending: 87, skipped: 0, indexing: true }, now)).toBe('읽는 중… 45 / 132');
  });
  test('thousands get separators', () => {
    expect(indexLine({ total: 1240, done: 45, failed: 0, pending: 0, skipped: 0, indexing: true }, now)).toBe('읽는 중… 45 / 1,240');
  });
  test('missing status → 미확인', () => {
    expect(indexLine(null, now)).toBe('챗봇이 읽은 기록: 미확인');
  });
  test('failedLine', () => {
    expect(failedLine({ failed: 2 })).toBe('읽지 못한 별 2개');
    expect(failedLine({ failed: 0 })).toBe('');
  });
});

describe('sourceCardModel', () => {
  test('live star', () => {
    const m = sourceCardModel(
      { star_id: 's1', exists: true, title: 'MCP가 뭐더라', planet_id: 'p1', created_at: new Date(2026, 10, 11).toISOString(), file_name: 'a.pdf' },
      planets,
      new Date(2026, 10, 20),
    );
    expect(m).toEqual({ title: 'MCP가 뭐더라', color: '#5ec8ff', date: '11.11', file: 'a.pdf', gone: false });
  });
  test('deleted star', () => {
    const m = sourceCardModel({ star_id: 's1', exists: false, title: null, planet_id: null, created_at: null, file_name: 'a.pdf' }, planets);
    expect(m.gone).toBe(true);
    expect(m.title).toBe('지워진 별');
    expect(m.date).toBe('');
  });
  test('untitled star and unknown planet', () => {
    const m = sourceCardModel({ star_id: 's1', exists: true, title: '', planet_id: 'x', created_at: null, file_name: null }, planets);
    expect(m.title).toBe('제목 없음');
    expect(m.color).toBe('#5b5480');
    expect(m.file).toBe('');
  });
});

describe('unavailableMessage', () => {
  test('ready with key → empty', () => {
    expect(unavailableMessage({ rag: { state: 'ready' }, key: true })).toBe('');
  });
  test('ready, key unknown → empty', () => {
    expect(unavailableMessage({ rag: { state: 'ready' }, key: null })).toBe('');
  });
  test('python missing', () => {
    expect(unavailableMessage({ rag: { state: 'missing', reason: 'not_installed' } })).toBe('챗봇을 준비하지 못했어요. README의 챗봇 설치 순서를 따라 주세요');
  });
  test('key missing', () => {
    expect(unavailableMessage({ rag: { state: 'ready' }, key: false })).toBe('OpenAI 키가 없어요. .env 파일에 키를 넣고 서버를 다시 켜 주세요');
  });
  test('port in use', () => {
    expect(unavailableMessage({ rag: { state: 'crashed', reason: 'port_in_use' } })).toBe(
      '챗봇 서버 포트를 다른 프로그램이 쓰고 있어요. 다른 spaceLog가 켜져 있으면 닫아 주세요',
    );
  });
  test('starting, crashed, gave up, off all have copy', () => {
    for (const rag of [{ state: 'starting' }, { state: 'crashed', reason: 'exited' }, { state: 'crashed', reason: 'too_many_restarts' }, { state: 'off' }, {}]) {
      const s = unavailableMessage({ rag });
      expect(s).not.toBe('');
      expect(s).not.toMatch(/!/);
    }
    expect(unavailableMessage({ rag: { state: 'starting' } })).toMatch(/준비하는 중/);
    expect(unavailableMessage({ rag: { state: 'crashed', reason: 'too_many_restarts' } })).toMatch(/다시 켜 주세요/);
  });
  test('no status at all → unknown copy', () => {
    expect(unavailableMessage(null)).not.toBe('');
  });
});

describe('canSend', () => {
  const ok = { text: '오늘 뭐 했지', composing: false, busy: false, enabled: true };
  test('normal', () => expect(canSend(ok)).toBe(true));
  test('blank', () => expect(canSend({ ...ok, text: '  \n ' })).toBe(false));
  test('composing', () => expect(canSend({ ...ok, composing: true })).toBe(false));
  test('busy', () => expect(canSend({ ...ok, busy: true })).toBe(false));
  test('disabled', () => expect(canSend({ ...ok, enabled: false })).toBe(false));
  test('length limit counts code points', () => {
    expect(canSend({ ...ok, text: '가'.repeat(QUESTION_MAX) })).toBe(true);
    expect(canSend({ ...ok, text: '가'.repeat(QUESTION_MAX + 1) })).toBe(false);
    expect(canSend({ ...ok, text: '😀'.repeat(QUESTION_MAX) })).toBe(true);
  });
});

describe('counterText', () => {
  test('hidden far from the limit', () => expect(counterText('가'.repeat(100))).toBe(''));
  test('shown near the limit', () => expect(counterText('가'.repeat(1850))).toBe('1,850/2,000'));
});

describe('titleFrom', () => {
  test('first 30 characters, whitespace collapsed', () => {
    expect(titleFrom('  오늘   띄운\n별 ')).toBe('오늘 띄운 별');
    expect(titleFrom('가'.repeat(40))).toBe('가'.repeat(30));
  });
  test('empty → 새 대화', () => expect(titleFrom('   ')).toBe('새 대화'));
});

describe('relativeTime', () => {
  const now = new Date(2026, 10, 13, 12, 0);
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  test('just now', () => expect(relativeTime(ago(20_000), now)).toBe('방금'));
  test('minutes', () => expect(relativeTime(ago(5 * 60_000), now)).toBe('5분 전'));
  test('hours', () => expect(relativeTime(ago(3 * 3600_000), now)).toBe('3시간 전'));
  test('yesterday', () => expect(relativeTime(new Date(2026, 10, 12, 23, 0).toISOString(), new Date(2026, 10, 13, 9, 0))).toBe('어제'));
  test('days', () => expect(relativeTime(new Date(2026, 10, 9, 12, 0).toISOString(), now)).toBe('4일 전'));
  test('older → date', () => expect(relativeTime(new Date(2026, 9, 1).toISOString(), now)).toBe('10.01'));
  test('another year', () => expect(relativeTime(new Date(2025, 9, 1).toISOString(), now)).toBe('25.10.01'));
  test('bad → 미확인', () => expect(relativeTime('nope', now)).toBe('미확인'));
});

describe('errorMessage', () => {
  test('every server code has copy without ! or apology', () => {
    for (const code of ['rag_unavailable', 'key_missing', 'openai_error', 'too_broad', 'bad_request', 'interrupted', 'internal', 'busy', 'chat_off']) {
      const s = errorMessage(code);
      expect(s).toBeTruthy();
      expect(s).not.toMatch(/!|죄송|보내기|전송|발사/);
    }
  });
  test('busy', () => expect(errorMessage('busy')).toBe('앞의 답을 만드는 중이에요'));
  test('unknown → internal', () => expect(errorMessage('weird')).toBe(errorMessage('internal')));
});

describe('askMeta', () => {
  test('local date and offset', () => {
    const d = new Date(2026, 0, 5, 1, 2);
    expect(askMeta(d)).toEqual({ today: '2026-01-05', tz_offset_min: -d.getTimezoneOffset() });
  });
});

describe('panelMode', () => {
  const ready = { rag: { state: 'ready' }, key: true };
  test('not consented → consent, whatever else', () => {
    expect(panelMode({ consented: false, enabled: false, ...ready })).toBe('consent');
    expect(panelMode({})).toBe('consent');
  });
  test('consented but off → off (tabs stay)', () => {
    expect(panelMode({ consented: true, enabled: false, ...ready })).toBe('off');
    expect(panelMode({ consented: true, enabled: false, rag: { state: 'missing' } })).toBe('off');
  });
  test('on but not usable → unavailable', () => {
    expect(panelMode({ consented: true, enabled: true, rag: { state: 'starting' }, key: null })).toBe('unavailable');
    expect(panelMode({ consented: true, enabled: true, rag: { state: 'ready' }, key: false })).toBe('unavailable');
  });
  test('on and usable → ready (unknown key does not block)', () => {
    expect(panelMode({ consented: true, enabled: true, ...ready })).toBe('ready');
    expect(panelMode({ consented: true, enabled: true, rag: { state: 'ready' }, key: null })).toBe('ready');
  });
});

describe('shouldPollUnread', () => {
  const settings = { consented: true, enabled: true, rag: { state: 'ready' }, key: true };
  test('only when ready, visible and online', () => {
    expect(shouldPollUnread({ settings, hidden: false, offline: false })).toBe(true);
    expect(shouldPollUnread({ settings: null })).toBe(false);
    expect(shouldPollUnread({ settings: { ...settings, consented: false } })).toBe(false);
    expect(shouldPollUnread({ settings: { ...settings, enabled: false } })).toBe(false);
    expect(shouldPollUnread({ settings: { ...settings, rag: { state: 'crashed' } } })).toBe(false);
    expect(shouldPollUnread({ settings, hidden: true })).toBe(false);
    expect(shouldPollUnread({ settings, offline: true })).toBe(false);
  });
});

describe('nextRetryDelay', () => {
  test('3 s → 10 s → 30 s, then stays at 30 s', () => {
    expect([0, 1, 2, 3, 10].map(nextRetryDelay)).toEqual([3000, 10000, 30000, 30000, 30000]);
  });
  test('bad input counts as no failures', () => {
    expect(nextRetryDelay(undefined)).toBe(3000);
    expect(nextRetryDelay(-2)).toBe(3000);
  });
});

describe('chatButtonLabel', () => {
  test('closed', () => {
    expect(chatButtonLabel({ open: false })).toBe('챗봇 열기');
    expect(chatButtonLabel({ open: false, unread: true })).toBe('챗봇 열기, 읽지 않은 답 있음');
  });
  test('open in front / behind the planet panel', () => {
    expect(chatButtonLabel({ open: true, unread: true })).toBe('챗봇 닫기');
    expect(chatButtonLabel({ open: true, behind: true })).toBe('챗봇 앞으로 가져오기');
  });
});

describe('chatButtonText (the word on the button)', () => {
  test('closed: 물어보기, open: 닫기, open behind the planet panel: 물어보기', () => {
    expect(chatButtonText({ open: false })).toBe('물어보기');
    expect(chatButtonText({ open: true })).toBe('닫기');
    expect(chatButtonText({ open: true, behind: true })).toBe('물어보기');
    expect(chatButtonText()).toBe('물어보기');
  });
});

describe('chatHintVisible (first-time bubble over the button)', () => {
  const base = { inWorld: true, total: 3, open: false, dismissed: false, offline: false };
  test('in the world with at least one star, until dismissed', () => {
    expect(chatHintVisible(base)).toBe(true);
    expect(chatHintVisible({ ...base, dismissed: true })).toBe(false);
  });
  test('not on the home screen, not while the chat window is open, not while offline', () => {
    expect(chatHintVisible({ ...base, inWorld: false })).toBe(false);
    expect(chatHintVisible({ ...base, open: true })).toBe(false);
    expect(chatHintVisible({ ...base, offline: true })).toBe(false);
  });
  test('an empty universe shows the 기록하기 bubble instead', () => {
    expect(chatHintVisible({ ...base, total: 0 })).toBe(false);
    expect(chatHintVisible({ ...base, total: undefined })).toBe(false);
    expect(chatHintVisible()).toBe(false);
  });
});

describe('savedStarSource (별로 저장한 답 → 띄운 별로 날아가기)', () => {
  test('a linked star becomes a source the planet panel can fly to', () => {
    expect(savedStarSource({ saved_star: { id: 's1', planet_id: 'p1', created_at: '2026-11-25T00:00:00.000Z' } })).toEqual({
      exists: true,
      star_id: 's1',
      planet_id: 'p1',
      created_at: '2026-11-25T00:00:00.000Z',
    });
  });
  test('not saved yet, or the star was deleted (server sends null) → null', () => {
    expect(savedStarSource({ saved_star: null })).toBeNull();
    expect(savedStarSource({})).toBeNull();
    expect(savedStarSource(undefined)).toBeNull();
    expect(savedStarSource({ saved_star: { id: 's1' } })).toBeNull(); // 행성을 모르면 날아갈 수 없다
  });
});

describe('answerAnnouncement', () => {
  test('stopped and failed', () => {
    expect(answerAnnouncement({ status: 'stopped', content: '반쯤' })).toBe('답을 멈췄어요');
    expect(answerAnnouncement({ status: 'failed', error: 'openai_error' })).toBe(errorMessage('openai_error'));
  });
  test('done: whitespace folded, cut at ANNOUNCE_MAX code points', () => {
    expect(answerAnnouncement({ status: 'done', content: ' 첫 줄\n\n둘째 ' })).toBe('첫 줄 둘째');
    const long = '가'.repeat(ANNOUNCE_MAX + 5);
    expect(answerAnnouncement({ status: 'done', content: long })).toBe(`${'가'.repeat(ANNOUNCE_MAX)}…`);
    expect(answerAnnouncement({ status: 'done', content: '' })).toBe('기록에서 찾지 못했어요.');
  });
});
