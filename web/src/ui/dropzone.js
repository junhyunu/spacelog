// 끌어다 놓기 · 붙여넣기(스펙 6-3). W-00 · W-01 어디서나 받는다.
// 파일을 화면 위로 가져오면 놓기 막(#dropveil, 쌓임 42)이 뜨고, 놓으면 저장 창이 파일 탭으로 열린다.
// 저장 창이 이미 열려 있으면 놓은 파일을 그 목록에 더한다. 저장 창의 점선 상자에 놓은 것도 여기서 한 번만 받는다.
import { isAskOpen } from './confirm.js';
import { isPlanetDeleteOpen } from './planetDelete.js';
import { isPlanetFormOpen } from './planetForm.js';
import { FOLDER_TOAST, classifyPaste, pastedTitle, splitDropped } from './saveLogic.js';
import { isSaveBusy, openSave } from './saveModal.js';
import { toast } from './toast.js';
import { isTransitioning } from './transition.js';

const IDLE_MS = 1200; // dragover가 이만큼 오지 않으면 끌기가 끝난 것으로 본다(막이 남지 않게)

let wired = false;
let depth = 0; // dragenter − dragleave. 자식 요소를 넘나들 때 막이 깜빡이지 않게 센다
let idleTimer = 0;

const veil = () => document.getElementById('dropveil');

// 확인 창 · 행성 꾸미기 창 · 행성 삭제 창이 떠 있거나, 전환 중이거나, 저장하는 중이면 받지 않는다
const blocked = () => isAskOpen() || isPlanetFormOpen() || isPlanetDeleteOpen() || isTransitioning() || isSaveBusy();

function hasFiles(e) {
  const types = e.dataTransfer?.types;
  return Boolean(types) && Array.from(types).includes('Files');
}

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

function onDragEnter(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth += 1;
  show(!blocked());
}

function onDragOver(e) {
  if (!hasFiles(e)) return;
  e.preventDefault(); // 받지 않을 때도 막는다(브라우저가 놓은 파일을 열지 않게)
  const off = blocked();
  e.dataTransfer.dropEffect = off ? 'none' : 'copy';
  show(!off);
}

function onDragLeave(e) {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) show(false);
}

function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  reset();
  if (blocked()) return;
  // 목록은 이 처리가 끝나면 비워지므로 여기서 바로 꺼낸다
  const dt = e.dataTransfer;
  const { files, folders } = dt.items?.length ? splitDropped(dt.items) : { files: [...(dt.files ?? [])], folders: 0 };
  if (folders) toast(FOLDER_TOAST);
  if (files.length) openSave({ tab: 'file', files }); // 500MB 초과 · 500개 초과 · 이미 담긴 파일은 저장 창이 빼고 알린다
}

function isField(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || Boolean(el.closest('[contenteditable=""],[contenteditable="true"]'));
}

function onPaste(e) {
  if (isField(e.target) || blocked()) return;
  const data = e.clipboardData;
  if (!data) return;
  const found = classifyPaste({ files: [...(data.files ?? [])], text: data.getData('text/plain') });
  if (!found) return;
  e.preventDefault();
  // 화면 갈무리는 이름이 늘 image.png라 제목을 따로 붙인다
  if (found.tab === 'file') found.titles = found.files.map(pastedTitle);
  openSave(found);
}

/** 끌어다 놓기 · 붙여넣기를 받기 시작한다(한 번만). */
export function initDropzone() {
  if (wired) return;
  wired = true;
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('dragend', reset);
  window.addEventListener('blur', reset);
  document.addEventListener('paste', onPaste);
}
