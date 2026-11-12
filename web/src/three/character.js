// 2등신 우주인(오리지널)과 대기 · 비행 움직임. 시안 431~465행, 904~918행을 옮겼다.
import * as THREE from 'three';
import { INK, part, rand } from './scene.js';

const WHITE = 0xf3f1ff;
const YEL = 0xffd23f;
const PINK = 0xff5d8f;
const VIO = 0x7a6cff;
const sph = (r, w = 22, h = 16) => new THREE.SphereGeometry(r, w, h);

/** 캐릭터의 뿌리 그룹. 위치가 곧 플레이어 위치다. */
export const player = new THREE.Group();
player.position.set(0, 0, 10);

let built = false;
let yawG, leanG, antBall;
let eyes = [];
let arms = [];
let legs = [];
const flames = [];
const puffs = [];
let puffIdx = 0;
const tmp = new THREE.Vector3();

/** 캐릭터를 만들어 scene에 붙인다. 두 번째부터는 만들어 둔 것을 돌려준다. */
export function initCharacter(scene) {
  if (built) {
    if (player.parent !== scene) {
      scene.add(player);
      puffs.forEach((p) => scene.add(p.m));
    }
    return player;
  }
  built = true;
  scene.add(player);
  yawG = new THREE.Group();
  player.add(yawG);
  leanG = new THREE.Group();
  yawG.add(leanG);

  // 몸통 · 벨트 · 가슴판
  part(leanG, sph(0.55), WHITE, [0, 0, 0], [1, 1.05, 0.92]);
  const belt = part(leanG, new THREE.TorusGeometry(0.5, 0.085, 8, 28), YEL, [0, -0.14, 0], null, 1.12);
  belt.rotation.x = Math.PI / 2;
  part(leanG, new THREE.BoxGeometry(0.4, 0.24, 0.12), PINK, [0, 0.14, 0.5], null, 1.12);
  // 헬멧 · 바이저 · 눈
  part(leanG, sph(0.78, 28, 20), WHITE, [0, 1.05, 0]);
  part(leanG, sph(0.6), 0x2b2f6b, [0, 1.02, 0.38], [1, 0.72, 0.62], 1.07);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x9ff3ff });
  eyes = [-0.19, 0.19].map((x) => {
    const e = new THREE.Mesh(sph(0.075, 10, 8), eyeMat);
    e.position.set(x, 1.05, 0.77);
    e.scale.set(1, 1.7, 0.5);
    leanG.add(e);
    return e;
  });
  const shine = new THREE.Mesh(sph(0.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  shine.position.set(0.26, 1.24, 0.68);
  shine.scale.set(1.3, 0.6, 0.4);
  leanG.add(shine);
  // 귀 · 안테나
  [-1, 1].forEach((s) => {
    const b = part(leanG, new THREE.CylinderGeometry(0.18, 0.18, 0.16, 16), YEL, [s * 0.78, 1.05, 0], null, 1.15);
    b.rotation.z = Math.PI / 2;
  });
  const ant = part(leanG, new THREE.CylinderGeometry(0.035, 0.035, 0.55, 8), INK, [0.3, 1.95, 0], null, 0);
  ant.rotation.z = -0.35;
  antBall = part(leanG, sph(0.13, 12, 10), PINK, [0.4, 2.22, 0], null, 1.15);
  // 팔 · 다리
  arms = [-1, 1].map((s) => {
    const a = new THREE.Group();
    a.position.set(s * 0.6, 0.18, 0);
    leanG.add(a);
    part(a, sph(0.2), WHITE, [s * 0.04, -0.18, 0], [1, 1.45, 1]);
    part(a, sph(0.19), YEL, [s * 0.07, -0.46, 0.02]);
    return a;
  });
  legs = [-1, 1].map((s) => {
    const l = new THREE.Group();
    l.position.set(s * 0.24, -0.5, 0);
    leanG.add(l);
    part(l, sph(0.22), WHITE, [0, -0.12, 0], [1, 1.25, 1]);
    part(l, sph(0.25), PINK, [0, -0.38, 0.07], [1.05, 0.68, 1.25]);
    return l;
  });
  // 제트팩 · 탱크 · 불꽃
  part(leanG, new THREE.BoxGeometry(0.72, 0.82, 0.36), VIO, [0, 0.16, -0.6], null, 1.07);
  [-1, 1].forEach((s) => {
    part(leanG, new THREE.CylinderGeometry(0.16, 0.16, 0.78, 14), YEL, [s * 0.25, 0.12, -0.84], null, 1.1);
    part(leanG, new THREE.CylinderGeometry(0.12, 0.17, 0.14, 12), INK, [s * 0.25, -0.33, -0.84], null, 0);
    const fg = new THREE.ConeGeometry(0.15, 0.7, 10);
    fg.rotateX(Math.PI);
    fg.translate(0, -0.35, 0);
    const f = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
    f.position.set(s * 0.25, -0.4, -0.84);
    leanG.add(f);
    const fg2 = new THREE.ConeGeometry(0.08, 0.45, 8);
    fg2.rotateX(Math.PI);
    fg2.translate(0, -0.22, 0);
    const f2 = new THREE.Mesh(fg2, new THREE.MeshBasicMaterial({ color: 0xfff1a0 }));
    f2.position.set(s * 0.25, -0.4, -0.84);
    leanG.add(f2);
    flames.push(f, f2);
  });

  // 연기 방울 40개를 돌려 쓴다
  const puffGeo = sph(0.16, 8, 6);
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color: 0xfff1a0, transparent: true }));
    m.visible = false;
    scene.add(m);
    puffs.push({ m, life: 0 });
  }
  return player;
}

