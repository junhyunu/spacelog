// 개발 전용: 3D 우주만 따로 띄워 눈으로 확인하는 화면(web/dev-universe.html).
// index.html · main.js에서 불러오지 않으므로 빌드에 들어가지 않는다. API를 부르지 않고 가짜 데이터만 쓴다.
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource/black-han-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '../styles/tokens.css';
import '../styles/app.css';

import { store } from '../store.js';
import { DECO_NAMES, PLANET_COLORS } from '../util.js';
import { enterOverview, flyTo, playerPosition, setInputBlocked, startLoop } from './controls.js';
import { flyStarIn, planetMesh, setSelectedStar, starMesh, syncUniverse } from './planets.js';
import { initScene } from './scene.js';

const DECOS = Object.keys(DECO_NAMES); // 10종
const NAMES = ['제품 기획', '21일차 수업', '읽은 것들', '생각 조각', '여행', '요리', '운동 기록', '스무 글자를 꽉 채운 아주 긴 행성 이름', '음악', '사진', '열한 번째', '열두 번째'];
const SUBS = ['PO 업무 · 스프린트', 'Claude · MCP', '아티클 · 책 밑줄', '', '가 본 곳', '', '주 3회', '이름이 길 때', '', '필름', '첫 고리 자리', ''];
const COUNTS = [3, 4, 2, 2, 0, 1, 14, 5, 1, 6, 2, 3]; // 합 43. 6번은 커진 행성, 4번은 빈 행성

// 행성 12개: 장식 10종 전부, 색 12가지, 고리는 자동 배정 규칙(n % 3 === 1)
let planets = NAMES.map((name, n) => ({
  id: `p${n}`,
  name,
  description: SUBS[n],
  color_index: (n % 16) + 1,
  deco: DECOS[n % DECOS.length],
  ring: n % 3 === 1,
  slot: n,
  count_in_period: COUNTS[n],
  count_total: COUNTS[n],
}));

let seq = 0;
let stars = planets.flatMap((p) =>
  [...Array(p.count_in_period)].map(() => {
    seq += 1;
    return { id: `s${seq}`, type: 'text', title: `가짜 별 ${seq}`, planet_id: p.id, created_at: new Date(Date.now() - seq * 60000).toISOString() };
  }),
);

let capDemo = false;
function sync() {
  for (const p of planets) {
    const n = stars.filter((s) => s.planet_id === p.id).length;
    p.count_in_period = capDemo ? n + 1240 : n; // 상한 초과 상태 흉내: 개수만 부풀린다
    p.count_total = p.count_in_period;
  }
  store.state.planets = planets;
  store.state.stars = stars;
  syncUniverse({ planets, stars, guestStarId: store.state.guestStarId });
}

const three = initScene(document.getElementById('stage')); // { scene, camera, renderer }
sync();
store.state.inWorld = true;
enterOverview();
startLoop();
setInputBlocked(() => false);

/* ---------- 이벤트를 콘솔에 찍는다 ---------- */
store.on('land', (planetId) => {
  console.log('[land]', planetId, planets.find((p) => p.id === planetId)?.name);
  store.state.panelPlanetId = planetId; // 패널이 열린 셈 치고, 멀어지면 leftPanelPlanet이 오는지 본다
});
store.on('pickStar', (starId) => {
  console.log('[pickStar]', starId);
  setSelectedStar(starId);
});
store.on('near', (planetId) => console.log('[near]', planetId));
store.on('leftPanelPlanet', () => {
  console.log('[leftPanelPlanet]', store.state.panelPlanetId);
  store.state.panelPlanetId = null;
  setSelectedStar(null);
});
store.on('manualMove', () => console.log('[manualMove]'));

