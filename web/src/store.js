// 화면 상태 + 이벤트. 모듈끼리는 여기를 거쳐 이야기한다.
// 쓰는 이벤트: 'data'(reload 끝), 'offline'(요청 실패), 'online'(다시 연결됨),
// 그 밖에 뒤 태스크가 정한 것('land', 'near', 'leftPanelPlanet', 'openDetail' …).
import { api } from './api.js';
import { DEFAULT_LOOK } from './ui/characterLogic.js';
import { periodRange } from './util.js';

const LAST_PLANET_KEY = 'spacelog.lastPlanet';

function readLastPlanet() {
  try {
    return globalThis.localStorage?.getItem(LAST_PLANET_KEY) || null;
  } catch {
    return null; // 저장소를 못 쓰는 환경(사생활 보호 창 등)
  }
}

function writeLastPlanet(value) {
  try {
    if (value) globalThis.localStorage?.setItem(LAST_PLANET_KEY, value);
    else globalThis.localStorage?.removeItem(LAST_PLANET_KEY);
  } catch {
    /* 못 써도 화면은 그대로 동작한다 */
  }
}

let lastPlanetId = readLastPlanet();

const state = {
  inWorld: false,
  offline: false, // 연결 실패 카드가 떠 있는 동안 true
  period: 'today', // 'all' | 'today' | 'week' | 'custom'
  range: periodRange('today'), // { from, to } ISO. custom일 때는 화면이 직접 넣는다
  planets: [],
  stars: [],
  summary: { in_period: 0, total: 0, planets: 0 },
  panelPlanetId: null,
  detailStarId: null,
  guestStarId: null,
  character: { ...DEFAULT_LOOK }, // 캐릭터의 모습 { kind, suit, accent, flame }(스펙 6-10). main.js가 시작할 때 받는다
  characterLoaded: false, // 서버에서 받는 데 성공했는지
  // 마지막으로 저장한 행성. 넣으면 localStorage에도 남는다
  get lastPlanetId() {
    return lastPlanetId;
  },
  set lastPlanetId(value) {
    lastPlanetId = value ? String(value) : null;
    writeLastPlanet(lastPlanetId);
  },
};

const listeners = new Map();

/** 이벤트를 듣는다. 돌려주는 함수를 부르면 그만 듣는다. */
function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (err) {
      console.error(`[store] '${event}' 처리 중 오류`, err);
    }
  }
}

let reloadSeq = 0;

/**
 * 지금 기간의 planets · stars · summary를 다시 받아 'data'를 알린다.
 * today · week는 부를 때마다 범위를 새로 계산한다(자정을 넘겨도 맞게).
 * 실패하면 상태를 그대로 두고 ApiError를 던진다. 겹쳐 부르면 마지막 것만 반영한다.
 */
async function reload() {
  const seq = ++reloadSeq;
  if (state.period !== 'custom') state.range = periodRange(state.period);
  const range = { from: state.range.from, to: state.range.to };
  const [planets, stars, summary] = await Promise.all([api.planets(range), api.stars(range), api.summary(range)]);
  if (seq !== reloadSeq) return state;
  state.planets = planets;
  state.stars = stars;
  state.summary = summary;
  emit('data', state);
  return state;
}

export const store = { state, on, emit, reload };
