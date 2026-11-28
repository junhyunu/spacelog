// 잠든 별 블랙홀(우주 안). 오래 안 본 별이 있으면 행성들 오른쪽 위 고정 자리에 뜬다.
// 그림은 ui/blackholeArt.js(시안 ① 주황 원반)를 캔버스에 그려 늘 카메라를 보는 판(Sprite)으로 띄운다.
// 잠든 별이 많을수록 커지고(20개에서 멈춤), 0개거나 설정이 끄기면 줄어들며 사라진다.
// 이름표는 행성 이름표와 같은 모양("잠든 별 블랙홀" + 주황 "잠든 별 n개").
// 누르면 controls.js 가 'blackHole' 을 알린다(→ remindTransition.js 가 빨려 들어간다).
import * as THREE from 'three';
import { store } from '../store.js';
import { BLACK_HOLE_REACH, drawBlackHole } from '../ui/blackholeArt.js';
import { holeScale } from '../ui/remindLogic.js';
import { universe } from './planets.js';
import { BLACK_HOLE_POSITION } from './slots.js';
const HOLE_R = 2.4; // 구멍 반지름(월드). 잠든 별 수 배율을 곱한다
const TEX = 512;
const LABEL_H = 2.35; // 이름표 높이(월드). 블랙홀 크기와 상관없이 같다
const LABEL_FONT = '"Black Han Sans","Malgun Gothic",sans-serif';
const SUB_FONT = '700 40px "Pretendard Variable",Pretendard,"Malgun Gothic",sans-serif';

let group = null;
let disk = null; // { canvas, ctx, tex, sprite }
let label = null; // { canvas, ctx, tex, sprite }
let hit = null;
let scale = 0;
let target = 0;
let count = 0;
let drawnCount = -1;
let lastDraw = -1;

function canvasSprite(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  return { canvas, ctx: canvas.getContext('2d'), tex, sprite };
}

function ensure() {
  if (group) return;
  group = new THREE.Group();
  group.position.set(...BLACK_HOLE_POSITION);
  group.visible = false;
  disk = canvasSprite(TEX, TEX);
  const size = 2 * BLACK_HOLE_REACH * HOLE_R;
  disk.sprite.scale.set(size, size, 1);
  group.add(disk.sprite);
  label = canvasSprite(768, 200);
  label.sprite.frustumCulled = false; // 기준점을 내려 띄우므로 구멍이 화면 밖이어도 이름표는 보일 수 있다
  group.add(label.sprite);
  hit = new THREE.Mesh(new THREE.SphereGeometry(HOLE_R * 3.2, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.userData.blackHole = true;
  group.add(hit);
  universe.add(group);
}

function drawLabel() {
  if (!label || drawnCount === count) return;
  drawnCount = count;
  const g = label.ctx;
  g.clearRect(0, 0, 768, 200);
  g.textAlign = 'center';
  g.lineJoin = 'round';
  g.font = `86px ${LABEL_FONT}`;
  g.lineWidth = 18;
  g.strokeStyle = '#1a1430';
  g.strokeText('잠든 별 블랙홀', 384, 100);
  g.fillStyle = '#fff';
  g.fillText('잠든 별 블랙홀', 384, 100);
  g.font = SUB_FONT;
  g.lineWidth = 12;
  const sub = `잠든 별 ${count.toLocaleString('ko-KR')}개`;
  g.strokeText(sub, 384, 160);
  g.fillStyle = '#ffb36b';
  g.fillText(sub, 384, 160);
  label.tex.needsUpdate = true;
}

/** 잠든 별 수를 맞춘다(store 'remind'). 설정이 끄기(days 0)면 0개로 본다. */
export function syncBlackHole(remind = store.state.remind) {
  count = remind && remind.days > 0 ? Math.max(0, Number(remind.total) || 0) : 0;
  target = holeScale(count);
  if (!universe.parent) return; // 우주를 아직 만들지 않았다: 처음 그릴 때 맞춘다
  ensure();
  drawLabel();
  const fonts = globalThis.document?.fonts;
  fonts?.load?.(`86px ${LABEL_FONT}`, '잠든 별 블랙홀').then(() => {
    drawnCount = -1;
    drawLabel();
  }).catch(() => {});
}

/** 크기 보간을 건너뛰고 지금 값으로(빨려 들어가기 · 나오기 직전의 한 장면을 찍을 때). */
export function settleBlackHole() {
  scale = target;
  if (group) {
    group.visible = scale > 0.02;
    group.scale.setScalar(Math.max(scale, 0.001));
  }
}

/** 매 프레임(controls.js 루프). t 초. 원반 그림은 초당 30번만 다시 그린다. */
export function updateBlackHole(dt, t) {
  if (!group) {
    if (!universe.parent) return;
    syncBlackHole();
    if (!group) return;
  }
  scale += (target - scale) * Math.min(1, dt * 3);
  if (Math.abs(target - scale) < 0.002) scale = target;
  group.visible = scale > 0.02;
  if (!group.visible) return;
  group.scale.setScalar(scale);
  // 이름표는 블랙홀 크기와 상관없이 행성 이름표와 같은 크기로, 원반 위에
  label.sprite.scale.set(9 / scale, LABEL_H / scale, 1);
  // 공간의 위쪽이 아니라 화면의 위쪽으로 올린다(판의 기준점을 내린다). 까닭: 카메라가 기울어 있어
  // 공간에서 위로 올리면 화면 가장자리에서 이름표가 바깥쪽으로 밀려 구멍 가운데와 어긋난다
  label.sprite.center.y = 0.5 - (HOLE_R * 2.1 * scale + 2.2) / LABEL_H;
  if (t - lastDraw >= 1 / 30 || t < lastDraw) {
    lastDraw = t;
    const g = disk.ctx;
    g.clearRect(0, 0, TEX, TEX);
    drawBlackHole(g, TEX / 2, TEX / 2, (TEX / 2 / BLACK_HOLE_REACH) * 0.98, t);
    disk.tex.needsUpdate = true;
  }
}

/** 누를 수 있는 것(보일 때만): 구멍 둘레의 보이지 않는 공 하나. */
export function blackHoleTargets() {
  return group && group.visible ? [hit] : [];
}

/** 조망 카메라에 함께 담을 자리(보일 때만). */
export function blackHoleFraming() {
  return target > 0 ? [[...BLACK_HOLE_POSITION]] : [];
}

/** 화면에서 구멍의 가운데와 반지름(px). 안 보이면 null. */
export function blackHoleOnScreen(camera, width, height) {
  if (!group || !group.visible || !camera) return null;
  const c = new THREE.Vector3(...BLACK_HOLE_POSITION);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const edge = c.clone().addScaledVector(right, HOLE_R * scale);
  const p = c.clone().project(camera);
  const q = edge.clone().project(camera);
  if (p.z > 1) return null; // 카메라 뒤
  const x = (p.x * 0.5 + 0.5) * width;
  const y = (-p.y * 0.5 + 0.5) * height;
  const r = Math.hypot((q.x * 0.5 + 0.5) * width - x, (-q.y * 0.5 + 0.5) * height - y);
  return { x, y, r: Math.max(4, r) };
}

store.on('remind', (r) => syncBlackHole(r));
