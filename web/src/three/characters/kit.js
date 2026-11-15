// 캐릭터 6종이 함께 쓰는 조각(스펙 6-10): 몸통 · 팔다리 · 헬멧 · 제트팩과 불꽃, 그리고 움직임.
// 모두 scene.js의 part() · ol() · toon()으로 만든다(잉크 외곽선 + 3단 음영). three r128의 도형만 쓴다.
//
// 뼈대(rig) 약속 — animateRig()와 character.js가 기대는 것:
//   root    돌리는 그룹(진행 방향 yaw). 캐릭터 앞은 +z
//   lean    숙이는 그룹(root의 자식). 모든 조각이 여기에 붙는다
//   arms    [왼, 오른] 어깨 그룹        legs  [왼, 오른] 골반 그룹
//   eyes    깜빡이는 눈 메시들. userData.open = 뜬 눈의 scale.y
//   flames  [바깥, 안, 바깥, 안] 불꽃 메시(길이는 scale.y). 0번 · 2번에서 연기가 나온다
//   wobble  [{ obj, x }] 좌우로 떠는 것(안테나 공 · 더듬이 공)
//   tail    꼬리 그룹(없으면 null)
import * as THREE from 'three';
import { INK, ol, outlineMat, part } from '../scene.js';

export const YEL = 0xffd23f;
export const VIO = 0x7a6cff;
export const VISOR = 0x2b2f6b;
export const EYE = 0x9ff3ff;

export const sph = (r, w = 22, h = 16) => new THREE.SphereGeometry(r, w, h);
export const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt, rb, h, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg);

/** 음영을 받지 않는 조각(눈 · 반짝임 · 불꽃). 외곽선 없음. */
export function flat(parent, geo, color, pos, scl, opts) {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial(Object.assign({ color }, opts)));
  if (pos) m.position.set(...pos);
  if (scl) m.scale.set(...scl);
  parent.add(m);
  return m;
}

/** 깜빡이는 눈 하나. 뜬 눈의 세로 배율을 userData.open에 적어 둔다. */
export function eye(parent, geo, color, pos, scl) {
  const e = flat(parent, geo, color, pos, scl);
  e.userData.open = e.scale.y;
  return e;
}

/** 가운데가 원점이 아닌 도형(관 모양 꼬리)의 외곽선: 조금 굵게 만든 도형을 뒤집어 겹친다. */
export function olGeo(mesh, fatGeo) {
  const o = new THREE.Mesh(fatGeo, outlineMat);
  o.userData.outline = true;
  mesh.add(o);
  return mesh;
}

export function newRig() {
  const root = new THREE.Group();
  const lean = new THREE.Group();
  root.add(lean);
  return { root, lean, arms: [], legs: [], eyes: [], flames: [], wobble: [], tail: null };
}

/** 둥근 몸통 + 노랑 벨트 + 포인트 색 가슴판. wide · deep으로 통통하게. */
export function roundTorso(rig, c, { wide = 1, deep = 1 } = {}) {
  const g = rig.lean;
  part(g, sph(0.55), c.suit, [0, 0, 0], [wide, 1.05, 0.92 * deep]);
  const belt = part(g, new THREE.TorusGeometry(0.5, 0.085, 8, 28), YEL, [0, -0.14, 0], [wide, deep, 1], 1.12);
  belt.rotation.x = Math.PI / 2;
  part(g, box(0.4, 0.24, 0.12), c.accent, [0, 0.14, 0.5 * deep], null, 1.12);
}

/** 둥근 팔 2개(위팔 = 몸 색, 손 = hand). x는 어깨까지의 거리. */
export function roundArms(rig, c, { x = 0.6, hand = YEL } = {}) {
  rig.arms = [-1, 1].map((s) => {
    const a = new THREE.Group();
    a.position.set(s * x, 0.18, 0);
    rig.lean.add(a);
    part(a, sph(0.2), c.suit, [s * 0.04, -0.18, 0], [1, 1.45, 1]);
    part(a, sph(0.19), hand, [s * 0.07, -0.46, 0.02]);
    return a;
  });
}

