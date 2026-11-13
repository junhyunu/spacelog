// 챗봇 창(#chatPanel, 2차 스펙 7장): 버튼 위로 열리는 카드(380px, 최대 75vh), 760px 이하 전체 화면.
// 탭 3개(홈 · 대화 · 설정), 처음 켜기 확인(행성 고르기), 쓸 수 없을 때 문구, 읽지 않음(빨간 점) 확인.
//
// 쌓임: 행성 패널(#panel)과 같은 층. 나중에 연 것이 위다 — 챗봇 창이 열린 뒤 행성 패널이 열리면 data-back을 붙여
//   #panel 아래로 내린다(chat.css). 확인 · 저장 · 꾸미기 창보다는 늘 아래.
// Esc 25: 창을 닫는다(escape.js 순서). 비행 키는 창이 열려 있어도 막지 않는다. 입력칸의 글쓰기는 controls.js가
//   원래 무시하고(typing), 창 안 버튼의 Space · 화살표는 여기서 전파를 끊어 버튼 누르기 · 탭 옮기기로 쓴다.
//
// store에서 듣는 것: 'data'(행성 목록이 바뀌면 열린 탭을 다시 그린다), 'enterWorld' · 'leaveWorld'(홈 탭의 바로 묻기),
//   'reachable'(다시 연결되면 읽지 않음 확인). 알리는 것: 'openSave' { text }(chatThread.js), 'openStar'(hud.js의 flyToStar)
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, ico, PLANET_COLORS } from '../util.js';
import { initChatButton } from './chatButton.js';
import { contextFor, errorMessage, failedLine, indexLine, quickQuestions, relativeTime, unavailableMessage } from './chatLogic.js';
import { leaveThread, openThread, refreshThreadInput, threadConversationId, threadRunning } from './chatThread.js';
import { ask } from './confirm.js';
import { registerEscape } from './escape.js';
import { flyToStar } from './hud.js';
import { toast } from './toast.js';
import { enterWorld } from './transition.js';

const $ = (id) => document.getElementById(id);
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false };
const POLL_MS = 30_000;
const INDEX_POLL_MS = 2_000;
const RUN_POLL_MS = 3_000; // 보던 답을 두고 닫았을 때: 끝나는 대로 빨간 점을 켜려고 짧게 확인한다
const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const faceOf = (p) => PLANET_COLORS[p?.color_index]?.face ?? '#7a6cff';

const NOTICE = '챗봇을 켜면 질문에 필요한 기록 내용이 OpenAI로 보내져요.';
const PRIVACY =
  '파일과 기록은 내 PC에 있고, 챗봇을 켜면 질문에 필요한 내용과 색인할 내용만 OpenAI로 보내져요. 빼 둔 행성의 별은 읽지 않아요.';
const HISTORY_NOTE = '행성을 빼도, 그 전에 같은 대화에서 나눈 내용은 이어 묻기에 쓰일 수 있어요. 새 대화를 시작하면 쓰이지 않아요.';

let btn = null;
let open = false;
let view = 'home'; // 'consent' | 'home' | 'list' | 'settings' | 'thread'
let tab = 'home'; // 아래 탭에서 선택된 것(대화 화면은 'list')
let settings = null; // GET /api/chat/settings
let convs = [];
let unreadCount = 0;
let threadId = null; // 대화 화면에서 연 대화(null = 빈 새 대화)
let loadSeq = 0;
let pollTimer = 0;
let indexTimer = 0;
let saving = false;
let runTimer = 0;

/* ---------- 상태 ---------- */
function blockReason() {
  if (!settings) return '챗봇 상태를 확인하지 못했어요. 잠시 뒤에 다시 열어 주세요';
  if (!settings.enabled) return errorMessage('chat_off');
  return unavailableMessage({ rag: settings.rag, key: settings.key });
}

async function loadSettings() {
  try {
    settings = await api.chatSettings();
  } catch (err) {
    if (err?.code !== 'offline') toast('챗봇 설정을 불러오지 못했어요. 다시 열어 주세요');
    return false;
  }
  return true;
}

async function loadConvs() {
  try {
    convs = await api.conversations();
  } catch {
    return false;
  }
  unreadCount = convs.filter((c) => c.unread).length;
  paintUnread();
  return true;
}

