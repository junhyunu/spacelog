// W-00 메인 홈: 인사말 · 개수 · 블랙홀 엠블럼 · 상단 줄. 아래의 행성 패널 + 별 목록은 homeList.js가 그린다.
// 시안 934~987행(renderHome · homeStates · drawBH)을 옮겼다. 데이터만 API에서 받는다.
//
// store로 알리는 것:
//   'openSave'                  "기록하기"(상단 줄 · 빈 우주 카드)
//   'newPlanet'                   "+ 새 행성"(행성 패널의 #hsNew · 빈 우주 카드의 #hNewPlanet)
//   'openLogin'                   "로그인"(#hLogin · 로그인 안내 말풍선)
//   'signOut'                     "로그아웃"(#hLogout · 사람 아이콘 메뉴의 "로그아웃")
//   'openAccount'                 사람 아이콘(#hMe) 메뉴의 "계정 설정" → 계정 설정 창
// 사람 아이콘 메뉴(#hMeMenu)는 우주의 #wMeMenu와 같은 모양: ↑↓ · Home · End로 옮기고, Esc(36) · 바깥 누르기 · Tab으로 접는다.
// 캐릭터 꾸미기는 우주 안에서만 연다(hud.js의 사람 아이콘 메뉴).
// 로그인 전에 "우주로 들어가기"를 누르면 전환 대신 로그인 안내 말풍선(#hLoginHint)을 띄운다.
// store에서 듣는 것:
//   'data'      우주 밖에 있을 때만 홈을 다시 그린다(처음 연결 · 다시 연결 · 저장 뒤).
// 연결 실패 상태는 main.js(showOffline)가 그린다. 여기서는 그 카드를 건드리지 않는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, periodRange } from '../util.js';
import { accountName, isSignedIn } from './account.js';
import { drawBlackHole } from './blackholeArt.js';
import { registerEscape } from './escape.js';
import { initHomeList, renderHomeList } from './homeList.js';
import { initLanding } from './landing.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const num = (n) => (Number(n) || 0).toLocaleString('en-US');
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

let home = null;
let onEnter = () => {};
let renderSeq = 0;

/* ---------- 그리기 ---------- */
function paint({ summary }) {
  const total = Number(summary?.total) || 0;
  const planetCount = Number(summary?.planets ?? store.state.planets.length) || 0;
  const todayN = Number(summary?.in_period) || 0;
  const empty = total === 0; // 전체 0개: 별이 하나도 없다(빈 행성은 있을 수 있다)

  $('hGreet').innerHTML = !isSignedIn()
    ? '나만의 우주를 시작해 보세요'
    : empty
    ? `${esc(accountName())}님, 나만의 우주를 시작해 보세요`
    : todayN
      ? `오늘 별 <em>${num(todayN)}개</em>를 띄웠어요`
      : '오늘은 아직 별이 없어요';
  $('hStats').innerHTML = `<b>${num(total)}</b>개의 별 <b>${num(planetCount)}</b>개의 행성`;

  // 아래 영역(행성 패널 + 별 목록, homeList.js): 별이 하나도 없어도 같은 화면이다(목록 자리에 첫 별을 띄우는 안내가 나온다)
  $('hMain').hidden = false;
  renderHomeList();

  home.querySelector('.hero').hidden = false;
  $('hLog').hidden = false;

  // #hState는 연결 실패 카드(main.js)만 쓴다. 그 카드가 아니면 비운다
  const st = $('hState');
  if (!st.querySelector('[data-retry]')) {
    st.hidden = true;
    st.textContent = '';
  }
}

/**
 * 홈을 최신 데이터로 다시 그린다. 그렸으면 true.
 * 인사말 숫자는 오늘 기간의 summary.in_period, 배지는 summary.total · summary.planets.
 * 연결이 끊겼으면 아무것도 바꾸지 않는다(연결 실패 카드는 main.js가 띄운다). 던지지 않는다.
 */
