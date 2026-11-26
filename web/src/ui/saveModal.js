// 기록하기 창 "별 띄우기"(#save, 스펙 6-9). 메모 + 첨부 파일 + 링크를 저장하면 별 하나가 된다.
// 메모 칸(#svText)의 글은 별의 본문(body)으로 저장되고, 별 상세의 메모 칸에서 그대로 고친다.
// 여는 곳: "기록하기"(#hLog · #wLog · 빈 우주 카드 → 'openSave' 이벤트, main.js), 끌어다 놓기 · 붙여넣기(dropzone.js).
// Esc는 escape.js의 60번 자리(행성 꾸미기 창 다음, 전환 건너뛰기 앞). 열려 있는 동안 비행 키를 받지 않는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { playerPosition, setInputBlocked } from '../three/controls.js';
import { flyStarIn } from '../three/planets.js';
import { planetFace, esc, fileSize, ico } from '../util.js';
import { ask, closeAsk } from './confirm.js';
import { memoCount } from './detailLogic.js';
import { registerEscape } from './escape.js';
import { flashStars } from './panel.js';
import { trapTab, wireBackdrop } from './planetForm.js';
import {
  ATTACH_MAX,
  KEPT_TOAST,
  TOO_BIG_TOAST,
  TOO_MANY_TOAST,
  URL_ERROR,
  URL_REFUSED,
  addToast,
  autoTitle,
  badLinks,
  canSubmit,
  clampPlanetName,
  cleanPlanetName,
  defaultPlanetId,
  httpUrl,
  matchSkipped,
  nothingToast,
  pendingLink,
  planAdd,
  resultToast,
  saveBlockHint,
  saveError,
  skipNote,
  submitTitle,
  urlError,
} from './saveLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const FLY_DROP = 6; // 캐릭터 아래 이만큼에서 솟는다
const THUMB_TYPE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
const THUMB_MAX = 30 * 1024 * 1024; // 이보다 큰 이미지는 칩 미리보기를 만들지 않는다
const SLOW_MS = 15000; // 파일 없는 저장이 이보다 오래 걸리면 취소를 다시 열어 준다
const TITLE_EMPTY = '비워 두면 메모 첫 줄을 써요';
const aborted = () => Object.assign(new Error('aborted'), { code: 'aborted' });
const LATE_FAIL = '저장하지 못했어요. 기록하기를 다시 누르면 쓰던 내용이 돌아와요';

// 열려 있는 동안의 상태. 글 · 제목 · 주소 · 새 행성 이름은 입력칸이 들고 있다.
let S = null;
let wired = false;
let itemSeq = 0;
// "기다리지 않고 닫기"로 닫은 창의 저장이 뒤늦게 실패했을 때 그 창의 내용. 다음에 빈 창을 열면 되돌려 놓는다.
let stash = null;

function fresh() {
  return {
    fromAnswer: null, // 챗봇 답의 "별로 저장"으로 열었으면 그 답(메시지) id. 별이 생기면 'savedFromAnswer'로 알린다
    items: [], // { id, kind: 'file', file, thumb, hint, skip } | { id, kind: 'link', url, bad }
    planet: 'new',
    pick: false, // 고른 행성이 사라져 다시 골라야 하는 동안(선택 상자 맨 위에 "행성을 골라 주세요"가 생긴다)
    extra: [], // 이 창에서 만들었지만 아직 store에 없는 행성
    busy: false,
    abort: null, // 저장하는 동안의 AbortController. 파일을 올릴 때만 "올리기 멈추기"로 쓴다
    files: false, // 지금 저장에 파일이 있는지
    uploaded: false, // 파일을 다 보냈는지(그 뒤로는 서버가 어차피 저장하므로 멈출 수 없다)
    snapshot: null, // 기다리지 않고 닫을 때 남겨 둔 내용(뒤늦게 실패하면 stash로 옮긴다)
    slow: false, // 파일 없는 저장의 응답이 늦어져 취소를 다시 열어 둔 동안
    pct: null,
    asking: false,
    prevFocus: null,
  };
}

const fileItems = () => (S ? S.items.filter((it) => it.kind === 'file') : []);
const linkItems = () => (S ? S.items.filter((it) => it.kind === 'link') : []);
// 서버가 저장하는 순서(파일 다음 링크)대로 보인다
const ordered = () => [...fileItems(), ...linkItems()];

/* ---------- 행성 선택 ---------- */

function planetList() {
  const list = [...store.state.planets];
  for (const p of S?.extra ?? []) if (!list.some((q) => String(q.id) === String(p.id))) list.push(p);
  return list;
}