/* ---------- 읽지 않음 ---------- */
function paintUnread() {
  const on = unreadCount > 0;
  btn?.setUnread(on);
  const tabDot = $('chatPanel')?.querySelector('[data-tab="list"] .dot');
  if (tabDot) tabDot.hidden = !on;
}

async function refreshUnread() {
  if (store.state.offline) return;
  try {
    const r = await api.unread();
    unreadCount = Number(r?.count) || 0;
    paintUnread();
  } catch {
    /* 연결 끊김은 api.js가 알린다 */
  }
}

// 만들던 답을 두고 창을 닫으면 그 답이 끝날 때까지 3초마다 목록을 보고, 끝나면 읽지 않음을 다시 받는다.
function watchRunning() {
  clearTimeout(runTimer);
  runTimer = setTimeout(async () => {
    if (open && view === 'thread' && threadRunning()) return; // 다시 열어 그 답을 보고 있다(끝나면 그쪽이 다시 받는다)
    let list;
    try {
      list = await api.conversations();
    } catch {
      return;
    }
    if (list.some((c) => c.running)) {
      watchRunning();
      return;
    }
    convs = list;
    unreadCount = list.filter((c) => c.unread).length;
    paintUnread();
    if (!open || panel().contains(document.activeElement)) return; // 누르던 자리를 지키려고 목록은 다음에 그린다
    if (view === 'list') renderList(panel().querySelector('.cp-body'));
    else if (view === 'home') renderHome(panel().querySelector('.cp-body'));
  }, RUN_POLL_MS);
}

// 창이 닫혀 있거나 대화 화면이 아닐 때만 30초마다. 탭이 숨겨져 있으면 멈춘다.
function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = 0;
  if (document.hidden) return;
  pollTimer = setInterval(() => {
    if (open && view === 'thread') return;
    refreshUnread();
  }, POLL_MS);
}

/* ---------- 창 열기 · 닫기 ---------- */
function panel() {
  return $('chatPanel');
}

function bringFront() {
  panel().removeAttribute('data-back');
}

export function isChatOpen() {
  return open;
}

export async function openChat() {
  if (open) return;
  open = true;
  const el = panel();
  bringFront();
  el.hidden = false;
  btn.setOpen(true);
  paintShell();
  const seq = ++loadSeq;
  el.querySelector('.cp-body').innerHTML = '<p class="cp-wait">불러오는 중…</p>';
  const ok = await loadSettings();
  if (seq !== loadSeq || !open) return;
  if (!ok) {
    closeChat();
    return;
  }
  if (!settings.consented || !settings.enabled) {
    show('consent');
    return;
  }
  await loadConvs();
  if (seq !== loadSeq || !open) return;
  if (view === 'thread') show('thread', { id: threadId });
  else show(view === 'consent' ? 'home' : view);
}

export function closeChat({ focus = true } = {}) {
  if (!open) return;
  open = false;
  loadSeq += 1;
  clearTimeout(indexTimer);
  const wasRunning = threadRunning();
  leaveThread(); // 흘려 받기를 끊는다: 이제 끝나는 답은 읽지 않음이 된다
  if (wasRunning) watchRunning();
  const el = panel();
  const had = el.contains(document.activeElement);
  el.hidden = true;
  btn.setOpen(false);
  if (had && focus) btn.el.focus({ preventScroll: true });
  else if (had) document.activeElement.blur();
}

function toggle() {
  // 행성 패널 아래로 내려가 있으면 닫지 않고 다시 위로
  if (open && panel().hasAttribute('data-back')) {
    bringFront();
    panel().querySelector('.cp-body')?.focus?.({ preventScroll: true });
    return;
  }
  if (open) closeChat();
  else openChat();
}