export async function renderHome() {
  if (!home) return false;
  const seq = ++renderSeq;
  const now = new Date();
  const today = periodRange('today', null, now);
  // 인사말은 늘 "오늘" 기준이다(목록의 기간과 상관없다). 목록 · 행성은 store의 것을 쓴다
  let summary;
  try {
    summary = await api.summary(today);
  } catch (err) {
    if (err?.code !== 'offline' && seq === renderSeq) toast('데이터를 불러오지 못했어요. 새로고침해 주세요');
    return false;
  }
  if (seq !== renderSeq) return false; // 더 새로운 그리기가 있다
  if (store.state.offline) return false; // 다시 연결되면 'data'가 와서 다시 그린다
  // 기다리는 사이 전환이 시작됐거나 우주 안이면 그리지 않는다(흡입 중인 요소를 갈아 끼우지 않게).
  // 돌아올 때 leaveWorld가 다시 그린다.
  if (home.inert || store.state.inWorld) return false;
  paint({ summary });
  return true;
}

/* ---------- 블랙홀 엠블럼 (시안 drawBH 그대로) ---------- */
let bhSpin = 0.22;
let bhRot = 0;
let bhLast = 0;
let bhRaf = 0;

function drawBH(now) {
  bhRaf = 0;
  // 홈이 안 보이거나 탭이 숨겨져 있으면 멈춘다. resumeEmblem()이 다시 켠다.
  if (home.hidden || document.hidden) {
    bhLast = 0;
    return;
  }
  const bhC = $('bhCanvas');
  const dt = bhLast ? Math.min((now - bhLast) / 1000, 0.05) : 0;
  bhLast = now;
  bhRot += dt * bhSpin * (reduceMq.matches ? 0.15 : 1);
  const w = bhC.clientWidth;
  if (w > 0) {
    const dpr = Math.min(devicePixelRatio, 2);
    // 시안은 너비만 봤다: 캔버스 기본 크기가 300×150이라 딱 300px일 때 높이가 안 맞아 찌그러졌다
    const px = Math.round(w * dpr);
    if (bhC.width !== px || bhC.height !== px) bhC.width = bhC.height = px;
    const g = bhC.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, w);
    const c = w / 2;
    const k = w / 300;
    const glow = g.createRadialGradient(c, c, 40 * k, c, c, 150 * k);
    glow.addColorStop(0, 'rgba(122,108,255,.55)');
    glow.addColorStop(1, 'rgba(122,108,255,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, w);
    g.lineCap = 'round';
    // 고리 3개: [반지름, 색, 속도 배율, 호 길이]
    const rings = [
      [128, '#7a6cff', 0.7, 2.2],
      [108, '#ff5d8f', 1, 1.7],
      [88, '#ffd23f', 1.5, 2.6],
    ];
    rings.forEach(([r, col, sp, len], i) => {
      for (let j = 0; j < 2; j++) {
        const a = bhRot * sp + i * 1.3 + j * Math.PI;
        g.beginPath();
        g.arc(c, c, r * k, a, a + len);
        g.strokeStyle = '#1a1430';
        g.lineWidth = 17 * k;
        g.stroke();
        g.beginPath();
        g.arc(c, c, r * k, a, a + len);
        g.strokeStyle = col;
        g.lineWidth = 10 * k;
        g.stroke();
      }
    });
    for (let i = 0; i < 16; i++) {
      const ph = (bhRot * 0.25 + i / 16) % 1;
      const rr = (145 - ph * 85) * k;
      const a = i * 2.4 + ph * 7 + bhRot;
      g.beginPath();
      g.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, (3.2 - ph * 2) * k, 0, 6.3);
      g.fillStyle = i % 3 ? '#fff' : '#ffd23f';
      g.globalAlpha = 1 - ph * 0.6;
      g.fill();
      g.globalAlpha = 1;
    }
    g.beginPath();
    g.arc(c, c, 66 * k, 0, 6.3);
    g.fillStyle = '#0c0820';
    g.fill();
    g.lineWidth = 5 * k;
    g.strokeStyle = '#1a1430';
    g.stroke();
  }
  bhRaf = requestAnimationFrame(drawBH);
}

/** 엠블럼 고리의 회전 속도. 평소 0.22, 전환 1단계에서 1.6. */
export function setEmblemSpin(speed) {
  bhSpin = speed;
}

