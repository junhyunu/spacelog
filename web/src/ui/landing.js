// 로그인 전 첫 화면(W-00)의 행성 · 캐릭터 장면. 블랙홀 둘레에 실제 우주의 행성과 캐릭터를 띄워 서비스를 보여 준다.
// 그림은 우주 화면의 3D 모델(planets.js · characters/builders.js)을 같은 빛으로 미리 그려 둔 이미지다(assets/landing/*.webp).
//   행성: 주제 10개(이름표 = 우주 화면과 같은 모양: 흰 이름 + 행성 색 "별 n개"). 누르면 화면에 없는 다른 주제로 바뀐다.
//   캐릭터: 6종 × 기본 · 색 슈트. 누르면 다른 종류로 바뀐다. 블랙홀 쪽을 바라본다(왼쪽에 있으면 오른쪽, 오른쪽에 있으면 왼쪽 그림).
//   바뀌는 효과: 작아졌다가 새 것이 튀어나오고 둘레로 별이 터진다(모션 줄이기면 짧게 흐려졌다 바뀐다).
// 자리는 넓은 화면 · 좁은 화면(760px 이하)을 따로 둔다. 좁은 화면은 행성 3개 · 캐릭터 1개.
// 로그인하면 .auth-out 이라 통째로 숨는다(account.css).
import { esc } from '../util.js';

const FILES = import.meta.glob('../assets/landing/*.webp', { eager: true, query: '?url', import: 'default' });
const src = (name) => FILES[`../assets/landing/${name}.webp`];

/** 주제 → [이름, 이름표 아래 글자 색(행성 색)] */
export const LANDING_PLANETS = Object.freeze({
  travel: ['여행', '#5ec8ff'],
  study: ['공부', '#ffb13b'],
  workout: ['운동', '#ff6fb5'],
  cook: ['요리', '#ff7a59'],
  book: ['독서', '#8fdc5a'],
  music: ['음악', '#d96bff'],
  idea: ['아이디어', '#c6e84a'],
  movie: ['영화', '#7cf0b0'],
  photo: ['사진', '#c29bff'],
  shop: ['쇼핑', '#ffc9a3'],
});
const KIND_KO = { astronaut: '우주인', cat: '고양이', robot: '로봇', bear: '곰', alien: '외계인', human: '사람' };
/** 캐릭터 그림 이름(방향 빼고): 종류-슈트(0 기본 · 1 색) */
export const LANDING_CHARS = Object.freeze(Object.keys(KIND_KO).flatMap((k) => [`${k}-0`, `${k}-1`]));

// 자리: x · y = 장면 안의 위치(가운데 기준), w = 폭(숫자면 vw, 글자면 CSS 값 그대로). m = 좁은 화면의 자리(없으면 좁은 화면에서 숨김).
// m.tallOnly = 좁고 낮은 화면(세로 740px 이하)에서는 숨김. far = 멀리 있는 작은 행성(조금 어둡게), label = 이름표, face = 캐릭터가 바라보는 쪽(r · l), fl = 둥실 박자
const SLOTS = [
  { kind: 'planet', id: 'photo', x: '6%', y: '90%', w: 40, fl: '', m: { x: '8%', y: '96%', w: 'min(60vw,34vh)' } },
  { kind: 'planet', id: 'book', x: '96%', y: '34%', w: 28, fl: 'c' },
  { kind: 'planet', id: 'travel', x: '15%', y: '42%', w: 16, fl: '', label: true, m: { x: '84%', y: '90%', w: 'min(30vw,17vh)' } },
  { kind: 'planet', id: 'study', x: '85%', y: '80%', w: 16, fl: 'b', label: true },
  { kind: 'planet', id: 'workout', x: '74%', y: '36%', w: 11, fl: 'c', label: true, m: { x: '82%', y: '19%', w: 'min(22vw,11vh)', tallOnly: true } },
  { kind: 'planet', id: 'idea', x: '26%', y: '22%', w: 6.5, fl: 'c', far: true },
  { kind: 'char', id: 'astronaut-0', x: '30%', y: '64%', w: 10.5, fl: '', face: 'r', tilt: 18, m: { x: '17%', y: '18%', w: 'min(24vw,12vh)' } },
  { kind: 'char', id: 'human-0', x: '71%', y: '64%', w: 8.5, fl: 'b', face: 'l', tilt: -14 },
];