/** 둥근 다리 2개(허벅지 = 몸 색, 부츠 = 포인트 색). */
export function roundLegs(rig, c, { x = 0.24 } = {}) {
  rig.legs = [-1, 1].map((s) => {
    const l = new THREE.Group();
    l.position.set(s * x, -0.5, 0);
    rig.lean.add(l);
    part(l, sph(0.22), c.suit, [0, -0.12, 0], [1, 1.25, 1]);
    part(l, sph(0.25), c.accent, [0, -0.38, 0.07], [1.05, 0.68, 1.25]);
    return l;
  });
}

/** 보라 제트팩 + 노랑 탱크 2개 + 불꽃(바깥 · 안쪽). back만큼 뒤로 민다(통통한 몸). */
export function jetpack(rig, c, { back = 0 } = {}) {
  const g = rig.lean;
  part(g, box(0.72, 0.82, 0.36), VIO, [0, 0.16, -0.6 - back], null, 1.07);
  [-1, 1].forEach((s) => {
    const z = -0.84 - back;
    part(g, cyl(0.16, 0.16, 0.78), YEL, [s * 0.25, 0.12, z], null, 1.1);
    part(g, cyl(0.12, 0.17, 0.14, 12), INK, [s * 0.25, -0.33, z], null, 0);
    const outer = new THREE.ConeGeometry(0.15, 0.7, 10);
    outer.rotateX(Math.PI);
    outer.translate(0, -0.35, 0);
    const inner = new THREE.ConeGeometry(0.08, 0.45, 8);
    inner.rotateX(Math.PI);
    inner.translate(0, -0.22, 0);
    rig.flames.push(flat(g, outer, c.flameOuter, [s * 0.25, -0.4, z]), flat(g, inner, c.flameInner, [s * 0.25, -0.4, z]));
  });
}

/**
 * 공 겉면에 딱 붙는 둥근 네모 조각(바이저). 가운데는 +z, halfLon · halfLat은 가로 · 세로 반각(rad).
 * 공 안에 묻힌 도형은 뒤집힌 껍데기 외곽선이 보이지 않아서, 겉면을 따라 조각을 따로 만든다.
 */
