// 체험판(서버 없는 빌드)의 시작점. vite.demo.config.js 가 web/index.html 의 /src/main.js 를 이것으로 바꾸고,
// web/src/api.js 를 web/demo/mockApi.js(브라우저 안 가짜 서버)로 바꿔 끼운다. 실제 앱 코드는 그대로 쓴다.
//   1. 데모 계정을 앱보다 먼저 넣는다(account.js) → 로그인 없이 앱의 홈 화면에서 시작
//   2. 앱을 띄운다(../src/main.js)
//   3. 화면 맨 위 안내 띠(닫을 수 없음) + "처음 상태로"(확인 창 → 저장소 비우기 → 새로 고침)
import { DEMO_ACCOUNT_KEY, ensureDemoAccount } from './account.js';
import '../src/main.js';
import { ask } from '../src/ui/confirm.js';
import { api } from './mockApi.js';
import { STATE_KEY } from './store.js';
import './demo.css';

export const BANNER_TEXT = '체험용 데모예요 · 입력한 내용은 이 브라우저에만 저장돼요';
export const BANNER_TEXT_SHORT = '체험판 · 이 브라우저에만 저장돼요'; // 400px 이하(demo.css가 둘 중 하나만 보인다): 띠를 한 줄로

function mountBanner() {
  const bar = document.createElement('div');
  bar.id = 'demoBar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', '체험판 안내');
  bar.innerHTML = '<div class="db-in"><span class="db-t"></span><button type="button" class="btn ghost sm" id="demoReset">처음 상태로</button></div>';
  const t = bar.querySelector('.db-t');
  for (const [cls, text] of [['db-long', BANNER_TEXT], ['db-short', BANNER_TEXT_SHORT]]) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    t.append(span);
  }
  document.body.prepend(bar);

  // 띠가 실제로 차지하는 높이(좁은 화면에서 두 줄이 되면 커진다)를 --demo-bar 로 알려 앱의 위쪽 부품을 그만큼 내린다(demo.css)
  const inner = bar.querySelector('.db-in');
  const measure = () => {
    const border = parseFloat(getComputedStyle(bar).borderBottomWidth) || 0;
    document.documentElement.style.setProperty('--demo-bar', `${Math.ceil(inner.offsetHeight + border)}px`);
  };
  measure();
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(inner);
  else addEventListener('resize', measure);
  document.fonts?.ready?.then(measure).catch(() => {});

  bar.querySelector('#demoReset').addEventListener('click', resetDemo);
}

let resetting = false;
async function resetDemo() {
  if (resetting) return;
  const ok = await ask({
    title: '처음 상태로 돌릴까요?',
    desc: '이 브라우저에 저장된 체험 내용이 모두 지워져요.',
    confirmLabel: '처음 상태로',
    confirmKind: 'pink',
  });
  if (!ok) return;
  resetting = true;
  try {
    await api.resetDemo(); // 체험 데이터(localStorage 상태 + IndexedDB 파일)를 비우고 다시 심는다
  } catch (err) {
    console.error('[demo] reset failed', err);
  }
  // 앱이 이 브라우저에 남긴 화면 설정(왼쪽 패널 · 말풍선 끔 · 마지막 행성 · 바꾼 이름)도 처음으로
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('spacelog.') && key !== STATE_KEY && key !== DEMO_ACCOUNT_KEY) localStorage.removeItem(key);
    }
  } catch {
    /* 저장소를 못 쓰면 건너뛴다 */
  }
  ensureDemoAccount({ force: true });
  location.reload();
}

// 앱이 api.js 를 거치지 않고 부르는 fetch('/api/…')(창을 닫는 순간의 메모 저장)를 가짜 서버로 돌린다.
// 체험판은 네트워크로 아무것도 보내지 않는다. 그 밖의 주소(서체 · blob: 미리보기 등)는 원래 fetch 그대로
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
  const path = url.startsWith(location.origin) ? url.slice(location.origin.length) : url;
  if (path.startsWith('/api/')) return api.demoFetch(path, init ?? {});
  return realFetch(input, init);
};

mountBanner();
