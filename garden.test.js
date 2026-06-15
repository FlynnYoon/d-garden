/**
 * D-Garden 멘탈 스코어 엔진 테스트
 * TDD 원칙: 이 파일이 RED(실패) → garden.js 구현 후 GREEN(통과)이 되어야 한다.
 */

const {
  clampScore,
  calcIdleDecay,
  calcMouseMove,
  calcShortInput,
  calcBurstInput,
  calcCrowdReaction,
  detectTypingState,
  getPlantState,
} = require('./garden');

const SPEC = require('./spec.json');

// ─────────────────────────────────────────
// 1. clampScore: 점수는 항상 0~100 사이를 유지해야 한다
// ─────────────────────────────────────────
describe('clampScore', () => {
  test('100을 초과하면 100으로 고정된다', () => {
    expect(clampScore(110)).toBe(100);
  });
  test('0 미만이면 0으로 고정된다', () => {
    expect(clampScore(-5)).toBe(0);
  });
  test('정상 범위 값은 그대로 반환한다', () => {
    expect(clampScore(50)).toBe(50);
  });
});

// ─────────────────────────────────────────
// 2. calcIdleDecay: 아무 입력 없으면 매초 IDLE_DECREASE_PER_SEC만큼 감소
// (기대값은 spec.json에서 계산 — 수치를 바꿔도 테스트는 유효)
// ─────────────────────────────────────────
describe('calcIdleDecay', () => {
  test('50점에서 감소하면 (50 + IDLE_DECREASE_PER_SEC)점이 된다', () => {
    expect(calcIdleDecay(50)).toBeCloseTo(50 + SPEC.IDLE_DECREASE_PER_SEC);
  });
  test('감소폭보다 작은 점수에서 감소해도 0 미만으로 내려가지 않는다', () => {
    const tiny = Math.abs(SPEC.IDLE_DECREASE_PER_SEC) / 2;
    expect(calcIdleDecay(tiny)).toBe(0);
  });
  test('0점에서 감소해도 0점을 유지한다', () => {
    expect(calcIdleDecay(0)).toBe(0);
  });
});

// ─────────────────────────────────────────
// 3. calcMouseMove: 마우스 이동 시 +MOUSE_MOVE_INCREASE, 단 MOUSE_MOVE_CAP 상한 방어
// ─────────────────────────────────────────
describe('calcMouseMove', () => {
  test('50점에서 마우스 이동 시 (50 + MOUSE_MOVE_INCREASE)점이 된다', () => {
    expect(calcMouseMove(50)).toBeCloseTo(50 + SPEC.MOUSE_MOVE_INCREASE);
  });
  test('상한(MOUSE_MOVE_CAP)에서 마우스 이동해도 상한을 넘지 않는다', () => {
    expect(calcMouseMove(SPEC.MOUSE_MOVE_CAP)).toBe(SPEC.MOUSE_MOVE_CAP);
  });
  test('상한 직전에서 마우스 이동 시 상한으로 고정된다', () => {
    const nearCap = SPEC.MOUSE_MOVE_CAP - SPEC.MOUSE_MOVE_INCREASE / 2;
    expect(calcMouseMove(nearCap)).toBe(SPEC.MOUSE_MOVE_CAP);
  });
});

// ─────────────────────────────────────────
// 4. calcShortInput: 짧은 타자/클릭 시 +SHORT_INPUT_INCREASE, 단 SHORT_INPUT_CAP 상한 방어
// ─────────────────────────────────────────
describe('calcShortInput', () => {
  test('50점에서 짧은 입력 시 (50 + SHORT_INPUT_INCREASE)점이 된다', () => {
    expect(calcShortInput(50)).toBeCloseTo(50 + SPEC.SHORT_INPUT_INCREASE);
  });
  test('상한(SHORT_INPUT_CAP)에서 짧은 입력해도 상한을 넘지 않는다', () => {
    expect(calcShortInput(SPEC.SHORT_INPUT_CAP)).toBe(SPEC.SHORT_INPUT_CAP);
  });
  test('상한 직전에서 짧은 입력 시 상한으로 고정된다', () => {
    const nearCap = SPEC.SHORT_INPUT_CAP - SPEC.SHORT_INPUT_INCREASE / 2;
    expect(calcShortInput(nearCap)).toBe(SPEC.SHORT_INPUT_CAP);
  });
});

