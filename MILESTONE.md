# D-Garden 마일스톤 진행 현황

> 최종 갱신: 2026-06-10

---

## M1 — 멘탈 스코어 엔진 ✅ 완료
> TDD: 모든 비즈니스 로직이 테스트로 보장됨

| 항목 | 상태 | 비고 |
|------|------|------|
| `spec.json` 수치 완성 | ✅ | CPM 기준, 키워드 딕셔너리, 팔레트, 테마 팔레트 전부 포함 |
| `garden.test.js` 테스트 케이스 | ✅ | **33개 케이스 전부 PASS** |
| `garden.js` 핵심 함수 구현 | ✅ | CPM 계산, 오타율, 상태 판정, 관객 반응 반영 |
| `npm test` 전체 GREEN | ✅ | `33 passed, 33 total` |

---

## M2 — Canvas 생성형 아트 엔진 ✅ 완료 (원본 명세 초과 구현)
> 브라우저에서 타이핑하면 식물이 살아있는 것처럼 반응

| 항목 | 상태 | 비고 |
|------|------|------|
| `index.html` 메인 대시보드 | ✅ | Glassmorphism UI, 점수/상태/CPM 패널 |
| `engine/tracker.js` 이벤트 수집 | ✅ | 키보드·마우스 CPM, 오타율, crowd 메시지 처리 |
| **프랙탈 나무** Canvas 렌더링 | ✅ | Bezier 곡선, 굵기 그라데이션, 멀티스탑 팔레트 |
| **물리 기반 바람** 시뮬레이션 | ✅ | 질량³ 관성, 3중 주파수, 위상 지연 |
| **스프링 물리** 상태 전환 | ✅ | Hooke's Law, displayScore/effectiveDepth 보간 |
| **개별 잎 생장 시스템** | ✅ | 좌표 DNA 기반 크기·속도, 가지 완료 후 체인 팝콘 |
| **씨앗 파티클 시스템** | ✅ | seeds[] 분리, 에너자이즈, COOLDOWN 부유 |
| 4단계 상태 팔레트 전환 | ✅ | RGB Lerp, 0분절 크로스페이드 |
| 대기 효과 (오로라/비넷 등) | ✅ | Aurora, OverheatEdge, CooldownVeil, Vignette |
| **테마 선택 기능** | ✅ | 4종: 글로잉나무·네온연꽃·심해덩굴·홀로그램다육이 |
| 테마 전환 smooth | ✅ | 팔레트 Lerp + localStorage 저장·복원 |
| 잎 풍성도 (3-클러스터) | ✅ | 90% 밀도, 3번째 잎, 1.6× BASE_LEAF_SIZE |

---

## M3 — Supabase Realtime 관객 인터랙션 ⚠️ 코드 완성 / 자격증명 미입력
> 코드는 모두 준비됨. Supabase 콘솔에서 키 발급만 남음

| 항목 | 상태 | 비고 |
|------|------|------|
| `engine/realtime.js` 수신 모듈 | ✅ | broadcast 구독, 상태 표시 |
| `audience.html` 관객 모바일 페이지 | ✅ | 메시지 전송, 칩 단축어, 토스트 알림 |
| `vercel.json` 배포 설정 | ✅ | `/audience` 라우팅, 캐시 무효화 |
| Supabase 프로젝트 생성 | ❌ **수동 필요** | supabase.com 에서 프로젝트 생성 |
| `spec.json` 키 입력 | ❌ **수동 필요** | `SUPABASE_URL`, `SUPABASE_ANON_KEY` 교체 |

---

## M4 — 완성 및 발표 준비 🔶 부분 완료
> 해커톤 발표장 실전 투입 전 남은 항목

