// 렌더러 · 배경 · 빛 · 툰 재질. 시안 390~429행을 옮겼다(수치 그대로).
// 불러올 때는 DOM을 건드리지 않는다. initScene()을 부를 때 캔버스를 만든다.
import * as THREE from 'three';

export const INK = 0x1a1430;
export const rand = (a, b) => a + Math.random() * (b - a);

/** initScene() 뒤에 채워진다. */
export let scene = null;
export let camera = null;
export let renderer = null;

/* ---------- 툰 재질 ---------- */
// 음영 3단계 맵 #5a5a5a / #b0b0b0 / #ffffff. 모든 툰 재질이 함께 쓴다(지우지 않는다).
let gradientMap = null;
function gradient() {
  if (gradientMap) return gradientMap;
  const c = document.createElement('canvas');
  c.width = 3;
  c.height = 1;
  const g = c.getContext('2d');
  ['#5a5a5a', '#b0b0b0', '#ffffff'].forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(i, 0, 1, 1);
  });
  gradientMap = new THREE.CanvasTexture(c);
  gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  return gradientMap;
}

/**
 * 3단 음영 툰 재질. opts는 MeshToonMaterial 옵션(emissive …).
 * r128의 툰 재질에는 flatShading이 없다(시안은 넘겼지만 경고만 나고 무시됐다). 넘기지 않는다.
 */
export function toon(color, opts = {}) {
  return new THREE.MeshToonMaterial(Object.assign({ color, gradientMap: gradient() }, opts));
}

/** 잉크 외곽선 재질. 모든 외곽선이 함께 쓴다(지우지 않는다). */
export const outlineMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

/** 메시에 뒤집힌 껍데기 외곽선을 붙이고 그 메시를 돌려준다. */
export function ol(mesh, scale = 1.08) {
  const o = new THREE.Mesh(mesh.geometry, outlineMat);
  o.scale.setScalar(scale);
  o.userData.outline = true;
  mesh.add(o);
  return mesh;
}

/** 툰 메시를 만들어 parent에 붙인다. s가 0이면 외곽선 없음. */
export function part(parent, geo, color, pos, scl, s = 1.08, matOpts) {
  const m = new THREE.Mesh(geo, toon(color, matOpts));
  if (pos) m.position.set(...pos);
  if (scl) m.scale.set(...scl);
  if (s) ol(m, s);
  parent.add(m);
  return m;
}

/* ---------- 배경 ---------- */
function blob(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, color);
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function glow(color) {
  return new THREE.Sprite(
    new THREE.SpriteMaterial({ map: blob(color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
}

function buildBackdrop() {
  // 먼 점별 1800개
  const N = 1800;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const pal = [
    [1, 1, 1],
    [1, 0.85, 0.5],
    [0.7, 0.85, 1],
    [1, 0.6, 0.8],
  ];
  const v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(400, 900));
    pos.set([v.x, v.y, v.z], i * 3);
    col.set(pal[i % 4], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, vertexColors: true, sizeAttenuation: false })));

  // 성운 4개
  [
    ['rgba(122,108,255,.55)', [-300, 120, -500], 520],
    ['rgba(255,93,143,.38)', [380, -80, -420], 460],
    ['rgba(94,200,255,.3)', [60, -220, 480], 560],
    ['rgba(255,210,63,.25)', [-420, -60, 260], 400],
  ].forEach(([c, p, s]) => {
    const sp = glow(c);
    sp.position.set(...p);
    sp.scale.set(s, s, 1);
    scene.add(sp);
  });

  // 툰 태양
  const sunG = new THREE.Group();
  sunG.position.set(160, 110, -260);
  scene.add(sunG);
  sunG.add(ol(new THREE.Mesh(new THREE.IcosahedronGeometry(22, 1), new THREE.MeshBasicMaterial({ color: 0xffd23f })), 1.06));
  const halo = glow('rgba(255,200,80,.7)');
  halo.scale.set(140, 140, 1);
  sunG.add(halo);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

/**
 * 렌더러 · 장면 · 카메라 · 배경 · 빛을 만들고 캔버스를 canvasParent에 붙인다.
 * 두 번째부터는 처음 만든 것을 그대로 돌려준다.
 */
export function initScene(canvasParent) {
  if (renderer) {
    if (canvasParent && renderer.domElement.parentNode !== canvasParent) canvasParent.appendChild(renderer.domElement);
    return { scene, camera, renderer };
  }
  const r = new THREE.WebGLRenderer({ antialias: true }); // WebGL을 못 쓰면 여기서 던진다
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  renderer = r;
  (canvasParent || document.body).appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15103a);
  camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 3000);

  scene.add(new THREE.HemisphereLight(0xcfd6ff, 0x3a2a6a, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.95);
  sun.position.set(40, 60, 30);
  scene.add(sun);

  buildBackdrop();
  addEventListener('resize', onResize);
  return { scene, camera, renderer };
}