// ─────────────────────────────────────────
// 5. calcBurstInput: 초몰입 지속 타자 시 +BURST_INPUT_INCREASE (상한선 없음, 과열 진입 가능)
// ─────────────────────────────────────────
describe('calcBurstInput', () => {
  test('50점에서 초몰입 타자 시 (50 + BURST_INPUT_INCREASE)점이 된다', () => {
    expect(calcBurstInput(50)).toBeCloseTo(50 + SPEC.BURST_INPUT_INCREASE);
  });
  test('상한(SHORT/MOUSE CAP)을 초과해도 계속 오른다 (상한선 없음)', () => {
    expect(calcBurstInput(65)).toBeCloseTo(65 + SPEC.BURST_INPUT_INCREASE);
  });
  test('최대치 직전에서 초몰입 타자 시 MAX_SCORE로 클램프된다', () => {
    const nearMax = SPEC.MAX_SCORE - SPEC.BURST_INPUT_INCREASE / 2;
    expect(calcBurstInput(nearMax)).toBe(SPEC.MAX_SCORE);
  });
});

// ─────────────────────────────────────────
// 6. calcCrowdReaction: 긍정/부정 키워드 → 점수 변동 + 스로틀
// ─────────────────────────────────────────
describe('calcCrowdReaction', () => {
  test('긍정 키워드("화이팅") 입력 시 +2점 상승한다', () => {
    expect(calcCrowdReaction(50, '화이팅', 0)).toBeCloseTo(52);
  });
  test('부정 키워드("별로") 입력 시 -2점 하락한다', () => {
    expect(calcCrowdReaction(50, '별로', 0)).toBeCloseTo(48);
  });
  test('알 수 없는 키워드는 점수 변동이 없다', () => {
    expect(calcCrowdReaction(50, '그냥', 0)).toBe(50);
  });
  test('초당 누적 변동이 5점 한도를 초과하면 스로틀된다', () => {
    // 이미 이번 초에 5점 변동이 있었을 때 추가 변동은 막힌다
    const result = calcCrowdReaction(50, '화이팅', SPEC.CROWD_LIMIT_PER_SEC);
    expect(result).toBe(50);
  });
  test('부분 스로틀: 남은 한도만큼만 점수가 오른다', () => {
    // 이미 4점 변동 → 최대 1점만 더 허용
    const result = calcCrowdReaction(50, '화이팅', 4);
    expect(result).toBeCloseTo(51);
  });
});

// ─────────────────────────────────────────
// 7. detectTypingState: CPM + 오타율(백스페이스 비율) → 타이핑 상태 판정
// (임계값은 spec.json: CPM_FOCUS_THRESHOLD / CPM_OVERHEAT_THRESHOLD / BACKSPACE_RATIO_THRESHOLD)
// ─────────────────────────────────────────
describe('detectTypingState', () => {
  test('CPM이 FOCUS 임계값 이상 + 오타율 낮으면 → FOCUS (초몰입)', () => {
    expect(detectTypingState(SPEC.CPM_FOCUS_THRESHOLD, SPEC.BACKSPACE_RATIO_THRESHOLD / 2)).toBe('FOCUS');
  });
  test('CPM이 OVERHEAT 임계값 이상 + 오타율 높으면 → RAGE (과열)', () => {
    expect(detectTypingState(SPEC.CPM_OVERHEAT_THRESHOLD, SPEC.BACKSPACE_RATIO_THRESHOLD)).toBe('RAGE');
  });
  test('CPM이 FOCUS 임계값 미만 → NORMAL (일반)', () => {
    expect(detectTypingState(SPEC.CPM_FOCUS_THRESHOLD - 1, 0.05)).toBe('NORMAL');
  });
  test('CPM이 OVERHEAT 임계값 이상이어도 오타율 낮으면 → FOCUS', () => {
    expect(detectTypingState(SPEC.CPM_OVERHEAT_THRESHOLD, SPEC.BACKSPACE_RATIO_THRESHOLD / 2)).toBe('FOCUS');
  });
});

// ─────────────────────────────────────────
// 8. getPlantState: 점수 → 식물 상태 4단계 판정
// ─────────────────────────────────────────
describe('getPlantState', () => {
  test('0점 → DORMANT', () => {
    expect(getPlantState(0)).toBe('DORMANT');
  });
  test('20점 → DORMANT', () => {
    expect(getPlantState(20)).toBe('DORMANT');
  });
  test('21점 → OPTIMAL', () => {
    expect(getPlantState(21)).toBe('OPTIMAL');
  });
  test('50점(초기값) → OPTIMAL', () => {
    expect(getPlantState(50)).toBe('OPTIMAL');
  });
  test('60점 → OPTIMAL', () => {
    expect(getPlantState(60)).toBe('OPTIMAL');
  });
  test('61점 → OVERHEAT', () => {
    expect(getPlantState(61)).toBe('OVERHEAT');
  });
  test('90점 → OVERHEAT', () => {
    expect(getPlantState(90)).toBe('OVERHEAT');
  });
  test('91점 → COOLDOWN', () => {
    expect(getPlantState(91)).toBe('COOLDOWN');
  });
  test('100점 → COOLDOWN', () => {
    expect(getPlantState(100)).toBe('COOLDOWN');
  });
});
