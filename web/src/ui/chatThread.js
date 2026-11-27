// 챗봇 대화 화면(2차 스펙 7장 "대화 화면"): 말풍선 · 흘려 받기(SSE) · 멈추기 · 출처 카드 · 별로 저장 · 입력칸.
// 답 글은 마크다운으로 그리지 않는다: textContent(줄바꿈은 CSS pre-wrap). 서버 · 모델 글은 모두 textContent나 esc().
// 흘려 받기를 구독하는 동안 서버는 "보고 있음"으로 친다(읽지 않음을 켜지 않는다). 그래서 화면을 떠나면 바로 끊는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, ico } from '../util.js';
import { answerAnnouncement, askMeta, canSend, counterText, errorMessage, isLongAnswer, quickQuestions, savedStarSource, sourceCardModel, titleFrom } from './chatLogic.js';
import { openRead } from './chatRead.js';
import { toast } from './toast.js';

let T = null; // 지금 그린 대화 화면 상태

const STATUS_NOTE = { stopped: '멈췄어요' };
// 근거가 없을 때 서버가 바꿔 넣는 문구(rag/answer.py NOT_FOUND). 별로 저장할 것이 없다
const isNotFound = (content) => {
  const t = String(content ?? '').trim();
  return t === '' || t === '기록에서 찾지 못했어요.';
};

/**
 * 대화 화면을 root에 그린다. convId가 없으면 빈 새 대화(첫 질문을 할 때 서버에 만든다).
 * hooks: onBack() · onChanged()(목록 · 읽지 않음을 다시 받을 때) · onSource(source) · getContext() ·
 *        getBlock() → '' | 막는 이유(꺼짐 · 준비 안 됨) · isOff() → 꺼져 있는지(막는 줄에 설정 열기 버튼) ·
 *        onOpenSettings() · onChatOff()
 * 화면 읽기: 흘려 받는 동안 말풍선 목록은 aria-live="off"이고, 숨은 role="status" 줄이 시작과 끝을 한 번씩 읽어 준다.
 * firstQuestion이 있으면 그리자마자 묻는다(홈 탭의 바로 묻기).
 */
export async function openThread(root, head, convId, hooks = {}, { firstQuestion } = {}) {
  leaveThread();
  const t = {
    root,
    head,
    hooks,
    conv: null,
    messages: [],
    running: null, // 흘려 받는 답 메시지 id
    close: null, // 흘려 받기 끊기
    busy: false, // 묻는 요청을 보내는 중
    composing: false,
    seq: 0,
    stick: true, // 맨 아래를 보고 있으면 새 글자를 따라 내려간다
  };
  T = t;
  build(t);
  if (convId) {
    t.title.textContent = '불러오는 중…';
    let r;
    try {
      r = await api.conversation(convId);
    } catch (err) {
      if (T !== t) return;
      if (err?.code !== 'offline') toast(errorMessage(err?.status === 404 ? 'not_found' : 'internal'));
      hooks.onBack?.();
      return;
    }
    if (T !== t) return;
    t.conv = r.conversation;
    t.messages = r.messages ?? [];
    hooks.onChanged?.(); // 읽지 않음이 지워졌다
  }
  paintHead(t);
  paintAll(t);
  const run = t.messages.find((m) => m.role === 'assistant' && m.status === 'running');
  if (run) subscribe(t, run);
  paintInput(t);
  if (firstQuestion) {
    t.ta.value = firstQuestion;
    submit(t);
  } else {
    t.ta.focus({ preventScroll: true });
  }
}

/** 대화 화면을 떠난다(흘려 받기를 끊는다). 언제 불러도 된다. */
export function leaveThread() {
  if (!T) return;
  T.close?.();
  T.close = null;
  T = null;
}

/** 지금 그려진 대화의 id(빈 새 대화면 null, 대화 화면이 아니면 undefined). */
export function threadConversationId() {
  return T ? (T.conv?.id ?? null) : undefined;
}

/** 대화 화면에서 답을 흘려 받는 중인지. */
export function threadRunning() {
  return Boolean(T?.running);
}

/** 막는 이유가 바뀌었을 때(설정 · 상태를 다시 받은 뒤) 입력칸을 다시 그린다. */
export function refreshThreadInput() {
  if (T) paintInput(T);
}

