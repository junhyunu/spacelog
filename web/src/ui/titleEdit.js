// 별 이름 바꾸기: 제목 자리가 그 자리에서 입력칸이 된다. 상세 머리(detail.js, 홈 · 우주) · 행성 패널 별 목록(panel.js) ·
// 홈 별 목록(homeList.js)이 같이 쓴다. 입력칸은 화면이 HTML로 그리고(titleEditHtml), 그린 뒤에 bind로 붙인다.
// 글(draft)은 여기서 쥐어서 화면을 다시 그려도(다른 별의 ☆ · 다시 받기) 쓰던 글이 남는다.
// Enter · 저장 = 저장, Esc · 취소 = 그만두기, 칸 밖을 누르면 바뀐 게 있을 때만 저장한다. 비우면 저장하지 않는다.
import { esc } from '../util.js';
import { renameCheck, TITLE_MAX } from './detailLogic.js';
import { renameStar } from './starActions.js';
import { toast } from './toast.js';

const EMPTY = '이름을 비울 수 없어요';

/**
 * 입력칸 HTML. bar가 true면 아래에 [취소][저장] 줄과 비었을 때의 안내(상세 머리), 아니면 옆에 [저장]만(목록 줄).
 * focusAttr · key: 화면이 다시 그린 뒤 초점을 되찾는 데 쓰는 속성(data-d · data-focus · data-fk)과 값
 */
export function titleEditHtml({ bar = false, focusAttr, key }) {
  const f = (k) => (focusAttr ? ` ${focusAttr}="${esc(k)}"` : '');
  const input = `<input type="text" class="tin" maxlength="${TITLE_MAX}" autocomplete="off" aria-label="별 이름"${f(key)}>`;
  if (!bar) return `<div class="tedit row" data-tedit>${input}<button type="button" class="btn yellow sm" data-tsave${f(`${key}:save`)}>저장</button></div>`;
  return (
    `<div class="tedit" data-tedit>${input}<div class="tebar"><small class="terr" role="alert" hidden>${EMPTY}</small>` +
    `<button type="button" class="btn ghost sm" data-tcancel${f(`${key}:cancel`)}>취소</button>` +
    `<button type="button" class="btn yellow sm" data-tsave${f(`${key}:save`)}>저장</button></div></div>`
  );
}

/**
 * 화면 하나의 이름 바꾸기 상태. 한 번에 별 하나만 고친다.
 * @param {{ render: () => void, focusAfter?: (id: string) => void }} o
 *   render: 화면을 다시 그린다(입력칸을 넣거나 뺀다) · focusAfter: 끝난 뒤 초점을 둘 곳(제목 · ✎ 등)
 */
export function createTitleEditor({ render, focusAfter }) {
  let st = null; // { id, draft, fresh, saving }

  const editor = {
    /** 이 별을 고치는 중인지 */
    is: (id) => st !== null && id !== null && id !== undefined && st.id === String(id),
    get active() {
      return st !== null;
    },
    start(star) {
      st = { id: String(star.id), draft: star.title || '', fresh: true, saving: false };
      render();
    },
    /** 고치기를 끝내고 다시 그린다. focus가 false면(칸 밖을 눌러 끝났다) 초점을 옮기지 않는다 */
    stop({ focus = true } = {}) {
      if (!st) return;
      const { id } = st;
      st = null;
      render();
      if (focus) focusAfter?.(id);
    },
    /** 다시 그리지 않고 잊는다(화면이 닫히거나 고르기로 바뀔 때) */
    clear() {
      st = null;
    },
    /** 그려진 입력칸(group = [data-tedit])에 붙인다. 이미 붙인 칸이면 아무 일도 없다 */
    bind(group, star) {
      if (!st || !group || group.dataset.bound) return;
      group.dataset.bound = '1';
      const mine = st;
      const input = group.querySelector('input');
      const err = group.querySelector('.terr');
      input.value = mine.draft;
      if (mine.fresh) {
        mine.fresh = false;
        input.focus({ preventScroll: true });
        input.select();
      }
      const showErr = (on) => {
        input.setAttribute('aria-invalid', String(on));
        if (err) err.hidden = !on;
      };
      const live = () => st === mine;
      const save = async ({ focus = true } = {}) => {
        if (!live() || mine.saving) return;
        const check = renameCheck(input.value, star.title);
        if (check.kind === 'empty') {
          showErr(true);
          if (!err) toast(EMPTY);
          input.focus({ preventScroll: true });
          return;
        }
        if (check.kind === 'same') {
          editor.stop({ focus });
          return;
        }
        mine.saving = true;
        group.setAttribute('aria-busy', 'true');
        input.readOnly = true;
        const ok = await renameStar(star, check.title);
        mine.saving = false;
        if (!live()) return;
        if (ok) {
          editor.stop({ focus });
          return;
        }
        // 저장하지 못했다: 쓰던 글 그대로 고치기를 이어 간다
        if (group.isConnected) {
          group.removeAttribute('aria-busy');
          input.readOnly = false;
          input.focus({ preventScroll: true });
        }
      };
      input.addEventListener('input', () => {
        mine.draft = input.value;
        showErr(false);
      });
      group.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.isComposing) {
          // 상세 닫기 · 패널 닫기 같은 다른 Esc보다 먼저 받는다(escape.js는 document에서 받는다)
          e.preventDefault();
          e.stopPropagation();
          if (!mine.saving) editor.stop();
        } else if (e.key === 'Enter' && e.target === input && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          save();
        }
      });
      group.querySelector('[data-tsave]')?.addEventListener('click', () => save());
      group.querySelector('[data-tcancel]')?.addEventListener('click', () => {
        if (!mine.saving) editor.stop();
      });
      // 칸 밖을 눌렀다: 바뀐 게 있으면 저장하고, 비었거나 그대로면 그만둔다.
      // 화면을 다시 그려 칸이 바뀐 경우(isConnected가 false)는 고치기를 이어 간다
      group.addEventListener('focusout', (e) => {
        if (group.contains(e.relatedTarget)) return;
        setTimeout(() => {
          if (!live() || mine.saving || !group.isConnected || group.contains(document.activeElement)) return;
          if (renameCheck(input.value, star.title).kind === 'ok') save({ focus: false });
          else editor.stop({ focus: false });
        }, 0);
      });
    },
  };
  return editor;
}
