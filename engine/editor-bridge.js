/**
 * D-Garden 에디터 브리지 — 가든 화면(수신)용
 *
 * Cursor/VS Code 확장(extension/)이 127.0.0.1에 띄운 SSE 서버에
 * EventSource로 접속해, 에디터 타이핑 집계를 Tracker.onEditorActivity()에 전달한다.
 * 연결이 끊겨도 EventSource가 자동 재접속하므로 별도 재시도 로직이 없다.
 *
 * spec.json에서 아래 값을 사용한다:
 *   EDITOR_BRIDGE_URL - SSE 엔드포인트 (기본: http://127.0.0.1:7331/events)
 */

const EditorBridge = (() => {
  let _connected = false;
  let _statusEl  = null; // 연결 상태 표시 DOM 요소 (선택적)
  let _source    = null;

  function setStatus(ok, msg) {
    _connected = ok;
    if (!_statusEl) {
      _statusEl = document.getElementById('editor-status');
    }
    if (_statusEl) {
      _statusEl.textContent = msg;
      _statusEl.style.color = ok ? '#00ccff' : 'rgba(255,255,255,0.3)';
    }
    console.info('[D-Garden EditorBridge]', msg);
  }

  /**
   * 가든 화면 초기화 — 확장 SSE 구독 시작
   * @param {object} spec - window.SPEC (spec.json 내용)
   */
  function init(spec) {
    const url = spec.EDITOR_BRIDGE_URL;

    // URL 미설정 → 상태 표시 숨기고 조용히 종료 (realtime.js와 동일 정책)
    if (!url) {
      if (_statusEl || (_statusEl = document.getElementById('editor-status'))) {
        _statusEl.style.display = 'none';
      }
      return;
    }

    if (typeof EventSource === 'undefined') {
      console.error('[D-Garden EditorBridge] 이 브라우저는 EventSource를 지원하지 않습니다.');
      return;
    }

    setStatus(false, '● EDITOR …');
    _source = new EventSource(url);

    _source.onopen  = () => setStatus(true,  '● EDITOR LINKED');
    _source.onerror = () => {
      // 확장 미실행/Cursor 종료 상태 — EventSource가 알아서 재접속을 반복한다
      if (_connected || _statusEl) setStatus(false, '● EDITOR OFFLINE');
    };

    _source.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (!data || typeof Tracker === 'undefined') return;
      if (data.type === 'keys') {
        Tracker.onEditorActivity(data.keys, data.backspaces);
      } else if (data.type === 'mouse') {
        Tracker.onEditorMouseMove(data.moves);
      }
    };
  }

  return {
    init,
    isConnected: () => _connected,
  };
})();
