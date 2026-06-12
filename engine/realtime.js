/**
 * D-Garden Supabase Realtime 브릿지 — 가든 화면(수신)용
 *
 * 관객들이 audience.html에서 보내는 응원 메시지를
 * Supabase Broadcast 채널로 수신하여 Tracker.onCrowdMessage()에 전달한다.
 *
 * spec.json에서 아래 값을 채워야 동작한다:
 *   SUPABASE_URL      - Supabase 프로젝트 URL
 *   SUPABASE_ANON_KEY - Supabase anon(public) 키
 *   REALTIME_CHANNEL  - 채널 이름 (기본값: "d-garden-crowd")
 */

const RealtimeClient = (() => {
  let _connected  = false;
  let _statusEl   = null; // 연결 상태 표시 DOM 요소 (선택적)

  /**
   * 연결 상태 표시 업데이트 (index.html에 #realtime-status 요소가 있으면 반영)
   */
  function setStatus(ok, msg) {
    _connected = ok;
    if (!_statusEl) {
      _statusEl = document.getElementById('realtime-status');
    }
    if (_statusEl) {
      _statusEl.textContent = msg;
      _statusEl.style.color = ok ? '#00ff99' : 'rgba(255,255,255,0.3)';
    }
    console.info('[D-Garden Realtime]', msg);
  }

  /**
   * 가든 화면 초기화 — Supabase 채널 구독 시작
   * @param {object} spec - window.SPEC (spec.json 내용)
   */
  async function init(spec) {
    const url  = spec.SUPABASE_URL;
    const key  = spec.SUPABASE_ANON_KEY;
    const name = spec.REALTIME_CHANNEL || 'd-garden-crowd';

    // 자격증명 미설정 → 상태 표시 숨기고 조용히 종료 (발표 화면에 노출 안 됨)
    if (!url || url.startsWith('YOUR_')) {
      if (_statusEl || (_statusEl = document.getElementById('realtime-status'))) {
        _statusEl.style.display = 'none';
      }
      return;
    }

    if (typeof window.supabase === 'undefined') {
      console.error('[D-Garden Realtime] Supabase CDN 미로드 — index.html에서 CDN 스크립트를 먼저 불러오세요.');
      return;
    }

    try {
      setStatus(false, '● 연결 중…');

      const client  = window.supabase.createClient(url, key);
      const channel = client.channel(name);

      channel
        .on('broadcast', { event: 'crowd_message' }, ({ payload }) => {
          if (!payload || typeof Tracker === 'undefined') return;
          const text = payload.text ? String(payload.text) : '';
          if (!text) return;

          // sentiment 필드가 있으면 키워드 판정 없이 직접 적용
          // 없으면 기존 POSITIVE_KEYWORDS / NEGATIVE_KEYWORDS 키워드 매칭으로 폴백
          if (payload.sentiment === 'pos') {
            Tracker.onCrowdMessage('화이팅'); // 긍정 키워드로 전달
          } else if (payload.sentiment === 'neg') {
            Tracker.onCrowdMessage('에이');   // 부정 키워드로 전달
          } else {
            Tracker.onCrowdMessage(text);     // 구버전 호환 폴백
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setStatus(true, '● LIVE');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            setStatus(false, `● 오류: ${status}`);
          }
        });

    } catch (err) {
      setStatus(false, `● 연결 실패: ${err.message}`);
      console.error('[D-Garden Realtime] 초기화 오류:', err);
    }
  }

  return {
    init,
    isConnected: () => _connected,
  };
})();
