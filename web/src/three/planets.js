// 행성 · 별 · 이름표: 만들기, 지우기, DB 상태와 맞추기, 별 날아오기.
// 시안 467~524행(buildPlanet · addStar · label)과 749~768행(relabel · detachStar · moveRec)을 옮겼다.
import * as THREE from 'three';
import { PLANET_COLORS } from '../util.js';
import { slotPosition } from './slots.js';
import { initScene, ol, outlineMat, scene, toon } from './scene.js';

const V3 = THREE.Vector3;

/** 행성 기본 반지름. 기간 안의 별 1개마다 +3.5%, 반지름 6에서 멈춘다. */
export const BASE_RADIUS = 4.2;
export const MAX_RADIUS = 6;
const GROW_PER_STAR = 0.035;
/** 한 행성에 그리는 별의 최대 개수(최근 것부터). */
export const STARS_PER_PLANET = 50;
/** 기간 안의 별이 이보다 많으면 별을 그리지 않는다. */
export const STAR_CAP = 2000;

const WHITE = 0xffffff;
const CREAM = 0xfff3d6;
const YELLOW = 0xffd23f;
const PINK = 0xff5d8f;

/**
 * 행성 · 별 · 날아가는 별이 모두 들어가는 뿌리 그룹. 장면 원점에 그대로 놓이므로
 * 이 그룹 안의 좌표가 곧 월드 좌표다. 처음 syncUniverse() 때 장면에 붙는다.
 */
export const universe = new THREE.Group();

const planets = new Map(); // id → P
const stars = new Map(); // id → S
const flying = []; // { S, t, from }
let selectedId = null;
let guestId = null;
const warnedGuests = new Set(); // 찾지 못해 이미 경고한 재발견 별 id
let capMode = false;
let layoutVer = 0;

const key = (id) => String(id);

/* ---------- 함께 쓰는 자원(지우지 않는다) ---------- */
const starGeo = (() => {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const rr = i % 2 ? 0.23 : 0.55;
    if (i) s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 1 });
  g.center();
  return g;
})();
let starMat = null; // 노랑
let starMatOn = null; // 핑크(고른 별 · 기간 밖 재발견 별)
function starMats() {
  if (!starMat) {
    starMat = toon(YELLOW, { emissive: 0x4a3000 });
    starMatOn = toon(PINK, { emissive: 0x400010 });
  }
}

/** 이 모듈이 만든 도형 · 재질 · 텍스처를 지운다. 함께 쓰는 것은 건드리지 않는다. */
function dispose(root) {
  root.traverse((o) => {
    if (o.isSprite) {
      o.material.map?.dispose();
      o.material.dispose();
      return;
    }
    if (!o.isMesh) return;
    if (o.geometry !== starGeo) o.geometry.dispose();
    const m = o.material;
    if (m !== outlineMat && m !== starMat && m !== starMatOn) m.dispose(); // gradientMap은 함께 쓰므로 남긴다
  });
}

/* ---------- 장식 ---------- */
// 행성마다 같은 모습이 다시 나오도록 id에서 씨앗을 얻는다(새로고침해도 장식 자리가 같다).
function seededRand(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (lo, hi) => lo + next() * (hi - lo);
}

const mesh = (geo, color, outline = 1.12, opts) => ol(new THREE.Mesh(geo, toon(color, opts)), outline);

// r128의 MeshToonMaterial은 flatShading 옵션을 받지 않는다(경고만 내고 무시).
// 각진 면이 필요한 원기둥 · 원뿔 · 반구는 도형의 법선을 면마다 따로 계산해 로우폴리로 보이게 한다.
// (정이십면체 · 정팔면체 · 정십이면체는 detail 0이면 원래 각져 있다.)
function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.computeVertexNormals();
  return g;
}

