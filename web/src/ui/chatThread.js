// 챗봇 대화 화면(2차 스펙 7장 "대화 화면"): 말풍선 · 흘려 받기(SSE) · 멈추기 · 출처 카드 · 별로 저장 · 입력칸.
// 답 글은 마크다운으로 그리지 않는다: textContent(줄바꿈은 CSS pre-wrap). 서버 · 모델 글은 모두 textContent나 esc().
// 흘려 받기를 구독하는 동안 서버는 "보고 있음"으로 친다(읽지 않음을 켜지 않는다). 그래서 화면을 떠나면 바로 끊는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, ico } from '../util.js';
import { askMeta, canSend, counterText, errorMessage, sourceCardModel, titleFrom } from './chatLogic.js';
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
 *        getBlock() → '' | 막는 이유(꺼짐 · 준비 안 됨) · onChatOff()
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
    '<p class="ct-block" role="status" hidden></p>' +
    '<form class="ct-form" novalidate>' +
    '<textarea class="ct-ta" rows="1" aria-label="질문" placeholder="기록에 대해 물어보세요"></textarea>' +
    '<div class="ct-row"><span class="ct-hint">Enter 묻기 · Shift+Enter 줄바꿈</span><span class="ct-count" aria-live="polite"></span>' +
    '<button type="submit" class="btn ct-go"></button></div>' +
    '</form></div>';
  t.list = t.root.querySelector('.ct-msgs');
  t.block = t.root.querySelector('.ct-block');
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

const TA_MAX = 150;
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
    t.list.innerHTML = '<p class="empty">무엇이든 물어보세요. 띄운 별에서 찾아 답해요.</p>';
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
  if (sources.length) {
    const ul = document.createElement('ul');
    ul.className = 'srcs';
    ul.setAttribute('aria-label', '출처');
    ul.innerHTML = sources
      .map((s, i) => {
        const v = sourceCardModel(s, store.state.planets);
        const inner =
          `<span class="pdot" style="background:${esc(v.color)}" aria-hidden="true"></span>` +
          `<span class="st"><b>${esc(v.title)}</b>` +
          (v.date || v.file ? `<small>${esc([v.date, v.file].filter(Boolean).join(' · '))}</small>` : '') +
          '</span>';
        return v.gone
          ? `<li><div class="src gone" aria-disabled="true">${inner}</div></li>`
          : `<li><button type="button" class="src" data-src="${i}" aria-label="${esc(`별 '${v.title}'(으)로 날아가기`)}">${inner}</button></li>`;
      })
      .join('');
    li.appendChild(ul);
  }
  if (m.status !== 'running' && m.status !== 'failed' && !m.not_found && !isNotFound(m.content)) {
    const acts = document.createElement('div');
    acts.className = 'bacts';
    acts.innerHTML = `<button type="button" class="btn ghost sm" data-save>${ico('star', 16)} 별로 저장</button>`;
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
  t.block.textContent = block;
  t.block.hidden = !block;
  t.ta.disabled = Boolean(block);
  t.count.textContent = counterText(t.ta.value);
  if (t.running) {
    t.go.innerHTML = `${ico('square', 16)} 멈추기`;
    t.go.className = 'btn ghost ct-go';
    t.go.disabled = false;
  } else {
    t.go.innerHTML = `${ico('arrow-up', 16)} 묻기`;
    t.go.className = 'btn ct-go';
    t.go.disabled = !canSend({ text: t.ta.value, composing: t.composing, busy: t.busy, enabled: !block });
  }
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
  paintInput(t);
  const finish = () => {
    if (T !== t || t.running !== m.id) return;
    t.running = null;
    t.close = null;
    repaint(t, m);
    paintInput(t);
    scrollDown(t);
    t.hooks.onChanged?.();
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
      t.close?.();
      t.close = null;
      t.running = null;
      repaint(t, m);
      paintInput(t);
      t.hooks.onChanged?.();
    }
  } catch (err) {
    if (err?.code !== 'not_running' && err?.code !== 'offline') toast('멈추지 못했어요. 다시 눌러 주세요');
    if (T === t) paintInput(t);
  }
}

function onListClick(t, e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const li = target.closest('.b');
  const m = li ? t.messages.find((x) => x.id === li.dataset.id) : null;
  if (!m) return;
  const src = target.closest('button[data-src]');
  if (src) {
    const s = m.sources?.[Number(src.dataset.src)];
    if (s && s.exists) t.hooks.onSource?.(s);
    return;
  }
  if (target.closest('[data-save]')) {
    // 기록하기 창: 글 칸에 답 내용(쓰던 글이 있으면 덮어쓰지 않는다 — saveModal.js 규칙)
    store.emit('openSave', { text: String(m.content ?? '') });
  }
}