/** 홈이 다시 보이게 된 뒤 부른다. 엠블럼 애니메이션이 멈춰 있으면 다시 켠다. */
export function resumeEmblem() {
  if (!home || bhRaf || home.hidden || document.hidden) return;
  bhRaf = requestAnimationFrame(drawBH);
}

/* ---------- 시작 ---------- */
function scatterStars() {
  const box = home.querySelector('.home-stars');
  if (!box || box.childElementCount) return;
  const cols = ['#fff', '#ffe9a8', '#bfe3ff', '#ffc2dc'];
  const rand = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < 90; i++) {
    const d = document.createElement('i');
    d.className = 'hstar';
    const s = rand(1.5, 4);
    d.style.cssText = `left:${rand(0, 100)}%;top:${rand(0, 100)}%;width:${s}px;height:${s}px;background:${cols[i % 4]}`;
    box.appendChild(d);
  }
}

// 로그인 전 "우주로 들어가기": 말풍선을 띄우고 그 안의 로그인 버튼에 초점을 둔다. 이미 떠 있으면 한 번 흔든다
function showLoginHint() {
  const hint = $('hLoginHint');
  if (!hint.hidden) {
    hint.classList.remove('nudge');
    void hint.offsetWidth; // 애니메이션을 처음부터 다시
    hint.classList.add('nudge');
  }
  hint.hidden = false;
  hint.querySelector('button').focus({ preventScroll: true });
}

/* ---------- 사람 아이콘 메뉴(#hMeMenu) ---------- */
// 홈(#home)이 화면에 붙어 있으므로 화면 기준(position:fixed)으로 버튼 바로 아래, 오른쪽 끝을 버튼 오른쪽 끝에 맞춘다
function placeMeMenu() {
  const menu = $('hMeMenu');
  if (menu.hidden) return;
  const b = $('hMe').getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.max(8, Math.min(b.right - w, innerWidth - w - 8)); // 화면 밖으로 나가지 않게
  menu.style.left = `${left}px`;
  menu.style.top = `${b.bottom + 8}px`;
}

function setMeMenu(on, { focus = false } = {}) {
  const menu = $('hMeMenu');
  if (menu.hidden === !on) return;
  menu.hidden = !on;
  $('hMe').setAttribute('aria-expanded', String(on));
  if (on) {
    placeMeMenu();
    menu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
  } else if (focus) $('hMe').focus({ preventScroll: true });
}