/* ---------- 확인용 버튼 ---------- */
let flyIdx = 0;
const actions = {
  '조망으로': () => enterOverview(),
  '다음 행성으로': () => {
    const p = planets[flyIdx++ % planets.length];
    flyTo(p.id).then((ok) => console.log('[flyTo 끝]', p.name, ok));
  },
  '새 별 날리기': () => {
    // 캐릭터 앞 아래쪽에서 가까운 행성(없으면 첫 행성)으로 날아 들어간다
    const p = planets.find((q) => q.id === store.state.panelPlanetId) || planets[0];
    seq += 1;
    const star = { id: `s${seq}`, type: 'text', title: `가짜 별 ${seq}`, planet_id: p.id, created_at: new Date().toISOString() };
    stars = [star, ...stars];
    sync();
    const from = playerPosition();
    from.y -= 1;
    console.log('[flyStarIn]', star.id, '→', p.name, flyStarIn(star.id, from));
  },
  '별 옮기기': () => {
    // 가장 최근 별을 다음 행성으로 옮긴다: syncUniverse가 알아서 날려 보낸다
    const s = stars[0];
    if (!s) return;
    const i = planets.findIndex((p) => p.id === s.planet_id);
    const to = planets[(i + 1) % planets.length];
    stars = [{ ...s, planet_id: to.id }, ...stars.slice(1)];
    sync();
    console.log('[별 옮김]', s.id, '→', to.name);
  },
  '모습 바꾸기': () => {
    // 모든 행성의 색 · 장식 · 고리를 한 칸씩 돌린다: 같은 자리에서 다시 만들어지고 별은 그대로 돈다
    planets = planets.map((p) => ({
      ...p,
      color_index: (p.color_index % 16) + 1,
      deco: DECOS[(DECOS.indexOf(p.deco) + 1) % DECOS.length],
      ring: !p.ring,
    }));
    sync();
    console.log('[모습 바꿈]', planets.map((p) => `${p.name}: ${PLANET_COLORS[p.color_index].name} · ${DECO_NAMES[p.deco]}${p.ring ? ' · 고리' : ''}`));
  },
  '이름 · 설명 바꾸기': () => {
    const p = planets[0];
    planets = [{ ...p, name: p.name === '제품 기획' ? '바뀐 이름' : '제품 기획', description: p.description ? '' : 'PO 업무 · 스프린트' }, ...planets.slice(1)];
    sync();
  },
  '행성 더하기': () => {
    const n = planets.length;
    planets = [...planets, { id: `p${n}`, name: `${n + 1}번째`, description: '', color_index: (n % 16) + 1, deco: DECOS[n % 10], ring: n % 3 === 1, slot: n, count_in_period: 0, count_total: 0 }];
    sync();
  },
  '행성 빼기': () => {
    const gone = planets[planets.length - 1];
    if (!gone || planets.length <= 1) return;
    planets = planets.slice(0, -1);
    stars = stars.filter((s) => s.planet_id !== gone.id);
    sync();
  },
  '상한 초과 보기': () => {
    capDemo = !capDemo;
    sync();
    console.log('[상한 초과 상태]', capDemo);
  },
};
const box = document.getElementById('devButtons');
for (const [label, fn] of Object.entries(actions)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    fn();
    e.currentTarget.blur(); // Space가 버튼을 다시 누르지 않게
  });
  box.appendChild(b);
}

// 주소로 바로 가기: ?fly=p4 (그 행성으로 날아간다), ?cap=1 (상한 초과 상태)
const query = new URLSearchParams(location.search);
if (query.get('cap')) actions['상한 초과 보기']();
if (query.get('fly')) flyTo(query.get('fly')).then((ok) => ok && store.emit('land', query.get('fly')));

// 콘솔에서 직접 만져 볼 수 있게
window.dev = { three, store, actions, syncUniverse, flyTo, flyStarIn, enterOverview, setSelectedStar, planetMesh, starMesh, playerPosition };
console.log('[dev-universe] 가짜 행성', planets.length, '개 · 별', stars.length, '개. window.dev로 만져 볼 수 있어요.');
