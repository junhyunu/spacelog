// 캐릭터 6종(스펙 6-10). 모두 같은 2등신 · 같은 크기 · 같은 뼈대(kit.js의 약속)다.
// CHARACTER_BUILDERS[kind](c) → rig.  c = resolveLook(look) = { suit, accent, flameOuter, flameInner }
// suit는 슈트 몸 · 헬멧 바깥, accent는 가슴판 · 부츠 · 안테나 공 등. 캐릭터 고유의 색(피부 · 눈 · 머리)은 고정이다.
import * as THREE from 'three';
import { resolveLook, normalizeLook } from '../../ui/characterLogic.js';
import { INK, ol, part } from '../scene.js';
import {
  EYE,
  VISOR,
  YEL,
  antenna,
  box,
  cyl,
  HELMET_Y,
  earCaps,
  eye,
  flat,
  helmet,
  jetpack,
  newRig,
  olGeo,
  roundArms,
  roundLegs,
  roundTorso,
  sph,
  visorZ,
} from './kit.js';

const ALIEN_SKIN = 0xa8e87c;
const HUMAN_SKIN = 0xffc9a3;
const HUMAN_EYE = 0x2a6fdb;
const HUMAN_HAIR = 0x3a2012; // 고동색(빛을 받으면 1.5배쯤 밝아진다)
const DARK = 0x14102a;

/* ---------- 우주인: 지금까지의 캐릭터 그대로(시안 431~465행) ---------- */
function astronaut(c) {
  const rig = newRig();
  const g = rig.lean;
  roundTorso(rig, c);
  helmet(rig, c);
  rig.eyes = [-0.19, 0.19].map((x) => eye(g, sph(0.075, 10, 8), EYE, [x, 1.05, 0.79], [1, 1.7, 0.5]));
  const ant = part(g, cyl(0.035, 0.035, 0.55, 8), INK, [0.3, 1.95, 0], null, 0);
  ant.rotation.z = -0.35;
  rig.wobble.push({ obj: part(g, sph(0.13, 12, 10), c.accent, [0.4, 2.22, 0], null, 1.15), x: 0.4 });
  roundArms(rig, c);
  roundLegs(rig, c);
  jetpack(rig, c);
  return rig;
}

/* ---------- 로봇: 네모난 머리, 안테나 2개, 어두운 화면 얼굴에 밝은 눈, 각진 몸 ---------- */
function robot(c) {
  const rig = newRig();
  const g = rig.lean;
  // 몸통 · 벨트 · 가슴판
  part(g, box(1.0, 1.0, 0.86), c.suit, [0, 0, 0], null, 1.07);
  part(g, box(1.07, 0.17, 0.93), YEL, [0, -0.16, 0], null, 1.05);
  part(g, box(0.5, 0.3, 0.12), c.accent, [0, 0.17, 0.43], null, 1.12);
  // 머리 · 화면 · 눈 · 입
  part(g, box(1.44, 1.14, 1.2), c.suit, [0, 1.05, 0], null, 1.06);
  part(g, box(1.14, 0.76, 0.12), VISOR, [0, 1.05, 0.585], null, 1.06);
  rig.eyes = [-0.27, 0.27].map((x) => eye(g, box(0.22, 0.28, 0.05), EYE, [x, 1.11, 0.655]));
  flat(g, box(0.3, 0.055, 0.05), EYE, [0, 0.84, 0.655]);
  flat(g, box(0.16, 0.07, 0.05), 0xffffff, [0.38, 1.33, 0.655]);
  part(g, box(0.7, 0.36, 0.1), VISOR, [0, 1.12, -0.6], null, 1.08); // 뒤통수 판(뒤에서 볼 때가 많다)
  earCaps(rig, 0.74, 1.05);
  antenna(rig, c, [-0.42, 1.6, 0], -0.12, { len: 0.36, ball: 0.12 });
  antenna(rig, c, [0.42, 1.6, 0], 0.12, { len: 0.36, ball: 0.12 });
  // 팔 · 다리(각진)
  rig.arms = [-1, 1].map((s) => {
    const a = new THREE.Group();
    a.position.set(s * 0.62, 0.2, 0);
    g.add(a);
    part(a, box(0.3, 0.5, 0.3), c.suit, [s * 0.05, -0.18, 0], null, 1.1);
    part(a, box(0.36, 0.26, 0.36), YEL, [s * 0.07, -0.5, 0.02], null, 1.1);
    return a;
  });
  rig.legs = [-1, 1].map((s) => {
    const l = new THREE.Group();
    l.position.set(s * 0.25, -0.5, 0);
    g.add(l);
    part(l, box(0.34, 0.42, 0.34), c.suit, [0, -0.12, 0], null, 1.1);
    part(l, box(0.44, 0.27, 0.58), c.accent, [0, -0.41, 0.08], null, 1.1);
    return l;
  });
  jetpack(rig, c);
  return rig;
}

