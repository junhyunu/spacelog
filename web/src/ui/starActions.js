// 별 옮기기 · 지우기: 확인 창 → 서버 → 토스트 → 다시 받기. 우주의 행성 패널(panel.js)과 홈의 별 목록(homeList.js)이 함께 쓴다.
// 성공하면 다시 받기 전에도 화면이 맞게 store.state.stars를 먼저 고쳐 둔다. 부르는 쪽은 돌아온 값을 보고 자기 화면만 다시 그리면 된다.
import { api } from '../api.js';
import { store } from '../store.js';
import { ask } from './confirm.js';
import { deleteCopy } from './detailLogic.js';
import { toast } from './toast.js';

const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/** "어느 행성으로 옮길까요?" 확인 창의 내용. 목록의 ⋯ 메뉴와 상세(detail.js)의 "행성 옮기기"가 같은 창을 쓴다. */
export function moveCopy(star, others) {
  return {
    title: `'${star.title || '제목 없음'}'을(를) 어느 행성으로 옮길까요?`,
    desc: '옮기면 우주에서도 별이 그 행성으로 이동해요.',
    confirmLabel: '옮기기',
    confirmKind: 'yellow',
    select: { options: others.map((p) => ({ value: p.id, label: p.name })), value: others[0].id, label: '옮길 행성' },
  };
}

/**
 * 옮길 행성을 묻고 옮긴다. others = 지금 행성을 뺀 행성들(하나 이상).
 * @returns {Promise<string|null>} 옮긴 행성 id. 취소했거나 실패했으면 null
 */
export async function moveStar(star, others) {
  const target = await ask(moveCopy(star, others));
  if (!target) return null;
  const name = others.find((p) => same(p.id, target))?.name ?? '';
  try {
    await api.patchStar(star.id, { planet_id: target });
  } catch (err) {
    if (err?.code !== 'offline') toast('옮기지 못했어요');
    return null;
  }
  const inStore = store.state.stars.find((s) => same(s.id, star.id));
  if (inStore) inStore.planet_id = target; // 다시 받기 전에도 그 행성 목록에서 빠지게
  toast(`'${name}'(으)로 옮겼어요`);
  store.reload().catch(() => {});
  return String(target);
}

/**
 * 지울지 묻고 지운다(상세의 "이 별 지우기"와 같은 확인 창).
 * @returns {Promise<boolean>} 지웠으면 true(이미 지워진 별도 지운 것으로 본다)
 */
export async function deleteStar(star) {
  // 목록의 별에는 첨부 목록이 없을 수 있다: 확인 창이 "보관함 복사본 N개"를 정확히 말하도록 전체를 받아 온다
  const full = Array.isArray(star.attachments) ? star : await api.star(star.id).catch(() => star);
  const ok = await ask(deleteCopy(full));
  if (!ok) return false;
  try {
    await api.deleteStar(star.id);
  } catch (err) {
    // 이미 지워진 별(404)은 지운 것으로 본다
    if (err?.status !== 404) {
      if (err?.code !== 'offline') toast('지우지 못했어요. 다시 눌러 주세요');
      return false;
    }
  }
  store.state.stars = store.state.stars.filter((s) => !same(s.id, star.id));
  toast('지웠어요');
  store.reload().catch(() => {});
  return true;
}
