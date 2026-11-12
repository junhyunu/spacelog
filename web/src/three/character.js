// 플레이어 캐릭터(2등신, 6종)와 대기 · 비행 움직임. 우주인은 시안 431~465행, 움직임은 904~918행을 옮겼다.
// 모습은 characters/builders.js가 만들고(스펙 6-10), 여기서는 플레이어의 자리 · 방향 · 연기만 다룬다.
import * as THREE from 'three';
import { DEFAULT_LOOK, normalizeLook, resolveLook, sameLook } from '../ui/characterLogic.js';
import { CHARACTER_BUILDERS, buildRig } from './characters/builders.js';
import { animateRig, disposeRig } from './characters/kit.js';
import { outlineMat, rand } from './scene.js';

export { CHARACTER_BUILDERS };

/** 캐릭터의 뿌리 그룹. 위치가 곧 플레이어 위치다. */
export const player = new THREE.Group();
player.position.set(0, 0, 10);

let built = false;
let look = { ...DEFAULT_LOOK };
let rig = null; // 지금 모습의 뼈대(kit.js의 약속)
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
  rig = buildRig(look);
  player.add(rig.root);

  // 연기 방울 40개를 돌려 쓴다(색은 불꽃 안쪽 색)
  const puffGeo = new THREE.SphereGeometry(0.16, 8, 6);
  const color = resolveLook(look).flameInner;
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    m.visible = false;
    scene.add(m);
    puffs.push({ m, life: 0 });
  }
  return player;
}

/** 지금 캐릭터의 모습 { kind, suit, accent, flame }. */
export function characterLook() {
  return { ...look };
}

/**
 * 캐릭터의 모습을 바꾼다(스펙 6-10). 그 자리에서 메시만 다시 만든다:
 * 위치 · 속도 · 비행 상태 · 카메라는 건드리지 않고, 바라보던 방향과 숙인 정도도 이어받는다.
 * 아직 우주를 만들기 전이면 적어만 두고, initCharacter()가 그 모습으로 만든다.
 */
export function setCharacterLook(next) {
  const wanted = normalizeLook(next);
  if (sameLook(wanted, look)) return;
  look = wanted;
  if (!built) return;
  const old = rig;
  rig = buildRig(look);
  rig.root.rotation.y = old.root.rotation.y;
  rig.lean.rotation.copy(old.lean.rotation);
  rig.lean.position.copy(old.lean.position);
  player.add(rig.root);
  disposeRig(old); // 바꾼 도형 · 재질만 지운다(외곽선 재질 · 음영 맵은 함께 쓴다)
  const color = resolveLook(look).flameInner;
  puffs.forEach((p) => p.m.material.color.set(color));
}

/**
 * 꾸미기 창 미리보기 · 개발용 화면에 쓸 독립된 캐릭터 그룹(앞은 +z).
 * 플레이어 · 본 장면과 아무것도 나눠 쓰지 않는다(외곽선 재질 · 음영 맵도 따로 복사한다):
 * 다른 렌더러에 그렸다가 통째로 지워도 본 장면에 흔적이 남지 않는다.
 *   group.userData.rig        뼈대(animateCharacterPreview가 쓴다)
 *   group.userData.dispose()  만든 것을 모두 지운다
 */
export function buildCharacterPreview(next) {
  const r = buildRig(next);
  const ink = outlineMat.clone();
  let ramp = null;
  r.root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material === outlineMat) o.material = ink;
    else if (o.material.gradientMap) {
      if (!ramp) {
        ramp = o.material.gradientMap.clone();
        ramp.needsUpdate = true;
      }
      o.material.gradientMap = ramp;
    }
  });
  const group = r.root;
  group.userData.rig = r;
  group.userData.dispose = () => {
    disposeRig(r);
    ink.dispose();
    ramp?.dispose();
  };
  return group;
}

/** 미리보기 캐릭터의 대기 · 비행 움직임. k = 0(대기) ~ 1(가장 빠름). */
export function animateCharacterPreview(group, dt, t, k = 0) {
  if (group?.userData.rig) animateRig(group.userData.rig, dt, t, k);
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
    let dy = ty - rig.root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    rig.root.rotation.y += dy * (1 - Math.exp(-8 * dt));
  }
  animateRig(rig, dt, t, k);
  if (k > 0.25 && Math.random() < k * 0.9) {
    const p = puffs[puffIdx++ % puffs.length];
    p.life = 1;
    p.m.visible = true;
    p.m.position.copy(rig.flames[Math.random() < 0.5 ? 0 : 2].getWorldPosition(tmp));
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
