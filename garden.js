/**
 * D-Garden 멘탈 스코어 엔진
 * 모든 수치는 spec.json에서 로드한다. 절대 하드코딩하지 않는다.
 * Node.js(Jest)와 브라우저 환경 모두 지원한다.
 */

let SPEC;
if (typeof require === 'function') {
  SPEC = require('./spec.json');
} else {
  SPEC = window.SPEC;
}

// ─────────────────────────────────────────
// 유틸: 점수를 MIN~MAX 범위로 고정한다
// ─────────────────────────────────────────
function clampScore(score) {
  return Math.min(SPEC.MAX_SCORE, Math.max(SPEC.MIN_SCORE, score));
}

// ─────────────────────────────────────────
// 아무 입력 없을 때: 매초 IDLE_DECREASE_PER_SEC만큼 감소
// ─────────────────────────────────────────
function calcIdleDecay(score) {
  return clampScore(score + SPEC.IDLE_DECREASE_PER_SEC);
}

// ─────────────────────────────────────────
// 마우스 이동/휠: +MOUSE_MOVE_INCREASE, 단 MOUSE_MOVE_CAP 상한 방어
// ─────────────────────────────────────────
function calcMouseMove(score) {
  if (score >= SPEC.MOUSE_MOVE_CAP) return score;
  const next = score + SPEC.MOUSE_MOVE_INCREASE;
  return Math.min(next, SPEC.MOUSE_MOVE_CAP);
}

// ─────────────────────────────────────────
// 짧은 타자/클릭: +SHORT_INPUT_INCREASE, 단 SHORT_INPUT_CAP 상한 방어
// ─────────────────────────────────────────
function calcShortInput(score) {
  if (score >= SPEC.SHORT_INPUT_CAP) return score;
  const next = score + SPEC.SHORT_INPUT_INCREASE;
  return Math.min(next, SPEC.SHORT_INPUT_CAP);
}

// ─────────────────────────────────────────
// 초몰입 지속 타자: +BURST_INPUT_INCREASE (상한선 없음, 과열 진입 가능)
// ─────────────────────────────────────────
function calcBurstInput(score) {
  return clampScore(score + SPEC.BURST_INPUT_INCREASE);
}

// ─────────────────────────────────────────
// 관객 반응: 긍정/부정 키워드 감지 후 점수 변동
// crowdUsedThisSec: 이번 초에 이미 사용된 변동 폭(절댓값 누적)
// 초당 최대 CROWD_LIMIT_PER_SEC을 초과하지 않도록 스로틀링
// ─────────────────────────────────────────
function calcCrowdReaction(score, keyword, crowdUsedThisSec) {
  const remaining = SPEC.CROWD_LIMIT_PER_SEC - crowdUsedThisSec;
  if (remaining <= 0) return score;

  const isPositive = SPEC.POSITIVE_KEYWORDS.some(k => keyword.includes(k));
  const isNegative = SPEC.NEGATIVE_KEYWORDS.some(k => keyword.includes(k));

  let delta = 0;
  if (isPositive) delta = SPEC.CROWD_POSITIVE_SCORE;
  else if (isNegative) delta = SPEC.CROWD_NEGATIVE_SCORE;
  else return score;

  // 남은 한도 내에서만 변동 허용
  const clampedDelta = Math.sign(delta) * Math.min(Math.abs(delta), remaining);
  return clampScore(score + clampedDelta);
}

// ─────────────────────────────────────────
// 타이핑 상태 판정: CPM과 오타율로 FOCUS / RAGE / NORMAL 구분
// ─────────────────────────────────────────
function detectTypingState(cpm, backspaceRatio) {
  if (cpm >= SPEC.CPM_OVERHEAT_THRESHOLD && backspaceRatio >= SPEC.BACKSPACE_RATIO_THRESHOLD) {
    return 'RAGE';
  }
  if (cpm >= SPEC.CPM_FOCUS_THRESHOLD) {
    return 'FOCUS';
  }
  return 'NORMAL';
}

// ─────────────────────────────────────────
// 점수 → 식물 상태 4단계 판정
// ─────────────────────────────────────────
function getPlantState(score) {
  const states = SPEC.STATES;
  if (score <= states.DORMANT.max)  return 'DORMANT';
  if (score <= states.OPTIMAL.max)  return 'OPTIMAL';
  if (score <= states.OVERHEAT.max) return 'OVERHEAT';
  return 'COOLDOWN';
}

// Node.js(Jest) 환경에서는 CommonJS exports, 브라우저에서는 전역 함수로 노출
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clampScore,
    calcIdleDecay,
    calcMouseMove,
    calcShortInput,
    calcBurstInput,
    calcCrowdReaction,
    detectTypingState,
    getPlantState,
  };
}