const size = (w) => (typeof w === 'number' ? `${w}vw` : w);
let scene = null;
let live = null;
let preloaded = false;
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };
const TIP_KEY = 'spacelog.landingTipSeen';

/** 처음 보이는 이름표의 별 수(새로 바뀌면 3~20 사이 아무 수) */
const START_COUNT = { travel: 7, study: 12, workout: 5 };

function imgOf(slot) {
  return slot.kind === 'planet' ? src(`p-${slot.cur}`) : src(`c-${slot.cur}-${slot.face}`);
}
function nameOf(slot) {
  return slot.kind === 'planet' ? `${LANDING_PLANETS[slot.cur][0]} 행성` : `${KIND_KO[slot.cur.split('-')[0]]} 캐릭터`;
}

function paint(slot, count) {
  const btn = slot.btn;
  const label = slot.label
    ? `<span class="ls-lab" aria-hidden="true"><b>${esc(LANDING_PLANETS[slot.cur][0])}</b><small style="color:${LANDING_PLANETS[slot.cur][1]}">별 ${count}개</small></span>`
    : '';
  btn.innerHTML = `${label}<img src="${imgOf(slot)}" alt="" draggable="false">`;
  btn.setAttribute('aria-label', `${nameOf(slot)} · 눌러서 다른 ${slot.kind === 'planet' ? '행성으로' : '캐릭터로'} 바꾸기`);
}

/** 같은 종류의 다음 것. 지금 화면에 보이는 것은 건너뛴다. 캐릭터는 다른 종류로 넘어가게 3칸씩 */
export function nextLandingId(kind, cur, shown) {
  const pool = kind === 'planet' ? Object.keys(LANDING_PLANETS) : LANDING_CHARS;
  const step = kind === 'char' ? 3 : 1;
  let i = pool.indexOf(cur);
  for (let n = 0; n < pool.length * step; n++) {
    i = (i + step + pool.length) % pool.length;
    if (!shown.has(pool[i])) return pool[i];
  }
  return pool[(pool.indexOf(cur) + 1) % pool.length];
}

function visible(slot) {
  return !narrowMq.matches || Boolean(slot.m);
}

function burst(slot) {
  const sr = scene.getBoundingClientRect();
  const r = slot.btn.getBoundingClientRect();
  const cx = r.left + r.width / 2 - sr.left;
  const cy = r.top + r.height / 2 - sr.top;
  for (let i = 0; i < 7; i++) {
    const s = document.createElement('img');
    s.className = 'ls-burst';
    s.alt = '';
    s.src = src(`star${(i % 3) + 1}`);
    scene.appendChild(s);
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
    const d = r.width * (0.45 + Math.random() * 0.25);
    const at = (k, sc, deg) => `translate(${cx + Math.cos(a) * d * k}px,${cy + Math.sin(a) * d * k}px) translate(-50%,-50%) scale(${sc}) rotate(${deg}deg)`;
    s.animate(
      [
        { transform: at(0, 0.3, 0), opacity: 1 },
        { transform: at(1, 1, 200 + i * 30), opacity: 1, offset: 0.7 },
        { transform: at(1.15, 0.6, 260 + i * 30), opacity: 0 },
      ],
      { duration: 650, easing: 'cubic-bezier(.2,.8,.3,1)' },
    ).onfinish = () => s.remove();
  }
}