/**
 * 장식 만드는 표. ctx = { spin, place(mesh, dir, height), r, dark, light, rand(lo, hi), scatter(n, fn(dir, i)) }.
 * scatter는 표면의 무작위 방향 n곳을 골라 fn을 부른다(깃발이 있는 북극은 비운다).
 * 모든 조각은 toon() 재질 + ol() 잉크 외곽선, 12~18개.
 */
export const DECO_BUILDERS = {
  // --- 시안 그대로 ---
  town({ place, scatter, dark, light, rand }) {
    scatter(16, (dir, i) => {
      const m = i % 3
        ? mesh(new THREE.BoxGeometry(0.9, rand(0.8, 1.8), 0.9), i % 2 ? CREAM : light)
        : mesh(new THREE.ConeGeometry(0.6, 1.6, 6), dark);
      place(m, dir, 0.3);
    });
  },
  crystal({ place, scatter, light, rand }) {
    scatter(14, (dir, i) => {
      const m = mesh(new THREE.OctahedronGeometry(0.6, 0), i % 2 ? WHITE : light, 1.14);
      m.scale.set(0.7, rand(1.6, 2.6), 0.7);
      place(m, dir, 0.6);
    });
  },
  forest({ place, scatter, dark }) {
    scatter(18, (dir, i) => {
      const g = new THREE.Group();
      const trunk = mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.7, 6), 0x8a5a3c, 1.2);
      trunk.position.y = 0.35;
      g.add(trunk);
      const top = mesh(new THREE.IcosahedronGeometry(0.6, 0), i % 3 ? dark : 0xd6ff8a, 1.12);
      top.position.y = 1.05;
      g.add(top);
      place(g, dir, 0);
    });
  },
  rock({ place, scatter, dark, rand }) {
    scatter(12, (dir, i) => {
      place(mesh(new THREE.DodecahedronGeometry(rand(0.35, 0.75), 0), i % 2 ? dark : WHITE, 1.12), dir, 0.1);
    });
  },

  // --- 스펙 6-6에서 새로 만든 것 ---
  // 얼음: 끝이 뾰족한 하늘색 · 흰색 기둥 2~3개 묶음
  ice({ place, scatter, rand }) {
    const SKY = 0x9fdcff;
    scatter(14, (dir, i) => {
      const g = new THREE.Group();
      const n = rand(0, 1) < 0.5 ? 2 : 3;
      for (let j = 0; j < n; j++) {
        const h = rand(1.1, 1.9) * (j ? 0.68 : 1);
        const rad = rand(0.2, 0.28);
        const color = (i + j) % 2 ? WHITE : SKY;
        const pillar = new THREE.Group();
        const shaft = mesh(flat(new THREE.CylinderGeometry(rad * 0.82, rad, h * 0.62, 6)), color, 1.12);
        shaft.position.y = h * 0.31;
        const tip = mesh(flat(new THREE.ConeGeometry(rad * 0.82, h * 0.38, 6)), color, 1.12);
        tip.position.y = h * 0.81;
        pillar.add(shaft, tip);
        if (j) {
          const side = j === 1 ? 1 : -1;
          pillar.position.set(side * 0.34, 0, rand(-0.18, 0.18));
          pillar.rotation.z = -side * rand(0.22, 0.4);
        }
        g.add(pillar);
      }
      place(g, dir, -0.05);
    });
  },
  // 화산: 어두운 원뿔대 + 꼭대기에 주황색 작은 덩어리
  volcano({ place, scatter, dark, rand }) {
    scatter(12, (dir) => {
      const g = new THREE.Group();
      const h = rand(0.9, 1.4);
      const cone = mesh(flat(new THREE.CylinderGeometry(0.34, 0.9, h, 7)), dark, 1.1);
      cone.position.y = h / 2;
      const lava = mesh(new THREE.DodecahedronGeometry(rand(0.26, 0.34), 0), 0xff8a2a, 1.14, { emissive: 0x5a1a00 });
      lava.position.y = h + 0.06;
      g.add(cone, lava);
      place(g, dir, -0.1);
    });
  },
  // 버섯: 흰 기둥 + 납작한 반구 갓(핑크 또는 밝은 톤)
  mushroom({ place, scatter, light, rand }) {
    scatter(16, (dir, i) => {
      const g = new THREE.Group();
      const h = rand(0.55, 0.95);
      const stem = mesh(new THREE.CylinderGeometry(0.15, 0.2, h, 7), WHITE, 1.16);
      stem.position.y = h / 2;
      const capR = rand(0.5, 0.72);
      const cap = mesh(flat(new THREE.SphereGeometry(capR, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2)), i % 2 ? PINK : light, 1.1);
      cap.scale.y = 0.7;
      cap.position.y = h - 0.05;
      // 갓 아래쪽을 막는 판(아래에서 봐도 속이 비어 보이지 않게)
      const under = new THREE.Mesh(new THREE.CircleGeometry(capR, 8), toon(CREAM));
      under.rotation.x = Math.PI / 2;
      under.position.y = h - 0.05;
      g.add(stem, cap, under);
      place(g, dir, -0.05);
    });
  },
  // 선인장: 초록 기둥 + 옆으로 난 짧은 팔 1~2개
  cactus({ place, scatter, rand }) {
    const GREEN = 0x4fc46a;
    scatter(14, (dir) => {
      const g = new THREE.Group();
      const turn = new THREE.Group(); // 팔 방향을 제각각으로
      turn.rotation.y = rand(0, Math.PI * 2);
      g.add(turn);
      const h = rand(1.1, 1.7);
      const body = mesh(flat(new THREE.CylinderGeometry(0.24, 0.26, h, 7)), GREEN, 1.12);
      body.position.y = h / 2;
      const top = mesh(new THREE.IcosahedronGeometry(0.25, 0), GREEN, 1.12);
      top.position.y = h;
      turn.add(body, top);
      const n = rand(0, 1) < 0.5 ? 1 : 2;
      for (let j = 0; j < n; j++) {
        const side = j ? -1 : 1;
        const y0 = h * (j ? 0.34 : 0.52);
        const out = mesh(flat(new THREE.CylinderGeometry(0.11, 0.11, 0.36, 6)), GREEN, 1.2);
        out.rotation.z = Math.PI / 2;
        out.position.set(side * 0.38, y0, 0);
        const upLen = rand(0.36, 0.56);
        const upArm = mesh(flat(new THREE.CylinderGeometry(0.1, 0.12, upLen, 6)), GREEN, 1.2);
        upArm.position.set(side * 0.52, y0 + upLen / 2 - 0.06, 0);
        turn.add(out, upArm);
      }
      place(g, dir, -0.05);
    });
  },
  // 꽃: 가는 줄기 + 꼭대기의 작은 각진 공(노랑 · 핑크 · 흰색 번갈아)
  flower({ place, scatter, dark, rand }) {
    const heads = [YELLOW, PINK, WHITE];
    scatter(18, (dir, i) => {
      const g = new THREE.Group();
      const h = rand(0.7, 1.2);
      const stem = mesh(new THREE.CylinderGeometry(0.05, 0.065, h, 5), dark, 1.4);
      stem.position.y = h / 2;
      const head = mesh(new THREE.IcosahedronGeometry(rand(0.26, 0.36), 0), heads[i % 3], 1.14);
      head.position.y = h + 0.12;
      g.add(stem, head);
      place(g, dir, -0.05);
    });
  },
  // 구름: 표면에서 조금 떠 있는 흰 각진 공 3개 덩어리
  cloud({ place, scatter, light, rand }) {
    const lumps = [
      [-0.55, 0, 0, 0.46],
      [0, 0.18, 0.05, 0.6],
      [0.55, -0.02, -0.05, 0.42],
    ];
    scatter(12, (dir, i) => {
      const g = new THREE.Group();
      const turn = new THREE.Group();
      turn.rotation.y = rand(0, Math.PI * 2);
      g.add(turn);
      lumps.forEach(([x, y, z, rad], j) => {
        const lump = mesh(new THREE.IcosahedronGeometry(rad * rand(0.9, 1.1), 0), j !== 1 && i % 3 === 0 ? light : WHITE, 1.1);
        lump.position.set(x, y, z);
        turn.add(lump);
      });
      place(g, dir, rand(0.9, 1.5));
    });
  },
};

