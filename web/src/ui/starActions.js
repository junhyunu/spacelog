// 별 옮기기 · 지우기: 확인 창 → 서버 → 토스트 → 다시 받기. 우주의 행성 패널(panel.js)과 홈의 별 목록(homeList.js)이 함께 쓴다.
// 성공하면 다시 받기 전에도 화면이 맞게 store.state.stars를 먼저 고쳐 둔다. 부르는 쪽은 돌아온 값을 보고 자기 화면만 다시 그리면 된다.
import { api } from '../api.js';
import { store } from '../store.js';
import { ask } from './confirm.js';
import { deleteCopy } from './detailLogic.js';
import { deleteManyCopy, deleteManyToast, moveManyCopy, moveManyToast, moveTargets, partialFailToast, runBatches, vaultCopies } from './planetLogic.js';
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
 * 고른 별 여러 개를 한 행성으로 옮긴다(우주 행성 패널 · 홈 목록의 "여러 개 고르기"). others = moveTargets()의 값(하나 이상).
 * 이미 그 행성에 있거나 그사이 지워진 별은 서버가 건너뛴다. 토스트는 서버가 실제로 옮긴 수(moved)로 말한다(0이면 "이미 그 행성에 있어요").
 * @returns {Promise<string|{ partial: true, doneIds: string[] }|null>} 옮긴 행성 id(옮긴 것이 0개여도 돌려준다: 부르는 쪽은 고르기를 끝낸다).
 *   앞 묶음만 옮기고 실패했으면 { partial: true, doneIds }(부르는 쪽은 doneIds를 선택에서 빼고 바로 다시 그리며 고르기는 이어 간다). 취소했거나 아무것도 못 했으면 null
 */
export async function moveStars(ids, others) {
  const list = [...new Set((ids ?? []).map(String))];
  if (!list.length || !others?.length) return null;
  const target = await ask(moveManyCopy(list.length, others));
  if (!target) return null;
  const name = others.find((p) => same(p.id, target))?.name ?? '';
  // 서버는 한 번에 id 500개까지 받는다: 500개씩 차례로 보낸다(runBatches). 중간에 실패하면 앞 묶음만 처리된 채로 멈춘다
  const { count: moved, doneIds, error: err } = await runBatches(list, async (batch) => (await api.moveStars(batch, target))?.moved);
  if (err) {
    // 앞 묶음은 옮겨졌을 수 있다: 그만큼 목록을 고치고 다시 받는다
    if (doneIds.length) {
      const done = new Set(doneIds);
      for (const s of store.state.stars) if (done.has(String(s.id))) s.planet_id = target;
      store.reload().catch(() => {});
    }
    if (err?.code !== 'offline') toast(moved > 0 ? partialFailToast('move', moved) : '옮기지 못했어요');
    return doneIds.length ? { partial: true, doneIds } : null;
  }
  const alive = new Set(store.state.stars.map((s) => String(s.id)));
  toast(moveManyToast(moved, name, { gone: !list.some((id) => alive.has(id)) }));
  if (moved > 0) {
    const picked = new Set(list);
    for (const s of store.state.stars) if (picked.has(String(s.id))) s.planet_id = target; // 다시 받기 전에도 목록이 맞게
    store.reload().catch(() => {});
  }
  return String(target);
}

/**
 * "여러 개 고르기"의 "행성 옮기기": 고른 별 id들로 옮길 행성 목록(moveTargets)을 정하고 moveStars를 부른다.
 * 우주 행성 패널과 홈 목록이 같이 쓴다. 고른 별이 모두 한 행성이면 그 행성을 빼고, 섞였으면 전체(이미 그 행성에 있는 별은 서버가 건너뛴다).
 * @returns {Promise<string|null>} moveStars와 같다(옮길 것 · 행성이 없으면 null)
 */
export function movePickedStars(pickedIds) {
  const ids = [...(pickedIds ?? [])].map(String);
  const set = new Set(ids);
  const stars = (store.state.stars ?? []).filter((s) => set.has(String(s.id)));
  const others = moveTargets(stars, store.state.planets ?? []);
  if (!ids.length || !others.length) return Promise.resolve(null);
  return moveStars(ids, others);
}