function onMeMenuKey(e) {
  const items = [...$('hMeMenu').querySelectorAll('[role="menuitem"]')];
  const i = items.indexOf(document.activeElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus({ preventScroll: true });
}

function onMeMenuClick(e) {
  const el = e.target instanceof Element ? e.target.closest('[data-me]') : null;
  if (!el) return;
  e.stopPropagation(); // 홈의 버튼 처리(onClick)로 넘기지 않는다
  const act = el.dataset.me;
  setMeMenu(false, { focus: act === 'account' }); // 계정 설정 창을 닫으면 사람 아이콘으로 돌아온다
  if (act === 'logout') store.emit('signOut');
  else if (act === 'account') store.emit('openAccount');
}

function initMeMenu() {
  const menu = $('hMeMenu');
  menu.addEventListener('click', onMeMenuClick);
  menu.addEventListener('keydown', onMeMenuKey);
  addEventListener('pointerdown', (e) => {
    if (menu.hidden || !(e.target instanceof Node)) return;
    if (!menu.contains(e.target) && !$('hMe').contains(e.target)) setMeMenu(false);
  });
  // 초점이 메뉴 밖으로 나가면(Tab) 접는다. 스크롤 · 화면 크기가 바뀌면 자리를 다시 맞춘다
  menu.addEventListener('focusout', (e) => {
    const to = e.relatedTarget;
    if (to instanceof Node && (menu.contains(to) || $('hMe').contains(to))) return;
    if (to) setMeMenu(false);
  });
  home.addEventListener('scroll', placeMeMenu, { passive: true });
  addEventListener('resize', placeMeMenu);
  // Esc: 홈에서 메뉴가 펼쳐져 있으면 그것부터 접는다(우주의 #wMeMenu와 같은 자리, 둘이 함께 열릴 일은 없다)
  registerEscape(36, () => {
    if (menu.hidden || store.state.inWorld) return false;
    setMeMenu(false, { focus: true });
    return true;
  });
  store.on('signOut', () => setMeMenu(false));
}

function onClick(e) {
  const el = e.target instanceof Element ? e.target.closest('button') : null;
  if (!el || !home.contains(el)) return;
  if (el.id === 'enterBtn') {
    if (isSignedIn()) onEnter({});
    else showLoginHint();
  } else if (el.id === 'hRemind') {
    if (isSignedIn()) store.emit('remindFromHome'); // remindTransition.js: 우주를 거치지 않고 바로 잠든 별 화면을 연다(닫으면 홈으로)
  } else if (el.id === 'hLogin' || el.dataset.act === 'login') store.emit('openLogin');
  else if (el.id === 'hLogout') store.emit('signOut');
  else if (el.id === 'hMe') setMeMenu($('hMeMenu').hidden);
  else if (el.id === 'hLog' || el.dataset.act === 'log') store.emit('openSave');
  else if (el.dataset.act === 'newPlanet') store.emit('newPlanet');
  else if (el.id === 'hTopEnter') {
    // 상단 줄의 "우주로 들어가기": 블랙홀이 보이게 맨 위로 올린 뒤 들어간다(전환이 블랙홀 자리에서 시작한다)
    home.scrollTo({ top: 0 });
    onEnter({});
  }
}

/**
 * 홈을 준비한다(한 번만). enter는 transition.js의 enterWorld — 서로 불러오지 않도록 main.js가 넘겨준다.
 * 데이터는 store의 'data'가 올 때(연결 확인 뒤) 처음 그려진다.
 */
export function initHome({ enter } = {}) {
  if (home) return;
  home = $('home');
  if (typeof enter === 'function') onEnter = enter;
  scatterStars();
  initLanding(home); // 로그인 전 첫 화면의 행성 · 캐릭터(로그인하면 숨는다)
  home.addEventListener('click', onClick);
  initMeMenu();
  // 별 제목을 누르면: 우주로 들어가 그 별로 날아간다
  initHomeList({ openStar: (star) => onEnter({ planetId: star.planet_id, starId: star.id }) });
  // 스크롤하면 상단 줄이 위에 붙고(.stuck), 블랙홀이 화면 밖으로 나가면 상단 줄에 "우주로 들어가기"가 나타난다
  home.addEventListener('scroll', () => home.querySelector('.home-top').classList.toggle('stuck', home.scrollTop > 8), { passive: true });
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(([en]) => { $('hTopEnter').hidden = en.isIntersecting; }, { root: home, rootMargin: '-70px 0px 0px 0px' }).observe($('enterBtn'));
  }
  document.addEventListener('visibilitychange', resumeEmblem);
  // 우주 밖에 있고 전환 중(inert)이 아닐 때만 다시 그린다
  store.on('data', () => {
    if (!store.state.inWorld && !home.hidden && !home.inert) renderHome();
  });
  // 잠든 별 블랙홀 안내(블랙홀 아래 안내문 자리)
  store.on('remind', paintRemind);
  store.on('authChange', paintRemind);
  paintRemind();
  resumeEmblem();
}

/* ---------- 잠든 별 안내 ---------- */
let remindIconDrawn = false;

/** 잠든 별이 있으면(설정이 끄기가 아니면) 안내문 대신 "잠든 별 n개가 블랙홀에 모였어요 · 보러 가기 ›"를 보인다. */
function paintRemind() {
  const r = store.state.remind;
  const n = r && r.days > 0 ? Number(r.total) || 0 : 0;
  const show = n > 0 && isSignedIn();
  $('hRemind').hidden = !show;
  $('hHint').hidden = show;
  if (!show) return;
  $('hRemindN').textContent = n.toLocaleString('ko-KR');
  if (!remindIconDrawn) {
    remindIconDrawn = true;
    const cv = $('hRemind').querySelector('.hr-ico');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#05030d';
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    drawBlackHole(ctx, 32, 32, 10, 2);
    ctx.restore();
  }
}
