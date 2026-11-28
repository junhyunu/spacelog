// 잠든 별 블랙홀 그림(캔버스 2D). 시안 ① 주황 원반: 기울어진 빛 원반 + 휘어 보이는 빛 고리 + 검은 구멍.
// 잠든 별 화면의 하늘(remind.js), 우주의 블랙홀 판(three/blackhole.js), 홈 안내의 작은 아이콘이 같이 쓴다.
// DOM · three 를 쓰지 않는다(그리기만).

const TAU = Math.PI * 2;

function rnd(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// 원반 위를 도는 빛 알갱이(반지름은 구멍 크기의 배수)
const DISK = (() => {
  const r = rnd(7);
  return Array.from({ length: 150 }, () => ({ r: 1.3 + r() * 2.3, a: r() * TAU, sp: 0.6 + r() * 0.8, z: 0.5 + r() }));
})();

function glow(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r1, 0, TAU);
  ctx.fill();
}

/** 그림이 차지하는 반지름(구멍 반지름 R 의 배수). 캔버스 크기를 정할 때 쓴다. */
export const BLACK_HOLE_REACH = 4.8;

/**
 * 블랙홀 하나를 그린다. (x, y) 가운데, R 구멍 반지름(px), t 초(원반이 돈다). R 이 너무 작으면 그리지 않는다.
 * 원반 뒤쪽 → 빛 고리 → 구멍 → 원반 앞쪽 순으로 그려 앞쪽 띠가 구멍 위를 지나간다.
 */
export function drawBlackHole(ctx, x, y, R, t = 0) {
  if (!(R >= 0.5)) return;
  ctx.save();
  glow(ctx, x, y, R * 0.9, R * BLACK_HOLE_REACH, [[0, 'rgba(255,170,90,.42)'], [0.35, 'rgba(255,120,50,.15)'], [1, 'rgba(255,90,30,0)']]);
  const tilt = 0.17;
  const disk = (front) => {
    for (let i = 0; i < 24; i += 1) {
      const f = i / 23;
      const r = R * (1.3 + f * 2.3);
      const hot = 1 - f;
      ctx.strokeStyle = `rgba(255,${Math.round(140 + 115 * hot)},${Math.round(60 + 180 * hot * hot)},${(0.06 + 0.42 * hot * hot).toFixed(3)})`;
      ctx.lineWidth = R * 0.12;
      ctx.beginPath();
      if (front) ctx.ellipse(x, y, r, r * tilt, 0, 0, Math.PI);
      else ctx.ellipse(x, y, r, r * tilt, 0, Math.PI, TAU);
      ctx.stroke();
    }
    for (const p of DISK) {
      const a = p.a + (t * p.sp) / Math.pow(p.r, 1.5);
      const s = Math.sin(a);
      if (s > 0 !== front) continue;
      const dop = 0.45 + 0.55 * (-Math.cos(a) * 0.5 + 0.5); // 다가오는 쪽(왼쪽)이 더 밝다
      ctx.fillStyle = `rgba(255,${Math.round(225 - p.r * 20)},${Math.round(190 - p.r * 30)},${(dop * 0.85).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * p.r * R, y + s * p.r * R * tilt, R * 0.07 * p.z, R * 0.025 * p.z, 0, 0, TAU);
      ctx.fill();
    }
  };
  ctx.globalCompositeOperation = 'lighter';
  disk(false);
  for (let k = 0; k < 9; k += 1) {
    ctx.strokeStyle = `rgba(255,${200 - k * 10},${150 - k * 12},${(0.32 - k * 0.032).toFixed(3)})`;
    ctx.lineWidth = R * 0.08;
    ctx.beginPath();
    ctx.arc(x, y, R * (1.06 + k * 0.065), 0, TAU);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,215,170,.35)';
  ctx.lineWidth = R * 0.3;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.3, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(x, y, R, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,245,225,.95)';
  ctx.lineWidth = R * 0.045;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.03, 0, TAU);
  ctx.stroke();
  disk(true);
  ctx.restore();
}

// 하늘의 작은 별들(0~1 좌표, 크기, 반짝임 위상)
const SKY = (() => {
  const r = rnd(3);
  return Array.from({ length: 110 }, () => [r(), r(), r() * 1.3 + 0.3, r()]);
})();

/** 잠든 별 화면의 깜깜한 하늘: 바탕을 칠하고 작은 별을 반짝이게 찍는다. */
export function drawSky(ctx, w, h, t = 0, base = '#05030d') {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (const [x, y, z, p] of SKY) {
    ctx.fillStyle = `rgba(230,225,255,${(0.25 + 0.35 * Math.abs(Math.sin(t * 0.6 + p * 9))).toFixed(3)})`;
    ctx.fillRect(x * w, y * h, z, z);
  }
}

/** 네 갈래 별(알림 끈 별이 하늘에 박힌 모양). */
export function drawStar4(ctx, x, y, s, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const r = i % 2 ? s * 0.32 : s;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

/** 하늘에 박힌 별 하나(반짝임 + 처음 0.45초는 크게 반짝였다 줄어든다). age 초, size 기본 크기(px). */
export function drawKeptStar(ctx, x, y, size, age, t) {
  const pop = age < 0.45 ? 1 + 1.6 * (1 - age / 0.45) : 1;
  const r = size * pop * (0.75 + 0.25 * Math.sin(t * 2.4 + x));
  glow(ctx, x, y, 0, r * 3.2, [[0, 'rgba(255,225,140,.55)'], [1, 'rgba(255,225,140,0)']]);
  drawStar4(ctx, x, y, r, '#ffe58a');
}
