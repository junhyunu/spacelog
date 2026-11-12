// W-05 저장 창 "별 띄우기"(#save, 스펙 6-4). 글 · 링크 · 파일을 행성의 별로 저장한다.
// 여는 곳: "기록하기"(#hLog · #wLog · 빈 우주 카드 → 'openSave' 이벤트, main.js), 끌어다 놓기 · 붙여넣기(dropzone.js).
// Esc는 escape.js의 60번 자리(행성 꾸미기 창 다음, 전환 건너뛰기 앞). 열려 있는 동안 비행 키를 받지 않는다.
import { api } from '../api.js';
import { store } from '../store.js';
import { playerPosition, setInputBlocked } from '../three/controls.js';
import { flyStarIn } from '../three/planets.js';
import { PLANET_COLORS, esc, fileSize, firstLine, ico } from '../util.js';
import { ask, closeAsk } from './confirm.js';
import { registerEscape } from './escape.js';
import { flashStars } from './panel.js';
import { trapTab, wireBackdrop } from './planetForm.js';
import {
  FILES_MAX,
  TOO_BIG_TOAST,
  TOO_MANY_TOAST,
  canSubmit,
  clampPlanetName,
  cleanPlanetName,
  dedupeFiles,
  defaultPlanetId,
  fileStem,
  partitionBySize,
  remainingAfterUpload,
  remainingMessage,
  resultToast,
  saveError,
  urlError,
} from './saveLogic.js';
import { toast } from './toast.js';

const $ = (id) => document.getElementById(id);
const TABS = ['text', 'link', 'file'];
const PANES = { text: 'svPaneText', link: 'svPaneLink', file: 'svPaneFile' };
const TITLE_HINT = {
  text: '비워 두면 글의 첫 줄을 써요',
  link: '비워 두면 링크 제목을 가져와요',
  file: '비워 두면 파일 이름을 써요',
};
const FLY_MAX = 12; // 한 번에 솟는 별의 수(그보다 많으면 나머지는 제자리에 바로 뜬다)
const FLY_DROP = 6; // 캐릭터 아래 이만큼에서 솟는다
const THUMB_TYPE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
const THUMB_MAX = 30 * 1024 * 1024; // 이보다 큰 이미지는 미리보기를 만들지 않는다
const SLOW_MS = 15000; // 글 · 링크 저장이 이보다 오래 걸리면 취소를 다시 열어 준다
const KEPT_TOAST = '이미 쓰던 내용이 있어 그대로 두었어요';
const aborted = () => Object.assign(new Error('aborted'), { code: 'aborted' });

// 열려 있는 동안의 상태. 글 · 주소 · 메모 · 새 행성 이름은 입력칸이 그대로 들고 있다(탭을 바꿔도 남는다).
let S = null;
let wired = false;
let itemSeq = 0;

function fresh() {
  return {
    tab: 'text',
    textTitle: '', // 글 탭의 제목
    textTouched: false, // 제목을 직접 고쳤는지(그 전까지는 본문 첫 줄을 따라간다)
    linkTitle: '',
    items: [], // 파일 탭: { id, file, title, url }
    planet: 'new',
    pick: false, // 고른 행성이 사라져 다시 골라야 하는 동안(선택 상자 맨 위에 "행성을 골라 주세요"가 생긴다)
    extra: [], // 이 창에서 만들었지만 아직 store에 없는 행성
    busy: false,
    abort: null, // 파일을 올리는 동안의 AbortController(이때만 멈출 수 있다)
    slow: false, // 글 · 링크 저장의 응답이 늦어져 취소를 다시 열어 둔 동안
    pct: null,
    asking: false,
    prevFocus: null,
  };
}

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
  dot.style.background = planet ? (PLANET_COLORS[planet.color_index]?.face ?? '') : '';
  $('svNewName').hidden = !isNew;
}

// 선택 상자를 다시 채운다. wanted가 목록에 없으면 기본값(패널의 행성 → 마지막 저장 행성 → 첫 행성 → 새 행성).
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
      lastPlanetId: store.state.lastPlanetId,
      planets: list,
    });
  }
  sel.value = value;
  S.planet = value;
  paintPlanet();
}

/* ---------- 파일 목록 ---------- */

