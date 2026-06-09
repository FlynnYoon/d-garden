/**
 * D-Garden 입력 트래커
 * 키보드/마우스 이벤트를 수집하고, garden.js 함수를 호출하여 멘탈 스코어를 관리한다.
 * 브라우저 전역 객체 Tracker로 노출된다.
 */

const Tracker = (() => {
  let SPEC = null;
  let score = 50;

  // CPM 계산용: 최근 3초 안의 키 입력 시각 배열
  let keystrokeTimestamps = [];
  // 오타율 계산용
  let backspaceCount = 0;
  let totalKeyCount = 0;
  // 마지막 입력 시각 (idle 감지용)
  let lastInputTime = 0;
  // 관객 반응 초당 변동폭 누적
  let crowdUsedThisSec = 0;
  // 이번 초에 마우스 이동이 있었는지
  let mouseMoveThisSecond = false;
  // 마우스 이동 스로틀 타이머
  let lastMouseThrottle = 0;
  // 현재 CPM과 타이핑 상태
  let cpm = 0;
  let typingState = 'NORMAL';
  // 관객 이벤트 발생 플래그 (renderer 파티클 트리거용)
  let pendingCrowdEvent = false;
  // 초몰입 진입 플래그 (renderer 파티클 트리거용)
  let prevTypingState = 'NORMAL';

  let tickInterval = null;

  // 슬라이딩 윈도우(3초)로 CPM 계산
  function calcCurrentCPM() {
    const now = Date.now();
    keystrokeTimestamps = keystrokeTimestamps.filter(t => now - t < 3000);
    return keystrokeTimestamps.length * 20; // 3초 기준 → 분당 환산
  }

  // 매초 실행되는 스코어 업데이트 루프
  function tick() {
    const now = Date.now();
    const idleMs = now - lastInputTime;

    cpm = calcCurrentCPM();
    const bsRatio = totalKeyCount > 0 ? backspaceCount / totalKeyCount : 0;
    const prevState = typingState;
    typingState = detectTypingState(cpm, bsRatio);

    // 초몰입 진입 시 파티클 트리거
    if (prevState !== 'FOCUS' && typingState === 'FOCUS') {
      prevTypingState = typingState;
    }

    if (typingState === 'FOCUS' || typingState === 'RAGE') {
      score = calcBurstInput(score);
    } else if (idleMs > 2000) {
      score = calcIdleDecay(score);
    }

    if (mouseMoveThisSecond) {
      score = calcMouseMove(score);
      mouseMoveThisSecond = false;
    }

    // 매초 관객 변동폭 한도 리셋
    crowdUsedThisSec = 0;

    // 30초 이상 완전 idle이면 오타율 카운터 리셋 (새 작업 세션으로 간주)
    if (idleMs > 30000) {
      backspaceCount = 0;
      totalKeyCount = 0;
    }
  }

  // 초기화: spec과 이벤트 리스너 등록
  function init(spec) {
    SPEC = spec;
    score = SPEC.INITIAL_SCORE;
    lastInputTime = Date.now();

    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(tick, 1000);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('click', onMouseClick);
  }

  function onKeyDown(e) {
    lastInputTime = Date.now();
    totalKeyCount++;

    if (e.key === 'Backspace') {
      backspaceCount++;
    }

    keystrokeTimestamps.push(Date.now());

    // NORMAL 상태에서만 건당 점수 적용 (FOCUS/RAGE는 tick에서 일괄 처리)
    if (typingState === 'NORMAL') {
      score = calcShortInput(score);
    }
  }

  function onMouseMove() {
    const now = Date.now();
    if (now - lastMouseThrottle < 200) return;
    lastMouseThrottle = now;
    lastInputTime = now;
    mouseMoveThisSecond = true;
  }

  function onMouseClick() {
    lastInputTime = Date.now();
    score = calcShortInput(score);
  }

  // 관객 메시지 수신 시 외부에서 호출
  function onCrowdMessage(keyword) {
    const prev = score;
    score = calcCrowdReaction(score, keyword, crowdUsedThisSec);
    const delta = Math.abs(score - prev);
    crowdUsedThisSec += delta;
    if (delta > 0) pendingCrowdEvent = true;
  }

  // 현재 상태를 renderer/UI로 전달하기 위한 스냅샷
  function getState() {
    const hasCrowd = pendingCrowdEvent;
    const hasFocusEnter = prevTypingState === 'FOCUS' && typingState === 'FOCUS';
    pendingCrowdEvent = false;
    prevTypingState = typingState;

    return {
      score,
      state: getPlantState(score),
      cpm: Math.round(cpm),
      typingState,
      hasCrowdEvent: hasCrowd,
      hasFocusEnter,
    };
  }

  return { init, onCrowdMessage, getState };
})();