/** 떠 있는 연기 방울을 모두 감춘다(우주에 새로 들어올 때). */
export function resetCharacter() {
  puffs.forEach((p) => {
    p.life = 0;
    p.m.visible = false;
  });
}

/**
 * 매 프레임 움직임. t는 흐른 시간(초), vel은 지금 속도, maxSpeed는 최대 속도(15).
 * 대기: 위아래 0.14 · 약 2.9초 주기. 비행: 진행 방향으로 최대 0.55 rad 숙임, 불꽃 0.35~2배, 연기.
 */
export function updateCharacter(dt, t, vel, maxSpeed = 15) {
  if (!built) return;
  const sp = vel.length();
  const k = Math.min(sp / maxSpeed, 1.3);
  if (sp > 0.5) {
    const ty = Math.atan2(vel.x, vel.z);
    let dy = ty - yawG.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    yawG.rotation.y += dy * (1 - Math.exp(-8 * dt));
  }
  leanG.rotation.x += (Math.min(k, 1) * 0.55 - leanG.rotation.x) * (1 - Math.exp(-6 * dt));
  leanG.position.y = Math.sin(t * 2.2) * 0.14 * (1 - k * 0.6);
  leanG.rotation.z = Math.sin(t * 1.3) * 0.05;
  arms[0].rotation.x = -Math.sin(t * 2.2) * 0.25 - k * 0.9;
  arms[1].rotation.x = Math.sin(t * 2.2) * 0.25 - k * 0.9;
  arms[0].rotation.z = -0.25 - k * 0.3;
  arms[1].rotation.z = 0.25 + k * 0.3;
  legs[0].rotation.x = Math.sin(t * 2.6) * 0.25 + k * 0.5;
  legs[1].rotation.x = -Math.sin(t * 2.6) * 0.25 + k * 0.5;
  antBall.position.x = 0.4 + Math.sin(t * 5) * 0.04 * (1 + k * 3);
  const blink = t % 3.4 < 0.12;
  eyes.forEach((e) => {
    e.scale.y = blink ? 0.25 : 1.7;
  });
  flames.forEach((fm, i) => {
    fm.scale.set(1, 0.35 + k * 1.6 + Math.sin(t * 40 + i) * 0.12, 1);
  });
  if (k > 0.25 && Math.random() < k * 0.9) {
    const p = puffs[puffIdx++ % puffs.length];
    p.life = 1;
    p.m.visible = true;
    p.m.position.copy(flames[Math.random() < 0.5 ? 0 : 2].getWorldPosition(tmp));
    p.m.position.x += rand(-0.1, 0.1);
    p.m.position.y -= 0.3;
    p.m.position.z += rand(-0.1, 0.1);
  }
  puffs.forEach((p) => {
    if (p.life <= 0) return;
    p.life -= dt * 1.8;
    p.m.material.opacity = Math.max(p.life, 0);
    p.m.scale.setScalar(0.6 + (1 - p.life) * 1.4);
    if (p.life <= 0) p.m.visible = false;
  });
}
