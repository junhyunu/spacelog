// 체험판: 로그인 없이 바로 시작한다. 앱(web/src/ui/account.js)이 가져올 때 읽는 데모 계정을 그보다 먼저 넣어 둔다.
// 그래서 web/demo/main.js 는 이 파일을 앱보다 먼저 가져온다(import 는 적힌 순서대로 실행된다).
// 비교 테스트 빌드와 달리 우주로 바로 들어가지 않는다: 앱의 홈 화면에서 시작한다.
export const DEMO_ACCOUNT_KEY = 'spacelog.demoAccount';
export const DEMO_ACCOUNT = { email: 'demo@spacelog.app', name: '체험' };

export function ensureDemoAccount({ force = false } = {}) {
  try {
    if (force || !localStorage.getItem(DEMO_ACCOUNT_KEY)) localStorage.setItem(DEMO_ACCOUNT_KEY, JSON.stringify(DEMO_ACCOUNT));
  } catch {
    /* 저장소를 못 쓰는 브라우저: 로그인 화면에서 아무 이메일로나 들어가면 된다 */
  }
}

ensureDemoAccount();