function renderFiles() {
  if (!S) return;
  const list = $('svFiles');
  const multi = S.items.length > 1;
  list.hidden = S.items.length === 0;
  list.innerHTML = S.items
    .map((it) => {
      const name = it.file.name || '이름 미확인';
      const isImage = String(it.file.type).startsWith('image/');
      const thumb = it.url ? `<img src="${esc(it.url)}" alt="">` : ico(isImage ? 'image' : 'file-text', 17);
      const main = multi
        ? `<input type="text" class="ft" maxlength="200" autocomplete="off" value="${esc(it.title)}" placeholder="${esc(TITLE_HINT.file)}" aria-label="${esc(name)} 제목">`
        : `<span class="fn">${esc(name)}</span>`;
      const sub = multi ? `${esc(name)} · ${esc(fileSize(it.file.size))}` : esc(fileSize(it.file.size));
      return (
        `<li class="frow" data-id="${it.id}"><span class="th">${thumb}</span>` +
        `<div class="fm">${main}<small>${sub}</small></div>` +
        `<button type="button" class="btn x ghost" data-rm aria-label="${esc(name)} 빼기">${ico('x', 16)}</button></li>`
      );
    })
    .join('');
}

// 파일을 담는다. 500MB 초과 · 이미 담긴 파일 · 500개 초과분은 빼고 토스트로 알린다. 담은 개수를 돌려준다.
function addFiles(files, titles) {
  if (!S) return 0;
  const incoming = Array.from(files ?? []);
  const titleOf = new Map(incoming.map((f, i) => [f, titles?.[i]]));
  const { ok, tooBig } = partitionBySize(incoming);
  let add = dedupeFiles(
    S.items.map((it) => it.file),
    ok,
  );
  let notice = tooBig.length ? TOO_BIG_TOAST : ok.length && !add.length ? '이미 담긴 파일이에요' : null;
  const room = Math.max(0, FILES_MAX - S.items.length);
  if (add.length > room) {
    add = add.slice(0, room);
    notice = TOO_MANY_TOAST;
  }
  for (const file of add) {
    const title = titleOf.get(file);
    let url = null;
    if (THUMB_TYPE.test(file.type) && file.size <= THUMB_MAX) {
      try {
        url = URL.createObjectURL(file);
      } catch {
        url = null;
      }
    }
    S.items.push({ id: ++itemSeq, file, title: typeof title === 'string' && title ? title : fileStem(file.name), url });
  }
  if (notice) toast(notice);
  if (add.length) {
    showError('');
    renderFiles();
    paintTab();
  }
  return add.length;
}

function removeFile(id) {
  if (!S || S.busy) return;
  const at = S.items.findIndex((it) => String(it.id) === String(id));
  if (at < 0) return;
  const [gone] = S.items.splice(at, 1);
  if (gone.url) URL.revokeObjectURL(gone.url);
  renderFiles();
  paintTab();
  // 지운 자리의 다음 항목(없으면 "파일 고르기")으로 초점을 옮긴다
  const next = $('svFiles').querySelectorAll('[data-rm]')[Math.min(at, S.items.length - 1)];
  (next ?? $('svPick')).focus();
}

/* ---------- 그리기 ---------- */

function showError(message) {
  const el = $('svErr');
  el.textContent = message || '';
  el.hidden = !message;
}

// 주소 칸 아래의 안내와 aria-invalid를 함께 맞춘다. strict(칸을 떠날 때)가 아니면 "htt"처럼 치는 중인 것은 봐준다.
function paintUrlError(strict = false) {
  const value = $('svUrl').value.trim().toLowerCase();
  const typing = !strict && ('https://'.startsWith(value) || 'http://'.startsWith(value));
  const message = typing ? null : urlError(value);
  const el = $('svUrlErr');
  el.textContent = message || '';
  el.hidden = !message;
  $('svUrl').setAttribute('aria-invalid', String(Boolean(message)));
}

function paintSubmit() {
  if (!S) return;
  const yes = $('svYes');
  const ready = canSubmit({
    tab: S.tab,
    text: $('svText').value,
    url: $('svUrl').value,
    files: S.items,
    planetId: S.planet,
    newPlanetName: $('svNewName').value,
  });
  yes.disabled = S.busy || !ready;
  yes.textContent = !S.busy ? '별 띄우기' : S.pct === null ? '띄우는 중…' : `띄우는 중… ${S.pct}%`;
  yes.setAttribute('aria-busy', String(S.busy));
  syncUnload();
}

