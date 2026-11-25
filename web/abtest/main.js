// 비교 테스트 빌드의 시작점(universe.html). 실제 앱(web/src/main.js)을 그대로 띄우고, 테스트 흐름에 맞게 세 가지만 바꾼다.
//   1. 열리자마자 우주로 들어간다: 홈은 테스트 홈(spacelog-home.html)이 맡는다. 실제 앱의 홈은 안 보이게 두고 블랙홀 전환만 쓴다.
//   2. 왼쪽 패널의 "← 홈"은 테스트 홈으로 돌아간다.
//   3. 로그아웃(또는 회원 탈퇴)하면 테스트 홈으로 돌아간다.
// 서버 대신 쓰는 더미 데이터는 mockApi.js(vite.abtest.config.js가 api.js와 바꿔 끼운다).
import '../src/main.js';
import { store } from '../src/store.js';
import { enterWorld } from '../src/ui/transition.js';

const HOME = 'spacelog-home.html';

// 1. 열리면 바로 우주로(실제 앱의 홈 화면은 CSS로 숨겨 두었다). 데이터 · 장면 준비가 끝나기 전에는 enterWorld가
//    false를 돌려주므로, 들어갈 때까지 잠깐씩 다시 해 본다(10초까지)
//    블랙홀 흡입(1~3단계)은 테스트 홈이 이미 보여 줬다: 이 페이지는 잉크 막(#abtCover) 아래에서 그 단계를 건너뛰고(앱의 건너뛰기),
//    앱의 잉크 막이 준비 고리를 띄우는 4단계가 되면 #abtCover를 걷는다. 그 뒤 5단계(가운데 구멍으로 우주가 열림)는 앱 그대로
const cover = document.getElementById('abtCover');
function uncover() {
  cover?.remove();
  watch.disconnect();
}
const watch = new MutationObserver(() => {
  const veil = document.getElementById('veil');
  if (veil.classList.contains('waiting') || (store.state.inWorld && veil.hidden)) uncover();
});
watch.observe(document.getElementById('veil'), { attributes: true, attributeFilter: ['class', 'hidden'] });

let tries = 0;
async function goIn() {
  if (store.state.inWorld || ++tries > 50) {
    uncover();
    return;
  }
  if (!store.state.offline) {
    const entering = enterWorld({});
    dispatchEvent(new PointerEvent('pointerdown')); // 1~3단계 건너뛰기(transition.js의 requestSkip)
    if (await entering) return;
  }
  if (tries >= 50) uncover(); // 끝내 못 들어가면 막을 걷어 무엇이 문제인지 보이게
  setTimeout(goIn, 200);
}
setTimeout(goIn, 300);

// 2. "← 홈": 실제 앱의 홈 대신 테스트 홈으로. 앱의 처리(우주에서 나가기)보다 먼저 받는다
document.addEventListener(
  'click',
  (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('#goHome')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = HOME;
  },
  true,
);

// 3. 로그아웃 · 회원 탈퇴 → 테스트 홈(다시 열면 로그인한 상태로 시작한다)
store.on('authChange', ({ signedIn } = {}) => {
  if (!signedIn) setTimeout(() => (location.href = HOME), 600); // "로그아웃했어요"를 잠깐 보여 준다
});

// 뒤로 가기로 돌아왔을 때 예전 화면이 그대로 보이지 않게(홈에서 바꾼 것을 다시 읽는다)
addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});