/* ---------- 별로 저장 → 띄운 별 잇기 ---------- */
// 별 띄우기 창이 그 답에서 열려 별이 실제로 생겼을 때(saveModal.js). 취소하면 오지 않는다.
// 대화 화면을 닫은 뒤에 끝나도 서버에는 잇고, 그 대화가 열려 있으면 버튼을 바로 "띄운 별 보기"로 바꾼다.
store.on('savedFromAnswer', async ({ messageId, starId } = {}) => {
  if (!messageId || !starId) return;
  let r;
  try {
    r = await api.linkSavedStar(messageId, starId);
  } catch (err) {
    if (err?.code !== 'offline') toast('별은 띄웠지만 답에 표시하지 못했어요');
    return;
  }
  const t = T;
  const m = t?.messages.find((x) => String(x.id) === String(messageId));
  if (!t || !m) return;
  m.saved_star = r?.message?.saved_star ?? null;
  repaint(t, m);
});

/* ---------- 그리기 ---------- */
function build(t) {
  t.head.innerHTML =
    `<button type="button" class="btn ghost x" data-act="back" aria-label="대화 목록으로">${ico('arrow-left')}</button>` +
    '<h2 class="ct-title"></h2>';
  t.title = t.head.querySelector('.ct-title');
  t.head.querySelector('[data-act="back"]').addEventListener('click', () => t.hooks.onBack?.());

  t.root.innerHTML =
    '<div class="ct">' +
    '<div class="ct-msgs" role="log" aria-live="polite" aria-label="대화" tabindex="0"></div>' +
    '<p class="sr ct-say" role="status"></p>' +
    '<div class="ct-block" role="status" hidden><span class="ct-block-t"></span>' +
    '<button type="button" class="btn ghost sm" data-act="settings" hidden>설정 열기</button></div>' +
    // 입력창 하나: 묻기(↑) · 멈추기(■) 버튼은 칸 안 오른쪽 아래, 글자 수는 칸 안 오른쪽 위(한도에 가까울 때만).
    // 키 안내 줄은 두지 않는다(대화를 덜 가리게). 버튼에 마우스를 올리면 Enter · Shift+Enter를 알려 준다
    '<form class="ct-form" novalidate><div class="ct-box">' +
    '<textarea class="ct-ta" rows="1" aria-label="질문" placeholder="기록에 대해 물어보세요"></textarea>' +
    '<span class="ct-count" aria-live="polite"></span>' +
    '<button type="submit" class="ct-go"></button>' +
    '</div></form></div>';
  t.list = t.root.querySelector('.ct-msgs');
  t.block = t.root.querySelector('.ct-block');
  t.blockText = t.root.querySelector('.ct-block-t');
  t.blockGo = t.root.querySelector('[data-act="settings"]');
  t.say = t.root.querySelector('.ct-say');
  t.blockGo.addEventListener('click', () => t.hooks.onOpenSettings?.());
  t.form = t.root.querySelector('.ct-form');
  t.ta = t.root.querySelector('.ct-ta');
  t.go = t.root.querySelector('.ct-go');
  t.count = t.root.querySelector('.ct-count');

  t.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (t.running) stop(t);
    else submit(t);
  });
  t.ta.addEventListener('compositionstart', () => (t.composing = true));
  t.ta.addEventListener('compositionend', () => {
    t.composing = false;
    paintInput(t);
  });
  t.ta.addEventListener('input', () => {
    grow(t.ta);
    paintInput(t);
  });
  t.ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중의 Enter는 글자를 끝낼 뿐이다
    e.preventDefault();
    if (!t.running) submit(t);
  });
  t.list.addEventListener('click', (e) => onListClick(t, e));
  t.list.addEventListener('scroll', () => (t.stick = nearBottom(t.list)), { passive: true });
  grow(t.ta);
}

const TA_MAX = 112; // 4줄(14px × 1.5 × 4 + 위아래 여백 · 테두리). 그 뒤로는 칸 안에서 스크롤
function grow(ta) {
  ta.style.height = 'auto';
  const h = ta.scrollHeight + 5; // 테두리 2.5px × 2
  ta.style.height = `${Math.min(h, TA_MAX)}px`;
  ta.style.overflowY = h > TA_MAX ? 'auto' : 'hidden';
}

function paintHead(t) {
  t.title.textContent = t.conv?.title || '새 대화';
}

