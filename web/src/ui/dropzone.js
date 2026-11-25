// 끌어다 놓기 · 붙여넣기(스펙 6-3 · 6-9). W-00 · W-01 어디서나 받는다.
// 파일 · 링크 · 글을 화면 위로 가져오면 놓기 막(#dropveil, 쌓임 42)이 뜨고, 놓으면 기록하기 창에 담긴다
// (닫혀 있으면 연다. 쓰던 글은 그대로 둔다): 파일 → 첨부 칩, 주소 하나 → 링크 칩, 그 밖의 글 → 글 칸이 비어 있을 때만 글.
// 붙여넣기는 글 칸 밖에서만 받는다. 다만 글 없이 파일(그림)만 붙여넣으면 기록하기 창의 글 칸에서도 칩으로 받는다.
// 밖에서 끌어온 링크는 브라우저가 그 주소로 떠나 버리지 않게 늘 여기서 막는다(글 칸에 놓는 것만 브라우저에 맡긴다).
// 이 화면 안에서 시작한 끌기(미리보기 그림 · 링크 · 고른 글)는 받지 않는다.
import { isAccountOpen, isSignedIn } from './account.js';
import { isCharacterFormOpen } from './characterForm.js';
import { isAskOpen } from './confirm.js';
import { isPlanetDeleteOpen } from './planetDelete.js';
import { isPlanetFormOpen } from './planetForm.js';
import { FOLDER_TOAST, classifyDrop, classifyPaste, pastedHint, splitDropped } from './saveLogic.js';
import { isSaveBusy, isSaveOpen, openSave } from './saveModal.js';
import { toast } from './toast.js';
import { isTransitioning } from './transition.js';

const BUSY_TOAST = '올리는 중에는 담을 수 없어요';
const IDLE_MS = 1200; // dragover가 이만큼 오지 않으면 끌기가 끝난 것으로 본다(막이 남지 않게)
const TEXT_INPUT = /^(text|search|url|tel|email|password|number|)$/i;

let wired = false;
let depth = 0; // dragenter − dragleave. 자식 요소를 넘나들 때 막이 깜빡이지 않게 센다
let idleTimer = 0;
let internal = false; // 이 화면 안에서 시작한 끌기인지(dragstart ~ dragend · drop)

const veil = () => document.getElementById('dropveil');

// 로그인 전이거나, 확인 창 · 행성 꾸미기 창 · 캐릭터 꾸미기 창 · 행성 삭제 창 · 로그인 · 계정 설정 창이 떠 있거나,
// 전환 중이거나, 저장하는 중이면 받지 않는다
const otherBlocked = () =>
  !isSignedIn() || isAskOpen() || isPlanetFormOpen() || isCharacterFormOpen() || isPlanetDeleteOpen() || isAccountOpen() || isTransitioning();
const blocked = () => otherBlocked() || isSaveBusy();
// 저장하는 중에 놓거나 붙여넣은 것은 받지 않고 알린다(다른 창이 막고 있으면 조용히 둔다)
const busyOnly = () => isSaveBusy() && !otherBlocked();

// 끌려온 것의 종류: 'files' | 'text'(링크 · 글) | null(우리가 다루지 않는 것)
function kindOf(e) {
  const types = Array.from(e.dataTransfer?.types ?? []);
  if (types.includes('Files')) return 'files';
  if (types.includes('text/uri-list') || types.includes('text/plain')) return 'text';
  return null;
}

// 글을 받을 수 있는 칸(브라우저가 놓은 글을 그 칸에 넣는다). 잠긴 칸은 받지 못하므로 아니다.
function isTextField(target) {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUT.test(el.getAttribute('type') ?? '') && !el.readOnly && !el.disabled;
  return el.isContentEditable;
}

// 브라우저에 맡길 끌기: 다루지 않는 종류이거나, 글 칸 위의 링크 · 글
const leaveAlone = (e, kind) => kind === null || (kind === 'text' && isTextField(e.target));

function show(on) {
  const el = veil();
  if (el) el.hidden = !on;
  document.body.classList.toggle('dragging-files', on);
  clearTimeout(idleTimer);
  if (on) idleTimer = setTimeout(reset, IDLE_MS);
}