| 항목 | 상태 | 비고 |
|------|------|------|
| Vercel 배포 설정 (`vercel.json`) | ✅ | 설정 파일 완성 |
| GitHub 레포 + 첫 커밋 | ✅ | `474ebfc` — D-Garden v1.0 |
| 미배포 변경사항 스테이징 | ❌ **커밋·배포 필요** | 테마·비주얼 대규모 업데이트 미커밋 |
| Supabase 키 입력 후 재배포 | ❌ 대기 중 | M3 키 입력 선행 필요 |
| QR 코드 생성 기능 | ❌ 미구현 | 발표 슬라이드용 audience URL QR 생성 |
| `spec.json` 수치 라이브 조정 | 🔶 선택 | 현장 반응에 따라 조정 |
| 실제 모바일 연동 시연 리허설 | ❌ 미진행 | Supabase 연결 후 가능 |

---

## M5 — 입력 브리지 (전역 에이전트) ✅ 코드·검증 완료 / Cursor 재시작만 남음
> 실제 작업 중에도 가든이 반응하도록 로컬 SSE 브리지 구축.
> 배경: 웹페이지는 자기 탭 안의 입력만 볼 수 있어, 다른 앱에서 타이핑하면 idle로 판정되던 문제 해결.
> 진화: (1차) Cursor 전용 확장 → (2차) **컴퓨터 전체 입력을 듣는 백그라운드 에이전트**로 대체.

| 항목 | 상태 | 비고 |
|------|------|------|
| `agent/keycount.js` 입력 분류 로직 | ✅ | TDD — 순수함수 테스트 7개 (총 49개 GREEN) |
| `agent/index.js` 전역 후킹 + SSE | ✅ | uiohook-napi 전역 키/마우스, 127.0.0.1:7331, 키 내용 미전송 |
| `engine/editor-bridge.js` 수신 모듈 | ✅ | EventSource 구독, keys/mouse 이벤트 처리 |
| `engine/tracker.js` onEditorActivity/onEditorMouseMove | ✅ | onKeyDown·onMouseMove와 동일 집계 규칙 |
| `spec.json` EDITOR_BRIDGE_URL | ✅ | `http://127.0.0.1:7331/events` (DGARDEN_PORT로 변경 가능) |
| 전역 후킹 E2E 검증 | ✅ | 합성 키 20타·백스페이스 3 → SSE 프레임 정확 수신 확인 |
| Cursor 확장(1차안) 제거 | ✅ | `agent/`로 역할 대체되어 uninstall |
| Cursor 재시작 → 포트 7331 해제 + 에이전트 실행 | ❌ **수동 필요** | 재시작 후 `agent/start.cmd` 실행 → 페이지에 `● EDITOR LINKED` |

---

## 추가 구현 (원본 명세 초과)

| 항목 |
|------|
| 스프링 물리 기반 분절 없는 상태 전환 |
| 물리 바람 시뮬레이션 (관성·위상지연) |
| 성장-점수 직결 (점수 하락 시 나무도 수축) |
| 4종 테마 + localStorage 저장 |
| 네온연꽃: bezier 꽃잎 개화 애니메이션 |
| 심해덩굴: 3중 주파수 해초 운동 + 발광 펄스 |
| 홀로그램다육이: 에케베리아 로제트, 이색 잎 |
| OVERHEAT 빛 테두리 / COOLDOWN 호흡 펄스 |
| 관객 입력 → 씨앗 에너자이즈 파티클 폭발 |

---

## 남은 필수 작업 (해커톤 전 체크리스트)

```
[ ] supabase.com 프로젝트 생성 → URL + ANON KEY 복사
[ ] spec.json 의 SUPABASE_URL / SUPABASE_ANON_KEY 교체
[ ] git add . && git commit -m "feat: themes + visual overhaul"
[ ] vercel deploy (또는 git push → auto deploy)
[ ] 배포된 URL /audience 로 QR 생성 (qr.io 등 무료 사이트)
[ ] 실제 폰으로 audience 페이지 접속 → 메시지 전송 → 발표 화면 반응 확인
```