/* ---------- 이름표 ---------- */
const NAME_FONT = '"Black Han Sans","Malgun Gothic",sans-serif';
const SUB_FONT = '600 38px "Pretendard Variable",Pretendard,"Malgun Gothic",sans-serif';

function drawLabel(P) {
  const c = P.label.userData.canvas;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 768, 200);
  g.textAlign = 'center';
  g.lineJoin = 'round';
  // 이름: 86px, 20자짜리 이름도 잘리지 않게 폭에 맞춰 줄인다
  let size = 86;
  g.font = `${size}px ${NAME_FONT}`;
  const w = g.measureText(P.name).width;
  if (w > 730) {
    size = Math.max(30, Math.floor((size * 730) / w));
    g.font = `${size}px ${NAME_FONT}`;
  }
  g.lineWidth = Math.max(8, Math.round((18 * size) / 86));
  g.strokeStyle = '#1a1430';
  g.strokeText(P.name, 384, 100);
  g.fillStyle = '#fff';
  g.fillText(P.name, 384, 100);
  if (P.sub) {
    g.font = SUB_FONT;
    g.lineWidth = 12;
    g.strokeText(P.sub, 384, 160, 740);
    g.fillStyle = P.css;
    g.fillText(P.sub, 384, 160, 740);
  }
  P.label.material.map.needsUpdate = true;
}