function paintPlanet() {
  if (!S) return;
  const isNew = S.planet === 'new';
  const planet = isNew ? null : planetList().find((p) => String(p.id) === S.planet);
  const dot = $('svDot');
  dot.classList.toggle('new', isNew);
  dot.style.background = planet ? planetFace(planet, '') : '';
  $('svNewName').hidden = !isNew;
}

// 선택 상자를 다시 채운다. wanted가 목록에 없으면 기본값(패널의 행성 → 미분류 → 첫 행성(옛 서버) → 새 행성).
// 다시 골라야 하는 동안(S.pick)에는 아무것도 고르지 않은 자리('')가 맨 위에 있고, 직접 고를 때까지 그 자리에 둔다.
function rebuildPlanets(wanted) {
  if (!S) return;
  const list = planetList();
  const sel = $('svPlanet');
  sel.textContent = '';
  if (S.pick) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '행성을 골라 주세요';
    none.disabled = true;
    sel.appendChild(none);
  }
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = p.name; // textContent라 esc가 필요 없다
    sel.appendChild(opt);
  }
  const add = document.createElement('option');
  add.value = 'new';
  add.textContent = '+ 새 행성 만들기';
  sel.appendChild(add);

  let value = wanted === null || wanted === undefined ? null : String(wanted);
  if (S.pick) {
    value = '';
  } else if (value !== 'new' && !list.some((p) => String(p.id) === value)) {
    value = defaultPlanetId({
      panelPlanetId: store.state.panelPlanetId,
      planets: list,
    });
  }
  sel.value = value;
  S.planet = value;
  paintPlanet();
}

/* ---------- 첨부 칩 ---------- */

function chipHtml(it) {
  if (it.kind === 'link') {
    const bad = it.bad ? `<small>${esc(URL_REFUSED)}</small>` : '';
    return (
      `<li class="chip link${it.bad ? ' bad' : ''}" data-id="${it.id}"><span class="th" aria-hidden="true">${ico('link', 16)}</span>` +
      `<span class="cm"><span class="cn" title="${esc(it.url)}">${esc(it.url)}</span>${bad}</span>` +
      `<button type="button" class="btn x" data-rm aria-label="${esc(`링크 ${it.url} 빼기`)}">${ico('x', 14)}</button></li>`
    );
  }
  const name = it.file.name || '이름 미확인';
  const isImage = String(it.file.type).startsWith('image/');
  const thumb = it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : ico(isImage ? 'image' : 'file-text', 16);
  const note = it.skip ? skipNote(it.skip) : fileSize(it.file.size);
  return (
    `<li class="chip file${it.skip ? ' skip' : ''}" data-id="${it.id}"><span class="th" aria-hidden="true">${thumb}</span>` +
    `<span class="cm"><span class="cn" title="${esc(name)}">${esc(name)}</span><small>${esc(note)}</small></span>` +
    `<button type="button" class="btn x" data-rm aria-label="${esc(`${name} 빼기`)}">${ico('x', 14)}</button></li>`
  );
}

function renderChips() {
  if (!S) return;
  const list = $('svChips');
  const items = ordered();
  list.hidden = items.length === 0;
  list.innerHTML = items.map(chipHtml).join('');
  // 개수는 "첨부" 라벨 오른쪽에. 비어 있을 때는 개수 대신 버튼 옆에 끌어다 놓기 안내를 보인다
  $('svCount').textContent = items.length ? `${items.length}/${ATTACH_MAX}` : '';
  $('svAttHint').hidden = items.length > 0;
  for (const btn of list.querySelectorAll('[data-rm]')) btn.disabled = S.busy;
}

const room = () => Math.max(0, ATTACH_MAX - (S ? S.items.length : 0));

// 파일을 담는다. 500MB 초과 · 이미 담긴 파일 · 50개 초과분은 빼고 토스트로 알린다. 담은 개수를 돌려준다.
// hints는 files와 같은 순서의 제목 힌트(붙여넣은 그림 등).
function addFiles(files, hints) {
  if (!S || S.busy) return 0;
  const incoming = Array.from(files ?? []);
  const hintOf = new Map(incoming.map((f, i) => [f, hints?.[i] ?? null]));
  const plan = planAdd({ existing: fileItems().map((it) => it.file), incoming, room: room() });
  for (const file of plan.add) {
    let thumb = null;
    if (THUMB_TYPE.test(file.type) && file.size <= THUMB_MAX) {
      try {
        thumb = URL.createObjectURL(file);
      } catch {
        thumb = null;
      }
    }
    S.items.push({ id: ++itemSeq, kind: 'file', file, thumb, hint: hintOf.get(file) || null, skip: null });
  }
  const note = addToast(plan); // 여러 한도에 걸리면 한 줄에 이유마다 적는다
  if (note) toast(note);
  if (plan.add.length) changed();
  return plan.add.length;
}