/* ---------- 틀(머리 · 몸 · 탭) ---------- */
function build() {
  const el = panel();
  el.innerHTML =
    '<header class="cp-head"></header>' +
    '<div class="cp-body" id="chatBody" role="tabpanel"></div>' +
    '<nav class="cp-tabs" role="tablist" aria-label="챗봇 메뉴">' +
    tabBtn('home', 'house', '홈') +
    tabBtn('list', 'messages-square', '대화', true) +
    tabBtn('settings', 'settings', '설정') +
    '</nav>' +
    `<button type="button" class="btn ghost x cp-x" aria-label="챗봇 닫기">${ico('x')}</button>`;
  el.querySelector('.cp-x').addEventListener('click', () => closeChat());
  // 홈 · 대화 탭의 대화 열기 · 새 대화 · 지우기(몸은 그대로 두고 안만 바꿔 그리므로 한 번만 단다)
  el.querySelector('.cp-body').addEventListener('click', (e) => {
    if (view === 'home' || view === 'list') onConvClick(e);
  });
  const tabs = el.querySelector('.cp-tabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-tab]') : null;
    if (b) show(b.dataset.tab);
  });
  // 탭: 화살표로 옮긴다(로빙 tabindex)
  tabs.addEventListener('keydown', (e) => {
    const list = [...tabs.querySelectorAll('[data-tab]')];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    if (j < 0) return;
    e.preventDefault();
    list[j].focus();
    show(list[j].dataset.tab);
  });
  // 창 안 버튼 · 체크박스의 Space · 화살표는 비행 키로 넘기지 않는다(controls.js는 window에서 받는다)
  el.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox') return;
    if (e.code === 'Space' || e.key.startsWith('Arrow')) e.stopPropagation();
  });
  el.addEventListener('pointerdown', () => {
    // 행성 패널 아래로 내려가 있던 창을 누르면 다시 위로
    if (el.hasAttribute('data-back')) bringFront();
  });
}

function tabBtn(id, icon, label, dot = false) {
  return (
    `<button type="button" role="tab" data-tab="${id}" aria-controls="chatBody" aria-selected="false" tabindex="-1">` +
    `${ico(icon, 18)}<span>${label}</span>${dot ? '<span class="dot" aria-label="읽지 않은 답 있음" hidden></span>' : ''}</button>`
  );
}

function paintShell() {
  const el = panel();
  const tabs = el.querySelector('.cp-tabs');
  tabs.hidden = view === 'consent';
  for (const b of tabs.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle('on', on);
  }
  paintUnread();
}

function setHead(title) {
  const head = panel().querySelector('.cp-head');
  head.innerHTML = '<h2 class="ct-title"></h2>';
  head.firstChild.textContent = title;
}

/** 화면을 바꾼다. */
function show(next, { id, question } = {}) {
  if (threadRunning()) watchRunning(); // 다른 화면으로 가면 그 답은 아무도 보지 않는다
  leaveThread();
  clearTimeout(indexTimer);
  view = next;
  tab = next === 'thread' ? 'list' : next === 'consent' ? tab : next;
  const el = panel();
  el.dataset.view = next;
  paintShell();
  const body = el.querySelector('.cp-body');
  body.scrollTop = 0;
  if (next === 'consent') renderConsent(body);
  else if (next === 'home') renderHome(body);
  else if (next === 'list') renderList(body);
  else if (next === 'settings') renderSettings(body);
  else if (next === 'thread') {
    threadId = id ?? null;
    openThread(body, el.querySelector('.cp-head'), threadId, threadHooks(), { firstQuestion: question });
  }
}

function threadHooks() {
  return {
    onBack: () => show('list'),
    onChanged: () => {
      const id = threadConversationId();
      if (id) threadId = id;
      loadConvs();
    },
    onSource: goToSource,
    getContext: () => contextFor(store.state),
    getBlock: blockReason,
    onChatOff: async () => {
      if (await loadSettings()) refreshThreadInput();
    },
  };
}

/* ---------- 처음 켜기 확인 ---------- */
function planetChecks(excluded) {
  const set = new Set((excluded ?? []).map(String));
  const planets = store.state.planets ?? [];
  if (!planets.length) return '<p class="cp-sub">아직 행성이 없어요. 행성을 만들면 여기서 뺄 수 있어요.</p>';
  return (
    '<ul class="cp-planets">' +
    planets
      .map(
        (p) =>
          `<li><label class="cp-chk"><input type="checkbox" value="${esc(p.id)}"${set.has(String(p.id)) ? ' checked' : ''}>` +
          `<span class="pdot" style="background:${faceOf(p)}" aria-hidden="true"></span><span class="t">${esc(p.name)}</span></label></li>`,
      )
      .join('') +
    '</ul>'
  );
}

const checkedIds = (root) => [...root.querySelectorAll('.cp-planets input:checked')].map((i) => i.value);

