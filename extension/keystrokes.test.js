/**
 * 에디터 변경 이벤트 → 키 입력 추론 테스트
 * TDD 원칙: 이 파일이 RED(실패) → keystrokes.js 구현 후 GREEN(통과)이 되어야 한다.
 *
 * VS Code TextDocumentContentChangeEvent에서 {text, rangeLength}만 사용한다.
 *   text        - 새로 삽입된 문자열
 *   rangeLength - 대체/삭제된 기존 텍스트 길이
 */

const { inferKeystrokes, PASTE_KEY_CREDIT } = require('./keystrokes');

describe('inferKeystrokes', () => {
  test('한 글자 입력 → 1키, 백스페이스 0', () => {
    expect(inferKeystrokes({ text: 'a', rangeLength: 0 }))
      .toEqual({ keys: 1, backspaces: 0 });
  });

  test('자동 괄호쌍(2글자 삽입) → 2키로 집계', () => {
    expect(inferKeystrokes({ text: '()', rangeLength: 0 }))
      .toEqual({ keys: 2, backspaces: 0 });
  });

  test('한 글자 삭제 → 1키 + 백스페이스 1', () => {
    expect(inferKeystrokes({ text: '', rangeLength: 1 }))
      .toEqual({ keys: 1, backspaces: 1 });
  });

  test('블록 삭제(여러 글자) → 삭제 1회로만 집계', () => {
    expect(inferKeystrokes({ text: '', rangeLength: 120 }))
      .toEqual({ keys: 1, backspaces: 1 });
  });

  test('선택 영역 교체 → 타이핑 1키, 백스페이스 0', () => {
    expect(inferKeystrokes({ text: 'x', rangeLength: 5 }))
      .toEqual({ keys: 1, backspaces: 0 });
  });

  test('대량 붙여넣기/자동완성 → 고정 크레딧만 부여 (CPM 폭주 방지)', () => {
    expect(inferKeystrokes({ text: 'a'.repeat(500), rangeLength: 0 }))
      .toEqual({ keys: PASTE_KEY_CREDIT, backspaces: 0 });
  });

  test('변경 없음 → 0', () => {
    expect(inferKeystrokes({ text: '', rangeLength: 0 }))
      .toEqual({ keys: 0, backspaces: 0 });
  });

  test('필드 누락된 이벤트도 안전하게 0 처리', () => {
    expect(inferKeystrokes({})).toEqual({ keys: 0, backspaces: 0 });
  });
});
