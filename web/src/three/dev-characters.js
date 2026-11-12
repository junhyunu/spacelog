// 개발 전용: 캐릭터 6종을 나란히 세워 모습을 확인한다(스펙 6-10). dev-characters.html에서만 불러온다.
// 윗줄은 기본 색, 아랫줄은 몸 색 · 포인트 색 · 불꽃을 바꾼 예. 천천히 도는 회전대 위에 선다.
// 주소: ?yaw=180(도) &spin=0 &k=0.6(비행 자세) &only=cat(한 종류만 크게)
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource/black-han-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '../styles/tokens.css';
import '../styles/app.css';

import * as THREE from 'three';
import { CHARACTER_KINDS, FLAMES, KIND_NAMES, colorLabel } from '../ui/characterLogic.js';
import { animateCharacterPreview, buildCharacterPreview } from './character.js';
import { initScene } from './scene.js';

const q = new URLSearchParams(location.search);
const only = CHARACTER_KINDS.includes(q.get('only')) ? q.get('only') : null;
let yaw = ((Number(q.get('yaw')) || 0) * Math.PI) / 180;
let spin = q.get('spin') !== '0' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
let k = Math.max(0, Math.min(1, Number(q.get('k')) || 0));

// 아랫줄: 기본이 아닌 색의 예
const COLOURED = {
  astronaut: { suit: 2, accent: 5, flame: 'blue' },
  robot: { suit: 7, accent: 9, flame: 'green' },
  cat: { suit: 5, accent: 12, flame: 'pink' },
  alien: { suit: 12, accent: 1, flame: 'green' },
  bear: { suit: 16, accent: 14, flame: 'orange' },
  human: { suit: 11, accent: 13, flame: 'blue' },
};

const { scene, renderer } = initScene(document.getElementById('stage'));
const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.1, 3000);

const kinds = only ? [only] : CHARACTER_KINDS;
const GAP_X = 3.3;
const ROW_Y = [2.3, -2.7];
const items = [];
const labels = document.getElementById('labels');

kinds.forEach((kind, i) => {
  const x = (i - (kinds.length - 1) / 2) * GAP_X;
  [{ kind, suit: 0, accent: 0, flame: 'orange' }, { kind, ...COLOURED[kind] }].forEach((look, row) => {
    const group = buildCharacterPreview(look);
    const holder = new THREE.Group();
    holder.position.set(only ? (row - 0.5) * GAP_X : x, only ? 0 : ROW_Y[row], 0);
    holder.add(group);
    scene.add(holder);
    const tag = document.createElement('div');
    tag.className = 'tag card';
    tag.innerHTML =
      `<b>${KIND_NAMES[kind]}</b>` +
      `<small>${kind} · ${colorLabel(look.suit)} / ${colorLabel(look.accent)} / ${FLAMES[look.flame].name}</small>`;
    labels.appendChild(tag);
    items.push({ group, holder, tag, look });
  });
});

// 전체가 화면에 들어오게 카메라 거리를 맞춘다
function fit() {
  camera.aspect = innerWidth / innerHeight;
  const halfW = only ? GAP_X : (kinds.length * GAP_X) / 2 + 0.4;
  const halfH = only ? 2.9 : 5.6;
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const dist = Math.max(halfH / tan, halfW / (tan * camera.aspect));
  camera.position.set(0, only ? 0.35 : -0.1, dist);
  camera.lookAt(0, only ? 0.35 : -0.1, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', fit);
fit();

// 조작 막대
const bar = document.getElementById('devBar');
function button(text, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost sm';
  b.textContent = text;
  b.addEventListener('click', fn);
  bar.appendChild(b);
}
button('앞', () => ((yaw = 0), (spin = false)));
button('뒤', () => ((yaw = Math.PI), (spin = false)));
button('옆(3/4)', () => ((yaw = Math.PI * 0.25), (spin = false)));
button('돌리기', () => (spin = !spin));
button('대기 · 비행', () => (k = k > 0 ? 0 : 0.7));

const clock = new THREE.Clock();
const v = new THREE.Vector3();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime + 0.5;
  if (spin) yaw += dt * 0.5;
  for (const it of items) {
    it.holder.rotation.y = yaw;
    animateCharacterPreview(it.group, dt, t, k);
    v.set(it.holder.position.x, it.holder.position.y - (k > 0 ? 2.1 : 1.55), 0).project(camera);
    it.tag.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
    it.tag.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
  }
  renderer.render(scene, camera);
}
frame();

window.devCharacters = { items, scene, camera, renderer, set: (o) => ({ yaw, spin, k } = { yaw, spin, k, ...o }) };