function paintAll(t) {
  if (!t.messages.length) {
    // 빈 새 대화: 챗봇의 첫 마디 말풍선(저장되는 메시지가 아니다) + 바로 묻는 추천 질문(홈 탭과 같은 것).
    // 첫 질문을 보내면 목록을 비우고(submit) 실제 말풍선이 그 자리에 온다
    t.quick = quickQuestions(store.state);
    const blocked = Boolean(t.hooks.getBlock?.());
    t.list.innerHTML =
      '<div class="b bot greet"><p class="tx">무엇이든 물어보세요. 띄운 별에서 찾아 답해요.</p></div>' +
      `<div class="cp-quick ct-quick" role="group" aria-label="추천 질문">${t.quick
        .map((q, i) => `<button type="button" class="btn ghost" data-quick="${i}"${blocked ? ' disabled' : ''}>${esc(q)}</button>`)
        .join('')}</div>`;
    return;
  }
  t.list.textContent = '';
  for (const m of t.messages) t.list.appendChild(bubble(m));
  scrollDown(t, true);
}

// 말풍선 하나. 사용자 · 모델 글은 textContent로만 넣는다.
function bubble(m) {
  const li = document.createElement('div');
  li.className = `b ${m.role === 'user' ? 'user' : 'bot'}`;
  li.dataset.id = m.id;
  const tx = document.createElement('p');
  tx.className = 'tx';
  li.appendChild(tx);
  if (m.role === 'user') {
    tx.textContent = m.content ?? '';
    return li;
  }
  paintBot(li, m);
  return li;
}

function paintBot(li, m) {
  const tx = li.querySelector('.tx');
  const running = m.status === 'running';
  tx.textContent = m.content ?? '';
  li.classList.toggle('running', running);
  li.setAttribute('aria-busy', String(running));
  // 상태 줄: 만드는 중 · 멈춤 · 실패
  let note = li.querySelector('.note');
  const noteText = running ? (m.content ? '' : '답을 만드는 중…') : m.status === 'failed' ? errorMessage(m.error) : STATUS_NOTE[m.status] ?? '';
  if (noteText) {
    if (!note) {
      note = document.createElement('p');
      note.className = 'note';
      tx.after(note);
    }
    note.textContent = noteText;
    note.classList.toggle('err', m.status === 'failed');
  } else note?.remove();
  paintSources(li, m);
}

function paintSources(li, m) {
  li.querySelector('.srcs')?.remove();
  li.querySelector('.bacts')?.remove();
  const sources = Array.isArray(m.sources) ? m.sources : [];
  // 출처: 본문보다 조용하게. 점선 아래 "근거 N개"와 한 줄 텍스트 버튼(색 점 · 밑줄 제목 · 날짜).
  // 파일 이름은 줄에서 빼고 마우스를 올리면 보이게 한다(title)
  if (sources.length) {
    const box = document.createElement('div');
    box.className = 'srcs';
    const items = sources
      .map((s, i) => {
        const v = sourceCardModel(s, store.state.planets);
        const tip = [v.date, v.file].filter(Boolean).join(' · ');
        const inner =
          `<span class="pdot" style="background:${esc(v.color)}" aria-hidden="true"></span>` +
          `<span class="t">${esc(v.title)}</span>` +
          (v.date ? `<small>${esc(v.date)}</small>` : '');
        return v.gone
          ? `<li><div class="src gone" aria-disabled="true">${inner}</div></li>`
          : `<li><button type="button" class="src" data-src="${i}" title="${esc(tip)}" aria-label="${esc(`별 '${v.title}'(으)로 날아가기${tip ? `, ${tip}` : ''}`)}">${inner}</button></li>`;
      })
      .join('');
    box.innerHTML = `<p class="srclbl">근거 ${sources.length}개</p><ul aria-label="출처">${items}</ul>`;
    li.appendChild(box);
  }
  if (m.status !== 'running' && m.status !== 'failed' && !m.not_found && !isNotFound(m.content)) {
    const acts = document.createElement('div');
    acts.className = 'bacts';
    // 이미 별로 띄웠으면 "띄운 별 보기 →"(누르면 그 별로 날아간다). 그 별을 지우면 서버가 null을 보내 다시 "별로 저장"이 된다
    // 긴 답은 앞에 "크게 보기"(chatRead.js: 넓은 화면은 가운데 읽기 창, 좁은 화면은 꽉 찬 화면)
    acts.innerHTML =
      (isLongAnswer(m.content) ? `<button type="button" class="btn ghost sm" data-read>${ico('maximize-2', 14)} 크게 보기</button>` : '') +
      (savedStarSource(m)
        ? `<button type="button" class="btn ghost sm saved" data-saved>${ico('star', 14)} 띄운 별 보기 →</button>`
        : `<button type="button" class="btn ghost sm" data-save>${ico('star', 14)} 별로 저장</button>`);
    li.appendChild(acts);
  }
}