// 링크 칩을 더한다. 주소가 아니면 안내만 보인다. 더했으면 true.
function addLink(raw) {
  if (!S || S.busy) return false;
  const url = httpUrl(raw);
  if (!url) {
    showUrlError(URL_ERROR);
    return false;
  }
  if (!room()) {
    toast(TOO_MANY_TOAST);
    return false;
  }
  if (linkItems().some((it) => it.url === url)) {
    toast('이미 담긴 링크예요');
    return false;
  }
  S.items.push({ id: ++itemSeq, kind: 'link', url, bad: false });
  changed();
  return true;
}

function removeItem(id) {
  if (!S || S.busy) return;
  const before = ordered();
  const at = before.findIndex((it) => String(it.id) === String(id));
  if (at < 0) return;
  const gone = before[at];
  S.items = S.items.filter((it) => it !== gone);
  if (gone.thumb) URL.revokeObjectURL(gone.thumb);
  changed();
  // 지운 자리의 다음 칩(없으면 "파일 첨부")으로 초점을 옮긴다
  const next = $('svChips').querySelectorAll('[data-rm]')[Math.min(at, S.items.length - 1)];
  (next ?? $('svAttach')).focus();
}

/* ---------- 그리기 ---------- */

function showError(message) {
  const el = $('svErr');
  el.textContent = message || '';
  el.hidden = !message;
}

function showUrlError(message) {
  const el = $('svUrlErr');
  el.textContent = message || '';
  el.hidden = !message;
  $('svUrl').setAttribute('aria-invalid', String(Boolean(message)));
}

// 칩 · 제목 힌트 · 버튼을 지금 내용에 맞춘다
function changed() {
  showError('');
  renderChips();
  paintTitleHint();
  paintMemoCount();
  paintSubmit();
}

function titleParts() {
  return {
    text: $('svText').value,
    files: fileItems().map((it) => ({ name: it.file.name, hint: it.hint })),
    links: linkItems().map((it) => it.url),
  };
}

// 제목 칸의 placeholder: 비워 두면 쓰일 제목. 입력한 값처럼 보이지 않게 "비워 두면"을 앞에 붙인다
function paintTitleHint() {
  if (!S) return;
  const auto = autoTitle(titleParts());
  $('svTitle').placeholder = auto ? `비워 두면 “${auto}”` : TITLE_EMPTY;
}

function paintSubmit() {
  if (!S) return;
  const yes = $('svYes');
  // 주소 칸에 쳐 두고 아직 더하지 않은 링크도 내용으로 센다(저장할 때 칩으로 더하거나, 틀렸으면 알린다)
  const typed = $('svUrl').value.trim() !== '' ? 1 : 0;
  const fields = {
    text: $('svText').value,
    count: Math.min(ATTACH_MAX, S.items.length + typed),
    planetId: S.planet,
    newPlanetName: $('svNewName').value,
  };
  const ready = canSubmit(fields);
  yes.disabled = S.busy || !ready;
  // 잠긴 까닭(흐린 안내, 버튼 바로 위). 띄우는 중에는 숨긴다
  const hint = S.busy || ready ? '' : saveBlockHint(fields);
  $('svBlockHint').textContent = hint;
  $('svBlockHint').hidden = !hint;
  yes.textContent = !S.busy ? '별 띄우기' : S.pct === null ? '띄우는 중…' : `띄우는 중… ${S.pct}%`;
  yes.setAttribute('aria-busy', String(S.busy));
  syncUnload();
}

// 취소 · ✕: 파일을 올리는 동안에는 "올리기 멈추기"로 살아 있고, 파일 없는 저장은 응답이 늦어질 때만 다시 열린다.
// 파일을 다 보낸 뒤에는 서버가 어차피 저장하므로 "마무리하는 중…"으로 잠근다.
function paintCancel() {
  if (!S) return;
  const finishing = S.busy && S.files && S.uploaded;
  const stoppable = S.busy && S.files && !S.uploaded;
  const off = S.busy && !stoppable && !S.slow;
  $('svNo').disabled = off;
  $('svX').disabled = off;
  $('svNo').textContent = finishing ? '마무리하는 중…' : stoppable ? '올리기 멈추기' : '취소';
}