/* ---------- 고양이: 둥근 헬멧 위 세모 귀 2개, 바이저 안 눈, 뒤에 꼬리 ---------- */
function cat(c) {
  const rig = newRig();
  const g = rig.lean;
  roundTorso(rig, c);
  helmet(rig, c);
  // 세모 귀: 납작한 사각뿔. 안쪽은 포인트 색
  [-1, 1].forEach((s) => {
    const geo = new THREE.ConeGeometry(0.34, 0.56, 4);
    geo.rotateY(Math.PI / 4);
    const ear = part(g, geo, c.suit, [s * 0.5, 1.78, 0], [1, 1, 0.6], 1.12);
    ear.rotation.z = -s * 0.5;
    const inGeo = new THREE.ConeGeometry(0.2, 0.34, 4);
    inGeo.rotateY(Math.PI / 4);
    part(ear, inGeo, c.accent, [0, -0.06, 0.13], null, 0);
  });
  // 눈(세로 동공) · 코
  rig.eyes = [-0.2, 0.2].map((x) => {
    const e = eye(g, sph(0.085, 12, 10), 0xffe45c, [x, 1.07, visorZ(x, 0.02) + 0.005], [1.15, 1.5, 0.5]);
    flat(e, sph(0.05, 8, 8), DARK, [0, 0, 0.055], [0.38, 1.25, 0.6]);
    return e;
  });
  flat(g, sph(0.05, 8, 6), 0xff9ec4, [0, 0.92, visorZ(0, -0.13)], [1.3, 0.8, 0.5]);
  roundArms(rig, c);
  roundLegs(rig, c);
  jetpack(rig, c);
  // 꼬리: 오른쪽 엉덩이 뒤에서 나와 제트팩 옆으로 말려 올라간다. 끝은 포인트 색
  const tail = new THREE.Group();
  tail.position.set(0.2, -0.36, -0.36);
  g.add(tail);
  const pts = [
    [0, 0, 0],
    [0.3, -0.2, -0.3],
    [0.68, -0.14, -0.5],
    [0.9, 0.2, -0.52],
    [0.86, 0.62, -0.46],
    [0.7, 0.9, -0.4],
  ].map((p) => new THREE.Vector3(...p));
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = part(tail, new THREE.TubeGeometry(curve, 20, 0.1, 10), c.suit, null, null, 0);
  olGeo(tube, new THREE.TubeGeometry(curve, 20, 0.135, 10));
  part(tail, sph(0.145, 12, 10), c.accent, pts[pts.length - 1].toArray(), null, 1.2);
  rig.tail = tail;
  return rig;
}

/* ---------- 외계인: 헬멧 없이 큰 머리, 크고 검은 타원 눈, 더듬이 2개(끝에 공) ---------- */
function alien(c) {
  const rig = newRig();
  const g = rig.lean;
  roundTorso(rig, c);
  part(g, sph(0.8, 28, 20), ALIEN_SKIN, [0, 1.08, 0], [1.06, 0.96, 1], 1.07);
  rig.eyes = [-1, 1].map((s) => {
    const e = eye(g, sph(0.2, 16, 12), DARK, [s * 0.31, 1.1, 0.735], [0.82, 1.3, 0.32]);
    e.rotation.z = -s * 0.38;
    flat(e, sph(0.05, 8, 6), 0xffffff, [-s * 0.07, 0.09, 0.19], [1, 0.8, 0.5]);
    return e;
  });
  flat(g, sph(0.05, 8, 6), DARK, [0, 0.76, 0.74], [1.7, 0.5, 0.5]);
  antenna(rig, c, [-0.26, 1.8, 0], -0.36, { len: 0.42, ball: 0.12 });
  antenna(rig, c, [0.26, 1.8, 0], 0.36, { len: 0.42, ball: 0.12 });
  roundArms(rig, c, { hand: ALIEN_SKIN });
  roundLegs(rig, c);
  jetpack(rig, c);
  return rig;
}

