// 로그인 · 회원가입 · 계정 설정. 서버에 계정 기능이 아직 없어서 화면만 보여 준다(화면은 배포된 서비스처럼 쓴다).
// - 로그인: 아무 이메일 · 비밀번호로 들어간다. 상태는 이 브라우저(localStorage)에만 남는다.
// - 회원가입: 로그인 창이 같은 자리에서 모드를 바꾼다(이름 · 비밀번호 확인 칸이 더 보인다). 칸만 검사하고 바로 들어간다.
// - Google 계정으로 계속하기: 구글 창을 띄우지 않고 바로 들어간다(보여 주기용 계정).
// - 비밀번호를 잊으셨나요?: 아직 준비 중이라고만 알린다.
// - 계정 설정: 우주선장 이름은 실제로 바뀐다(이 브라우저에서). 비밀번호 변경 · 회원 탈퇴는 확인 문구만 보여 준다.
// - 로그인 전에는 body.signed-out: 기록과 관련된 것을 숨긴다(account.css).
//
// store에서 듣는 것: 'openLogin' · 'openAccount' · 'signOut'
// store로 알리는 것: 'authChange' { signedIn }  (main.js가 홈을 다시 그리거나 우주에서 나간다)
import { store } from '../store.js';
import { setInputBlocked } from '../three/controls.js';
import { ask } from './confirm.js';
import { registerEscape } from './escape.js';
import { trapTab, wireBackdrop } from './planetForm.js';
import { openRemindSettings, remindSettingsBack, saveRemindSettingsChoice } from './remindSettings.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const KEY = 'spacelog.demoAccount';
const NAME_MAX = 20;
const PW_MIN = 8;

let account = read(); // { email, name } | null
let open = null; // 'login' | 'account' | null
let mode = 'login'; // 로그인 창의 모드: 'login' | 'signup'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_DEMO_EMAIL = 'google-user@gmail.com';
let prevFocus = null;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v.email === 'string' ? { email: v.email, name: String(v.name || '우주선장') } : null;
  } catch {
    return null;
  }
}

function write() {
  try {
    if (account) localStorage.setItem(KEY, JSON.stringify(account));
    else localStorage.removeItem(KEY);
  } catch {
    // 저장소를 못 쓰면 이번 탭에서만 유지된다
  }
}

/** 로그인했는지. */
export function isSignedIn() {
  return account !== null;
}

/** 로그인 · 계정 설정 창이 떠 있는지. */
export function isAccountOpen() {
  return open !== null;
}

/** 보이는 이름(로그인 전이면 빈 글). */
export function accountName() {
  return account?.name ?? '';
}

function paint() {
  document.body.classList.toggle('signed-out', !account);
  $('wMeName').textContent = account ? `${account.name}님` : '';
  $('wMeEmail').textContent = account?.email ?? '';
  $('hMeName').textContent = $('wMeName').textContent; // 홈의 사람 아이콘 메뉴도 같은 글
  $('hMeEmail').textContent = $('wMeEmail').textContent;
  if (account) $('hLoginHint').hidden = true;
}

function setAccount(next) {
  account = next;
  write();
  paint();
  store.emit('authChange', { signedIn: Boolean(account) });
}

/* ---------- 창 열고 닫기 ---------- */
function boxOf(which) {
  return which === 'login' ? $('loginForm') : $('accountForm');
}

function showError(which, msg) {
  const el = which === 'login' ? $('lgErr') : $('acErr');
  el.textContent = msg;
  el.hidden = !msg;
}

function openDialog(which) {
  if (open) closeDialog();
  open = which;
  prevFocus = document.activeElement;
  showError(which, '');
  boxOf(which).hidden = false;
  if (which === 'login') {
    for (const id of ['lgName', 'lgEmail', 'lgPw', 'lgPw2']) $(id).value = '';
    setMode('login');
    $('lgEmail').focus();
  } else {
    $('acName').value = account?.name ?? '';
    $('acEmail').textContent = account?.email ?? '';
    for (const id of ['acPwNow', 'acPwNew', 'acPwNew2']) $(id).value = '';
    openRemindSettings(); // 잠든 별 블랙홀 칸(기간 · 알림 끈 별)
    boxOf(which).querySelector('.card').scrollTop = 0;
    $('acName').focus();
  }
}

function closeDialog() {
  if (!open) return;
  boxOf(open).hidden = true;
  open = null;
  if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus) && !prevFocus.closest('[hidden]')) {
    prevFocus.focus({ preventScroll: true });
  }
  prevFocus = null;
}

/* ---------- 로그인 · 회원가입 ---------- */
// 같은 창에서 모드만 바꾼다: 제목 · 확정 버튼 · 아래 한 줄이 바뀌고, 가입일 때만 이름 · 비밀번호 확인 칸이 보인다.
// 적어 둔 이메일 · 비밀번호는 남긴다(잘못 들어왔다가 돌아가도 다시 쓰지 않게)
function setMode(next) {
  mode = next;
  const up = mode === 'signup';
  $('lgTitle').textContent = up ? '회원가입' : '로그인';
  $('lgYes').textContent = up ? '가입하기' : '로그인';
  $('lgNameFld').hidden = !up;
  $('lgPw2Fld').hidden = !up;
  $('lgForgot').hidden = up;
  $('lgPw').autocomplete = up ? 'new-password' : 'current-password';
  $('lgSwitchText').textContent = up ? '이미 계정이 있나요?' : '처음이신가요?';
  $('lgSwitch').textContent = up ? '로그인' : '회원가입';
  showError('login', '');
}

