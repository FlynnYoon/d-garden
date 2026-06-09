/**
 * D-Garden Canvas 렌더러 (부드러운 상태 전환 버전)
 *
 * 핵심 원칙:
 *   - 상태 전환 시 나무 구조/성장률 리셋 없음 (No Re-initialization)
 *   - prevPalette → currPalette RGB Lerp: 색상이 수액처럼 스르륵 물듦
 *   - displayCPM 점진 변화: 바람 속도가 부드럽게 빨라지고 느려짐
 *   - 대기 효과(Aurora, OverheatEdge 등)도 가중치 Lerp로 교차 페이드
 *   - SDD: 모든 팔레트 색상 → spec.json PALETTE
 */

const Renderer = (() => {
  let canvas, ctx;
  let PALETTE = null;
  let particles = [];
  let treeTips  = [];
  let currentScore = 50;
  let currentState = 'OPTIMAL';
  let currentCPM   = 0;

  // ─── 색상 전환 시스템 ────────────────────────────────────────
  // prevPalette: 전환 시작 시점의 시각적 팔레트 (스냅샷)
  // currPalette: 목표 팔레트 (현재 상태)
  // transitionT: 0(이전) → 1(현재), 매 프레임 조금씩 증가
  let prevPalette   = null;
  let currPalette   = null;
  let transitionT   = 1.0;
  let prevStateName = 'OPTIMAL';

  const TRANSITION_SPEED = 0.020; // ~50프레임(~0.83초) 전환 완료

  // 바람 속도: currentCPM을 즉시 반영하지 않고 부드럽게 추종
  let displayCPM = 0;

  // ─── 시각적 보간 상태 레이어 (Visual State Object) ────────────
  // garden.js는 비즈니스 로직만 담당한다. 아래 renderState는 renderer.js가
  // 매 프레임 실시간 Lerp를 수행하여 분절 없는 시각 연속성을 보장하는 전용 레이어.
  //
  // 분절 원인 3가지:
  //   1) currentScore 즉시 반영 → trunkLen, baseSize 점프
  //   2) maxDepth(= 가지 깊이) 정수 점프 → growthTarget 급변
  //   3) CPM 즉시 반영 → 바람 속도 점프 (displayCPM이 이미 처리)
  // 훅의 법칙(Hooke's Law) 기반 스프링 시뮬레이터
  // velocity(속도) + stiffness(스프링 계수) + damping(댐핑) 으로 오버슛 후 안착
  const renderState = {
    displayScore:   50,   // 스프링으로 targetScore를 쫓음 (오버슛 → 안착)
    scoreVelocity:   0,   // 점수 스프링 속도
    effectiveDepth:  6,   // 스프링으로 targetDepth를 쫓음
    depthVelocity:   0,   // 깊이 스프링 속도
  };

  // ─── 순차 생장 ───────────────────────────────────────────────
  const OVERLAP_WINDOW = 0.65;
  let growthProgress = 0;
  let growthTarget   = 8;
  let lastAnimTime   = Date.now();

  function updateGrowthProgress() {
    const now = Date.now();
    const dt  = Math.min(now - lastAnimTime, 100);
    lastAnimTime = now;

    // ── 핵심: growthProgress = 점수 직접 반영 ────────────────────────
    // 점수 올라가면 나무 자라고, 점수 내려가면 나무 줄어듦
    // effectiveDepth(spring)에서 growthTarget 미리 계산 후 점수 비율로 설정
    const md = Math.max(3, Math.min(10, Math.round(renderState.effectiveDepth)));
    growthTarget   = (md - 1) * OVERLAP_WINDOW + 1;
    growthProgress = (renderState.displayScore / 100) * growthTarget;

    // ── 스프링 물리 보간 (매 프레임 실행) ──────────────────────────
    // Hooke's Law: F = -k * displacement (가속도 = 변위에 비례)
    // 댐핑(Damping) < 1.0 → 언더댐핑 → 오버슛 후 수렴 = 탄성 안착감

    // 점수 스프링: k=0.07, d=0.74 → 오버슛 ~6% 후 자연스럽게 안착
    const scoreDisp         = currentScore - renderState.displayScore;
    renderState.scoreVelocity  += scoreDisp * 0.07;   // 스프링 힘
    renderState.scoreVelocity  *= 0.74;               // 댐핑(마찰)
    renderState.displayScore   += renderState.scoreVelocity;
    // 스프링 오버슈트로 범위 이탈 방지 (0~100 클램프)
    renderState.displayScore    = Math.max(0, Math.min(100, renderState.displayScore));

    // 가지 깊이 스프링: 더 부드럽게 (k=0.05, d=0.80) → 가지 수 출렁임
    const targetDepth          = getMaxDepth(currentScore, currentState);
    const depthDisp            = targetDepth - renderState.effectiveDepth;
    renderState.depthVelocity  += depthDisp * 0.05;
    renderState.depthVelocity  *= 0.80;
    renderState.effectiveDepth += renderState.depthVelocity;

    // transitionT 전진 + displayCPM 추종
    transitionT = Math.min(1, transitionT + TRANSITION_SPEED);
    displayCPM += (currentCPM - displayCPM) * 0.07;
  }

  /**
   * 가지마다 고유한 생장 속도 가중치 (Dynamic Branch Velocity)
   *
   * velocityOffset ±0.80: 글로벌 growthProgress에 더하거나 빼서
   * 빠른 가지(+0.8)는 이웃보다 0.8 유닛 일찍 자라고,
   * 느린 가지(-0.8)는 더 늦게 시작 → 매 순간 불균형한 나무 실루엣
   *
   * 단말 가지(levelIndex=7)의 최대 지연이 growthTarget 내에 완료되도록
   * 오프셋 범위를 ±0.80으로 제한 (5.55 - 0.8 = 4.75 >= 4.55 ✓)
   */
  function calcBranchGrowthFactor(levelIndex, branchId) {
    const velocityOffset  = (seededRandom(branchId * 59 + 3) - 0.5) * 1.60; // ±0.80
    const personalProgress = growthProgress + velocityOffset;
    const raw = Math.max(0, Math.min(1, personalProgress - levelIndex * OVERLAP_WINDOW));
    return 1 - Math.pow(1 - raw, 3); // Cubic Ease-Out
  }

  /**
   * 스프링 물리 이징 함수 (Hooke's Law 감쇠 조화 진동)
   *
   * x(t) = 1 - e^(-d*t) * (cos(w*t) + (d/w)*sin(w*t))
   *   d = 7.0  : 댐핑 계수 (클수록 빨리 안정, <임계댐핑 → 오버슛)
   *   w = 10.0 : 진동 주파수 (클수록 출렁임 빈도 증가)
   *
   * 결과: t=0 → 0, 피크(t≈0.31) → ~1.11 (11% 오버슛), t=1 → ≈1.0
   * 잎 생장에 적용 시 '팍 터지듯 110%로 피어났다가 100%로 안착' 연출
   */
  function springEase(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const d = 7.0, w = 10.0;
    return 1 - Math.exp(-d * t) * (Math.cos(w * t) + (d / w) * Math.sin(w * t));
  }

  // ─── 의사난수 ────────────────────────────────────────────────
  function seededRandom(seed) {
    seed = ((seed ^ 61) ^ (seed >>> 16)) >>> 0;
    seed = (seed + (seed << 3)) >>> 0;
    seed = (seed ^ (seed >>> 4)) >>> 0;
    seed = Math.imul(seed, 0x27d4eb2d) >>> 0;
    seed = (seed ^ (seed >>> 15)) >>> 0;
    return seed / 0xFFFFFFFF;
  }

  // ─── 색상 유틸 ───────────────────────────────────────────────
  // hex('#rrggbb') 또는 rgb/rgba 문자열 모두 처리 → [r, g, b] 반환
  function parseColor(c) {
    if (typeof c === 'string' && c.startsWith('#')) {
      return [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16), parseInt(c.slice(5,7),16)];
    }
    const m = (c || '').match(/[\d.]+/g) || [0,0,0];
    return [parseInt(m[0])||0, parseInt(m[1])||0, parseInt(m[2])||0];
  }

  // hex 또는 rgb 문자열 두 개를 t 비율로 보간 → '#rrggbb' 반환
  function lerpColor(c1, c2, t) {
    const a=parseColor(c1), b=parseColor(c2);
    const hex=(n)=>Math.round(n).toString(16).padStart(2,'0');
    return `#${hex(a[0]+(b[0]-a[0])*t)}${hex(a[1]+(b[1]-a[1])*t)}${hex(a[2]+(b[2]-a[2])*t)}`;
  }

  function hexToRgba(hex, alpha) {
    const c=parseColor(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
  }

  // rgba(r,g,b,a) 문자열 → [r,g,b,a] 배열
  function parseRGBA(str) {
    return (str.match(/[\d.]+/g) || []).map(Number);
  }

  // rgba 문자열 두 개를 t 비율로 보간
  function lerpRGBA(c1, c2, t) {
    const a = parseRGBA(c1), b = parseRGBA(c2);
    return `rgba(${Math.round(a[0]+(b[0]-a[0])*t)},${Math.round(a[1]+(b[1]-a[1])*t)},${Math.round(a[2]+(b[2]-a[2])*t)},${(a[3]+(b[3]-a[3])*t).toFixed(2)})`;
  }

  function getGradientColor(t, stops) {
    const v = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i].t) {
        const range = stops[i].t - stops[i-1].t;
        const local = range > 0 ? (v - stops[i-1].t) / range : 0;
        return lerpColor(stops[i-1].color, stops[i].color, local);
      }
    }
    return stops[stops.length-1].color;
  }

  /**
   * 매 프레임 prevPalette ↔ currPalette 사이를 transitionT로 보간한
   * 유효 팔레트를 계산한다.
   * colorStops는 고정 5개 샘플로 리샘플링 → 어떤 상태 조합도 매끄럽게 섞임.
   */
  function buildEffectivePalette() {
    if (!prevPalette || !currPalette) return currPalette || PALETTE.OPTIMAL;
    const t = 1 - Math.pow(1 - transitionT, 2); // Ease-out quad
    const SAMPLES = [0, 0.25, 0.5, 0.75, 1.0];

    return {
      colorStops: SAMPLES.map(s => ({
        t: s,
        color: lerpColor(
          getGradientColor(s, prevPalette.colorStops),
          getGradientColor(s, currPalette.colorStops),
          t
        ),
      })),
      tipColorA:   lerpColor(prevPalette.tipColorA,   currPalette.tipColorA,   t),
      tipColorB:   lerpColor(prevPalette.tipColorB,   currPalette.tipColorB,   t),
      orbColor:    lerpColor(prevPalette.orbColor,     currPalette.orbColor,    t),
      orbAltColor: lerpColor(prevPalette.orbAltColor,  currPalette.orbAltColor, t),
      orbSpecial:  lerpColor(prevPalette.orbSpecial,   currPalette.orbSpecial,  t),
      glowColor:   lerpRGBA(prevPalette.glowColor,    currPalette.glowColor,   t),
      glowBlur:    prevPalette.glowBlur + (currPalette.glowBlur - prevPalette.glowBlur) * t,
      spread:      prevPalette.spread   + (currPalette.spread   - prevPalette.spread)   * t,
      bgCenter:    lerpColor(prevPalette.bgCenter,    currPalette.bgCenter,    t),
      bgEdge:      lerpColor(prevPalette.bgEdge,      currPalette.bgEdge,      t),
    };
  }

  // 특정 상태의 현재 가중치 (대기 효과 크로스페이드용)
  // 전환 중일 때 이전 상태는 fade-out, 현재 상태는 fade-in
  function getStateWeight(stateName) {
    const t = 1 - Math.pow(1 - transitionT, 2);
    if (currentState === stateName)  return t;
    if (prevStateName === stateName) return 1 - t;
    return 0;
  }

  /**
   * COOLDOWN 전용 호흡 펄스 계수 (4.2초 주기 들숨/날숨)
   * 반환값 0.38 ~ 0.95: 날숨에 어두워지고 들숨에 밝아짐
   * breathWeight = getStateWeight('COOLDOWN') 로 COOLDOWN 이외 상태에서 중립(1.0) 유지
   */
  function breathPulse(time) {
    const raw = 0.65 + 0.30 * Math.sin(time * 0.0015); // 0.35 ~ 0.95
    const w   = getStateWeight('COOLDOWN');
    return 1 - w + w * raw; // COOLDOWN 진입할수록 호흡 효과 강화
  }

  function getMaxDepth(score, state) {
    // 범위 확장: DORMANT=앙상한 뼈대(3), OVERHEAT=폭발적 성장(10)
    // 점수 차이가 시각적으로 극적으로 드러나도록
    if (state === 'DORMANT')  return 3;
    if (state === 'COOLDOWN') return 7;
    if (state === 'OVERHEAT') return 10;
    // OPTIMAL: 21~60점 → depth 5~9
    return Math.min(9, 5 + Math.floor((score - 21) / 10));
  }

  // ─── 잎사귀 (Leaf) ─────────────────────────────────────────────
  // 잎사귀는 가지 끝에 고정된 고정형 UI 오브젝트 (씨앗 파티클과 완전히 분리)

  /**
   * 3단계 생장 체인 1단계: 가지 gf → 잎 등장 허용 최대값
   * 가지가 100%(gf≥0.99) 완전히 뻗기 전까지 잎 크기는 절대 0 (체인 게이트 1)
   * 반환값: 0 or 1 (게이트 역할만 수행)
   */
  function leafGrowScale(gf) {
    return gf >= 0.99 ? 1 : 0;
  }

  /**
   * 가지 완료 타이밍을 growthProgress 스케일로 역산 (씨앗·잎 개별 타이밍 계산)
   * levelIndex와 branchId로 해당 가지가 gf=1에 도달한 growthProgress 기준점을 반환.
   */
  function branchCompletionThreshold(levelIndex, branchId) {
    const velocityOffset = (seededRandom(branchId * 59 + 3) - 0.5) * 1.60;
    return levelIndex * OVERLAP_WINDOW + 1.0 - velocityOffset;
  }

  /**
   * 3단계 생장 체인 진행도 계산 (씨앗 생성 조건 판별용)
   * 좌표 DNA(Math.sin) 기반으로 이 tip의 잎사귀 leafProgress 0~1을 반환.
   */
  function estimateLeafProgress(tip) {
    if (tip.gf < 0.99) return 0;
    const li         = tip.li !== undefined ? tip.li : 0;
    const threshold  = branchCompletionThreshold(li, tip.id);
    const leafAge    = Math.max(0, growthProgress - threshold);
    const leafSeed   = Math.sin(tip.x * 12.3 + tip.y * 45.6);
    const growthSpd  = 0.8 + Math.abs(leafSeed) * 1.2;
    return Math.min(1.0, leafAge * growthSpd);
  }

  /**
   * 단일 잎사귀 드로우 (ctx.ellipse 기반 나뭇잎 형상)
   *
   * @param targetSize    이 잎의 최종 목표 크기 (잎마다 다름 — 독립 랜덤값)
   * @param birthProgress 0→1: 이 잎의 개별 탄생 타임라인 진행도
   * @param angleOffset   보조 잎 각도 오프셋 (radian)
   * @param droop         COOLDOWN 처짐 각도 (radian)
   */
  /**
   * 단일 잎사귀 드로우 (베지어 커브 기반 자연스러운 잎 형상)
   *
   * @param angleOffset  가지 방향 대비 개별 잎의 뻗음 각도 — 이걸로 나비 방지
   *                     drawAllLeaves에서 좌표 DNA로 계산된 방향각을 전달받는다.
   */
  function drawLeaf(x, y, angle, targetSize, ep, time, birthProgress, angleOffset, droop) {
    if (birthProgress < 0.015) return;

    const cooldownW   = getStateWeight('COOLDOWN');
    const bp          = breathPulse(time);
    const eased       = springEase(birthProgress);

    // ── 잎 3중 주파수 Flutter ────────────────────────────────────
    const leafPhase   = x * 0.011 + y * 0.009;
    const flutterBase = 0.10 * (1 - cooldownW * 0.82);
    const flt1  = Math.sin(time * 0.0042 + leafPhase)        * 0.55;
    const flt2  = Math.sin(time * 0.0098 + leafPhase * 1.55) * 0.28;
    const flt3  = Math.sin(time * 0.0200 + leafPhase * 0.80) * 0.17;
    const flutter = flutterBase * (flt1 + flt2 + flt3);

    const len = targetSize * eased;
    const wid = len * 0.36; // 약 2.8:1 — 너무 뾰족하지 않고 통통한 잎

    if (len < 1.0) return;

    ctx.save();
    ctx.translate(x, y);

    // ── 핵심 수정: Math.PI/2 제거 ────────────────────────────────
    // 기존: angle + PI/2 → 가지에 수직 → 좌우 대칭 나무에서 나비 날개처럼 보임
    // 변경: angle + angleOffset → 각 잎이 고유 방향으로 뻗어나가도록
    //       angleOffset은 drawAllLeaves에서 좌표 DNA로 ±72° 범위로 결정됨
    ctx.rotate(angle + (angleOffset || 0) + flutter + (droop || 0));

    // ── 베지어 커브 잎 모양 ──────────────────────────────────────
    // 가지 끝(0, 0)에서 출발 → 양쪽으로 배 부름 → 뾰족한 잎 끝(0, -len)으로 수렴
    // ctx.ellipse 대비: 비대칭 윤곽, 기저부가 좁고 중간이 두꺼운 자연스러운 실루엣
    ctx.beginPath();
    ctx.moveTo(0, 0);
    // 오른쪽 윤곽: 기저 → 최대폭(25%) → 끝점
    ctx.bezierCurveTo( wid,       -len * 0.28,   wid * 0.52,  -len * 0.68,  0, -len);
    // 왼쪽 윤곽: 끝점 → 최대폭(25%) → 기저
    ctx.bezierCurveTo(-wid * 0.52,-len * 0.68,  -wid,         -len * 0.28,  0,  0);

    const grad = ctx.createLinearGradient(0, 0, 0, -len);
    grad.addColorStop(0.0,  hexToRgba(ep.tipColorA,  0.55 * eased * bp));
    grad.addColorStop(0.45, hexToRgba(ep.tipColorB,  0.80 * eased * bp));
    grad.addColorStop(1.0,  hexToRgba(ep.orbSpecial, 0.50 * eased * bp));

    ctx.shadowBlur  = 18 * eased * bp;
    ctx.shadowColor = ep.glowColor;
    ctx.fillStyle   = grad;
    ctx.fill();

    // ── 잎맥 (발광 중앙선) ──
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.05);
    ctx.lineTo(0, -len * 0.90);
    ctx.strokeStyle = hexToRgba(ep.orbSpecial, 0.30 * eased * bp);
    ctx.lineWidth   = 0.7;
    ctx.shadowBlur  = 5;
    ctx.stroke();

    ctx.restore();
  }

  function drawAllLeaves(time, ep) {
    // spec.json의 BASE_LEAF_SIZE + 점수 비례 보정 → 잎의 기본 크기 기준값
    const BASE_LEAF_SIZE = (window.SPEC.BASE_LEAF_SIZE || 10) * (1 + renderState.displayScore * 0.005);

    // COOLDOWN: 잎이 에너지를 잃고 서서히 수축하는 시각적 피드백
    const cooldownW    = getStateWeight('COOLDOWN');
    const cooldownShrink = 1 - cooldownW * 0.55; // COOLDOWN 100%에서 45% 크기로
    const droop        = cooldownW * 0.38;        // 중력에 처지는 각도

    treeTips.forEach((tip) => {
      // ── 체인 게이트: 가지가 99% 이상 자라기 전까지 잎 출현 완전 차단 ──
      if (tip.gf < 0.99) return;

      // branchId 기반 잎 선택 (75% 확률, 나머지는 빈 끝가지)
      if (seededRandom(tip.id * 31 + 3) > 0.75) return;

      // ── 가지 완료 시점 역산 → 잎의 '탄생 시간(Birth Time)' 기준점 ──
      const li        = tip.li !== undefined ? tip.li : 0;
      const threshold = branchCompletionThreshold(li, tip.id);
      const leafAge   = Math.max(0, growthProgress - threshold);

      // ── 좌표 시드 DNA: 같은 좌표 → 항상 같은 크기/속도 (Stateless) ──
      const leafSeed    = Math.sin(tip.x * 12.3 + tip.y * 45.6);
      const absS        = Math.abs(leafSeed);
      // 크기: 0.5x ~ 2.0x BASE_LEAF_SIZE (3~20px 범위에서 제각각)
      const maxLeafSize = BASE_LEAF_SIZE * (0.5 + absS * 1.5);
      // 속도: 느린 잎(0.8x) ~ 빠른 잎(2.0x)
      const growthSpeed = 0.8 + absS * 1.2;

      // ── 잎 개별 leafProgress 계산 (이 잎만의 0→1 타임라인) ──
      const leafProgress = Math.min(1.0, leafAge * growthSpeed);
      if (leafProgress < 0.01) return;

      // ── 실제 크기: 스프링 이징(팡!) + COOLDOWN 수축 ──
      const currentLeafSize = maxLeafSize * cooldownShrink;

      // ── 핵심: 좌표 DNA 기반 개별 뻗음 방향각 ────────────────────
      // leafSeed(-1~1) × 1.25 rad ≈ ±72° 범위에서 각 잎이 고유한 방향으로 뻗어나감
      // 가지 끝에서 "사방으로 흩어지는" 자연스러운 식물 실루엣 완성
      const leafDir = leafSeed * 1.25;

      drawLeaf(tip.x, tip.y, tip.angle, currentLeafSize, ep, time, leafProgress, leafDir, droop);

      // ── 보조 잎: 35% 확률로 주 잎 이후 약간 늦게 팝콘처럼 터짐 ──
      if (seededRandom(tip.id * 47 + 7) > 0.65) {
        const subSeed      = Math.sin(tip.x * 8.7 + tip.y * 33.2 + 1.5);
        const absSubS      = Math.abs(subSeed);
        const subMaxSize   = BASE_LEAF_SIZE * (0.3 + absSubS * 0.85);
        const subSpeed     = 0.7 + absSubS * 1.1;
        const subAge       = Math.max(0, leafAge - 0.4);
        const subProgress  = Math.min(1.0, subAge * subSpeed);
        if (subProgress > 0.01) {
          const subSize    = subMaxSize * cooldownShrink;
          // 보조 잎은 주 잎 반대 방향으로 기울어짐 → 한 가지 끝에 양쪽으로 벌어진 잎 쌍
          const subDir     = subSeed * 1.25 + Math.PI * 0.25;
          drawLeaf(tip.x, tip.y, tip.angle, subSize, ep, time, subProgress, subDir, droop);
        }
      }
    });
  }

  // ─── 프랙탈 가지 ─────────────────────────────────────────────
  function drawBranch(x1, y1, angle, length, depth, maxDepth, ep, time, branchId) {
    const levelIndex   = Math.max(0, maxDepth - depth - 1);
    // 개별 속도 오프셋 적용: 같은 깊이의 가지들도 서로 다른 속도로 자람
    const growthFactor = calcBranchGrowthFactor(levelIndex, branchId);

    if (growthFactor <= 0) {
      treeTips.push({ x: x1, y: y1, angle, gf: 0, id: branchId });
      return;
    }
    if (depth === 0) {
      // id = branchId: 프레임 간 안정적인 잎 개별 타이밍의 키
      treeTips.push({ x: x1, y: y1, angle, gf: growthFactor, id: branchId, li: levelIndex });
      return;
    }

    const sr = (n) => seededRandom(branchId * 41 + n * 17);

    // ── 물리 기반 바람 시뮬레이션 ────────────────────────────────
    const cooldownW = getStateWeight('COOLDOWN');

    // 1. 관성(Inertia by Mass): 줄기는 무거워 거의 안 흔들림, 끝단은 파르르
    //    mass = depth/maxDepth: 1(줄기) → 0(끝단)
    //    inertia = mass³: 비선형 — 줄기에 극단적 안정성 부여
    const mass      = depth / maxDepth;
    const inertia   = mass * mass * mass;
    const swayBase  = (0.028 + Math.min(displayCPM / 350, 1) * 0.095) * (1 - cooldownW * 0.85);
    const windPower = Math.max(0, swayBase - inertia * 0.062);

    // 2. 위상 지연(Phase Delay): 바람이 뿌리→끝단으로 전파
    //    끝단(depthRatio≈1)이 줄기 움직임에 한 박자 늦게 반응
    const depthRatio = 1 - mass;                               // 0(줄기) ~ 1(끝단)
    const phaseDelay = depthRatio * 2.60 + branchId * 0.14 + x1 * 0.003;

    // 3. 다중 주파수(Multi-freq Wind): 1차(거시 기류) + 2차(돌풍) + 3차(난류)
    //    끝단으로 갈수록 freqMult 3.8배 증가 → 잔가지 고주파 파르르
    const freqMult = 1.0 + depthRatio * 2.8;
    const wind1 = Math.sin(time * 0.00055 * freqMult + phaseDelay)                           * 0.58;
    const wind2 = Math.sin(time * 0.00140 * freqMult + phaseDelay * 1.35 + branchId * 0.28) * 0.30;
    const wind3 = Math.sin(time * 0.00380 * freqMult + phaseDelay * 2.00 + x1  * 0.0065)   * 0.12;
    const sway  = windPower * (wind1 + wind2 + wind3);

    const organicAngle  = angle + sway + (sr(0) - 0.5) * 0.22;
    const organicLength = length * (0.80 + sr(1) * 0.38) * growthFactor;

    const x2 = x1 + Math.cos(organicAngle) * organicLength;
    const y2 = y1 + Math.sin(organicAngle) * organicLength;

    const perpAngle = organicAngle + Math.PI / 2;
    const curvature = (sr(2) - 0.5) * organicLength * 0.42;
    const cpX = x1*0.3 + x2*0.7 + Math.cos(perpAngle)*curvature;
    const cpY = y1*0.3 + y2*0.7 + Math.sin(perpAngle)*curvature;

    const tStart = 1 - depth / maxDepth;
    const tMid   = 1 - (depth - 0.5) / maxDepth;
    const tEnd   = 1 - (depth - 1) / maxDepth;

    const colorStart = getGradientColor(tStart, ep.colorStops);
    const colorMid   = getGradientColor(tMid,   ep.colorStops);
    const isTip      = depth <= 2;
    const tipRand    = sr(9);
    const colorEnd   = isTip
      ? (tipRand < 0.70 ? ep.tipColorA : tipRand < 0.90 ? ep.tipColorB : ep.orbSpecial)
      : getGradientColor(tEnd, ep.colorStops);

    const lw = Math.max(0.3, Math.pow(depth / maxDepth, 1.6) * 12);
    const branchGrad = ctx.createLinearGradient(x1, y1, x2, y2);
    branchGrad.addColorStop(0,   colorStart);
    branchGrad.addColorStop(0.5, colorMid);
    branchGrad.addColorStop(1,   colorEnd);

    const bezierPath = () => {
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(cpX, cpY, x2, y2);
    };

    // 호흡 펄스: COOLDOWN에서 나무 전체가 천천히 밝아졌다 어두워짐
    const bp        = breathPulse(time);
    const baseAlpha = Math.pow(growthFactor, 0.55) * bp;

    ctx.save(); ctx.lineCap='round'; ctx.lineWidth=lw*9;
    ctx.globalAlpha=baseAlpha*(0.018+tStart*0.028); ctx.shadowBlur=0; ctx.strokeStyle=colorStart;
    bezierPath(); ctx.stroke(); ctx.restore();

    ctx.save(); ctx.lineCap='round'; ctx.lineWidth=lw*2.8;
    ctx.globalAlpha=baseAlpha*(0.14+tEnd*0.10);
    ctx.shadowBlur=ep.glowBlur*0.85*bp; ctx.shadowColor=ep.glowColor; ctx.strokeStyle=colorEnd;
    bezierPath(); ctx.stroke(); ctx.restore();

    ctx.save(); ctx.lineCap='round'; ctx.lineWidth=lw;
    ctx.globalAlpha=baseAlpha;
    ctx.shadowBlur=ep.glowBlur*(0.35+tEnd*0.65)*bp; ctx.shadowColor=ep.glowColor;
    ctx.strokeStyle=branchGrad; bezierPath(); ctx.stroke(); ctx.restore();

    const nextLen    = organicLength*(0.62+sr(3)*0.13);
    const leftAngle  = organicAngle - ep.spread*(0.82+sr(4)*0.36);
    const rightAngle = organicAngle + ep.spread*(0.82+sr(5)*0.36);
    drawBranch(x2, y2, leftAngle,  nextLen, depth-1, maxDepth, ep, time, branchId*2);
    drawBranch(x2, y2, rightAngle, nextLen, depth-1, maxDepth, ep, time, branchId*2+1);

    if (depth >= 4 && sr(6) > 0.75) {
      const tenAngle = organicAngle + (sr(7)-0.5)*1.1;
      drawBranch(x2, y2, tenAngle, nextLen*0.58, depth-2, maxDepth, ep, time, branchId*3+99);
    }
  }

  // ─── 나무 전체 ────────────────────────────────────────────────
  function drawTree(time, ep) {
    treeTips = [];
    // effectiveDepth Lerp: 정수 점프 대신 연속 Lerp → 가지 수 급변 차단
    // Math.round로 최종 정수화 (프랙탈 재귀는 정수 depth 필요)
    const maxDepth = Math.max(3, Math.min(10, Math.round(renderState.effectiveDepth)));
    const cx       = canvas.width  / 2;
    const cy       = canvas.height * 0.88;
    const breathe  = 1 + Math.sin(time * 0.0009) * 0.025;
    // 점수 0: 화면 높이 14%, 점수 100: 화면 높이 52% → 3.7배 차이로 극적인 성장감
    const trunkLen = canvas.height * (0.14 + renderState.displayScore * 0.0038) * breathe;

    // growthTarget은 updateGrowthProgress에서 이미 계산됨 (중복 계산 제거)

    drawGround(cx, cy, time, ep);
    drawBranch(cx, cy, -Math.PI/2, trunkLen, maxDepth, maxDepth, ep, time, 1);
    drawAllLeaves(time, ep);
  }

  // ─── 배경·대기 효과 ──────────────────────────────────────────
  function drawBackground(time, ep) {
    const cx = canvas.width / 2, cy = canvas.height / 2;

    // 기본 라디알 배경
    const g = ctx.createRadialGradient(cx, cy * 1.2, 0, cx, cy, Math.max(canvas.width, canvas.height) * 0.9);
    g.addColorStop(0, ep.bgCenter); g.addColorStop(1, ep.bgEdge);
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 점수 반응형 뿌리 블룸: 점수 높을수록 나무 발치에서 빛이 솟구침
    const bloomPow = renderState.displayScore / 100;
    if (bloomPow > 0.08) {
      const by = canvas.height * 0.88;
      const br = canvas.height * bloomPow * 0.80;
      const bg = ctx.createRadialGradient(cx, by, 0, cx, by, br);
      const ba = bloomPow * 0.28;
      bg.addColorStop(0,   ep.glowColor.replace(/[\d.]+\)$/, `${ba * 2.2})`));
      bg.addColorStop(0.3, ep.glowColor.replace(/[\d.]+\)$/, `${ba})`));
      bg.addColorStop(1,   'transparent');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 별: 260개, 더 밝고 뚜렷하게 반짝임
    for (let i = 0; i < 260; i++) {
      const sx = Math.abs(Math.sin(i * 127.1)) * canvas.width;
      const sy = Math.abs(Math.sin(i * 311.7)) * canvas.height;
      const tw = 0.3 + Math.abs(Math.sin(time * 0.0018 + i * 0.7)) * 0.7;
      const sz = i % 7 === 0 ? 1.6 : 0.9; // 7개 중 1개는 큰 별
      ctx.globalAlpha = tw * 0.08; ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(sx, sy, sz, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 오로라: 4개 레이어, 기존 대비 3배 강도
  function drawAurora(time, ep) {
    const w = getStateWeight('OPTIMAL');
    if (w <= 0.01) return;
    [
      { ph: 0.0, a: 0.11, h: 180 },
      { ph: 2.2, a: 0.08, h: 140 },
      { ph: 4.5, a: 0.06, h: 100 },
      { ph: 1.1, a: 0.04, h: 70  },
    ].forEach(b => {
      const y = (Math.sin(time * 0.00035 + b.ph) * 0.24 + 0.32) * canvas.height;
      const g = ctx.createLinearGradient(0, y - b.h, 0, y + b.h);
      g.addColorStop(0,   'transparent');
      g.addColorStop(0.5, ep.glowColor.replace(/[\d.]+\)$/, `${b.a * w})`));
      g.addColorStop(1,   'transparent');
      ctx.fillStyle = g; ctx.fillRect(0, y - b.h, canvas.width, b.h * 2);
    });
  }

  // OVERHEAT 외곽 불꽃: 이중 링, 기존 대비 2배 강도
  function drawOverheatEdge(time, ep) {
    const w = getStateWeight('OVERHEAT');
    if (w <= 0.01) return;

    // 바깥 링: 느리게 맥박
    const a1 = (0.22 + Math.sin(time * 0.004) * 0.10) * w;
    const g1 = ctx.createRadialGradient(
      canvas.width/2, canvas.height/2, canvas.height * 0.12,
      canvas.width/2, canvas.height/2, canvas.height * 0.96
    );
    g1.addColorStop(0,    'transparent');
    g1.addColorStop(0.72, ep.glowColor.replace(/[\d.]+\)$/, `${a1 * 0.45})`));
    g1.addColorStop(1,    ep.glowColor.replace(/[\d.]+\)$/, `${a1})`));
    ctx.fillStyle = g1; ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 안쪽 링: 빠른 맥박 (심장 박동 느낌)
    const a2 = (0.10 + Math.sin(time * 0.012 + 1.2) * 0.07) * w;
    const g2 = ctx.createRadialGradient(
      canvas.width/2, canvas.height/2, canvas.height * 0.32,
      canvas.width/2, canvas.height/2, canvas.height * 0.80
    );
    g2.addColorStop(0, 'transparent');
    g2.addColorStop(1, ep.glowColor.replace(/[\d.]+\)$/, `${a2})`));
    ctx.fillStyle = g2; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // COOLDOWN 베일: 더 깊고 숨결 같은 라벤더 글로우
  function drawCooldownVeil(time, ep) {
    const w = getStateWeight('COOLDOWN');
    if (w <= 0.01) return;
    const bp = 0.65 + 0.30 * Math.sin(time * 0.0015);
    const veilAlpha = (0.10 + 0.05 * bp) * w;
    const g = ctx.createRadialGradient(
      canvas.width/2, canvas.height * 0.55, canvas.height * 0.06,
      canvas.width/2, canvas.height * 0.55, canvas.height * 0.90
    );
    g.addColorStop(0,   ep.glowColor.replace(/[\d.]+\)$/, `${veilAlpha * 0.35})`));
    g.addColorStop(0.5, ep.glowColor.replace(/[\d.]+\)$/, `${veilAlpha})`));
    g.addColorStop(1,   'transparent');
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);

    const lineAlpha = 0.040 * bp * w;
    const lineY = (Math.sin(time * 0.00018) * 0.12 + 0.28) * canvas.height;
    const lineG = ctx.createLinearGradient(0, lineY - 55, 0, lineY + 55);
    lineG.addColorStop(0,   'transparent');
    lineG.addColorStop(0.5, ep.glowColor.replace(/[\d.]+\)$/, `${lineAlpha})`));
    lineG.addColorStop(1,   'transparent');
    ctx.fillStyle = lineG; ctx.fillRect(0, lineY - 55, canvas.width, 110);
  }

  // 비네트: 외곽을 더 깊게 압도
  function drawVignette() {
    const g = ctx.createRadialGradient(
      canvas.width/2, canvas.height/2, canvas.height * 0.18,
      canvas.width/2, canvas.height/2, canvas.height * 0.95
    );
    g.addColorStop(0, 'transparent'); g.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // 지면 글로우: 점수 반응 크기 + 훨씬 밝은 코어
  function drawGround(cx, cy, time, ep) {
    const scoreBoost = 0.6 + renderState.displayScore * 0.007; // 점수 반응 크기
    const pulse = 1 + Math.sin(time * 0.0013) * 0.28;
    const r = 260 * pulse * scoreBoost;

    ctx.save();
    ctx.shadowBlur = 90; ctx.shadowColor = ep.glowColor;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0,    ep.glowColor.replace(/[\d.]+\)$/, '0.95)'));
    g.addColorStop(0.30, ep.glowColor.replace(/[\d.]+\)$/, '0.40)'));
    g.addColorStop(0.65, ep.glowColor.replace(/[\d.]+\)$/, '0.10)'));
    g.addColorStop(1,    'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(cx, cy, r, 30, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ─── 씨앗 파티클 (Seed) ────────────────────────────────────────
  // 잎 사이에서 떠다니는 야광 플랑크톤. burst 파티클과 완전히 분리된 독립 오브젝트.
  // - 주변(Ambient) 씨앗: 조용히 둥둥 떠다니며 펄스 진동
  // - 에너자이즈(Energized) 씨앗: 에너지를 받아 급성장 후 스르륵 소멸

  let seeds = [];
  const SEED_MAX = 60; // 화면에 상주하는 최대 씨앗 수

  // 씨앗 1개 생성
  function spawnSeed(energized, ep) {
    if (!energized && seeds.length >= SEED_MAX) return;
    // ── 체인 2단계 게이트: 잎이 50% 이상 자란 끝단에서만 씨앗 생성 ──
    // 가지 80% → 잎 등장 → 잎 50% → 씨앗 맺힘: 3단계 생명 주기
    const pts = treeTips.filter(t => estimateLeafProgress(t) >= 0.50);
    if (pts.length === 0) return;
    const tip = pts[Math.floor(Math.random() * pts.length)];
    const colorPool = [ep.orbColor, ep.orbAltColor, ep.orbSpecial, ep.tipColorA, ep.tipColorB];

    // COOLDOWN 반딧불이 모드: 수평 산란 없이 수직 상승, 크기 작고 은은하게
    const cdW         = getStateWeight('COOLDOWN');
    const scatterMult = 1 - cdW * 0.90; // COOLDOWN에서 수평 속도 90% 억제
    const riseMult    = 1 - cdW * 0.55; // 상승 속도도 55% 줄여 천천히 둥둥

    const sx = tip.x + (Math.random() - 0.5) * 44 * scatterMult;
    const sy = tip.y + (Math.random() - 0.5) * 20 * scatterMult;
    seeds.push({
      x: sx, y: sy,
      // 좌표를 함께 저장 → 펄스 위상차 계산에 사용 (좌표가 다르면 맥박이 다름)
      spawnX: sx, spawnY: sy,
      vx:   (Math.random() - 0.5) * 0.32 * scatterMult,
      vy:   -(0.12 + Math.random() * 0.35) * riseMult - 0.05,
      phase:     Math.random() * Math.PI * 2,
      baseSize:  (1.4 + Math.random() * 2.6) * (1 - cdW * 0.40),
      baseAlpha: (0.42 + Math.random() * 0.38) * (1 - cdW * 0.25),
      color: colorPool[Math.floor(Math.random() * colorPool.length)],
      life:  1.0,
      decay: energized ? 0.003 + Math.random() * 0.004 : 0.0007 + Math.random() * 0.0010,
      energized,
      energyProgress: 0,
      energySpeed:    0.012 + Math.random() * 0.010,
    });
  }

  // 기존 씨앗 + 신규 씨앗을 에너자이즈 (군중 반응 / DEEP FOCUS 진입 시 호출)
  function energizeSeeds(ep) {
    const epSafe = ep || buildEffectivePalette();
    // 기존 주변 씨앗 중 최대 8개 에너자이즈 전환
    seeds.filter(s => !s.energized).slice(0, 8).forEach(s => {
      s.energized     = true;
      s.energyProgress = 0;
      s.energySpeed   = 0.010 + Math.random() * 0.010;
      s.decay         = 0.004 + Math.random() * 0.003;
    });
    // 새 에너자이즈 씨앗 추가 생성
    for (let i = 0; i < 14; i++) spawnSeed(true, epSafe);
  }

  // 씨앗 물리 + 펄스 + 렌더링 (매 프레임 호출)
  function updateSeeds(time, ep) {
    // 나무가 충분히 자란 경우에만 주변 씨앗 보충
    const grown = treeTips.filter(t => t.gf > 0.75);
    if (grown.length > 0 && seeds.length < SEED_MAX && Math.random() < 0.20) {
      spawnSeed(false, ep);
    }

    for (let i = seeds.length - 1; i >= 0; i--) {
      const s = seeds[i];

      // 물리 이동 (공기 저항으로 매우 느리게 감속)
      s.x  += s.vx;
      s.y  += s.vy;
      s.vx *= 0.9985;
      s.vy *= 0.9985;
      s.life -= s.decay;
      if (s.life <= 0) { seeds.splice(i, 1); continue; }

      // 에너자이즈 진행
      if (s.energized) {
        s.energyProgress = Math.min(2, s.energyProgress + s.energySpeed);
      }

      // 좌표 기반 고유 위상차: 같은 나무에 붙어있어도 씨앗마다 맥박 타이밍이 다름
      // (spawnX * 17.3 + spawnY * 31.7) * 0.0004 → 좌표가 조금만 달라도 위상 크게 달라짐
      const coordPhase = (s.spawnX * 17.3 + s.spawnY * 31.7) * 0.0004;
      const pulse = 1 + 0.32 * Math.sin(time * 0.003 + coordPhase);

      // 에너자이즈 스케일/알파 계산
      // energyProgress 0→1: sin 곡선으로 최대 3.5배 성장
      // energyProgress 1→2: 수축하며 알파 0으로 소멸
      let energyScale = 1, energyAlpha = 1;
      if (s.energized) {
        const growT  = Math.min(1, s.energyProgress);           // 0→1
        const shrinkT = Math.max(0, s.energyProgress - 1);      // 0→1
        energyScale = 1 + 2.8 * Math.sin(growT * Math.PI / 2) * (1 - shrinkT);
        energyAlpha = Math.max(0, 1 - shrinkT * shrinkT);
      }

      // COOLDOWN 씨앗: 호흡과 동기화된 느린 깜빡임 (반딧불이 효과)
      const cdW       = getStateWeight('COOLDOWN');
      const seedBreath = 1 - cdW + cdW * (0.55 + 0.45 * Math.sin(Date.now() * 0.0018 + s.phase * 2.3));

      const displaySize  = Math.max(0.3, s.baseSize * pulse * energyScale);
      const displayAlpha = Math.min(1, s.baseAlpha * s.life * energyAlpha * seedBreath);

      ctx.save();
      ctx.globalAlpha = displayAlpha;
      ctx.shadowBlur  = displaySize * (s.energized ? 18 : (4 + cdW * 6)); // COOLDOWN에서 부드러운 후광
      ctx.shadowColor = s.color;
      ctx.fillStyle   = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, displaySize, 0, Math.PI * 2);
      ctx.fill();

      // 에너자이즈 상태: 외부 반짝임 링 추가 (에너지 방출 효과)
      if (s.energized && energyScale > 1.8) {
        ctx.globalAlpha = displayAlpha * 0.25;
        ctx.beginPath();
        ctx.arc(s.x, s.y, displaySize * 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = s.color;
        ctx.lineWidth   = 0.7;
        ctx.shadowBlur  = displaySize * 4;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ─── 파티클 (Burst) ──────────────────────────────────────────
  // 군중 반응/집중 진입 시 폭발처럼 뿜어지는 단명 파티클 (씨앗과 별개)
  function updateParticles() {
    for (let i=particles.length-1; i>=0; i--) {
      const p=particles[i];
      p.x+=p.vx; p.y+=p.vy; p.vy+=0.038; p.vx*=0.990; p.life-=p.decay;
      if (p.life<=0){particles.splice(i,1);continue;}
      ctx.save(); ctx.globalAlpha=p.life*p.life; ctx.shadowBlur=18;
      ctx.shadowColor=p.color; ctx.fillStyle=p.color;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.size*(0.35+p.life*0.65),0,Math.PI*2); ctx.fill(); ctx.restore();
    }
  }

  function spawnParticles(count, type, ep) {
    const p = ep || buildEffectivePalette();
    const crowdColors=['#ffdd44','#ff88bb','#88ddff','#ccffaa','#ffaaff','#ffffff'];
    const focusColors=Array.from({length:10},(_,i)=>i<7?p.orbColor:i<9?p.orbAltColor:p.orbSpecial);
    const colors=type==='crowd'?crowdColors:focusColors;
    const pts=treeTips.filter(t=>t.gf>0.5);
    const bases=pts.length>0?pts:[{x:canvas.width/2,y:canvas.height*0.4}];
    for(let i=0;i<count;i++){
      const pt=bases[Math.floor(Math.random()*bases.length)];
      const speed=0.7+Math.random()*4.2; const ang=Math.random()*Math.PI*2;
      particles.push({
        x:pt.x+(Math.random()-0.5)*32, y:pt.y+(Math.random()-0.5)*32,
        vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed-2.8,
        size:2.2+Math.random()*5.5, life:1.0, decay:0.006+Math.random()*0.013,
        color:colors[Math.floor(Math.random()*colors.length)],
      });
    }
  }

  // burst 파티클 주기적 방출 (씨앗 보충은 updateSeeds 내부에서 자체 관리)
  function spawnAmbient(ep) {
    const grown = treeTips.filter(t => t.gf > 0.8);
    if (grown.length === 0) return;
    if (currentState === 'OVERHEAT' && Math.random() < 0.32) spawnParticles(3, 'focus', ep);
    else if (currentState === 'OPTIMAL' && Math.random() < 0.10) spawnParticles(1, 'focus', ep);
    else if (currentState === 'COOLDOWN' && Math.random() < 0.05) spawnParticles(1, 'focus', ep);
  }

  // ─── 메인 루프 ───────────────────────────────────────────────
  function animate() {
    const time = Date.now();
    updateGrowthProgress();
    const ep = buildEffectivePalette();

    drawBackground(time, ep);
    drawAurora(time, ep);
    drawTree(time, ep);
    // 씨앗은 잎 위에, burst 파티클보다 아래 레이어
    updateSeeds(time, ep);
    drawOverheatEdge(time, ep);
    drawCooldownVeil(time, ep);
    drawVignette();
    spawnAmbient(ep);
    updateParticles();
    requestAnimationFrame(animate);
  }

  function init(canvasEl) {
    if (!window.SPEC || !window.SPEC.PALETTE) {
      console.error('[D-Garden] SPEC.PALETTE 로드 실패. spec.json을 확인하세요.');
      return;
    }
    PALETTE = window.SPEC.PALETTE;
    prevPalette = PALETTE.OPTIMAL;
    currPalette = PALETTE.OPTIMAL;

    // renderState를 SPEC 초기값으로 시드: 첫 프레임부터 정상 수치 보장
    const initScore = (window.SPEC.INITIAL_SCORE != null) ? window.SPEC.INITIAL_SCORE : 50;
    renderState.displayScore   = initScore;
    renderState.effectiveDepth = getMaxDepth(initScore, 'OPTIMAL');

    canvas = canvasEl; ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    });
    lastAnimTime = Date.now();
    animate();
  }

  function update(score, state, cpm) {
    if (state !== currentState) {
      // 현재 시각적 팔레트를 스냅샷으로 저장 → 리셋 없이 색상 Lerp 전환
      prevPalette   = buildEffectivePalette();
      currPalette   = PALETTE[state];
      prevStateName = currentState;
      transitionT   = 0;
      // growthProgress 리셋 없음 — 나무 구조 그대로 유지
    }

    currentScore = score;
    currentState = state;
    currentCPM   = cpm || 0;
    // growthTarget은 drawTree의 effectiveDepth Lerp 완료 후 계산되므로 여기서는 설정 불필요
  }

  function triggerTipGrowth() {
    growthProgress = Math.max(0, growthTarget - 2 * OVERLAP_WINDOW);
  }

  function getBadgeColor(state) {
    return PALETTE ? (PALETTE[state] || PALETTE.OPTIMAL).orbColor : '#00ffaa';
  }

  return { init, update, spawnParticles, energizeSeeds, getBadgeColor, triggerTipGrowth };
})();
