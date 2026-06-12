/**
 * 에디터 변경 이벤트 → 키 입력 추론 (순수 함수)
 *
 * VS Code TextDocumentContentChangeEvent에서 {text, rangeLength}만 사용해
 * 실제 키 입력 횟수(keys)와 삭제 횟수(backspaces)를 추정한다.
 * Node(Jest)와 확장 런타임 양쪽에서 require로 사용된다.
 */

// 3글자 이상 한 번에 삽입되면 붙여넣기/AI 자동완성으로 간주 → 고정 크레딧만 부여
const PASTE_KEY_CREDIT = 3;

function inferKeystrokes(change) {
  const inserted = change && change.text ? change.text.length : 0;
  const removed  = change && change.rangeLength ? change.rangeLength : 0;

  if (inserted === 0 && removed === 0) return { keys: 0, backspaces: 0 };

  // 순수 삭제 = Backspace/Delete 1회 (블록 삭제도 키는 1번)
  if (inserted === 0) return { keys: 1, backspaces: 1 };

  // 1~2글자 삽입 = 실제 타이핑 (자동 괄호쌍 포함, 선택 영역 교체도 타이핑)
  if (inserted <= 2) return { keys: inserted, backspaces: 0 };

  // 대량 삽입 = 붙여넣기/자동완성 → CPM 폭주 방지
  return { keys: PASTE_KEY_CREDIT, backspaces: 0 };
}

module.exports = { inferKeystrokes, PASTE_KEY_CREDIT };