function makeLabel(P) {
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = 200;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  sp.userData.canvas = c;
  sp.scale.set(9, 2.35, 1);
  P.label = sp;
  P.group.add(sp);
  refreshLabel(P);
}

/** 이름표를 다시 그린다. 서체가 아직 안 왔으면 온 뒤에 한 번 더 그린다. */
function refreshLabel(P) {
  drawLabel(P);
  const fonts = globalThis.document?.fonts;
  if (!fonts?.load) return;
  const label = P.label;
  const text = P.labelKey;
  Promise.all([fonts.load(`86px ${NAME_FONT}`, P.name), fonts.load(SUB_FONT, P.sub || P.name)])
    .then(() => {
      if (P.label === label && P.labelKey === text && planets.get(P.id) === P) drawLabel(P);
    })
    .catch(() => {});
}

/* ---------- 행성 ---------- */
const UP = new V3(0, 1, 0);

function colorOf(index) {
  return (PLANET_COLORS[index] || PLANET_COLORS[1]).face;
}

function scaleFor(count) {
  const n = Number.isFinite(count) && count > 0 ? count : 0;
  return Math.min(1 + n * GROW_PER_STAR, MAX_RADIUS / BASE_RADIUS);
}

/** 행성의 겉모습(몸 · 장식 · 깃발 · 고리 · 이름표)을 만든다. 자리와 별은 건드리지 않는다. */
function buildLook(P) {
  const r = P.r;
  const col = new THREE.Color(P.css);
  const spin = new THREE.Group();
  spin.rotation.y = P.spinAngle;
  spin.scale.setScalar(P.scale);
  P.group.add(spin);
  P.spin = spin;

  const body = ol(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), toon(col.getHex())), 1.035);
  body.userData.planetId = P.id;
  spin.add(body);
  P.body = body;

  // 장식
  const dark = col.clone().multiplyScalar(0.72).getHex();
  const light = col.clone().lerp(new THREE.Color(0xffffff), 0.45).getHex();
  const rand = seededRand(`${P.id}:${P.deco}`);
  const place = (m, dir, h) => {
    m.position.copy(dir).multiplyScalar(r + h);
    m.quaternion.setFromUnitVectors(UP, dir);
    spin.add(m);
  };
  const scatter = (n, fn) => {
    for (let i = 0; i < n; i++) {
      const dir = new V3();
      // 북극은 깃발 자리라 비운다. 시안은 그 조각을 건너뛰었지만, 여기서는 다시 뽑아 n개를 채운다
      do dir.set(rand(-1, 1), rand(-1, 1), rand(-1, 1));
      while (dir.lengthSq() < 1e-6 || dir.normalize().y > 0.9);
      fn(dir, i);
    }
  };
  const build = Object.hasOwn(DECO_BUILDERS, P.deco) ? DECO_BUILDERS[P.deco] : DECO_BUILDERS.rock;
  build({ spin, place, r, dark, light, rand, scatter });

  // 북극의 핑크 깃발
  const pole = mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4, 8), WHITE, 1.2);
  pole.position.set(0, r + 1.1, 0);
  const flag = mesh(new THREE.BoxGeometry(1.3, 0.8, 0.06), PINK, 1.1);
  flag.position.set(0.68, r + 1.9, 0);
  spin.add(pole, flag);

  // 고리
  P.ringMesh = null;
  if (P.ring) {
    const ring = mesh(new THREE.TorusGeometry(r * 1.65, 0.28, 6, 56), 0xfff1a0, 1.08);
    ring.scale.set(P.scale, P.scale, 0.35 * P.scale);
    ring.rotation.set(1.25, 0, P.ringAngle);
    P.group.add(ring);
    P.ringMesh = ring;
  }

  makeLabel(P);
  P.label.position.set(0, r * P.scale + 4.3, 0);
}