function msgEl(t, id) {
  return [...t.list.querySelectorAll('.b')].find((el) => el.dataset.id === String(id)) ?? null;
}

function repaint(t, m) {
  const el = msgEl(t, m.id);
  if (el) paintBot(el, m);
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollDown(t, force = false) {
  if (force || t.stick) {
    t.list.scrollTop = t.list.scrollHeight;
    t.stick = true;
  }
}

function paintInput(t) {
  const block = t.hooks.getBlock?.() ?? '';
  if (t.blockText.textContent !== block) t.blockText.textContent = block; // 같은 글을 다시 넣어 또 읽히지 않게
  t.block.hidden = !block;
  t.blockGo.hidden = !block || !t.hooks.isOff?.();
  t.ta.disabled = Boolean(block);
  t.count.textContent = counterText(t.ta.value);
  // 아이콘만 있는 버튼이라 이름(aria-label)과 마우스를 올렸을 때의 안내(title)를 함께 둔다
  if (t.running) {
    t.go.innerHTML = ico('square', 14);
    t.go.className = 'ct-go stop';
    t.go.setAttribute('aria-label', '답 멈추기');
    t.go.title = '답 멈추기';
    t.go.disabled = false;
  } else {
    t.go.innerHTML = ico('arrow-up', 18);
    t.go.className = 'ct-go';
    t.go.setAttribute('aria-label', '묻기');
    t.go.title = '묻기 (Enter) · 줄바꿈은 Shift+Enter';
    t.go.disabled = !canSend({ text: t.ta.value, composing: t.composing, busy: t.busy, enabled: !block });
  }
}

/* ---------- 화면 읽기 ---------- */
// 흘려 받는 동안 말풍선 목록은 조용히(글자마다 읽지 않게), 시작 · 끝만 숨은 status 줄로 한 번씩
function quiet(t, on) {
  t.list.setAttribute('aria-live', on ? 'off' : 'polite');
}

function announce(t, text) {
  t.say.textContent = '';
  // 비운 뒤 조금 있다 넣어야 같은 문구도 다시 읽힌다
  setTimeout(() => {
    if (T === t) t.say.textContent = text;
  }, 60);
}

/* ---------- 묻기 · 흘려 받기 ---------- */
async function submit(t) {
  const block = t.hooks.getBlock?.() ?? '';
  const text = t.ta.value;
  if (t.running || !canSend({ text, composing: t.composing, busy: t.busy, enabled: !block })) return;
  const question = text.trim();
  t.busy = true;
  paintInput(t);
  try {
    if (!t.conv) {
      const r = await api.createConversation();
      if (T !== t) return;
      t.conv = r.conversation;
    }
    const r = await api.ask(t.conv.id, { question, context: t.hooks.getContext?.() ?? {}, ...askMeta() });
    if (T !== t) return;
    if (t.ta.value === text) t.ta.value = '';
    grow(t.ta);
    quiet(t, true); // 새 말풍선 두 개를 목록이 읽지 않게(시작은 아래 subscribe가 알린다)
    if (!t.messages.length) t.list.textContent = '';
    if (!t.messages.length || t.conv.title === '새 대화') t.conv.title = titleFrom(question);
    paintHead(t);
    t.messages.push(r.user_message, r.assistant_message);
    t.list.appendChild(bubble(r.user_message));
    t.list.appendChild(bubble(r.assistant_message));
    scrollDown(t, true);
    subscribe(t, r.assistant_message);
  } catch (err) {
    if (T !== t) return;
    const code = err?.code;
    if (code !== 'offline') toast(errorMessage(code === 'not_found' ? 'not_found' : code));
    if (code === 'chat_off') t.hooks.onChatOff?.();
    if (code === 'not_found') t.conv = null; // 그사이 지워진 대화: 다음 질문은 새 대화로
  } finally {
    if (T === t) {
      t.busy = false;
      paintInput(t);
      t.hooks.onChanged?.();
    }
  }
}

function subscribe(t, m) {
  t.close?.();
  t.running = m.id;
  quiet(t, true);
  announce(t, '답을 만들고 있어요');
  paintInput(t);
  const finish = () => {
    if (T !== t || t.running !== m.id) return;
    ended(t, m);
  };
  t.close = api.streamAnswer(m.id, {
    onSnapshot(d) {
      m.content = String(d.content ?? '');
      if (Array.isArray(d.sources)) m.sources = d.sources;
      m.status = d.status ?? 'running';
      m.error = d.error ?? null;
      repaint(t, m);
      scrollDown(t);
    },
    onToken(text) {
      m.content = `${m.content ?? ''}${text}`;
      const el = msgEl(t, m.id);
      if (el) {
        el.querySelector('.tx').textContent = m.content;
        el.querySelector('.note')?.remove();
      }
      scrollDown(t);
    },
    onReplace(text) {
      m.content = text;
      repaint(t, m);
      scrollDown(t);
    },
    onSources(sources) {
      m.sources = sources;
      repaint(t, m);
      scrollDown(t);
    },
    onDone(d) {
      m.status = d.status === 'stopped' ? 'stopped' : 'done';
      m.not_found = d.not_found === true; // "찾지 못했어요"는 별로 저장할 것이 없다
      finish();
    },
    onError(d) {
      m.status = 'failed';
      m.error = d.code ?? 'internal';
      finish();
    },
  });
}

// 답이 끝났다(done · stopped · failed): 그리고, 한 번 읽어 주고, 목록을 다시 듣게 한다
function ended(t, m) {
  t.close?.();
  t.close = null;
  t.running = null;
  repaint(t, m);
  paintInput(t);
  scrollDown(t);
  announce(t, answerAnnouncement(m));
  quiet(t, false);
  t.hooks.onChanged?.();
}

async function stop(t) {
  const id = t.running;
  if (!id) return;
  t.go.disabled = true;
  try {
    const r = await api.stopAnswer(id);
    // 흘려 받기가 곧 done(stopped)을 준다. 혹시 먼저 끊겼으면 여기서 맞춘다
    const m = t.messages.find((x) => x.id === id);
    if (T === t && m && t.running === id && r?.message) {
      Object.assign(m, r.message);
      ended(t, m);
    }
  } catch (err) {
    if (err?.code !== 'not_running' && err?.code !== 'offline') toast('멈추지 못했어요. 다시 눌러 주세요');
    if (T === t) paintInput(t);
  }
}

function onListClick(t, e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  // 빈 새 대화의 추천 질문: 입력칸에 넣고 바로 묻는다
  const quick = target.closest('[data-quick]');
  if (quick) {
    if (!quick.disabled && t.quick?.[Number(quick.dataset.quick)]) {
      t.ta.value = t.quick[Number(quick.dataset.quick)];
      submit(t);
    }
    return;
  }
  const li = target.closest('.b');
  const m = li ? t.messages.find((x) => x.id === li.dataset.id) : null;
  if (!m) return;
  const src = target.closest('button[data-src]');
  if (src) {
    const s = m.sources?.[Number(src.dataset.src)];
    if (s && s.exists) t.hooks.onSource?.(s);
    return;
  }
  if (target.closest('[data-saved]')) {
    const s = savedStarSource(m);
    if (s) t.hooks.onSource?.(s);
    return;
  }
  if (target.closest('[data-read]')) {
    // 크게 보기: 물어본 말은 이 답 바로 앞의 사용자 말풍선
    const i = t.messages.indexOf(m);
    const q = t.messages.slice(0, i).reverse().find((x) => x.role === 'user');
    openRead(m, String(q?.content ?? '').trim(), { onSource: (s) => t.hooks.onSource?.(s), onSave: saveAnswer }, () =>
      msgEl(t, m.id)?.querySelector('[data-read]') ?? null,
    );
    return;
  }
  if (target.closest('[data-save]')) saveAnswer(m);
}

// 기록하기 창: 글 칸에 답 내용(쓰던 글이 있으면 덮어쓰지 않는다 — saveModal.js 규칙).
// 별이 실제로 생기면 'savedFromAnswer'가 와서 이 답에 잇는다
function saveAnswer(m) {
  store.emit('openSave', { text: String(m.content ?? ''), fromAnswer: m.id });
}
