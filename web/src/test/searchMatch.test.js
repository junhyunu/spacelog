import { describe, it, expect } from 'vitest';
import { normText, queryTerms, matchesText, markRanges, markHtml, snipAround } from '../ui/searchMatch.js';

describe('searchMatch', () => {
  it('queryTerms', () => {
    expect(queryTerms('이번 주')).toEqual(['이번주']);
    expect(queryTerms('주 계획')).toEqual(['주계획']);
    expect(queryTerms('  Flask   RAG ')).toEqual(['flask', 'rag']);
    expect(queryTerms('주')).toEqual(['주']);
    expect(queryTerms('a b c')).toEqual(['abc']);
    expect(queryTerms('')).toEqual([]);
    expect(queryTerms('   ')).toEqual([]);
  });
  it('matchesText', () => {
    expect(matchesText(['이번 주에는 Flask 웹'], queryTerms('이번주'))).toBe(true);
    expect(matchesText(['이번주 회의'], queryTerms('이번 주'))).toBe(true);
    expect(matchesText(['Flask 웹 기능과 RAG'], queryTerms('RAG Flask'))).toBe(true);
    expect(matchesText(['제목 Flask', '본문 RAG'], queryTerms('flask rag'))).toBe(true);
    expect(matchesText(['Flask 웹'], queryTerms('Flask xyz'))).toBe(false);
    expect(matchesText(['이번 주'.normalize('NFD')], queryTerms('이번주'))).toBe(true);
    expect(matchesText(['아무거나'], [])).toBe(true);
  });
  it('markHtml', () => {
    expect(markHtml('이번 주에는', '이번주')).toBe('<mark>이번 주</mark>에는');
    expect(markHtml('Flask 와 RAG', 'rag flask')).toBe('<mark>Flask</mark> 와 <mark>RAG</mark>');
    expect(markHtml('a<b> 이번  주', '이번주')).toBe('a&lt;b&gt; <mark>이번  주</mark>');
    expect(markHtml('줄\n바꿈', '줄바꿈')).toBe('<mark>줄\n바꿈</mark>');
    expect(markHtml('abc', '')).toBe('abc');
    expect(markHtml('이번 주'.normalize('NFD'), '이번주')).toBe('<mark>이번 주</mark>');
  });
  it('markRanges merges touching ranges', () => {
    expect(markRanges('abcd', ['ab', 'cd'])).toEqual([[0, 4]]);
    expect(markRanges('ab cd', ['ab', 'zz'])).toEqual([[0, 2]]);
  });
  it('snipAround', () => {
    expect(snipAround('앞'.repeat(30) + ' 이번 주 끝', '이번주')).toMatch(/^…/);
    expect(snipAround('짧은 이번 주 글', '이번주')).toBe('짧은 <mark>이번 주</mark> 글');
    expect(snipAround('줄1\n\n  이번   주', '이번주')).toBe('줄1 <mark>이번 주</mark>');
    expect(snipAround('없음', 'xyz')).toBeNull();
    expect(snipAround('abc', '')).toBeNull();
  });
});
