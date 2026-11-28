// "다른 행성과 합치기": 확인 창(합칠 행성 고르기) → 서버 → 토스트 → 다시 받기.
// 우주의 행성 패널 메뉴(panel.js)와 홈 왼쪽 행성 목록의 ⋯ 메뉴(homeList.js)가 같이 쓴다.
// 합친 뒤 패널을 닫거나(우주) 받은 행성으로 거르기를 옮기는(홈) 것은 부르는 쪽이 정한다.
import { api } from '../api.js';
import { store } from '../store.js';
import { ask, setAskDesc } from './confirm.js';
import { mergeDesc, mergeErrorText, mergeFailure } from './planetLogic.js';
import { toast } from './toast.js';

const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/** 합칠 수 있는 행성(자기를 뺀 모두). 비었으면 메뉴의 "합치기"를 잠근다. */
export const mergeTargets = (planet) => (store.state.planets ?? []).filter((p) => !same(p.id, planet?.id));

/**
 * 합칠 행성을 묻고 합친다.
 * @returns {Promise<string|null>} 받은 행성 id. 취소했거나 실패했으면 null
 */
export async function mergePlanet(planet) {
  const others = mergeTargets(planet);
  if (!others.length) return null;
  const nameOf = (id) => others.find((p) => same(p.id, id))?.name ?? '';
  const answer = ask({
    title: `행성 '${planet.name}'을(를) 다른 행성과 합칠까요?`,
    desc: mergeDesc(planet.count_total, others[0].name),
    confirmLabel: '합치기',
    confirmKind: 'yellow',
    select: { options: others.map((p) => ({ value: p.id, label: p.name })), value: others[0].id, label: '합칠 행성' },
  });
  // 고른 행성에 맞춰 설명의 이름을 바꾼다(textContent라 esc가 필요 없다)
  const sel = document.querySelector('#cExtra select');
  sel?.addEventListener('change', () => {
    setAskDesc(mergeDesc(planet.count_total, nameOf(sel.value)));
  });
  const into = await answer;
  if (!into) return null;
  try {
    await api.mergePlanet(planet.id, into);
  } catch (err) {
    const why = mergeFailure(err);
    // 두 행성 중 하나가 그사이 사라졌다: 다시 받는다(사라진 행성의 패널 · 거르기는 'data'가 정리한다)
    if (why === 'stale') store.reload().catch(() => {});
    toast(mergeErrorText(why));
    return null;
  }
  // 다시 받기 전에도 별이 받은 행성 목록에 보이게
  for (const s of store.state.stars) if (same(s.planet_id, planet.id)) s.planet_id = String(into);
  toast(`'${nameOf(into)}'(으)로 합쳤어요`);
  store.reload().catch(() => {});
  return String(into);
}