/**
 * "여러 개 고르기"의 "지우기": "N개를 지울까요?"를 묻고 한 번에 지운다(우주 행성 패널 · 홈 목록이 같이 쓴다).
 * 보관함 복사본 수는 목록의 별(store.state.stars)에 이미 있는 attachments로 센다(목록 응답에도 첨부 목록이 있다).
 * 셀 수 없는 별이 섞이면 수를 말하지 않는 문구를 쓴다(별마다 api.star로 받지 않는다).
 * @returns {Promise<number|{ partial: true, doneIds: string[] }|null>} 서버가 지운 수(0이어도 돌려준다: 부르는 쪽은 고르기를 끝낸다).
 *   앞 묶음만 지우고 실패했으면 { partial: true, doneIds }(moveStars와 같다). 취소했거나 아무것도 못 했으면 null
 */
export async function deletePickedStars(pickedIds) {
  const ids = [...new Set([...(pickedIds ?? [])].map(String))];
  if (!ids.length) return null;
  const set = new Set(ids);
  const stars = (store.state.stars ?? []).filter((s) => set.has(String(s.id)));
  const ok = await ask(deleteManyCopy(ids.length, vaultCopies(stars, ids.length)));
  if (!ok) return null;
  const { count: deleted, doneIds, error: err } = await runBatches(ids, async (batch) => (await api.deleteStars(batch))?.deleted);
  if (err) {
    // 앞 묶음은 지워졌을 수 있다: 그만큼 목록에서 빼고 다시 받는다
    if (doneIds.length) {
      const done = new Set(doneIds);
      store.state.stars = store.state.stars.filter((s) => !done.has(String(s.id)));
      store.reload().catch(() => {});
    }
    if (err?.code !== 'offline') toast(deleted > 0 ? partialFailToast('delete', deleted) : '지우지 못했어요. 다시 눌러 주세요');
    return doneIds.length ? { partial: true, doneIds } : null;
  }
  store.state.stars = store.state.stars.filter((s) => !set.has(String(s.id))); // 다시 받기 전에도 목록에서 빠지게
  toast(deleteManyToast(deleted));
  store.reload().catch(() => {});
  return deleted;
}

/** 고르는 중에는 오른쪽 아래 물어보기 버튼(#chatBtn)을 숨긴다(body.picking, chat.css). 두 화면이 고르기를 켜고 끌 때 부른다. */
export function setPickingUi(on) {
  document.body.classList.toggle('picking', Boolean(on));
}

// 화면이 쥔 별과 store의 같은 별(다른 객체일 수 있다)에 값을 함께 적고, 다른 화면이 다시 그리도록 알린다
function patchLocal(star, fields) {
  Object.assign(star, fields);
  const inStore = store.state.stars.find((s) => same(s.id, star.id));
  if (inStore && inStore !== star) Object.assign(inStore, fields);
  store.emit('starChanged', { id: String(star.id) });
}

/**
 * 자주 찾음(☆)을 켜고 끈다. 먼저 화면을 바꾸고, 저장하지 못하면 되돌린다.
 * 홈 목록 · 행성 패널 · 상세(홈 · 우주)가 같이 쓴다. 바뀌면 store의 'starChanged'를 알린다.
 * onFlip(value)은 값을 적을 때마다(되돌릴 때도) 부른다: 화면이 따로 쥔 사본(홈 검색용 목록 등)을 맞출 때 쓴다.
 * @returns {Promise<boolean>} 저장했으면 true
 */
export async function toggleFavStar(star, { onFlip } = {}) {
  const next = !star.fav;
  const flip = (value) => {
    onFlip?.(value);
    patchLocal(star, { fav: value });
  };
  flip(next);
  try {
    await api.patchStar(star.id, { fav: next });
    return true;
  } catch (err) {
    flip(!next); // 저장하지 못했다: 되돌린다
    if (err?.code !== 'offline') toast('자주 찾음을 바꾸지 못했어요');
    return false;
  }
}

/**
 * 별 이름을 바꾼다. title은 renameCheck(detailLogic.js)를 거친 이름. 저장한 뒤에 화면을 바꾼다(실패하면 그대로).
 * 다시 받기로 검색 목록 · 3D까지 새 이름을 쓴다. 챗봇 색인은 서버가 고친다.
 * @returns {Promise<boolean>} 바꿨으면 true
 */
export async function renameStar(star, title) {
  try {
    await api.patchStar(star.id, { title });
  } catch (err) {
    if (err?.code !== 'offline') toast(err?.status === 404 ? '그 별은 지워졌어요' : '이름을 바꾸지 못했어요');
    if (err?.status === 404) store.reload().catch(() => {});
    return false;
  }
  patchLocal(star, { title });
  toast('이름을 바꿨어요');
  store.reload().catch(() => {});
  return true;
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