function renderConsent(body) {
  setHead('챗봇 켜기');
  body.innerHTML =
    '<div class="cp-consent">' +
    `<p class="cp-lead">${esc(NOTICE)}</p>` +
    '<p class="cp-sub">켜기를 누른 뒤에 기록을 읽기 시작해요. 챗봇이 읽지 않을 행성은 체크해 두세요.</p>' +
    '<div class="lbl" id="cpExLbl">챗봇이 읽지 않을 행성</div>' +
    `<div role="group" aria-labelledby="cpExLbl">${planetChecks(settings?.excluded_planets)}</div>` +
    '<div class="row"><button type="button" class="btn ghost" data-act="cancel">취소</button><button type="button" class="btn yellow" data-act="on">켜기</button></div>' +
    '</div>';
  body.querySelector('[data-act="cancel"]').addEventListener('click', () => closeChat());
  const on = body.querySelector('[data-act="on"]');
  on.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    on.disabled = true;
    try {
      settings = await api.saveChatSettings({ consented: true, enabled: true, excluded_planets: checkedIds(body) });
      toast('챗봇을 켰어요');
      await loadConvs();
      if (open) {
        show('home');
        panel().querySelector('[data-tab="home"]')?.focus({ preventScroll: true });
      }
    } catch (err) {
      if (err?.code === 'unknown_planet') toast('그사이 행성이 바뀌었어요. 다시 골라 주세요');
      else if (err?.code !== 'offline') toast('챗봇을 켜지 못했어요. 다시 눌러 주세요');
      if (open && view === 'consent') renderConsent(body);
    } finally {
      saving = false;
      if (on.isConnected) on.disabled = false;
    }
  });
  body.querySelector('.cp-planets input, [data-act="on"]')?.focus({ preventScroll: true });
}

/* ---------- 홈 탭 ---------- */
function convItem(c, { del = false } = {}) {
  const title = c.title || '새 대화';
  const note = c.running ? '답 만드는 중' : relativeTime(c.updated_at);
  return (
    `<li class="cv${c.unread ? ' unread' : ''}"><button type="button" class="cvb" data-open="${esc(c.id)}">` +
    `<span class="t">${esc(title)}</span>` +
    (c.unread ? '<span class="dot" aria-label="읽지 않은 답 있음"></span>' : '') +
    `<span class="d">${esc(note)}</span></button>` +
    (del ? `<button type="button" class="ic del" data-del="${esc(c.id)}" aria-label="${esc(`대화 '${title}' 지우기`)}">${ico('trash-2', 16)}</button>` : '') +
    '</li>'
  );
}

function blockBanner() {
  const why = blockReason();
  return why ? `<p class="banner cp-banner" role="status"><span>${esc(why)}</span></p>` : '';
}

function renderHome(body) {
  setHead('챗봇');
  const qs = quickQuestions(store.state);
  const recent = convs.slice(0, 3);
  const blocked = Boolean(blockReason());
  body.innerHTML =
    '<div class="cp-home">' +
    blockBanner() +
    '<h3 class="cp-hi">무엇을 찾아 드릴까요</h3>' +
    '<p class="cp-sub">띄운 별에서 찾아 답해요. 답 아래에 근거가 된 별이 보여요.</p>' +
    '<div class="cp-quick">' +
    qs.map((q, i) => `<button type="button" class="btn ghost" data-q="${i}"${blocked ? ' disabled' : ''}>${esc(q)}</button>`).join('') +
    '</div>' +
    '<div class="lbl">최근 대화</div>' +
    (recent.length ? `<ul class="cp-convs">${recent.map((c) => convItem(c)).join('')}</ul>` : '<p class="empty">아직 대화가 없어요</p>') +
    `<button type="button" class="btn violet cp-new" data-act="new">${ico('message-square-plus', 18)} 새 대화</button>` +
    '</div>';
  body.querySelectorAll('[data-q]').forEach((b) =>
    b.addEventListener('click', () => show('thread', { id: null, question: qs[Number(b.dataset.q)] })),
  );
}

/* ---------- 대화 탭 ---------- */
function renderList(body) {
  setHead('대화');
  body.innerHTML =
    '<div class="cp-list">' +
    (convs.length ? `<ul class="cp-convs">${convs.map((c) => convItem(c, { del: true })).join('')}</ul>` : '<p class="empty">아직 대화가 없어요. 홈에서 바로 물어보세요</p>') +
    `<button type="button" class="btn violet cp-new" data-act="new">${ico('message-square-plus', 18)} 새 대화</button>` +
    '</div>';
}

