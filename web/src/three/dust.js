// 미분류 행성의 모습: 줄무늬 텍스처, 먼지 알 재질. three.js가 필요한 부분(순수 부분은 dustLogic.js).
import * as THREE from 'three';
import { seededRand } from './dustLogic.js';

const DUST_WHITE = 0xeef1ff;
const DUST_PINK = 0xff5d8f; // 고른 먼지(프로젝트 핑크)

const STRIPE_COLORS = ['#26303c', '#2f3a48', '#3a4757', '#4c5b6b', '#33404f', '#2a3340', '#56677a', '#303b49'];

/**
 * 줄무늬 몸 텍스처(512×256 캔버스, 가로로 물결치는 띠, 띠 사이로 가는 진한 끊긴 줄). seed(행성 id)가 같으면 늘 같은 무늬.
 */
export function stripeTexture(seed) {
  const W = 512;
  const H = 256;
  const rand = seededRand(`stripe:${seed}`);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  // 바탕은 진한 잉크 청색: 띠마다 위 · 아래 경계가 따로 물결쳐서 이웃 띠와 살짝 어긋난 곳이
  // 가는 진한 끊긴 줄로 드러난다(사용자가 고른 시안의 거친 줄무늬 느낌)
  g.fillStyle = '#141a24';
  g.fillRect(0, 0, W, H);

  // 물결은 가로 폭에 정수 번(2~3번) 들어가게 해서 RepeatWrapping으로 이어 붙여도 이음매가 없다
  const wave = (amp) => ({ amp, k: Math.floor(rand(2, 4)), phase: rand(0, Math.PI * 2) });
  const at = (base, w, x) => base + w.amp * Math.sin((x / W) * Math.PI * 2 * w.k + w.phase);

  const STEP = 8;
  let y = 0;
  while (y < H) {
    const h = rand(6, 32);
    const first = y === 0;
    const last = y + h >= H;
    const top = first ? { amp: 0, k: 1, phase: 0 } : wave(2.2);
    const bottom = last ? { amp: 0, k: 1, phase: 0 } : wave(2.6);
    const bottomY = last ? H : y + h;
    g.fillStyle = STRIPE_COLORS[Math.floor(rand(0, STRIPE_COLORS.length))];
    g.beginPath();
    g.moveTo(0, at(y, top, 0));
    for (let x = STEP; x <= W; x += STEP) g.lineTo(x, at(y, top, x));
    for (let x = W; x >= 0; x -= STEP) g.lineTo(x, at(bottomY, bottom, x));
    g.closePath();
    g.fill();
    y += h;
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