function enter(next) {
  closeDialog();
  setAccount(next);
  toast(`${account.name}님, 반가워요`);
}

function onLogin(e) {
  e.preventDefault();
  const up = mode === 'signup';
  const name = $('lgName').value.trim();
  const email = $('lgEmail').value.trim();
  const pw = $('lgPw').value;
  if (up && !name) return showError('login', '우주선장 이름을 적어 주세요');
  if (up && [...name].length > NAME_MAX) return showError('login', `이름은 ${NAME_MAX}자까지 쓸 수 있어요`);
  if (!email) return showError('login', '이메일을 적어 주세요');
  if (!EMAIL_RE.test(email)) return showError('login', '이메일 모양이 아니에요. 예: name@example.com');
  if (!pw) return showError('login', '비밀번호를 적어 주세요');
  if (up && [...pw].length < PW_MIN) return showError('login', `비밀번호는 ${PW_MIN}자 이상이어야 해요`);
  if (up && pw !== $('lgPw2').value) return showError('login', '비밀번호 두 칸이 서로 달라요');
  return enter({ email, name: up ? name : account?.name || '우주선장' });
}

// 보여 주기용: 구글 창을 띄우지 않고 바로 들어간다
function onGoogle() {
  enter({ email: GOOGLE_DEMO_EMAIL, name: account?.name || '우주선장' });
}

/* ---------- 계정 설정 ---------- */
function onSaveAccount(e) {
  e.preventDefault();
  const name = $('acName').value.trim();
  if (!name) return showError('account', '이름을 적어 주세요');
  if ([...name].length > NAME_MAX) return showError('account', `이름은 ${NAME_MAX}자까지 쓸 수 있어요`);

  const now = $('acPwNow').value;
  const next = $('acPwNew').value;
  const again = $('acPwNew2').value;
  const changingPw = Boolean(now || next || again);
  if (changingPw) {
    if (!now) return showError('account', '지금 비밀번호를 적어 주세요');
    if ([...next].length < PW_MIN) return showError('account', `새 비밀번호는 ${PW_MIN}자 이상이어야 해요`);
    if (next !== again) return showError('account', '새 비밀번호 두 칸이 서로 달라요');
    if (next === now) return showError('account', '지금 비밀번호와 다른 비밀번호를 적어 주세요');
  }

  closeDialog();
  setAccount({ ...account, name });
  saveRemindSettingsChoice(); // 잠든 별 기간이 바뀌었으면 저장(실패하면 따로 알린다)
  toast(changingPw ? '저장했어요. 비밀번호도 바꿨어요(시연용)' : '저장했어요');
}

async function onLeave() {
  closeDialog();
  const ok = await ask({
    title: '회원 탈퇴할까요?',
    desc: '모든 별과 행성이 지워지고 되돌릴 수 없어요. (시연용이라 실제로는 지우지 않고 로그아웃만 해요)',
    confirmLabel: '탈퇴하기',
  });
  if (!ok) return;
  setAccount(null);
  toast('탈퇴했어요(시연용)');
}

function signOut() {
  if (!account) return;
  setAccount(null);
  toast('로그아웃했어요');
}

/* ---------- 시작 ---------- */
let ready = false;

/** 로그인 상태를 화면에 반영하고 두 창을 준비한다(한 번만). */
export function initAccount() {
  if (ready) return;
  ready = true;
  paint();

  $('lgForm').addEventListener('submit', onLogin);
  $('lgX').addEventListener('click', closeDialog);
  $('lgNo').addEventListener('click', closeDialog);
  $('lgGoogle').addEventListener('click', onGoogle);
  $('lgForgot').addEventListener('click', () => toast('비밀번호 찾기는 아직 준비 중이에요'));
  $('lgSwitch').addEventListener('click', () => {
    setMode(mode === 'signup' ? 'login' : 'signup');
    (mode === 'signup' ? $('lgName') : $('lgEmail')).focus();
  });
  $('acForm').addEventListener('submit', onSaveAccount);
  $('acX').addEventListener('click', closeDialog);
  $('acNo').addEventListener('click', closeDialog);
  $('acLeave').addEventListener('click', onLeave);
  for (const which of ['login', 'account']) {
    const box = boxOf(which);
    wireBackdrop(box, closeDialog);
    box.addEventListener('keydown', (e) => trapTab(box, e));
  }

  store.on('openLogin', () => openDialog('login'));
  store.on('openAccount', () => {
    if (account) openDialog('account');
  });
  store.on('signOut', signOut);
}

// Esc = 닫기(행성 꾸미기 창과 같은 자리). 열려 있는 동안 비행 키를 막는다.
registerEscape(70, () => {
  if (!open) return false;
  if (open === 'account' && remindSettingsBack()) return true; // 알림 끈 별 전체 목록이면 설정으로 돌아간다
  closeDialog();
  return true;
});
setInputBlocked(() => open !== null);