function disposeLook(P) {
  P.spinAngle = P.spin.rotation.y;
  if (P.ringMesh) P.ringAngle = P.ringMesh.rotation.z;
  for (const o of [P.spin, P.ringMesh, P.label]) {
    if (!o) continue;
    P.group.remove(o);
    dispose(o);
  }
  P.spin = P.body = P.ringMesh = P.label = null;
}

function lookOf(d) {
  return { color_index: Number(d.color_index) || 1, deco: String(d.deco || 'rock'), ring: Boolean(d.ring) };
}

function labelOf(d) {
  const name = String(d.name ?? '');
  const sub = capMode ? `별 ${(Number(d.count_in_period) || 0).toLocaleString('en-US')}개` : String(d.description ?? '').trim();
  return { name, sub };
}

function createPlanet(d, count) {
  const look = lookOf(d);
  const text = labelOf(d);
  const P = {
    id: key(d.id),
    r: BASE_RADIUS,
    ...look,
    ...text,
    css: colorOf(look.color_index),
    labelKey: '',
    slot: d.slot,
    group: new THREE.Group(),
    spinAngle: 0,
    ringAngle: 0.3,
    targetScale: scaleFor(count),
    scale: scaleFor(count),
  };
  P.labelKey = `${P.name}\n${P.sub}`;
  P.group.position.set(...slotPosition(d.slot));
  P.group.userData.planetId = P.id;
  universe.add(P.group);
  planets.set(P.id, P);
  buildLook(P);
  return P;
}

function removePlanet(P) {
  for (const S of [...stars.values()]) if (S.planetId === P.id) removeStar(S);
  universe.remove(P.group);
  dispose(P.group);
  planets.delete(P.id);
}

/* ---------- 별 ---------- */
const orbitRadius = (P, S) => P.r * P.scale + S.extra;