// 메모 칸은 쓰는 만큼 늘어난다(최소 3줄 · 최대 높이는 CSS, 그 뒤로는 칸 안에서 스크롤). 창의 스크롤 자리는 지킨다
function growText() {
  const el = $('svText');
  const wrap = $('svBodyWrap');
  const top = wrap.scrollTop;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 6}px`;
  wrap.scrollTop = top;
}

// 메모 글자 수: 1만 8천 자부터 "18,200 / 20,000", 2만 자를 넘으면 빨갛게(그동안 "별 띄우기"는 canSubmit이 막는다)
function paintMemoCount() {
  const el = $('svMemoCnt');
  const count = memoCount($('svText').value);
  el.hidden = !count;
  el.textContent = count ? count.text : '';
  el.classList.toggle('bad', Boolean(count?.over));
}

// 저장하는 중이거나 쓰던 것이 있으면 탭을 닫거나 새로 고칠 때 브라우저가 한 번 묻게 한다.
let unloadOn = false;
function onBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}
function syncUnload() {
  const want = Boolean(S) && (S.busy || hasContent());
  if (want === unloadOn) return;
  unloadOn = want;
  if (want) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}

function setBusy(on, pct = null) {
  if (!S) return;
  S.busy = on;
  S.pct = on ? pct : null;
  const box = $('save');
  for (const el of box.querySelectorAll('input[type="text"], textarea')) el.readOnly = on;
  for (const el of box.querySelectorAll('select, input[type="file"], button:not(#svYes)')) el.disabled = on;
  if (!on) {
    S.abort = null;
    S.files = false;
    S.uploaded = false;
    S.slow = false;
  }
  paintCancel();
  paintSubmit();
}

function setLinkRow(open, { focus = false } = {}) {
  $('svLinkRow').hidden = !open;
  $('svLinkBtn').setAttribute('aria-expanded', String(open));
  if (!open) showUrlError('');
  if (open && focus) $('svUrl').focus();
}

/* ---------- 닫기 ---------- */

function hasContent() {
  if (!S) return false;
  return (
    $('svText').value.trim() !== '' ||
    S.items.length > 0 ||
    $('svTitle').value.trim() !== '' ||
    $('svUrl').value.trim() !== '' ||
    $('svNewName').value.trim() !== ''
  );
}

const FIELDS = ['svText', 'svUrl', 'svTitle', 'svNewName', 'svFile'];

function clearFields() {
  for (const id of FIELDS) $(id).value = '';
  $('svText').style.height = '';
  $('svChips').textContent = '';
  $('svCount').textContent = '';
  $('svAttHint').hidden = false;
  $('svMemoCnt').hidden = true;
  $('svMemoCnt').textContent = '';
}

function close() {
  const c = S;
  if (!c) return;
  S = null;
  for (const it of c.items) if (it.thumb) URL.revokeObjectURL(it.thumb);
  $('save').hidden = true;
  clearFields();
  setLinkRow(false);
  syncUnload();
  const prev = c.prevFocus;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
}

// 닫기 전에 창의 내용을 남긴다(미리보기 주소는 닫을 때 풀리므로 남기지 않는다)
function snapshot(c) {
  return {
    text: $('svText').value,
    title: $('svTitle').value,
    url: $('svUrl').value,
    newName: $('svNewName').value,
    planet: c.planet,
    extra: [...c.extra],
    fromAnswer: c.fromAnswer,
    items: c.items.map((it) => (it.kind === 'file' ? { kind: 'file', file: it.file, hint: it.hint } : { kind: 'link', url: it.url })),
  };
}

// 남겨 둔 내용을 막 연 빈 창에 되돌린다
function restore(snap) {
  for (const it of snap.items) {
    if (it.kind === 'link') {
      S.items.push({ id: ++itemSeq, kind: 'link', url: it.url, bad: false });
      continue;
    }
    let thumb = null;
    if (THUMB_TYPE.test(it.file.type) && it.file.size <= THUMB_MAX) {
      try {
        thumb = URL.createObjectURL(it.file);
      } catch {
        thumb = null;
      }
    }
    S.items.push({ id: ++itemSeq, kind: 'file', file: it.file, thumb, hint: it.hint, skip: null });
  }
  $('svText').value = snap.text;
  $('svTitle').value = snap.title;
  $('svUrl').value = snap.url;
  $('svNewName').value = snap.newName;
  S.fromAnswer = snap.fromAnswer ?? null;
  S.extra = snap.extra.filter((p) => !store.state.planets.some((q) => String(q.id) === String(p.id)));
  const known = snap.planet === 'new' || planetList().some((p) => String(p.id) === String(snap.planet));
  if (!known) {
    // 그 사이 행성이 사라졌으면 조용히 바꾸지 않고 다시 고르게 한다
    S.pick = true;
    S.planet = '';
  }
  rebuildPlanets(known ? snap.planet : '');
  if (snap.url.trim()) setLinkRow(true);
}

// 취소 · ✕ · Esc · 바깥 클릭. 쓰던 것이 있으면 먼저 묻는다.
// 파일을 올리는 중이면 멈출지 묻고(멈춰도 창과 내용은 남는다), 파일 없는 저장 중에는 응답이 늦어질 때만 닫을 수 있다.
function requestClose() {
  const c = S;
  if (!c || c.asking) return;
  if (c.busy) {
    if (c.uploaded) return; // 다 올라가 마무리하는 중: 멈출 수 없다
    if (c.files && c.abort) {
      const ctl = c.abort;
      c.asking = true;
      ask({ title: '올리기를 멈출까요?', desc: '쓴 글과 담은 첨부는 창에 그대로 남아요.', confirmLabel: '멈추기', confirmKind: 'pink' }).then((yes) => {
        c.asking = false;
        // 그 사이 다 올라갔으면 멈추지 않는다(서버가 저장한다). 뒤처리는 submit의 catch가 한다
        if (yes && S === c && c.abort === ctl && !c.uploaded) ctl.abort();
      });
    } else if (c.slow) {
      c.asking = true;
      ask({ title: '기다리지 않고 닫을까요?', desc: '저장이 뒤늦게 끝나면 별은 그대로 남아요.', confirmLabel: '닫기', confirmKind: 'pink' }).then((yes) => {
        c.asking = false;
        if (yes && S === c && c.busy && c.slow) {
          c.snapshot = snapshot(c); // 뒤늦게 실패하면 다음에 열 때 되돌려 놓는다
          close(); // 늦게 온 결과는 submit이 받아 알린다
        }
      });
    }
    return;
  }
  if (!hasContent()) {
    close();
    return;
  }
  c.asking = true;
  ask({ title: '쓰던 기록을 버릴까요?', desc: '입력한 내용이 사라져요.', confirmLabel: '버리기', confirmKind: 'pink' }).then((yes) => {
    c.asking = false;
    if (yes && S === c && !c.busy) close();
  });
}

/* ---------- 저장 ---------- */

// 띄운 별을 알리고 화면에 올린다(토스트 · 다시 받기 · 솟아오르기 · 목록의 분홍 표시). 창을 닫을지는 부르는 쪽이 정한다.
async function land(planetId, star, skipped) {
  store.state.lastPlanetId = planetId;
  toast(resultToast(skipped));
  try {
    await store.reload(); // 'data' → 우주 안이면 3D · 목록, 밖이면 홈의 숫자 · 카드가 다시 그려진다
  } catch {
    return; // 연결이 끊겼으면 연결 실패 카드가 알린다
  }
  if (!star) return;
  if (store.state.inWorld) {
    // 화면 가운데 아래(캐릭터 발밑)에서 솟아 그 행성 궤도로 들어간다
    const from = playerPosition();
    from.y -= FLY_DROP;
    flyStarIn(star.id, from);
  }
  flashStars([star.id]);
}

function focusAfterSave() {
  if (!S) return;
  paintSubmit();
  const yes = $('svYes');
  (yes.disabled ? $('svNo') : yes).focus();
}

// 주소 칸에 쳐 두고 더하지 않은 링크: 주소면 칩으로 더하고 저장을 이어 간다(true).
// 주소가 아니거나 더할 수 없으면 칸 아래에 알리고 칸으로 초점을 옮긴다(false). 칸의 글은 지우지 않는다.
function takeTypedLink() {
  const input = $('svUrl');
  const p = pendingLink(input.value, linkItems().map((it) => it.url));
  if (!p) return true;
  const fail = () => {
    setLinkRow(true);
    input.focus();
    return false;
  };
  if (p.error) {
    setLinkRow(true);
    showUrlError(p.error);
    return fail();
  }
  if (!p.dup && !addLink(p.url)) return fail();
  input.value = '';
  showUrlError('');
  paintSubmit();
  return true;
}

async function submit() {
  const c = S;
  if (!c || c.busy) return;
  if (!takeTypedLink()) return;
  if ($('svYes').disabled) return;
  const files = fileItems();
  const links = linkItems().map((it) => it.url);
  const body = $('svText').value;
  const title = submitTitle($('svTitle').value, titleParts());
  showError('');
  // 지난번에 서버가 뺀 표시는 지운다(이번 결과로 다시 표시한다)
  for (const it of files) it.skip = null;
  for (const it of linkItems()) it.bad = false;
  renderChips();
  const ctl = new AbortController();
  c.abort = ctl;
  c.files = files.length > 0;
  c.slow = false;
  setBusy(true, c.files ? 0 : null);
  // 파일 없는 저장은 멈출 수 없지만 끝없이 붙잡아 두지 않는다
  const slowTimer = c.files
    ? 0
    : setTimeout(() => {
        if (S !== c || !c.busy) return;
        c.slow = true;
        showError('응답이 늦어지고 있어요');
        paintCancel();
      }, SLOW_MS);

  let madePlanet = false;
  let planetId = c.planet;
  try {
    if (planetId === 'new') {
      // 행성을 먼저 만든다. 별 저장이 실패해도 행성은 남기고, 다시 누르면 그 행성을 그대로 쓴다.
      const planet = await api.createPlanet({ name: cleanPlanetName($('svNewName').value) });
      madePlanet = true;
      c.extra.push(planet);
      planetId = String(planet.id);
      if (S === c) {
        $('svNewName').value = '';
        rebuildPlanets(planetId);
      }
    }
    // 행성을 만드는 동안 누른 멈춤은 올리기 직전에 받는다
    if (ctl.signal.aborted) throw aborted();
    const res = await api.createStar(
      { planet_id: planetId, title, body, links, files: files.map((it) => it.file) },
      (pct) => {
        if (S !== c || !c.busy) return;
        c.pct = pct;
        paintSubmit();
      },
      {
        signal: ctl.signal,
        // 파일을 다 보냈다: 이제 서버가 저장하므로 "올리기 멈추기"를 "마무리하는 중…"으로 잠그고, 묻던 것은 거둔다
        onUploaded: () => {
          if (S !== c || !c.busy) return;
          c.uploaded = true;
          if (c.asking) closeAsk();
          paintCancel();
        },
      },
    );
    clearTimeout(slowTimer);
    // 멈출지 · 닫을지 묻는 사이에 끝났으면 그 물음은 거둔다
    if (c.asking && c.busy) closeAsk();
    if (S === c) close();
    // 챗봇 답에서 연 창이면 그 답에 "띄운 별"을 잇게 한다(chatThread.js가 듣는다)
    if (c.fromAnswer && res?.star?.id) store.emit('savedFromAnswer', { messageId: c.fromAnswer, starId: res.star.id });
    await land(planetId, res?.star, res?.skipped ?? []);
  } catch (err) {
    clearTimeout(slowTimer);
    if (c.asking && c.busy) closeAsk();
    if (S !== c) {
      if (madePlanet) store.reload().catch(() => {});
      if (c.snapshot) {
        // 기다리지 않고 닫은 저장이 뒤늦게 실패했다: 내용을 들고 있다가 다음에 빈 창을 열면 되돌린다
        stash = c.snapshot;
        if (madePlanet) {
          stash.planet = planetId; // 행성은 만들어졌으니 다시 만들지 않는다
          stash.newName = '';
          stash.extra = [...c.extra];
        }
        toast(LATE_FAIL);
      }
      return;
    }
    setBusy(false);
    if (err?.code === 'nothing_to_save') {
      // 같은 파일뿐이라 별을 만들지 않았다: 창을 그대로 두고 뺀 칩을 표시한다
      const skipped = Array.isArray(err.data?.skipped) ? err.data.skipped : [];
      const marks = matchSkipped(files, skipped);
      files.forEach((it, i) => {
        it.skip = marks[i];
      });
      renderChips();
      const message = nothingToast(skipped);
      showError(message);
      toast(message);
      if (madePlanet) store.reload().catch(() => {});
      focusAfterSave();
      return;
    }
    if (err?.code === 'unknown_planet') {
      // 고른 행성이 그 사이 지워졌다: 목록을 새로 받고, 아무것도 고르지 않은 자리에서 다시 고르게 한다
      c.extra = [];
      c.pick = true;
      c.planet = '';
      showError(saveError(err, c.files));
      rebuildPlanets('');
      await store.reload().catch(() => {});
      if (S === c && !c.busy) {
        paintSubmit();
        $('svPlanet').focus();
      }
      return;
    }
    if (err?.code === 'invalid_url' || err?.code === 'invalid_links') {
      // 서버가 받지 않은 링크: 짚을 수 있는 칩을 표시한다
      const bad = new Set(badLinks(links));
      linkItems().forEach((it, i) => {
        it.bad = bad.has(i);
      });
      renderChips();
    }
    if (err?.code === 'stop_late') store.reload().catch(() => {}); // 저장됐을 수 있다
    showError(saveError(err, files.length > 0));
    if (madePlanet) store.reload().catch(() => {});
    if (S === c && !c.busy) focusAfterSave();
  }
}

/* ---------- 입력 ---------- */

function onTextInput() {
  if (!S) return;
  growText();
  showError('');
  paintTitleHint();
  paintMemoCount();
  paintSubmit();
}

// 새 행성 이름은 서버처럼 다듬은 뒤의 글자(코드 포인트) 수로 20자까지. 한글을 조합하는 중에는 자르지 않는다.
function clampNewName(e) {
  const el = $('svNewName');
  if (!e?.isComposing) {
    const next = clampPlanetName(el.value);
    if (next !== el.value) el.value = next;
  }
  showError('');
  paintSubmit();
}

function submitUrl() {
  if (addLink($('svUrl').value)) {
    $('svUrl').value = '';
    showUrlError('');
    $('svUrl').focus();
  }
}

function onKeydown(e) {
  const box = $('save');
  trapTab(box, e);
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return; // 한글 조합을 끝내는 Enter
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    submit();
  } else if (e.target === $('svUrl')) {
    e.preventDefault();
    submitUrl();
  } else if (e.target instanceof HTMLInputElement) {
    e.preventDefault(); // 한 줄 입력칸의 Enter로는 저장하지 않는다(Ctrl+Enter로 저장)
  }
}

function wire() {
  if (wired) return;
  wired = true;
  const box = $('save');
  $('svX').innerHTML = ico('x');
  $('svAttachIco').outerHTML = ico('paperclip', 16);
  $('svLinkIco').outerHTML = ico('link', 16);
  wireBackdrop(box, requestClose);
  box.addEventListener('keydown', onKeydown);
  $('svForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  $('svNo').addEventListener('click', requestClose);
  $('svX').addEventListener('click', requestClose);

  $('svText').addEventListener('input', onTextInput);
  $('svTitle').addEventListener('input', () => showError(''));
  box.addEventListener('input', syncUnload); // 어느 칸이든 쓰기 시작하면 떠날 때 묻는다

  $('svAttach').addEventListener('click', () => {
    if (!room()) {
      toast(TOO_MANY_TOAST);
      return;
    }
    $('svFile').click();
  });
  $('svFile').addEventListener('change', () => {
    const picked = [...$('svFile').files];
    $('svFile').value = ''; // 같은 파일을 다시 골라도 change가 오게
    if (picked.length) addFiles(picked);
  });
  $('svLinkBtn').addEventListener('click', () => {
    const open = $('svLinkRow').hidden;
    setLinkRow(open, { focus: open });
    if (!open) $('svLinkBtn').focus();
  });
  $('svUrlAdd').addEventListener('click', submitUrl);
  $('svUrl').addEventListener('input', () => {
    // "htt"처럼 치는 중인 것은 봐준다. 칸을 떠나거나 붙이기를 누를 때 알린다
    const v = $('svUrl').value.trim().toLowerCase();
    const typing = 'https://'.startsWith(v) || 'http://'.startsWith(v);
    showUrlError(typing ? null : urlError(v));
    paintSubmit(); // 쳐 둔 링크도 내용이다
  });
  $('svUrl').addEventListener('blur', () => {
    if ($('svUrl').value.trim()) showUrlError(urlError($('svUrl').value));
  });
  $('svChips').addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-rm]') : null;
    if (btn) removeItem(btn.closest('.chip').dataset.id);
  });

  $('svPlanet').addEventListener('change', () => {
    if (!S) return;
    S.planet = $('svPlanet').value;
    if (S.pick && S.planet !== '') {
      S.pick = false;
      rebuildPlanets(S.planet); // "행성을 골라 주세요" 자리를 치운다
    }
    paintPlanet();
    showError('');
    paintSubmit();
    if (S.planet === 'new') $('svNewName').focus();
  });
  $('svNewName').addEventListener('input', clampNewName);
  $('svNewName').addEventListener('compositionend', () => clampNewName());

  // 다른 곳에서 행성이 바뀌면(만들기 · 지우기 · 이름 바꾸기) 선택 상자를 맞춘다
  store.on('data', () => {
    if (!S || S.busy) return;
    S.extra = S.extra.filter((p) => !store.state.planets.some((q) => String(q.id) === String(p.id)));
    const chosen = S.planet !== '' && S.planet !== 'new' ? String(S.planet) : null;
    const gone =
      chosen !== null &&
      !store.state.planets.some((p) => String(p.id) === chosen) &&
      !S.extra.some((p) => String(p.id) === chosen);
    if (gone) {
      // 조용히 다른 행성으로 바꾸지 않는다. 다시 고르게 한다.
      S.pick = true;
      S.planet = '';
      toast('고른 행성이 사라졌어요. 다시 골라 주세요');
    }
    rebuildPlanets(S.planet);
    paintSubmit();
  });

  // 우주에서 나갈 때: 비어 있는 창만 닫는다. 쓰던 것이 있거나 저장 중이면 그대로 둔다(창은 홈 위에도 떠 있고 내용을 잃지 않는다).
  store.on('leavingWorld', () => {
    if (S && !S.busy && !S.asking && !hasContent()) close();
  });
}

/* ---------- 밖에서 쓰는 것 ---------- */

/** 기록하기 창이 떠 있는지. */
export function isSaveOpen() {
  return S !== null;
}

/** 저장하는 중인지(이때는 더 받지 않는다). */
export function isSaveBusy() {
  return Boolean(S?.busy);
}

/** 묻지 않고 닫는다. 쓰던 내용은 사라진다. */
export function closeSave() {
  close();
}

/**
 * 기록하기 창을 연다(이미 열려 있으면 그 창에 더한다). 쓰던 글은 덮어쓰지 않는다.
 * files는 첨부 칩으로 더한다(hints는 같은 순서의 제목 힌트). url은 링크 칩. text는 글 칸이 비어 있을 때만 담고,
 * 이미 쓰던 글이 있으면 그대로 두었다고 토스트로 알린다.
 * @param {{ text?: string, url?: string, files?: File[], hints?: (string|null)[] }} [o]
 * @returns {boolean} 받았으면 true(저장 중이거나, 닫혀 있는데 담을 것이 하나도 없으면 false)
 */
export function openSave({ text, url, files, hints, fromAnswer } = {}) {
  wire();
  const list = Array.from(files ?? []);
  const hasText = typeof text === 'string' && text.trim() !== '';
  const hasUrl = typeof url === 'string' && url.trim() !== '';

  if (S) {
    if (S.busy) return false;
    if (list.length) addFiles(list, hints);
    if (hasUrl) addLink(url);
    if (hasText) {
      if ($('svText').value.trim() === '') {
        $('svText').value = text;
        if (fromAnswer) S.fromAnswer = String(fromAnswer); // 답이 실제로 들어갔을 때만
        onTextInput();
      } else {
        toast(KEPT_TOAST);
      }
    }
    return true;
  }

  // 닫혀 있는데 담을 수 있는 파일이 하나도 없으면(모두 500MB 초과) 창을 열지 않는다
  if (list.length && !hasText && !hasUrl && !planAdd({ incoming: list }).add.length) {
    toast(TOO_BIG_TOAST);
    return false;
  }

  S = fresh();
  S.prevFocus = document.activeElement;
  clearFields();
  setLinkRow(false);
  if (hasText) $('svText').value = text;
  if (hasText && fromAnswer) S.fromAnswer = String(fromAnswer);
  showError('');
  setBusy(false);
  rebuildPlanets(null);
  // 기다리지 않고 닫은 저장이 실패했으면 그 내용을 되돌린다(담아 온 것 없이 빈 창을 열 때만)
  if (stash && !hasText && !hasUrl && !list.length) {
    const snap = stash;
    stash = null;
    restore(snap);
  }
  if (list.length) addFiles(list, hints);
  if (hasUrl) addLink(url);
  renderChips();
  paintTitleHint();
  paintMemoCount();
  paintSubmit();

  $('save').hidden = false;
  growText();
  $('svBodyWrap').scrollTop = 0;
  $('svText').focus();
  return true;
}

// Esc = 취소(파일을 올리는 중이면 멈출지 묻고, 파일 없는 저장 중 · 묻는 중에는 키만 삼킨다). 열려 있는 동안 비행 키를 막는다.
registerEscape(60, () => {
  if (!S) return false;
  requestClose();
  return true;
});
setInputBlocked(isSaveOpen);