/* ---------- 곰돌이: 둥근 헬멧 위 둥근 귀 2개, 통통한 몸, 바이저 안 눈과 코 ---------- */
function bear(c) {
  const rig = newRig();
  const g = rig.lean;
  roundTorso(rig, c, { wide: 1.2, deep: 1.1 });
  helmet(rig, c, { tall: 0.44 });
  [-1, 1].forEach((s) => {
    const ear = part(g, sph(0.3, 16, 12), c.suit, [s * 0.58, 1.7, 0], [1, 1, 0.6], 1.1);
    part(ear, sph(0.17, 12, 10), c.accent, [0, 0, 0.2], [1, 1, 0.55], 0);
  });
  rig.eyes = [-0.21, 0.21].map((x) => eye(g, sph(0.075, 10, 8), EYE, [x, 1.15, visorZ(x, 0.1) + 0.005], [1, 1.2, 0.5]));
  flat(g, sph(0.2, 14, 10), 0xffe9c9, [0, 0.9, visorZ(0, -0.15) - 0.03], [1.2, 0.8, 0.3]);
  flat(g, sph(0.065, 10, 8), DARK, [0, 0.95, visorZ(0, -0.1) + 0.035], [1.35, 0.9, 0.6]);
  roundArms(rig, c, { x: 0.7 });
  roundLegs(rig, c, { x: 0.28 });
  jetpack(rig, c, { back: 0.06 });
  return rig;
}

/* ---------- 사람: 투명한 유리 헬멧 안에 살구색 얼굴 · 파란 눈 · 고동색 머리. 우주복 몸 ---------- */
function human(c) {
  const rig = newRig();
  const g = rig.lean;
  roundTorso(rig, c);
  // 유리 헬멧: 안쪽 벽(옅은 하늘색, 뒤집힌 면) 바깥에 잉크 껍데기 → 둘레에 잉크 테두리만 남는다
  const HY = HELMET_Y;
  const shell = new THREE.Mesh(sph(0.78, 28, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }));
  shell.position.set(0, HY, 0);
  shell.renderOrder = 2;
  g.add(ol(shell, 1.07));
  flat(g, sph(0.765, 28, 20), 0xd3ecff, [0, HY, 0], null, { side: THREE.BackSide });
  const shine = flat(g, sph(0.1, 10, 8), 0xffffff, [0.28, 1.5, 0.62], [1.4, 0.6, 0.4], { transparent: true, opacity: 0.9, depthWrite: false });
  shine.rotation.z = -0.5;
  shine.renderOrder = 3;
  // 목 둘레(몸 색) · 귀마개 · 안테나
  const collar = part(g, new THREE.TorusGeometry(0.47, 0.1, 8, 28), c.suit, [0, 0.43, 0], null, 1.12);
  collar.rotation.x = Math.PI / 2;
  earCaps(rig, 0.78, HY);
  antenna(rig, c, [0.27, 1.79, 0], 0.35, { len: 0.38, ball: 0.13 }); // 유리 안으로 들어가지 않게 겉면에서 시작한다
  // 얼굴 · 머리카락
  part(g, sph(0.5, 24, 18), HUMAN_SKIN, [0, 0.98, 0.04], null, 1.06);
  part(g, sph(0.54, 24, 18), HUMAN_HAIR, [0, 1.1, -0.07], null, 1.05);
  [
    [-0.2, 1.36, 0.33, 0.17],
    [0.1, 1.4, 0.34, 0.19],
    [0.33, 1.3, 0.26, 0.15],
  ].forEach(([x, y, z, r]) => part(g, sph(r, 12, 10), HUMAN_HAIR, [x, y, z], [1.15, 0.8, 0.8], 0));
  [-1, 1].forEach((s) => part(g, sph(0.1, 10, 8), HUMAN_SKIN, [s * 0.5, 0.98, 0.02], [0.6, 1, 0.8], 1.12));
  rig.eyes = [-0.17, 0.17].map((x) => {
    const e = eye(g, sph(0.075, 12, 10), HUMAN_EYE, [x, 1.02, 0.515], [1, 1.5, 0.5]);
    flat(e, sph(0.025, 6, 6), 0xffffff, [0.02, 0.03, 0.07]);
    return e;
  });
  [-1, 1].forEach((s) => flat(g, sph(0.07, 8, 6), 0xff9fb0, [s * 0.3, 0.88, 0.43], [1.2, 0.65, 0.3]));
  flat(g, sph(0.04, 8, 6), 0x9a3d3d, [0, 0.83, 0.525], [1.7, 0.55, 0.5]);
  roundArms(rig, c);
  roundLegs(rig, c);
  jetpack(rig, c);
  return rig;
}

/** 종류 → 만드는 함수. */
export const CHARACTER_BUILDERS = Object.freeze({ astronaut, robot, cat, alien, bear, human });

/** 고른 모습(look)으로 뼈대를 만든다. 틀린 값은 기본값으로 바꿔 만든다. */
export function buildRig(look) {
  const l = normalizeLook(look);
  const rig = CHARACTER_BUILDERS[l.kind](resolveLook(l));
  rig.look = l;
  return rig;
}