function createStar(id, P, fromPos) {
  starMats();
  const pivot = new THREE.Group();
  pivot.rotation.set(THREE.MathUtils.randFloat(-0.7, 0.7), THREE.MathUtils.randFloat(0, 6.28), THREE.MathUtils.randFloat(-0.7, 0.7));
  P.group.add(pivot);
  const holder = new THREE.Group();
  holder.rotation.y = THREE.MathUtils.randFloat(0, 6.28);
  pivot.add(holder);
  const m = ol(new THREE.Mesh(starGeo, starMat), 1.16);
  m.userData = { starId: id, planetId: P.id };
  const S = {
    id,
    planetId: P.id,
    pivot,
    holder,
    mesh: m,
    extra: 2.4 + THREE.MathUtils.randFloat(0, 1.8), // 궤도 반지름 = 행성 반지름 + 2.4 ~ 4.2
    speed: THREE.MathUtils.randFloat(0.18, 0.38) * (Math.random() < 0.5 ? -1 : 1),
    spin: THREE.MathUtils.randFloat(1, 2.4),
  };
  stars.set(id, S);
  if (fromPos) launch(S, fromPos);
  else {
    holder.add(m);
    m.position.set(orbitRadius(P, S), 0, 0);
  }
  return S;
}

function launch(S, fromPos) {
  const entry = flying.find((F) => F.S === S);
  if (entry) {
    entry.t = 0;
    entry.from.copy(fromPos);
  } else {
    universe.add(S.mesh); // holder에서 빠진다
    flying.push({ S, t: 0, from: fromPos.clone() });
  }
  S.mesh.position.copy(fromPos);
  S.mesh.scale.setScalar(1);
}

function removeStar(S) {
  const fi = flying.findIndex((F) => F.S === S);
  if (fi >= 0) flying.splice(fi, 1);
  if (S.mesh.parent) S.mesh.parent.remove(S.mesh);
  if (S.pivot.parent) S.pivot.parent.remove(S.pivot);
  stars.delete(S.id);
  // 별 도형 · 재질 · 외곽선 재질은 모든 별이 함께 쓰므로 지우지 않는다
}

function paintStars() {
  starMats();
  for (const S of stars.values()) S.mesh.material = S.id === selectedId || S.id === guestId ? starMatOn : starMat;
}