async function swap(slot) {
  if (slot.busy) return;
  slot.busy = true;
  hideTip();
  preloadAll();
  const shown = new Set(slots().filter((s) => s.kind === slot.kind && visible(s)).map((s) => s.cur));
  const next = nextLandingId(slot.kind, slot.cur, shown);
  const btn = slot.btn;
  const run = (k, o) => (typeof btn.animate === 'function' ? btn.animate(k, o).finished.catch(() => {}) : Promise.resolve());
  if (reduceMq.matches) {
    await run([{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
    slot.cur = next;
    paint(slot, 3 + Math.floor(Math.random() * 18));
    await run([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
  } else {
    await run([{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.4 }, { transform: 'scale(0)' }], { duration: 220, easing: 'ease-in' });
    slot.cur = next;
    paint(slot, 3 + Math.floor(Math.random() * 18));
    burst(slot);
    await run(
      [{ transform: 'scale(0)' }, { transform: 'scale(1.18)', offset: 0.65 }, { transform: 'scale(.96)', offset: 0.85 }, { transform: 'scale(1)' }],
      { duration: 420, easing: 'ease-out' },
    );
  }
  if (live) live.textContent = `${nameOf(slot)}${slot.kind === 'planet' ? '으로' : '로'} 바꿨어요`;
  slot.busy = false;
}

let slotList = [];
const slots = () => slotList;

function hideTip() {
  const tip = scene?.querySelector('.ls-tip');
  if (!tip || tip.hidden) return;
  tip.hidden = true;
  try {
    localStorage.setItem(TIP_KEY, '1');
  } catch {
    /* 저장소를 못 쓰면 다음에 다시 보인다 */
  }
}

/** 바뀔 그림을 미리 받아 둔다(처음 누를 때 또는 잠시 뒤 한가할 때) */
function preloadAll() {
  if (preloaded) return;
  preloaded = true;
  for (const url of Object.values(FILES)) {
    const im = new Image();
    im.src = url;
  }
}

/** #home 안에 장면을 만든다. 한 번만. */
export function initLanding(home) {
  if (scene || !home) return;
  scene = document.createElement('div');
  scene.id = 'hScene';
  scene.className = 'auth-out';
  scene.setAttribute('role', 'group');
  scene.setAttribute('aria-label', '우주 미리 보기: 행성과 캐릭터를 눌러 바꿔 보세요');
  slotList = SLOTS.map((d) => ({ ...d, cur: d.id }));
  for (const s of slotList) {
    const box = document.createElement('div');
    box.className = `ls ls-${s.kind}${s.far ? ' far' : ''}${s.m ? '' : ' wide-only'}${s.m?.tallOnly ? ' tall-only' : ''}${s.fl ? ` fl-${s.fl}` : ''}`;
    const m = s.m || s;
    box.style.cssText = `--x:${s.x};--y:${s.y};--w:${size(s.w)};--mx:${m.x};--my:${m.y};--mw:${size(m.w)};--tilt:${s.tilt || 0}deg`;
    s.btn = document.createElement('button');
    s.btn.type = 'button';
    s.btn.className = 'ls-hit';
    s.btn.addEventListener('click', () => swap(s));
    box.appendChild(s.btn);
    scene.appendChild(box);
    paint(s, START_COUNT[s.cur] ?? 9);
  }
  // 처음 한 번만 보이는 안내 말풍선(첫 캐릭터 위)
  let seen = false;
  try {
    seen = localStorage.getItem(TIP_KEY) === '1';
  } catch {
    /* 저장소를 못 쓰면 보인다 */
  }
  const tip = document.createElement('p');
  tip.className = 'ls-tip';
  // 좁고 낮은 화면은 짧은 글(landing.css)
  tip.innerHTML = '<span class="tl">눌러 보세요! 행성도, 나도 바뀌어요</span><span class="ts">눌러 보세요!</span>';
  tip.hidden = seen;
  scene.appendChild(tip);
  live = document.createElement('p');
  live.className = 'ls-live';
  live.setAttribute('aria-live', 'polite');
  scene.appendChild(live);
  home.appendChild(scene);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 2500));
  idle(preloadAll);
}
