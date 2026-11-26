// 미분류 행성의 모습: 줄무늬 텍스처, 먼지 알 재질. three.js가 필요한 부분(순수 부분은 dustLogic.js).
import * as THREE from 'three';
import { seededRand } from './dustLogic.js';

const DUST_WHITE = 0xeef1ff;
const DUST_PINK = 0xff5d8f; // 고른 먼지(프로젝트 핑크)

const STRIPE_COLORS = ['#26303c', '#2f3a48', '#3a4757', '#4c5b6b', '#33404f', '#2a3340', '#56677a', '#303b49'];

/**
 * 줄무늬 몸 텍스처(512×256 캔버스, 가로로 물결치는 띠). seed(행성 id)가 같으면 늘 같은 무늬.
 * 띠 경계의 물결은 가로 폭에 정수 번 들어가게 해서 RepeatWrapping으로 이어 붙여도 이음매가 없다.
 */
export function stripeTexture(seed) {
  const W = 512;
  const H = 256;
  const rand = seededRand(`stripe:${seed}`);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // 경계선: 맨 위 · 맨 아래는 평평, 그 사이는 높이 6~32px 간격으로 사인 물결(진폭 2~3px)
  const edges = [{ y: 0, amp: 0, k: 1, phase: 0 }];
  let y = 0;
  for (;;) {
    y += rand(6, 32);
    if (y >= H - 4) break;
    edges.push({ y, amp: rand(2, 3), k: Math.floor(rand(1, 5)), phase: rand(0, Math.PI * 2) });
  }
  edges.push({ y: H, amp: 0, k: 1, phase: 0 });
  const edgeY = (e, x) => e.y + e.amp * Math.sin((x / W) * Math.PI * 2 * e.k + e.phase);

  const STEP = 8;
  for (let i = 0; i < edges.length - 1; i++) {
    const top = edges[i];
    const bottom = edges[i + 1];
    g.fillStyle = STRIPE_COLORS[Math.floor(rand(0, STRIPE_COLORS.length))];
    g.beginPath();
    g.moveTo(0, edgeY(top, 0));
    for (let x = STEP; x <= W; x += STEP) g.lineTo(x, edgeY(top, x));
    // 아래 경계는 1px 더 내려 그려 띠 사이에 틈이 보이지 않게 한다(다음 띠가 위에 덮는다)
    for (let x = W; x >= 0; x -= STEP) g.lineTo(x, edgeY(bottom, x) + 1);
    g.closePath();
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/* ---------- 먼지 알(모든 먼지가 함께 쓴다, 지우지 않는다) ---------- */
let dust = null;

function grainTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.45, 'rgba(244,246,255,1)');
  r.addColorStop(0.62, 'rgba(238,241,255,.55)');
  r.addColorStop(1, 'rgba(238,241,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** 먼지 알 재질 { normal: 하양, on: 핑크 }. 처음 부를 때 한 번 만들고 그 뒤로 같은 것을 돌려준다. */
export function dustMaterials() {
  if (!dust) {
    const map = grainTexture();
    const make = (color) => new THREE.SpriteMaterial({ map, color, transparent: true, depthWrite: false });
    dust = { normal: make(DUST_WHITE), on: make(DUST_PINK) };
  }
  return dust;
}

/** 함께 쓰는 먼지 재질인지(지우면 안 되는지). */
export function isDustMaterial(m) {
  return dust !== null && (m === dust.normal || m === dust.on);
}
