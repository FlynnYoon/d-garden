# D-Garden 마일스톤 진행 현황

## M1 - 멘탈 스코어 엔진 (비즈니스 로직 + TDD)
> 목표: 점수 계산이 spec.json 규칙대로 정확히 동작하는지 테스트로 보장

- [x] `spec.json` 수치 완성 (CPM 기준, 키워드 딕셔너리 포함)
- [ ] `garden.test.js` 테스트 케이스 작성
- [ ] `garden.js` 핵심 함수 구현
- [ ] `npm test` 전체 GREEN 확인

**완료 기준:** `npm test` 실행 시 모든 케이스 PASS

---

## M2 - HTML5 Canvas 생성형 아트 엔진
> 목표: 브라우저에서 점수에 따라 4가지 식물 상태가 실시간 시각화

- [x] `index.html` 메인 대시보드 (Glassmorphism UI)
- [x] `engine/tracker.js` 키보드/마우스 이벤트 수집
- [x] `engine/renderer.js` 프랙탈 나무 + 파티클 꽃 Canvas 렌더링

**완료 기준:** 브라우저에서 타이핑하면 식물이 살아있는 것처럼 반응

---

## M3 - Supabase Realtime 관객 인터랙션
> 목표: 관객 QR 스캔 → 응원 입력 → 발표 화면 파티클 이펙트

- [ ] Supabase 프로젝트 생성 및 키 발급 (수동)
- [ ] `remote.html` 관객 모바일 리모컨 페이지
- [ ] `engine/crowd.js` Supabase Realtime 채널 연동

**완료 기준:** 모바일에서 "화이팅" 입력 시 발표 화면 식물 파티클 폭발 + 점수 +2점

---

## M4 - 완성 및 발표 준비
> 목표: 해커톤 발표장에서 쓸 수 있는 수준으로 마무리

- [ ] GitHub 레포 생성 + Vercel 배포
- [ ] QR 코드 URL 생성 (발표 슬라이드용)
- [ ] 점수 게이지 UI 및 상태 텍스트 최종 polish
- [ ] `spec.json` 수치 라이브 조정 최종 확인

**완료 기준:** 실제 모바일 + 발표 화면 연동 시연 성공