function reset() {
  depth = 0;
  show(false);
}

function onDragStart() {
  internal = true;
}

function onDragEnd() {
  internal = false;
  reset();
}

function onDragEnter(e) {
  const kind = kindOf(e);
  if (kind === null || internal) return;
  depth += 1;
  if (leaveAlone(e, kind)) {
    show(false);
    return;
  }
  e.preventDefault();
  show(!blocked());
}

function onDragOver(e) {
  const kind = kindOf(e);
  if (leaveAlone(e, kind)) {
    if (kind !== null && !internal) show(false);
    return;
  }
  e.preventDefault(); // 받지 않을 때도 막는다(브라우저가 놓은 파일을 열거나 링크로 떠나지 않게)
  const off = internal || blocked();
  e.dataTransfer.dropEffect = off ? 'none' : 'copy';
  if (!internal) show(!off);
}

function onDragLeave(e) {
  if (kindOf(e) === null || internal) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) show(false);
}

function onDrop(e) {
  const kind = kindOf(e);
  const mine = internal;
  internal = false;
  reset();
  if (leaveAlone(e, kind)) return;
  e.preventDefault();
  if (mine) return;
  if (blocked()) {
    if (busyOnly()) toast(BUSY_TOAST);
    return;
  }
  // 목록은 이 처리가 끝나면 비워지므로 여기서 바로 꺼낸다
  const dt = e.dataTransfer;
  if (kind === 'files') {
    const { files, folders } = dt.items?.length ? splitDropped(dt.items) : { files: [...(dt.files ?? [])], folders: 0 };
    if (folders) toast(FOLDER_TOAST);
    if (files.length) {
      openSave({ files }); // 500MB 초과 · 50개 초과 · 이미 담긴 파일은 기록하기 창이 빼고 알린다
      return;
    }
    if (folders) return;
  }
  // 링크 · 글(파일이라고 왔지만 꺼낼 파일이 없을 때도 여기로 온다)
  const found = classifyDrop({ types: Array.from(dt.types ?? []), uriList: dt.getData('text/uri-list'), text: dt.getData('text/plain') });
  if (found) openSave(found); // 쓰던 글이 있으면 덮어쓰지 않는다(링크는 칩으로 더한다)
}

function isField(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || Boolean(el.closest('[contenteditable=""],[contenteditable="true"]'));
}

function onPaste(e) {
  if (otherBlocked()) return;
  const data = e.clipboardData;
  if (!data) return;
  const files = [...(data.files ?? [])];
  const text = data.getData('text/plain');
  if (isField(e.target)) {
    // 저장하는 동안 잠긴 기록하기 창의 칸에 붙여넣은 것도 알린다
    if (isSaveBusy() && e.target.closest?.('#save') && (files.length || text.trim())) {
      e.preventDefault();
      toast(BUSY_TOAST);
      return;
    }
    // 칸 안의 붙여넣기는 브라우저에 맡긴다. 기록하기 창 안에서 글 없이 파일만 붙여넣은 것만 칩으로 받는다
    if (!(isSaveOpen() && e.target.closest?.('#save') && files.length && !text.trim())) return;
  }
  const found = classifyPaste({ files, text });
  if (!found) return;
  e.preventDefault();
  if (isSaveBusy()) {
    toast(BUSY_TOAST);
    return;
  }
  if (found.kind === 'files') {
    // 클립보드 그림은 이름이 늘 image.png라 제목 힌트를 붙인다
    openSave({ files: found.files, hints: found.files.map(pastedHint) });
  } else {
    openSave(found);
  }
}

/** 끌어다 놓기 · 붙여넣기를 받기 시작한다(한 번만). */
export function initDropzone() {
  if (wired) return;
  wired = true;
  window.addEventListener('dragstart', onDragStart);
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('dragend', onDragEnd);
  // 끌던 요소가 사라지면 dragend가 오지 않을 수 있다. 새로 누르면 앞의 끌기는 끝난 것이다
  window.addEventListener('pointerdown', () => {
    internal = false;
  });
  window.addEventListener('blur', reset);
  document.addEventListener('paste', onPaste);
}
