import { describe, expect, test } from 'vitest';
import { topbarState } from '../ui/topbarLogic.js';
import { panelCountText } from '../ui/planetLogic.js';
import { periodName } from '../util.js';

describe('topbarState', () => {
  test('outside the universe → never tucked', () => {
    expect(topbarState({ inWorld: false, panelOpen: true, chatOpen: true, peek: true, searching: true })).toEqual({ tucked: false, peek: false });
  });
  test('panel only → tucked', () => {
    expect(topbarState({ inWorld: true, panelOpen: true, chatOpen: false, peek: false })).toEqual({ tucked: true, peek: false });
  });
  test('chat only → tucked', () => {
    expect(topbarState({ inWorld: true, panelOpen: false, chatOpen: true, peek: false })).toEqual({ tucked: true, peek: false });
  });
  test('both open → tucked, peek kept', () => {
    expect(topbarState({ inWorld: true, panelOpen: true, chatOpen: true, peek: true })).toEqual({ tucked: true, peek: true });
  });
  test('both closed with peek → bar back in place, peek cleared', () => {
    expect(topbarState({ inWorld: true, panelOpen: false, chatOpen: false, peek: true })).toEqual({ tucked: false, peek: false });
  });
  test('searching while tucked keeps the bar down', () => {
    expect(topbarState({ inWorld: true, panelOpen: true, chatOpen: false, peek: false, searching: true })).toEqual({ tucked: true, peek: true });
  });
  test('searching with nothing open → not tucked', () => {
    expect(topbarState({ inWorld: true, panelOpen: false, chatOpen: false, peek: false, searching: true })).toEqual({ tucked: false, peek: false });
  });
  test('narrow screen → never tucked, even with panel or chat open', () => {
    expect(topbarState({ inWorld: true, narrow: true, panelOpen: true, chatOpen: false, peek: true })).toEqual({ tucked: false, peek: false });
    expect(topbarState({ inWorld: true, narrow: true, panelOpen: false, chatOpen: true, searching: true })).toEqual({ tucked: false, peek: false });
  });
  test('wide screen (narrow false) → tucks as before', () => {
    expect(topbarState({ inWorld: true, narrow: false, panelOpen: true })).toEqual({ tucked: true, peek: false });
  });
  test('no argument → not tucked', () => {
    expect(topbarState()).toEqual({ tucked: false, peek: false });
  });
});

describe('periodName', () => {
  test('same names as the period button', () => {
    expect(periodName('all')).toBe('전체');
    expect(periodName('today')).toBe('오늘');
    expect(periodName('week')).toBe('이번 주');
    expect(periodName('custom')).toBe('직접 지정');
    expect(periodName('nope')).toBe('');
  });
});

describe('panelCountText', () => {
  test('today', () => {
    expect(panelCountText({ period: 'today', inPeriod: 3, total: 6 })).toBe('오늘 별 3개 · 전체 6개');
  });
  test('this week', () => {
    expect(panelCountText({ period: 'week', inPeriod: 4, total: 6 })).toBe('이번 주 별 4개 · 전체 6개');
  });
  // custom: range는 store.state.range 그대로({ from, to } ISO, to는 끝 날 다음 자정). 앱의 날짜 표기(11.20)로 보인다
  const day = (m, d) => new Date(2026, m - 1, d).toISOString();
  test('custom range → actual dates', () => {
    expect(panelCountText({ period: 'custom', inPeriod: 2, total: 6, range: { from: day(11, 20), to: day(11, 27) } })).toBe('11.20–11.26 별 2개 · 전체 6개');
  });
  test('custom single day → one date', () => {
    expect(panelCountText({ period: 'custom', inPeriod: 1, total: 6, range: { from: day(11, 20), to: day(11, 21) } })).toBe('11.20 별 1개 · 전체 6개');
  });
  test('custom without a usable range → period name', () => {
    expect(panelCountText({ period: 'custom', inPeriod: 2, total: 6 })).toBe('직접 지정 별 2개 · 전체 6개');
  });
  test('all → unchanged copy', () => {
    expect(panelCountText({ period: 'all', inPeriod: 6, total: 6 })).toBe('전체 별 6개');
  });
  test('thousands separator', () => {
    expect(panelCountText({ period: 'all', total: 1200 })).toBe('전체 별 1,200개');
  });
});