async function onConvClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const openB = t.closest('[data-open]');
  if (openB) {
    show('thread', { id: openB.dataset.open });
    return;
  }
  if (t.closest('[data-act="new"]')) {
    show('thread', { id: null });
    return;
  }
  const del = t.closest('[data-del]');
  if (del) {
    const c = convs.find((x) => x.id === del.dataset.del);
    if (!c) return;
    const yes = await ask({
      title: `대화 '${c.title || '새 대화'}'을(를) 지울까요?`,
      desc: c.running ? '만들던 답을 멈추고 질문과 답을 함께 지워요. 별은 그대로예요.' : '질문과 답이 함께 지워져요. 별은 그대로예요.',
      confirmLabel: '지우기',
    });
    if (!yes) return;
    try {
      await api.deleteConversation(c.id);
      toast('대화를 지웠어요');
    } catch (err) {
      if (err?.status !== 404 && err?.code !== 'offline') toast('대화를 지우지 못했어요. 다시 눌러 주세요');
    }
    if (threadId === c.id) threadId = null;
    await loadConvs();
    if (open && view === 'list') {
      renderList(panel().querySelector('.cp-body'));
      panel().querySelector('.cp-convs .cvb, .cp-new')?.focus({ preventScroll: true });
    }
  }
}

/* ---------- 설정 탭 ---------- */
function keyLine() {
  if (settings?.key === true) return '연결됨';
  if (settings?.key === false) return '없음';
  return '미확인';
}

function renderSettings(body) {
  setHead('설정');
  const s = settings ?? {};
  const why = s.enabled ? unavailableMessage({ rag: s.rag, key: s.key }) : '';
  const failed = failedLine(s.index);
  body.innerHTML =
    '<div class="cp-set">' +
    '<label class="cp-sw"><span class="t">챗봇 켜기</span><input type="checkbox" role="switch" data-act="switch"' +
    `${s.enabled ? ' checked' : ''}><span class="knob" aria-hidden="true"></span></label>` +
    '<section><div class="lbl" id="cpSetEx">챗봇이 읽지 않을 행성</div>' +
    `<div role="group" aria-labelledby="cpSetEx">${planetChecks(s.excluded_planets)}</div></section>` +
    '<section><div class="lbl">상태</div>' +
    `<p class="cp-line">OpenAI 키: <b>${esc(keyLine())}</b></p>` +
    (why ? `<p class="cp-line warn">${esc(why)}</p>` : '') +
    `<p class="cp-line" data-index>${esc(indexLine(s.index))}</p>` +
    '<div class="cp-idx">' +
    (failed ? `<span class="cp-line">${esc(failed)}</span><button type="button" class="btn sm" data-act="retry">${ico('refresh-cw', 14)} 다시 시도</button>` : '') +
    '<button type="button" class="btn ghost sm" data-act="all">처음부터 다시 읽기</button></div>' +
    `<p class="cp-line">이번 달 요청 <b>${esc(num(s.usage?.requests))}</b>번</p></section>` +
    `<section><div class="lbl">OpenAI 안내</div><p class="cp-sub">${esc(PRIVACY)}</p><p class="cp-sub">${esc(HISTORY_NOTE)}</p></section>` +
    '</div>';

  body.querySelector('[data-act="switch"]').addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const want = input.checked;
    input.disabled = true;
    try {
      settings = await api.saveChatSettings({ enabled: want });
      toast(want ? '챗봇을 켰어요' : '챗봇을 껐어요');
    } catch (err) {
      input.checked = !want;
      if (err?.code !== 'offline') toast('설정을 바꾸지 못했어요. 다시 눌러 주세요');
    } finally {
      input.disabled = false;
    }
    if (!open) return;
    if (!settings.enabled || !settings.consented) show('consent');
    else renderSettings(body);
  });
  body.querySelector('.cp-planets')?.addEventListener('change', async (e) => {
    const input = e.target;
    const ids = checkedIds(body);
    try {
      settings = await api.saveChatSettings({ excluded_planets: ids });
      toast(input.checked ? '그 행성은 챗봇이 읽지 않아요' : '그 행성도 챗봇이 읽어요');
    } catch (err) {
      input.checked = !input.checked;
      if (err?.code !== 'offline') toast('설정을 바꾸지 못했어요. 다시 눌러 주세요');
    }
    if (open && view === 'settings') paintIndex(body);
  });
  body.querySelector('[data-act="retry"]')?.addEventListener('click', () => reindex('failed'));
  body.querySelector('[data-act="all"]').addEventListener('click', async () => {
    const yes = await ask({
      title: '챗봇이 기록을 처음부터 다시 읽을까요?',
      desc: '읽은 내용을 지우고 모든 별을 다시 읽어요. 그동안 OpenAI 요청이 생기고, 다 읽을 때까지 답이 덜 정확할 수 있어요.',
      confirmLabel: '다시 읽기',
      confirmKind: 'yellow',
    });
    if (yes) reindex('all');
  });
  if (s.index?.indexing) indexTimer = setTimeout(pollIndex, INDEX_POLL_MS);
}

