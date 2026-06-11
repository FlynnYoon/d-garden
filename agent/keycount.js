/**
 * 전역 입력 카운터 순수 로직
 *
 * uiohook-napi의 실제 keycode 값은 daemon(index.js)에서 주입하므로,
 * 이 모듈은 특정 라이브러리·OS에 의존하지 않는 순수 함수만 둔다.
 * Node(Jest)와 daemon 양쪽에서 require로 사용된다.
 */

/**
 * 키다운 1건을 분류한다.
 * @param {number} keycode      눌린 키 코드
 * @param {number[]} deleteKeys 삭제 계열 키 코드 목록 (Backspace, Delete)
 * @returns {{keys:number, backspaces:number}}
 */
function classifyKeydown(keycode, deleteKeys) {
  const isDelete = Array.isArray(deleteKeys) && deleteKeys.indexOf(keycode) !== -1;
  return { keys: 1, backspaces: isDelete ? 1 : 0 };
}

/**
 * 마우스 이동을 집계할지 판단한다 (이벤트 폭주 방지용 스로틀).
 * @param {number} lastTime   마지막으로 집계한 시각(ms)
 * @param {number} now        현재 시각(ms)
 * @param {number} throttleMs 최소 간격(ms)
 * @returns {boolean}
 */
function shouldCountMouseMove(lastTime, now, throttleMs) {
  if (!lastTime) return true; // 첫 이동은 무조건 집계
  return now - lastTime >= throttleMs;
}

module.exports = { classifyKeydown, shouldCountMouseMove };