// 취소 · ✕: 파일을 올리는 동안에는 "올리기 멈추기"로 살아 있고, 글 · 링크 저장은 응답이 늦어질 때만 다시 열린다.
function paintCancel() {
  if (!S) return;
  const off = S.busy && !S.abort && !S.slow;
  $('svNo').disabled = off;
  $('svX').disabled = off;
  $('svNo').textContent = S.busy && S.abort ? '올리기 멈추기' : '취소';
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

// 탭 · 내용 영역 · 제목 칸을 지금 탭에 맞춘다. 입력한 내용은 건드리지 않는다.
function paintTab() {
  if (!S) return;
  for (const btn of $('svTabs').querySelectorAll('[role="tab"]')) {
    const on = btn.dataset.tab === S.tab;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  for (const tab of TABS) $(PANES[tab]).hidden = tab !== S.tab;

  // 파일이 2개 이상이면 제목은 목록에서 파일별로 쓴다. 파일이 없을 때도 쓸 제목이 없으니 숨긴다.
  const title = $('svTitle');
  $('svTitleFld').hidden = S.tab === 'file' && S.items.length !== 1;
  title.placeholder = TITLE_HINT[S.tab];
  if (S.tab === 'text') title.value = S.textTitle;
  else if (S.tab === 'link') title.value = S.linkTitle;
  else title.value = S.items.length === 1 ? S.items[0].title : '';
  paintSubmit();
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
    S.slow = false;
  }
  paintCancel();
  paintSubmit();
}

function setTab(tab) {
  if (!S || S.busy || !TABS.includes(tab)) return;
  S.tab = tab;
  paintTab();
}

function focusContent() {
  if (!S) return;
  const el = S.tab === 'text' ? $('svText') : S.tab === 'link' ? $('svUrl') : $('svPick');
  el.focus();
}

/* ---------- 닫기 ---------- */

function hasContent() {
  if (!S) return false;
  return (
    $('svText').value.trim() !== '' ||
    $('svUrl').value.trim() !== '' ||
    S.items.length > 0 ||
    $('svMemo').value.trim() !== '' ||
    $('svNewName').value.trim() !== '' ||
    S.textTouched ||
    S.linkTitle.trim() !== ''
  );
}

function close() {
  const c = S;
  if (!c) return;
  S = null;
  for (const it of c.items) if (it.url) URL.revokeObjectURL(it.url);
  $('save').hidden = true;
  for (const id of ['svText', 'svUrl', 'svTitle', 'svMemo', 'svNewName', 'svFile']) $(id).value = '';
  $('svFiles').textContent = '';
  syncUnload();
  const prev = c.prevFocus;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
}

// 취소 · ✕ · Esc · 바깥 클릭. 쓰던 것이 있으면 먼저 묻는다.
// 파일을 올리는 중이면 멈출지 묻고(멈춰도 창과 목록은 남는다), 글 · 링크를 저장하는 중에는 응답이 늦어질 때만 닫을 수 있다.
function requestClose() {
  const c = S;
  if (!c || c.asking) return;
  if (c.busy) {
    if (c.abort) {
      const ctl = c.abort;
      c.asking = true;
      ask({ title: '올리기를 멈출까요?', desc: '이미 올라간 파일은 별로 남아요.', confirmLabel: '멈추기', confirmKind: 'pink' }).then((yes) => {
        c.asking = false;
        if (yes && S === c && c.abort === ctl) ctl.abort(); // 뒤처리는 submit의 catch가 한다
      });
    } else if (c.slow) {
      c.asking = true;
      ask({ title: '기다리지 않고 닫을까요?', desc: '저장이 뒤늦게 끝나면 별은 그대로 남아요.', confirmLabel: '닫기', confirmKind: 'pink' }).then((yes) => {
        c.asking = false;
        if (yes && S === c && c.busy && c.slow) close(); // 늦게 온 결과는 submit이 받아 알린다
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
async function land(planetId, result) {
  const ids = result.created.map((s) => s.id);
  store.state.lastPlanetId = planetId;
  toast(resultToast(result));
  try {
    await store.reload(); // 'data' → 우주 안이면 3D · 목록, 밖이면 홈의 숫자 · 카드가 다시 그려진다
  } catch {
    return; // 연결이 끊겼으면 연결 실패 카드가 알린다
  }
  if (store.state.inWorld) {
    // 화면 가운데 아래(캐릭터 발밑)에서 솟아 그 행성 궤도로 들어간다
    const from = playerPosition();
    from.y -= FLY_DROP;
    for (const id of ids.slice(0, FLY_MAX)) flyStarIn(id, from);
  }
  flashStars(ids);
}

// 일부만 저장됐다: 저장되지 않은 파일만 목록에 남기고 창을 그대로 둔다.
function keepUnsaved(c, unsaved, skipped) {
  const keep = new Set(unsaved);
  for (const it of c.items) if (!keep.has(it) && it.url) URL.revokeObjectURL(it.url);
  c.items = unsaved;
  setBusy(false);
  renderFiles();
  paintTab();
  showError(remainingMessage(unsaved.length, skipped));
}

function focusAfterSave() {
  if (!S) return;
  paintSubmit();
  const yes = $('svYes');
  (yes.disabled ? $('svNo') : yes).focus();
}

async function submit() {
  const c = S;
  if (!c || c.busy || $('svYes').disabled) return;
  const tab = c.tab;
  const memo = $('svMemo').value;
  const title = $('svTitle').value.trim();
  showError('');
  // 파일 올리기는 처음부터 멈출 수 있다(행성을 만드는 동안 누른 멈춤은 올리기 직전에 받는다)
  const ctl = tab === 'file' ? new AbortController() : null;
  c.abort = ctl;
  c.slow = false;
  setBusy(true, tab === 'file' ? 0 : null);
  // 글 · 링크는 멈출 수 없지만 끝없이 붙잡아 두지 않는다
  const slowTimer = ctl
    ? 0
    : setTimeout(() => {
        if (S !== c || !c.busy) return;
        c.slow = true;
        showError('응답이 늦어지고 있어요');
        paintCancel();
      }, SLOW_MS);

  let madePlanet = false;
  try {
    let planetId = c.planet;
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

    let result;
    if (tab === 'text') {
      const star = await api.createStar({ type: 'text', title, body: $('svText').value, planet_id: planetId, memo });
      result = { created: [star], skipped: [] };
    } else if (tab === 'link') {
      const star = await api.createStar({ type: 'link', title, url: $('svUrl').value.trim(), planet_id: planetId, memo });
      result = { created: [star], skipped: [] };
    } else {
      if (ctl.signal.aborted) throw aborted();
      const res = await api.uploadStars(
        { planet_id: planetId, memo, files: c.items.map((it) => it.file), titles: c.items.map((it) => it.title.trim()) },
        (pct) => {
          if (S !== c || !c.busy) return;
          c.pct = pct;
          paintSubmit();
        },
        { signal: ctl.signal },
      );
      result = { created: res?.created ?? [], skipped: res?.skipped ?? [] };
    }
    clearTimeout(slowTimer);
    // 멈출지 · 닫을지 묻는 사이에 끝났으면 그 물음은 거둔다
    if (c.asking && c.busy) closeAsk();

    if (S !== c) {
      // 기다리다 닫은 뒤에 끝났다: 별은 생겼으니 알리고 화면에 올린다
      if (result.created.length) await land(planetId, result);
      else if (madePlanet) store.reload().catch(() => {});
      return;
    }
    const unsaved =
      tab === 'file' && result.skipped.some((s) => s?.reason !== 'duplicate' && s?.reason !== 'too_large')
        ? remainingAfterUpload(c.items, result)
        : [];
    if (unsaved.length) {
      keepUnsaved(c, unsaved, result.skipped);
      if (result.created.length) await land(planetId, result);
      else {
        toast(resultToast(result));
        if (madePlanet) store.reload().catch(() => {});
      }
      if (S === c && !c.busy) focusAfterSave();
      return;
    }
    if (result.created.length) {
      close();
      await land(planetId, result);
      return;
    }
    // 하나도 저장되지 않았다(같은 파일 등): 창을 그대로 두고 알린다
    setBusy(false);
    const message = resultToast(result);
    showError(message);
    toast(message);
    if (madePlanet) store.reload().catch(() => {});
  } catch (err) {
    clearTimeout(slowTimer);
    if (c.asking && c.busy) closeAsk();
    if (S !== c) {
      if (madePlanet) store.reload().catch(() => {});
      return;
    }
    if (err?.code === 'unknown_planet') {
      // 고른 행성이 그 사이 지워졌다: 목록을 새로 받고, 아무것도 고르지 않은 자리에서 다시 고르게 한다
      c.extra = [];
      c.pick = true;
      c.planet = '';
    }
    setBusy(false);
    showError(saveError(err, tab));
    if (err?.code === 'unknown_planet') {
      rebuildPlanets('');
      await store.reload().catch(() => {});
      if (S === c && !c.busy) {
        paintSubmit();
        $('svPlanet').focus();
      }
      return;
    }
    if (err?.code === 'aborted') {
      // 멈추기 전에 다 올라간 파일은 이미 별이 됐다. 목록은 그대로 두고 화면만 다시 받는다
      await store.reload().catch(() => {});
    } else if (madePlanet) {
      store.reload().catch(() => {});
    }
    if (S === c && !c.busy) focusAfterSave();
  }
}

/* ---------- 입력 ---------- */

function onTitleInput() {
  if (!S) return;
  const value = $('svTitle').value;
  if (S.tab === 'text') {
    S.textTitle = value;
    S.textTouched = value.trim() !== ''; // 비우면 다시 본문 첫 줄을 따라간다
  } else if (S.tab === 'link') {
    S.linkTitle = value;
  } else if (S.items.length === 1) {
    S.items[0].title = value;
  }
}

function onTextInput() {
  if (!S) return;
  if (!S.textTouched) {
    S.textTitle = firstLine($('svText').value, 40);
    if (S.tab === 'text') $('svTitle').value = S.textTitle;
  }
  showError('');
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

function onTabsKeydown(e) {
  const at = TABS.indexOf(e.target?.dataset?.tab);
  if (at < 0 || !S || S.busy) return;
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % TABS.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at + TABS.length - 1) % TABS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TABS.length - 1;
  if (next === null) return;
  e.preventDefault();
  setTab(TABS[next]);
  $('svTabs').querySelector(`[data-tab="${TABS[next]}"]`).focus();
}

function onKeydown(e) {
  const box = $('save');
  trapTab(box, e);
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return; // 한글 조합을 끝내는 Enter
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    submit();
  } else if (e.target instanceof HTMLInputElement) {
    e.preventDefault(); // 한 줄 입력칸의 Enter로는 저장하지 않는다(Ctrl+Enter로 저장)
  }
}

function wire() {
  if (wired) return;
  wired = true;
  const box = $('save');
  $('svX').innerHTML = ico('x');
  wireBackdrop(box, requestClose);
  box.addEventListener('keydown', onKeydown);
  $('svForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  $('svNo').addEventListener('click', requestClose);
  $('svX').addEventListener('click', requestClose);

  $('svTabs').addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
    if (btn) setTab(btn.dataset.tab);
  });
  $('svTabs').addEventListener('keydown', onTabsKeydown);

  $('svText').addEventListener('input', onTextInput);
  $('svUrl').addEventListener('input', () => {
    paintUrlError();
    showError('');
    paintSubmit();
  });
  $('svUrl').addEventListener('blur', () => paintUrlError(true));
  $('svTitle').addEventListener('input', onTitleInput);
  $('svMemo').addEventListener('input', () => showError(''));
  box.addEventListener('input', syncUnload); // 어느 칸이든 쓰기 시작하면 떠날 때 묻는다

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

  $('svPick').addEventListener('click', () => $('svFile').click());
  $('svFile').addEventListener('change', () => {
    const picked = [...$('svFile').files];
    $('svFile').value = ''; // 같은 파일을 다시 골라도 change가 오게
    if (picked.length) addFiles(picked);
  });
  $('svFiles').addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-rm]') : null;
    if (btn) removeFile(btn.closest('.frow').dataset.id);
  });
  $('svFiles').addEventListener('input', (e) => {
    const row = e.target instanceof Element ? e.target.closest('.frow') : null;
    const item = row && S?.items.find((it) => String(it.id) === row.dataset.id);
    if (item) item.title = e.target.value;
  });

  // 다른 곳에서 행성이 바뀌면(만들기 · 지우기 · 이름 바꾸기) 선택 상자를 맞춘다
  store.on('data', () => {
    if (!S || S.busy) return;
    S.extra = S.extra.filter((p) => !store.state.planets.some((q) => String(q.id) === String(p.id)));
    rebuildPlanets(S.planet);
    paintSubmit();
  });

  // 우주에서 나갈 때: 비어 있는 창만 닫는다. 쓰던 것이 있거나 저장 중이면 그대로 둔다(창은 홈 위에도 떠 있고 내용을 잃지 않는다).
  store.on('leavingWorld', () => {
    if (S && !S.busy && !S.asking && !hasContent()) close();
  });
}

/* ---------- 밖에서 쓰는 것 ---------- */

/** 저장 창이 떠 있는지. */
export function isSaveOpen() {
  return S !== null;
}

/** 저장하는 중인지(이때는 파일을 더 받지 않는다). */
export function isSaveBusy() {
  return Boolean(S?.busy);
}

/** 묻지 않고 닫는다. 쓰던 내용은 사라진다. */
export function closeSave() {
  close();
}

/**
 * 저장 창을 연다. 이미 열려 있으면 files는 파일 탭 목록에 더하고(하나라도 담겼을 때만) 파일 탭으로 옮기며,
 * text · url은 그 칸이 비어 있을 때만 담는다(쓰던 것을 덮어쓰지 않고, 그대로 두었다고 토스트로 알린다).
 * titles는 files와 같은 순서의 제목(없으면 파일 이름에서 확장자를 뺀 것).
 * @param {{ tab?: 'text'|'link'|'file', text?: string, url?: string, files?: File[], titles?: string[] }} [o]
 * @returns {boolean} 받았으면 true(저장 중이거나 담을 파일이 하나도 없으면 false)
 */
export function openSave({ tab = 'text', text, url, files, titles } = {}) {
  wire();
  const list = Array.from(files ?? []);
  const hasText = typeof text === 'string' && text.trim() !== '';
  const hasUrl = typeof url === 'string' && url.trim() !== '';

  if (S) {
    if (S.busy) return false;
    if (list.length) {
      // 하나라도 담겼을 때만 파일 탭으로 옮긴다(모두 이미 담긴 파일이면 addFiles가 "이미 담긴 파일이에요"라고 알린다)
      if (addFiles(list, titles) > 0) setTab('file');
    } else if (hasText) {
      if ($('svText').value.trim() === '') {
        $('svText').value = text;
        onTextInput();
        setTab('text');
      } else {
        toast(KEPT_TOAST);
      }
    } else if (hasUrl) {
      if ($('svUrl').value.trim() === '') {
        $('svUrl').value = url.trim();
        paintUrlError();
        showError('');
        setTab('link');
      } else {
        toast(KEPT_TOAST);
      }
    }
    return true;
  }

  // 담을 수 있는 파일이 하나도 없으면 창을 열지 않는다
  if (list.length && !partitionBySize(list).ok.length) {
    toast(TOO_BIG_TOAST);
    return false;
  }

  S = fresh();
  S.prevFocus = document.activeElement;
  S.tab = TABS.includes(tab) ? tab : 'text';
  for (const id of ['svText', 'svUrl', 'svTitle', 'svMemo', 'svNewName', 'svFile']) $(id).value = '';
  if (hasText) {
    $('svText').value = text;
    S.textTitle = firstLine(text, 40);
  }
  if (hasUrl) $('svUrl').value = url.trim();
  showError('');
  setBusy(false);
  rebuildPlanets(null);
  renderFiles();
  if (list.length) addFiles(list, titles);
  paintUrlError();
  paintTab();

  $('save').hidden = false;
  $('svBodyWrap').scrollTop = 0;
  focusContent();
  return true;
}

// Esc = 취소(파일을 올리는 중이면 멈출지 묻고, 글 · 링크 저장 중 · 묻는 중에는 키만 삼킨다). 열려 있는 동안 비행 키를 막는다.
registerEscape(60, () => {
  if (!S) return false;
  requestClose();
  return true;
});
setInputBlocked(isSaveOpen);
