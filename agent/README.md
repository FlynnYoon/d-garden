# D-Garden Agent (전역 입력 브리지)

컴퓨터 전체의 키보드/마우스 입력 **횟수**를 감지해, D-Garden 페이지로 중계하는 로컬 백그라운드 프로그램입니다.
어떤 앱에서 일하든(Cursor·브라우저·메모장 등) 나무가 반응합니다.

## 실행

```
cd agent
npm install      # 최초 1회 (uiohook-napi 네이티브 모듈)
npm start        # 또는 start.cmd 더블클릭
```

실행하면 `http://127.0.0.1:7331/events` 에 SSE 서버가 뜨고, D-Garden 페이지(`engine/editor-bridge.js`)가 자동으로 구독합니다.
페이지 좌측 상단에 `● EDITOR LINKED` 가 뜨면 연결 성공입니다. 끄려면 실행 창을 닫으세요.

## 프라이버시

- **외부 전송 없음** — `127.0.0.1`(내 컴퓨터)에만 바인딩합니다.
- **키 내용 미수집** — 어떤 키를 눌렀는지는 절대 읽지 않고, "몇 번 눌렀는지"와 "삭제였는지"만 셉니다.

## 참고

- 구조상 전역 키 후킹이라 백신(Windows Defender 등)이 경고할 수 있습니다. 본인이 실행한 것이면 허용하세요.
- 포트는 `spec.json` 의 `EDITOR_BRIDGE_URL` 과 맞춰야 합니다. 바꾸려면 `DGARDEN_PORT` 환경변수로 실행하세요.
- Cursor 전용 확장(`extension/`)은 이 에이전트로 대체되었습니다(역할 중복).