function toV3(p) {
  if (!p) return null;
  if (p.isVector3) return p.clone();
  if (Array.isArray(p)) return new V3(p[0], p[1], p[2]);
  if (typeof p === 'object') return new V3(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
  return null;
}

/* ---------- 밖에서 부르는 것 ---------- */

/**
 * DB 상태와 3D를 맞춘다.
 * - planets: 지금 있는 모든 행성(count_in_period가 기간 안의 별 수)
 * - stars: 기간 안의 별, 최신순
 * - guestStarId: 기간 밖인데 잠시 보여 줄 별(재발견). stars에 없으면 guestStar로 그 별의 { id, planet_id }를 함께 준다.
 * 없는 것은 만들고 사라진 것은 지우며, 색 · 장식 · 고리가 바뀐 행성은 같은 자리에서 다시 만든다(별은 그대로).
 */
export function syncUniverse({ planets: planetList = [], stars: starList = [], guestStarId = null, guestStar = null } = {}) {
  if (!universe.parent) (scene || initScene(document.getElementById('stage')).scene).add(universe);

  // 행성별 기간 안의 별 수: 서버가 준 값을 쓰고, 없으면 목록에서 센다
  const counted = new Map();
  for (const s of starList) counted.set(key(s.planet_id), (counted.get(key(s.planet_id)) || 0) + 1);
  const countOf = (d) => (Number.isFinite(d.count_in_period) ? d.count_in_period : counted.get(key(d.id)) || 0);
  const totalInPeriod = Math.max(starList.length, planetList.reduce((a, d) => a + countOf(d), 0));
  capMode = totalInPeriod > STAR_CAP;
  guestId = guestStarId === null || guestStarId === undefined ? null : key(guestStarId);
  const hadSelected = selectedId !== null && stars.has(selectedId);

  // --- 행성 ---
  const seen = new Set();
  let moved = false;
  for (const d of planetList) {
    const id = key(d.id);
    seen.add(id);
    const count = countOf(d);
    let P = planets.get(id);
    if (!P) {
      createPlanet({ ...d, count_in_period: count }, count);
      moved = true;
      continue;
    }
    if (P.slot !== d.slot) {
      P.slot = d.slot;
      P.group.position.set(...slotPosition(d.slot));
      moved = true;
    }
    P.targetScale = scaleFor(count);
    const look = lookOf(d);
    const text = labelOf({ ...d, count_in_period: count });
    const labelKey = `${text.name}\n${text.sub}`;
    if (look.color_index !== P.color_index || look.deco !== P.deco || look.ring !== P.ring) {
      disposeLook(P);
      Object.assign(P, look, text, { css: colorOf(look.color_index), labelKey });
      buildLook(P);
    } else if (labelKey !== P.labelKey) {
      Object.assign(P, text, { labelKey });
      refreshLabel(P);
    }
  }
  for (const P of [...planets.values()]) {
    if (!seen.has(P.id)) {
      removePlanet(P);
      moved = true;
    }
  }
  if (moved) layoutVer += 1;

  // --- 별 ---
  const wanted = new Map(); // 별 id → 행성 id
  if (!capMode) {
    const drawn = new Map();
    for (const s of starList) {
      const pid = key(s.planet_id);
      if (!planets.has(pid)) continue;
      const n = drawn.get(pid) || 0;
      if (n >= STARS_PER_PLANET) continue;
      drawn.set(pid, n + 1);
      wanted.set(key(s.id), pid);
    }
  }
  if (guestId !== null) {
    const g = starList.find((s) => key(s.id) === guestId) || (guestStar && key(guestStar.id) === guestId ? guestStar : null);
    if (g && planets.has(key(g.planet_id))) wanted.set(guestId, key(g.planet_id));
    else if (!g && !warnedGuests.has(guestId)) {
      warnedGuests.add(guestId);
      console.warn(`[planets] guestStarId ${guestId}를 stars에서도 guestStar에서도 찾지 못해 그리지 않습니다.`);
    }
  }
  for (const S of [...stars.values()]) {
    const pid = wanted.get(S.id);
    if (pid === undefined) {
      removeStar(S);
    } else if (pid !== S.planetId) {
      // 다른 행성으로 옮겨졌다: 지금 있던 곳에서 새 행성 궤도로 날아간다
      const from = S.mesh.getWorldPosition(new V3());
      removeStar(S);
      createStar(S.id, planets.get(pid), from);
    }
  }
  for (const [id, pid] of wanted) if (!stars.has(id)) createStar(id, planets.get(pid), null);
  if (hadSelected && !stars.has(selectedId)) selectedId = null; // 고른 별이 사라졌다
  paintStars();
}

/**
 * 별이 fromWorldPos에서 솟았다가 자기 궤도로 들어간다(1.5초, 위로 7, 가운데서 1.8배).
 * 그 별이 그려져 있지 않으면(상한 초과 · 50개 밖) 아무것도 하지 않고 false.
 * fromWorldPos는 THREE.Vector3, [x, y, z], { x, y, z } 가운데 하나.
 */
export function flyStarIn(starId, fromWorldPos) {
  const S = stars.get(key(starId));
  const from = toV3(fromWorldPos);
  if (!S || !from) return false;
  launch(S, from);
  return true;
}

/** 행성의 뿌리 그룹(position이 행성 중심의 월드 좌표). 없으면 null. */
export function planetMesh(id) {
  return planets.get(key(id))?.group ?? null;
}

/** 별 메시. 월드 좌표는 getWorldPosition()으로 얻는다. 그려져 있지 않으면 null. */
export function starMesh(id) {
  return stars.get(key(id))?.mesh ?? null;
}

/** 고른 별만 핑크로 칠한다. null이면 해제. 아직 그려지지 않은 별이면 그려질 때 칠해진다. */
export function setSelectedStar(id) {
  selectedId = id === null || id === undefined ? null : key(id);
  paintStars();
}

/**
 * 행성 정보 { id, name, position(Vector3, 읽기만), radius(지금 보이는 반지름) }. 없으면 null.
 * out을 주면 새 객체를 만들지 않고 거기에 채워 돌려준다(프레임마다 부를 때).
 */
export function planetInfo(id, out) {
  const P = planets.get(key(id));
  if (!P) return null;
  const info = out || {};
  info.id = P.id;
  info.name = P.name;
  info.position = P.group.position;
  info.radius = P.r * P.scale;
  return info;
}

/** 그 행성이 지금 장면에 있는지. */
export function hasPlanet(id) {
  return planets.has(key(id));
}

/** 모든 행성에 대해 fn(id, position, radius, name)을 부른다. */
export function eachPlanet(fn) {
  for (const P of planets.values()) fn(P.id, P.group.position, P.r * P.scale, P.name);
}

/** 모든 행성의 자리 [[x, y, z], …]. overviewDistance()에 넣는다. */
export function planetPositions() {
  return [...planets.values()].map((P) => P.group.position.toArray());
}

/** 행성이 생기거나 사라지거나 자리가 바뀔 때마다 늘어나는 번호. */
export function layoutVersion() {
  return layoutVer;
}

/** 그 별이 도는 행성의 id. 그려져 있지 않으면 null. */
export function starPlanetId(starId) {
  return stars.get(key(starId))?.planetId ?? null;
}

/** 클릭으로 고를 수 있는 메시들. userData가 { starId, planetId } 또는 { planetId }. */
export function pickTargets() {
  const list = [];
  for (const S of stars.values()) list.push(S.mesh);
  for (const P of planets.values()) list.push(P.body);
  return list;
}

const tgt = new V3();
const mid = new V3();
const pa = new V3();
const pb = new V3();

/** 매 프레임: 자전, 크기 보간(약 0.3초), 고리 · 별 공전, 날아가는 별. */
export function updateUniverse(dt) {
  for (const P of planets.values()) {
    P.spin.rotation.y += dt * 0.06;
    P.scale += (P.targetScale - P.scale) * Math.min(1, dt * 3);
    P.spin.scale.setScalar(P.scale);
    if (P.ringMesh) {
      P.ringMesh.rotation.z += dt * 0.05;
      P.ringMesh.scale.set(P.scale, P.scale, 0.35 * P.scale);
    }
    P.label.position.y = P.r * P.scale + 4.3;
  }
  for (const S of stars.values()) {
    S.holder.rotation.y += S.speed * dt;
    S.mesh.rotation.y += S.spin * dt;
    if (S.mesh.parent === S.holder) S.mesh.position.x = orbitRadius(planets.get(S.planetId), S);
  }
  for (let i = flying.length - 1; i >= 0; i--) {
    const F = flying[i];
    const S = F.S;
    const R = orbitRadius(planets.get(S.planetId), S);
    F.t += dt / 1.5;
    const e = F.t < 0.5 ? 2 * F.t * F.t : 1 - Math.pow(-2 * F.t + 2, 2) / 2;
    S.holder.updateWorldMatrix(true, false);
    S.holder.localToWorld(tgt.set(R, 0, 0));
    mid.copy(F.from).lerp(tgt, 0.5);
    mid.y += 7;
    pa.copy(F.from).lerp(mid, e);
    pb.copy(mid).lerp(tgt, e);
    S.mesh.position.copy(pa.lerp(pb, e));
    S.mesh.scale.setScalar(1 + Math.sin(Math.min(F.t, 1) * Math.PI) * 0.8);
    S.mesh.rotation.y += dt * 8;
    if (F.t >= 1) {
      S.holder.add(S.mesh);
      S.mesh.position.set(R, 0, 0);
      S.mesh.scale.setScalar(1);
      flying.splice(i, 1);
    }
  }
}
