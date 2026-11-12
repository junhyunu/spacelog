// 챗봇 라우트. Task 1: 상태만. (설정 · 대화는 다음 태스크에서 여기에 더한다.)

export function registerChat(app) {
  // 키 값은 절대 내보내지 않는다. 파이썬이 ready 일 때만 key(있다/없다)를 채운다.
  app.get('/api/chat/status', async () => {
    const rag = app.rag;
    const st = rag?.status?.() ?? { state: 'off' };
    let key = null;
    if (st.state === 'ready') {
      try {
        const health = await rag.client.health();
        key = typeof health?.key === 'boolean' ? health.key : null;
      } catch {
        key = null;
      }
    }
    return { rag: { state: st.state, reason: st.reason ?? null }, key };
  });
}