// 읽는 중이면 2초마다 숫자만 다시 그린다(포커스가 그대로 있게)
function paintIndex(body) {
  const line = body.querySelector('[data-index]');
  if (line) line.textContent = indexLine(settings?.index);
  clearTimeout(indexTimer);
  if (settings?.index?.indexing) indexTimer = setTimeout(pollIndex, INDEX_POLL_MS);
}

async function pollIndex() {
  if (!open || view !== 'settings') return;
  const before = Boolean(settings?.index?.failed);
  if (!(await loadSettings()) || !open || view !== 'settings') return;
  const body = panel().querySelector('.cp-body');
  // 실패 수가 생기거나 없어지면 버튼 줄까지 다시 그린다
  if (before !== Boolean(settings?.index?.failed) && !body.contains(document.activeElement)) renderSettings(body);
  else paintIndex(body);
}

async function reindex(scope) {
  try {
    const r = await api.reindex(scope);
    if (settings) settings.index = r.index;
    toast(scope === 'all' ? '처음부터 다시 읽기 시작했어요' : '다시 읽기 시작했어요');
  } catch (err) {
    if (err?.code !== 'offline') toast(errorMessage(err?.code === 'chat_off' ? 'chat_off' : 'rag_unavailable'));
  }
  await loadSettings();
  if (open && view === 'settings') renderSettings(panel().querySelector('.cp-body'));
}

/* ---------- 출처 카드 → 별 ---------- */
function goToSource(src) {
  if (!src?.exists || !src.planet_id) return;
  if (narrowMq.matches) closeChat({ focus: false }); // 좁은 화면: 날아가는 모습이 보이게
  const star = { id: src.star_id, planet_id: src.planet_id, created_at: src.created_at };
  if (store.state.inWorld) flyToStar(star); // 기간 밖이면 손님 별 규칙 그대로(hud.js)
  else enterWorld({ planetId: src.planet_id, starId: src.star_id });
}

/* ---------- 시작 ---------- */
/** 버튼 · 창을 준비한다(한 번만). */
export function initChat() {
  if (btn) return;
  btn = initChatButton({ onToggle: toggle });
  build();

  // 행성 패널이 챗봇 창보다 나중에 열리면 그쪽이 위
  const planetPanel = $('panel');
  let panelWasHidden = planetPanel.hidden;
  new MutationObserver(() => {
    const hidden = planetPanel.hidden;
    if (panelWasHidden && !hidden && open) panel().setAttribute('data-back', '');
    if (hidden) bringFront(); // 겨룰 창이 없으면 늘 위(홈으로 나가도 #home 위에 남게)
    panelWasHidden = hidden;
  }).observe(planetPanel, { attributes: true, attributeFilter: ['hidden'] });

  registerEscape(25, () => {
    if (!open) return false;
    closeChat();
    return true;
  });

  // 행성이 바뀌면(이름 · 추가 · 삭제) 열린 탭을 다시 그린다. 대화 화면은 그대로(출처 카드는 다음에 그릴 때)
  store.on('data', () => {
    if (!open || saving) return;
    const body = panel().querySelector('.cp-body');
    if (body.contains(document.activeElement)) return; // 쓰거나 고르는 중이면 건드리지 않는다
    if (view === 'home') renderHome(body);
    else if (view === 'consent') renderConsent(body);
  });
  const reHome = () => {
    if (open && view === 'home') renderHome(panel().querySelector('.cp-body'));
  };
  store.on('enterWorld', reHome);
  store.on('leaveWorld', reHome);
  store.on('reachable', refreshUnread);
  store.on('online', refreshUnread);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInterval(pollTimer);
    else {
      refreshUnread();
      schedulePoll();
    }
  });
  schedulePoll();
  refreshUnread();
}
