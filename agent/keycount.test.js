/**
 * 전역 입력 카운터 순수 로직 테스트
 * TDD: 이 파일이 RED → keycount.js 구현 후 GREEN 이 되어야 한다.
 *
 * uiohook-napi의 실제 keycode는 daemon(index.js)에서 주입하므로
 * 이 순수 함수는 keycode 숫자에 의존하지 않고 "삭제 키 목록"만 받는다.
 */

const { classifyKeydown, shouldCountMouseMove } = require('./keycount');

describe('classifyKeydown', () => {
  const DELETE_KEYS = [14, 4919]; // 예시: Backspace, Delete (실제 값은 daemon에서 주입)

  test('일반 글자 키 → 1키, 백스페이스 0', () => {
    expect(classifyKeydown(30, DELETE_KEYS)).toEqual({ keys: 1, backspaces: 0 });
  });

  test('백스페이스 키 → 1키 + 백스페이스 1', () => {
    expect(classifyKeydown(14, DELETE_KEYS)).toEqual({ keys: 1, backspaces: 1 });
  });

  test('Delete 키 → 1키 + 백스페이스 1', () => {
    expect(classifyKeydown(4919, DELETE_KEYS)).toEqual({ keys: 1, backspaces: 1 });
  });

  test('삭제 키 목록이 비어도 안전하게 동작', () => {
    expect(classifyKeydown(14, [])).toEqual({ keys: 1, backspaces: 0 });
  });
});

describe('shouldCountMouseMove', () => {
  const THROTTLE = 200;

  test('마지막 집계 후 충분히 지났으면 집계한다', () => {
    expect(shouldCountMouseMove(1000, 1300, THROTTLE)).toBe(true);
  });

  test('스로틀 시간 이내면 집계하지 않는다 (이벤트 폭주 방지)', () => {
    expect(shouldCountMouseMove(1000, 1100, THROTTLE)).toBe(false);
  });

  test('첫 이동(lastTime 0)은 항상 집계한다', () => {
    expect(shouldCountMouseMove(0, 50, THROTTLE)).toBe(true);
  });

  test('정확히 스로틀 경계면 집계한다', () => {
    expect(shouldCountMouseMove(1000, 1200, THROTTLE)).toBe(true);
  });
});