export function domePatch(radius, halfLon, halfLat, { rings = 8, seg = 44, power = 2.7 } = {}) {
  const pos = [];
  const nor = [];
  const idx = [];
  const put = (lon, lat) => {
    const x = Math.cos(lat) * Math.sin(lon);
    const y = Math.sin(lat);
    const z = Math.cos(lat) * Math.cos(lon);
    pos.push(x * radius, y * radius, z * radius);
    nor.push(x, y, z);
  };
  put(0, 0);
  for (let i = 1; i <= rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const e = (Math.abs(cs) ** power + Math.abs(sn) ** power) ** (-1 / power); // 둥근 네모(초타원)
      put((halfLon * i * e * cs) / rings, (halfLat * i * e * sn) / rings);
    }
  }
  for (let j = 0; j < seg; j++) idx.push(0, 1 + j, 1 + ((j + 1) % seg));
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = 1 + (i - 1) * seg + j;
      const b = 1 + (i - 1) * seg + ((j + 1) % seg);
      idx.push(a, a + seg, b + seg, a, b + seg, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

export const HELMET_R = 0.78;
export const HELMET_Y = 1.05;
/** 바이저 겉면의 z(헬멧 가운데에서 x, dy만큼 떨어진 곳). 눈 · 코를 그 위에 얹을 때 쓴다. */
export const visorZ = (x, dy) => Math.sqrt((HELMET_R + 0.03) ** 2 - x * x - dy * dy);

/**
 * 둥근 헬멧(몸 색) + 남색 바이저(잉크 테두리) + 양옆 노랑 귀마개. (반짝임 조각은 어색해 뺐다)
 * 시안의 바이저는 헬멧 안에 0.03 묻혀 보이지 않았다. 겉면에 붙는 조각으로 바꿔 보이게 했다.
 * tall은 바이저의 세로 반각(rad): 코까지 들어가야 하는 곰돌이는 더 크다.
 */
export function helmet(rig, c, { tall = 0.36, wide = 0.8 } = {}) {
  const g = rig.lean;
  part(g, sph(HELMET_R, 28, 20), c.suit, [0, HELMET_Y, 0]);
  flat(g, domePatch(HELMET_R + 0.012, wide + 0.055, tall + 0.055), INK, [0, HELMET_Y - 0.03, 0]);
  part(g, domePatch(HELMET_R + 0.03, wide, tall), VISOR, [0, HELMET_Y - 0.03, 0], null, 0);
  earCaps(rig, HELMET_R, HELMET_Y);
}

export function earCaps(rig, x, y) {
  [-1, 1].forEach((s) => {
    const b = part(rig.lean, cyl(0.18, 0.18, 0.16, 16), YEL, [s * x, y, 0], null, 1.15);
    b.rotation.z = Math.PI / 2;
  });
}

/** 잉크색 대 + 포인트 색 공. 공은 좌우로 떤다. base는 대의 아래 끝, tilt는 바깥으로 기운 각(rad, +면 오른쪽). */
export function antenna(rig, c, base, tilt, { len = 0.55, ball = 0.13 } = {}) {
  const dir = [Math.sin(tilt), Math.cos(tilt)];
  const stalk = part(rig.lean, cyl(0.035, 0.035, len, 8), INK, [base[0] + (dir[0] * len) / 2, base[1] + (dir[1] * len) / 2, base[2]], null, 0);
  stalk.rotation.z = -tilt;
  const tip = [base[0] + dir[0] * (len + ball * 0.6), base[1] + dir[1] * (len + ball * 0.6), base[2]];
  const b = part(rig.lean, sph(ball, 12, 10), c.accent, tip, null, 1.15);
  rig.wobble.push({ obj: b, x: tip[0] });
}

/**
 * 한 프레임의 움직임(방향 돌리기는 빼고). k = 속도 / 최대 속도(0 ~ 1.3).
 * 대기: 위아래 0.14 · 약 2.9초 주기. 비행: 최대 0.55 rad 숙임, 불꽃 0.35 ~ 2배. 눈은 3.4초마다 깜빡인다.
 */
export function animateRig(rig, dt, t, k) {
  const { lean, arms, legs } = rig;
  lean.rotation.x += (Math.min(k, 1) * 0.55 - lean.rotation.x) * (1 - Math.exp(-6 * dt));
  lean.position.y = Math.sin(t * 2.2) * 0.14 * (1 - k * 0.6);
  lean.rotation.z = Math.sin(t * 1.3) * 0.05;
  arms[0].rotation.x = -Math.sin(t * 2.2) * 0.25 - k * 0.9;
  arms[1].rotation.x = Math.sin(t * 2.2) * 0.25 - k * 0.9;
  arms[0].rotation.z = -0.25 - k * 0.3;
  arms[1].rotation.z = 0.25 + k * 0.3;
  legs[0].rotation.x = Math.sin(t * 2.6) * 0.25 + k * 0.5;
  legs[1].rotation.x = -Math.sin(t * 2.6) * 0.25 + k * 0.5;
  for (const w of rig.wobble) w.obj.position.x = w.x + Math.sin(t * 5) * 0.04 * (1 + k * 3);
  if (rig.tail) {
    rig.tail.rotation.y = Math.sin(t * 2.4) * 0.16 * (1 - Math.min(k, 1) * 0.5);
    rig.tail.rotation.x = -Math.min(k, 1) * 0.35;
  }
  const blink = t % 3.4 < 0.12;
  for (const e of rig.eyes) e.scale.y = e.userData.open * (blink ? 0.15 : 1);
  rig.flames.forEach((fm, i) => {
    fm.scale.set(1, 0.35 + k * 1.6 + Math.sin(t * 40 + i) * 0.12, 1);
  });
}

/** 뼈대가 만든 도형 · 재질을 지운다. 함께 쓰는 것(외곽선 재질 · 음영 맵)은 남긴다. */
export function disposeRig(rig) {
  const seen = new Set();
  rig.root.traverse((o) => {
    if (!o.isMesh) return;
    for (const res of [o.geometry, o.material]) {
      if (!res || res === outlineMat || seen.has(res)) continue;
      seen.add(res);
      res.dispose(); // 툰 재질의 gradientMap은 재질과 함께 지워지지 않는다(모두가 함께 쓴다)
    }
  });
  rig.root.parent?.remove(rig.root);
}
