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
  let PALETTE = null;  // 현재 활성 테마의 팔레트 세트 (DORMANT/OPTIMAL/OVERHEAT/COOLDOWN 맵)
  let THEMES  = null;  // spec.json THEMES + GLOWING_TREE(= 기존 PALETTE) 통합 맵
  let currentTheme = 'GLOWING_TREE';
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

  // 작은 별 정적 캐시 레이어 (성능 최적화: buildStarLayer 참고)
  let starLayer = null;

  // ─── 가상 카메라 (줌아웃 + 패닝) ────────────────────────────────
  // 식물이 커지면 스프링 물리로 부드럽게 줌아웃하고 위로 패닝
  const cam = {
    scale:    1.0,   // 현재 줌 (1=원본, 0.5=절반 크기로 줌아웃)
    scaleVel: 0,     // 줌 스프링 속도
    panY:     0,     // 수직 패닝 오프셋 (음수=위로)
    panYVel:  0,     // 패닝 스프링 속도
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
    // 펄럭임 진폭·속도 — 과하면 시선을 빼앗아 집중을 방해하므로 spec에서 절제된 값으로 관리
    const flutterBase = (window.SPEC.LEAF_FLUTTER_AMPLITUDE || 0.035) * (1 - cooldownW * 0.82);
    const fs    = window.SPEC.LEAF_FLUTTER_SPEED || 0.65;
    const flt1  = Math.sin(time * 0.0042 * fs + leafPhase)        * 0.28;
    const flt2  = Math.sin(time * 0.0098 * fs + leafPhase * 1.55) * 0.14;
    const flt3  = Math.sin(time * 0.0200 * fs + leafPhase * 0.80) * 0.08;
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
    grad.addColorStop(0.0,  hexToRgba(ep.tipColorA,  0.62 * eased * bp));
    grad.addColorStop(0.40, hexToRgba(ep.tipColorB,  0.90 * eased * bp));
    grad.addColorStop(0.80, hexToRgba(ep.orbSpecial, 0.72 * eased * bp));
    grad.addColorStop(1.0,  hexToRgba(ep.orbSpecial, 0.40 * eased * bp));

    // 글로우 강화: shadowBlur 18 → 32
    ctx.shadowBlur  = 32 * eased * bp;
    ctx.shadowColor = ep.glowColor;
    ctx.fillStyle   = grad;
    ctx.fill();

    // 2차 글로우 패스 (외곽 확산광)
    ctx.shadowBlur  = 55 * eased * bp;
    ctx.globalAlpha = 0.22 * eased * bp;
    ctx.fill();
    ctx.globalAlpha = 1;

    // ── 잎맥 (발광 중앙선) — 더 밝게 ──
    ctx.beginPath();
    ctx.moveTo(0, -len * 0.05);
    ctx.lineTo(0, -len * 0.88);
    ctx.strokeStyle = hexToRgba(ep.orbSpecial, 0.52 * eased * bp);
    ctx.lineWidth   = 1.1;
    ctx.shadowBlur  = 10;
    ctx.stroke();

    // 잎 끝 발광 포인트
    ctx.beginPath();
    ctx.arc(0, -len * 0.92, len * 0.06, 0, Math.PI * 2);
    ctx.fillStyle   = hexToRgba(ep.orbSpecial, 0.68 * eased * bp);
    ctx.shadowBlur  = 14;
    ctx.fill();

    ctx.restore();
  }

  function drawAllLeaves(time, ep) {
    const BASE_LEAF_SIZE = (window.SPEC.BASE_LEAF_SIZE || 10) * (window.SPEC.LEAF_SIZE_SCALE || 3.2) * (1 + renderState.displayScore * 0.008);
    const SIZE_VARIANCE  = window.SPEC.LEAF_SIZE_VARIANCE || 2.4;

    const cooldownW      = getStateWeight('COOLDOWN');
    const cooldownShrink = 1 - cooldownW * 0.55;
    const droop          = cooldownW * 0.38;

    // 잎 위치 선별: 안쪽 분기점에 잎 여러 장이 한 점에서 피면 연꽃처럼 보임
    // → 말단 가지(바깥쪽 두 단계)에만 잎을 허용하고, 좌우 균등 샘플링
    //   (slice(0,N)은 재귀 순서상 왼쪽 가지만 남아 한쪽에 몰림)
    const maxTips = window.SPEC.LEAF_MAX_TIPS || 60;
    const maxLi   = treeTips.reduce((m, t) => Math.max(m, t.li || 0), 0);
    let pool = treeTips.filter(t => t.gf >= 0.25 && (t.li || 0) >= maxLi - 1);
    if (pool.length < 12) pool = treeTips.filter(t => t.gf >= 0.25); // 어린 나무: 전체 허용
    let tips = pool;
    if (pool.length > maxTips) {
      const step = pool.length / maxTips;
      tips = [];
      for (let i = 0; i < maxTips; i++) tips.push(pool[Math.floor(i * step)]);
    }
    tips.forEach((tip) => {

      // 사실상 모든 가지 끝에 잎 (98%)
      if (seededRandom(tip.id * 31 + 3) > 0.98) return;

      const li        = tip.li !== undefined ? tip.li : 0;
      // 0.8 앞당김 → 가지가 완전히 자라기 전에 잎이 먼저 나오기 시작
      const threshold = branchCompletionThreshold(li, tip.id) - 0.8;
      const leafAge   = Math.max(0, growthProgress - threshold);

      const leafSeed    = Math.sin(tip.x * 12.3 + tip.y * 45.6);
      const absS        = Math.abs(leafSeed);
      // 크기 범위: 1.0x ~ (1+VARIANCE)x BASE_LEAF_SIZE → 다양한 잎 크기
      const maxLeafSize = BASE_LEAF_SIZE * (1.0 + absS * SIZE_VARIANCE);
      const growthSpeed = 1.4 + absS * 1.8;

      // gf: 중간 가지 팁은 부모 gf에 비례해서 잎 크기 점진적 증가 (처음부터 꽉 찬 잎 방지)
      const gfScale      = Math.min(1.0, tip.gf * 1.5);
      const leafProgress = Math.min(1.0, leafAge * growthSpeed) * gfScale;
      if (leafProgress < 0.01) return;

      const currentLeafSize = maxLeafSize * cooldownShrink;
      // 부채꼴 각도 축소(±71°→±51°): 한 점에서 방사형으로 퍼지면 꽃잎처럼 보임
      const leafDir         = leafSeed * 0.9;

      drawLeaf(tip.x, tip.y, tip.angle, currentLeafSize, ep, time, leafProgress, leafDir, droop);

      // ── 2번째 잎: 30% 확률 ──
      if (seededRandom(tip.id * 47 + 7) > 0.70) {
        const subSeed     = Math.sin(tip.x * 8.7 + tip.y * 33.2 + 1.5);
        const absSubS     = Math.abs(subSeed);
        const subMaxSize  = BASE_LEAF_SIZE * (0.75 + absSubS * 2.2);
        const subSpeed    = 1.3 + absSubS * 1.6;
        const subAge      = Math.max(0, leafAge - 0.15);
        const subProgress = Math.min(1.0, subAge * subSpeed);
        if (subProgress > 0.01) {
          const gap2 = maxLeafSize * 0.30;
          const bx2  = tip.x - Math.cos(tip.angle) * gap2;
          const by2  = tip.y - Math.sin(tip.angle) * gap2;
          const subDir = subSeed * 0.9 + Math.PI * 0.16;
          drawLeaf(bx2, by2, tip.angle, subMaxSize * cooldownShrink, ep, time, subProgress, subDir, droop);
        }
      }

      // ── 3번째 잎: 15% 확률 ──
      if (seededRandom(tip.id * 61 + 11) > 0.85) {
        const triSeed     = Math.sin(tip.x * 5.5 + tip.y * 22.1 + 3.0);
        const absTriS     = Math.abs(triSeed);
        const triMaxSize  = BASE_LEAF_SIZE * (0.65 + absTriS * 1.8);
        const triSpeed    = 1.2 + absTriS * 1.5;
        const triAge      = Math.max(0, leafAge - 0.28);
        const triProgress = Math.min(1.0, triAge * triSpeed);
        if (triProgress > 0.01) {
          const gap3 = maxLeafSize * 0.55;
          const bx3  = tip.x - Math.cos(tip.angle) * gap3;
          const by3  = tip.y - Math.sin(tip.angle) * gap3;
          const triDir = triSeed * 0.9 - Math.PI * 0.12;
          drawLeaf(bx3, by3, tip.angle, triMaxSize * cooldownShrink, ep, time, triProgress, triDir, droop);
        }
      }

      // ── 4번째·5번째 잎: 제거 (성능 최적화) ──

      // ── 잎 끝 반짝임 (5% 확률) ──
      if (leafProgress > 0.9 && seededRandom(tip.id * 113 + 29) > 0.95) {
        const sparkPhase = Math.sin(time * 0.007 + tip.x * 0.03 + tip.y * 0.025);
        if (sparkPhase > 0.5) {
          ctx.save();
          ctx.globalAlpha = (sparkPhase - 0.5) * 2 * 0.65 * (1 - cooldownW * 0.7);
          ctx.shadowBlur  = 22; ctx.shadowColor = ep.orbSpecial;
          ctx.fillStyle   = ep.orbSpecial;
          ctx.beginPath();
          ctx.arc(tip.x, tip.y - currentLeafSize * 0.85, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    });
  }

  // ─── 영혼의 나무 덩굴 (글로잉나무 전용) ─────────────────────────
  // 위쪽 가지 끝에서 수양버들처럼 늘어지는 발광 가닥 + 흘러내리는 빛 펄스

  // 2차 베지어 곡선 위의 t 지점 좌표 (펄스 위치 계산용)
  function quadAt(a, c, b, t) {
    const u = 1 - t;
    return u * u * a + 2 * u * t * c + t * t * b;
  }

  function drawSoulTendrils(time, ep) {
    const fx   = window.SPEC.FX || {};
    const maxN = fx.TENDRIL_COUNT || 22;
    // 충분히 자란, 화면 위쪽 절반의 가지 끝에서만 늘어짐
    const cand = treeTips.filter(t => t.gf > 0.6 && t.y < canvas.height * 0.55);
    if (!cand.length) return;
    const n    = Math.min(maxN, cand.length);
    const step = cand.length / n;

    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const tip = cand[Math.floor(i * step)];
      const sr1 = seededRandom(tip.id * 91 + 7);
      const len = canvas.height * (0.09 + sr1 * 0.13) * tip.gf;
      // 바람에 맞춰 아래끝이 천천히 흔들림
      const sway = Math.sin(time * 0.0006 + tip.x * 0.01 + sr1 * 6) * len * 0.16;
      const ex  = tip.x + sway,        ey  = tip.y + len;
      const cpx = tip.x + sway * 0.35, cpy = tip.y + len * 0.55;

      // 덩굴 가닥: 위는 흐리고 아래끝으로 갈수록 밝아짐 (영혼의 나무 특유의 빛)
      const g = ctx.createLinearGradient(tip.x, tip.y, ex, ey);
      g.addColorStop(0, hexToRgba(ep.tipColorB, 0.08));
      g.addColorStop(1, hexToRgba(ep.orbSpecial, 0.50));
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = g;
      ctx.lineWidth   = 1.1;
      ctx.shadowBlur  = 8; ctx.shadowColor = ep.glowColor;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.quadraticCurveTo(cpx, cpy, ex, ey);
      ctx.stroke();

      // 가닥을 타고 흘러내리는 빛 펄스 (가닥마다 위상이 다름)
      const pt = (time * 0.00045 + sr1 * 7) % 1;
      const px = quadAt(tip.x, cpx, ex, pt);
      const py = quadAt(tip.y, cpy, ey, pt);
      ctx.globalAlpha = 0.85 * Math.sin(pt * Math.PI);
      ctx.fillStyle   = ep.orbSpecial;
      ctx.shadowBlur  = 12;
      ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fill();

      // 끝 방울: 가닥 끝에 맺힌 발광점
      ctx.globalAlpha = 0.70;
      ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ─── 낙엽 파티클 (글로잉나무 전용) ──────────────────────────────
  // 성장 완료된 가지 끝에서 잎이 떨어져 나선형으로 낙하
  let fallingLeaves = [];

  function updateFallingLeaves(time, ep) {
    if (currentTheme !== 'GLOWING_TREE') {
      if (fallingLeaves.length) fallingLeaves = [];
      return;
    }
    const fx   = window.SPEC.FX || {};
    const maxN = fx.FALLING_LEAF_MAX || 8;
    const cdW  = getStateWeight('COOLDOWN');

    // 스폰: COOLDOWN에서 빈도 증가 (휴식의 서정성)
    const spawnP = 0.015 + cdW * 0.05;
    if (fallingLeaves.length < maxN && Math.random() < spawnP) {
      const grown = treeTips.filter(t => t.gf > 0.8);
      if (grown.length) {
        const src = grown[Math.floor(Math.random() * grown.length)];
        fallingLeaves.push({
          x: src.x, y: src.y,
          vx: (Math.random() - 0.5) * 0.4,
          vy: 0.15 + Math.random() * 0.3,
          rot:  Math.random() * Math.PI * 2,
          rotV: (Math.random() - 0.5) * 0.045,
          size: 4 + Math.random() * 7,
          life: 1,
          ph:   Math.random() * Math.PI * 2,
        });
      }
    }

    const baseY = canvas.height * 0.88;
    fallingLeaves = fallingLeaves.filter(l => l.life > 0.02 && l.y < baseY + 8);
    fallingLeaves.forEach(l => {
      l.x   += l.vx + Math.sin(time * 0.002 + l.ph) * 0.65; // 좌우 살랑임
      l.y   += l.vy;
      l.vy   = Math.min(l.vy + 0.0045, 0.95);               // 중력 가속 (종단 속도 제한)
      l.rot += l.rotV;
      l.life -= 0.0022;

      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(l.rot);
      ctx.globalAlpha = l.life * 0.85;
      ctx.fillStyle   = ep.tipColorA;
      ctx.beginPath();
      ctx.ellipse(0, 0, l.size, l.size * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      // 잎맥 라인
      ctx.globalAlpha = l.life * 0.45;
      ctx.strokeStyle = ep.orbSpecial;
      ctx.lineWidth   = 0.7;
      ctx.beginPath(); ctx.moveTo(-l.size * 0.8, 0); ctx.lineTo(l.size * 0.8, 0); ctx.stroke();
      ctx.restore();
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

    // OVERHEAT: 폭발적 에너지 표현 — 줄기(mass 큰 쪽)일수록 굵어지고 잔가지는 섬세하게 유지
    const overheatW  = getStateWeight('OVERHEAT');
    const widthBoost = 1 + overheatW * (window.SPEC.TRUNK_OVERHEAT_BOOST || 0.55) * mass;
    const lw = Math.max(0.3, Math.pow(depth / maxDepth, 1.6) * 12 * widthBoost);
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

    // 하위 가지가 아직 성장 전일 때, 현재 가지 끝단을 잎 위치로 등록
    // → 낮은 score에서도 자라고 있는 가지 끝에 잎이 나오게 함
    const childLI = levelIndex + 1;
    const childGF = calcBranchGrowthFactor(childLI, branchId * 2);
    if (growthFactor > 0.25 && childGF < 0.35 && depth >= 1) {
      treeTips.push({ x: x2, y: y2, angle: organicAngle, gf: growthFactor, id: branchId, li: levelIndex });
    }

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
    const maxDepth   = Math.max(3, Math.min(10, Math.round(renderState.effectiveDepth)));
    const cx         = canvas.width  / 2;
    const cy         = canvas.height * 0.88;
    const breathe    = 1 + Math.sin(time * 0.0009) * 0.025;
    const scoreRatio = renderState.displayScore / 100;

    drawGround(cx, cy, time, ep);

    switch (currentTheme) {
      case 'NEON_LOTUS':
        drawLotus(cx, cy, time, ep);
        drawDriftingPetals(cx, cy, time, ep);  // 수면 위 떠다니는 꽃잎
        break;
      case 'DEEP_VINE':
        drawVine(cx, cy, time, ep);
        // drawAllLeaves 제거: 4.2× 크기 잎이 수십 개 덩굴 끝에 중복 적용되어 폭발적으로 증가
        drawVineBubbles(cx, cy, time, ep);     // 상승 기포
        drawVineFog(ep);                       // 하단 원근 안개
        break;
      case 'HOLOGRAM_SUCCULENT':
        drawSucculent(cx, cy, time, ep);
        break;
      default: {
        // 글로잉나무: drawBranch가 trunk부터 가지까지 자연스럽게 통합 렌더
        const trunkLen = canvas.height * (0.14 + renderState.displayScore * 0.0038) * breathe;

        // 수관 글로우: 캐노피 영역 은은한 후광 (나무 뒤)
        const canopyR = canvas.height * 0.30 * scoreRatio;
        if (canopyR > 20) {
          const cgy = cy - trunkLen * 1.6;
          const cg  = ctx.createRadialGradient(cx, cgy, 0, cx, cgy, canopyR);
          cg.addColorStop(0, ep.glowColor.replace(/[\d.]+\)$/, '0.13)'));
          cg.addColorStop(1, ep.glowColor.replace(/[\d.]+\)$/, '0)'));
          ctx.fillStyle = cg;
          ctx.fillRect(cx - canopyR, cgy - canopyR, canopyR * 2, canopyR * 2);
        }

        drawBranch(cx, cy, -Math.PI / 2, trunkLen, maxDepth, maxDepth, ep, time, 1);
        drawAllLeaves(time, ep);
        drawSoulTendrils(time, ep);   // 영혼의 나무 덩굴 커튼
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ─── 테마: 네온연꽃 ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  /**
   * 수면 잔물결 + 반사 글로우 (연꽃 아래 수면 표현)
   */
  function drawLotusWater(cx, cy, time, ep) {
    const r = 560 * (renderState.displayScore / 100);
    if (r < 10) return;
    ctx.save();
    for (let i = 0; i < 4; i++) {
      const t = ((time * 0.0003 + i * 0.25) % 1);
      const rr = r * (0.30 + t * 0.70);
      ctx.globalAlpha = (1 - t) * 0.22;
      ctx.strokeStyle = ep.tipColorA;
      ctx.shadowBlur  = 10; ctx.shadowColor = ep.glowColor;
      ctx.lineWidth   = 1.2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rr, rr * 0.18, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.14;
    const wg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    wg.addColorStop(0,   ep.glowColor.replace(/[\d.]+\)$/, '0.7)'));
    wg.addColorStop(0.5, ep.glowColor.replace(/[\d.]+\)$/, '0.2)'));
    wg.addColorStop(1,   'transparent');
    ctx.fillStyle = wg;
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.18, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /**
   * 연꽃 수술: 황금 orb + 방사 광선
   */
  function drawLotusStamen(cx, cy, time, ep, gp) {
    const prog  = Math.max(0, Math.min(1, (gp - 0.3) / 0.5));
    if (prog <= 0) return;
    const orbR  = 38 * springEase(prog);
    const pulse = 0.8 + 0.2 * Math.sin(time * 0.005);
    ctx.save();
    const rayCount = 16;
    for (let i = 0; i < rayCount; i++) {
      const a       = (i / rayCount) * Math.PI * 2;
      const rayPulse = 0.5 + 0.5 * Math.sin(time * 0.006 + i * 0.4);
      const rayLen  = (16 + springEase(prog) * 14) * rayPulse;
      ctx.globalAlpha = prog * rayPulse * 0.60;
      ctx.strokeStyle = '#ffdd44'; ctx.shadowBlur = 8; ctx.shadowColor = '#ffdd44';
      ctx.lineWidth   = 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * orbR * 0.9, cy + Math.sin(a) * orbR * 0.9);
      ctx.lineTo(cx + Math.cos(a) * (orbR + rayLen), cy + Math.sin(a) * (orbR + rayLen));
      ctx.stroke();
    }
    ctx.globalAlpha = prog * pulse;
    ctx.shadowBlur  = 28 * pulse; ctx.shadowColor = '#ffdd44';
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, '#ffdd44'); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /**
   * 네온연꽃 메인 드로우
   * - ctx.rotate() 로 꽃잎 배치
   * - bezierCurveTo 로 꽃잎 형상
   * - 점수 높을수록 꽃잎 활짝 열림 + 꽃가루 파티클
   */
  function drawLotus(cx, cy, time, ep) {
    const gp         = Math.min(1, growthProgress / Math.max(growthTarget, 0.01));
    const score      = renderState.displayScore;
    const layerCount = Math.max(1, Math.round(renderState.effectiveDepth / 2));
    // 연꽃 중심: trunk 기준선에서 화면 위로 올려 중앙에 띄움
    const lotusCY    = cy - canvas.height * 0.22;

    drawLotusWater(cx, lotusCY, time, ep);

    // 바깥 레이어 먼저 (페인터 알고리즘)
    for (let layer = layerCount - 1; layer >= 0; layer--) {
      const petalCount = 8 + layer * 4;
      const openThresh = layer * 0.20;
      const openProg   = Math.max(0, Math.min(1, (gp - openThresh) * 2.8));
      if (openProg <= 0.01) continue;

      const maxOpen   = Math.PI * (0.38 + layer * 0.04);
      const openAngle = springEase(openProg) * maxOpen;
      // 꽃잎 3배 확장: 52→155, 38→110
      const petalLen  = (155 + layer * 110) * (score / 100) * springEase(openProg);
      const petalWid  = petalLen * 0.28;

      for (let p = 0; p < petalCount; p++) {
        const rotAngle   = (p / petalCount) * Math.PI * 2;
        const petalDelay = Math.abs(Math.sin(p * 2.3)) * 0.10;
        const pProg      = Math.max(0, Math.min(1, (openProg - petalDelay) * (1 + petalDelay)));
        if (pProg <= 0 || petalLen < 2) continue;

        const eased = springEase(pProg);

        ctx.save();
        ctx.translate(cx, lotusCY);
        ctx.rotate(rotAngle);
        ctx.rotate(-openAngle);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo( petalWid, -petalLen * 0.28,  petalWid * 0.55, -petalLen * 0.73, 0, -petalLen * eased);
        ctx.bezierCurveTo(-petalWid * 0.55, -petalLen * 0.73 * eased, -petalWid, -petalLen * 0.28 * eased, 0, 0);

        const grad = ctx.createLinearGradient(0, 0, 0, -petalLen * eased);
        grad.addColorStop(0,    hexToRgba(ep.tipColorA, 0.52 * eased));
        grad.addColorStop(0.45, hexToRgba(ep.tipColorB, 0.80 * eased));
        grad.addColorStop(1,    hexToRgba(ep.orbSpecial, 0.18 * eased));
        ctx.shadowBlur  = ep.glowBlur * 0.55 * eased;
        ctx.shadowColor = ep.glowColor;
        ctx.fillStyle   = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(0, -petalLen * 0.06 * eased);
        ctx.lineTo(0, -petalLen * 0.88 * eased);
        ctx.strokeStyle = hexToRgba(ep.orbSpecial, 0.25 * eased);
        ctx.lineWidth   = 0.8; ctx.shadowBlur = 5;
        ctx.stroke();

        ctx.restore();

        const wx = cx + Math.cos(rotAngle) * petalLen * Math.sin(openAngle) * eased;
        const wy = lotusCY - petalLen * Math.cos(openAngle) * eased;
        treeTips.push({ x: wx, y: wy, angle: rotAngle - Math.PI / 2, gf: pProg, id: layer * 100 + p, li: layer });
      }
    }

    drawLotusStamen(cx, lotusCY, time, ep, gp);
    drawLotusMotes(cx, lotusCY, time, ep);

    if (gp > 0.75 && Math.random() < 0.10) {
      const pollenEp = { ...ep, orbColor: '#ffdd44', orbAltColor: '#ffee88', orbSpecial: '#ffff99' };
      spawnParticles(2, 'focus', pollenEp);
    }
  }

  /**
   * 연꽃 둘레를 떠도는 빛 무리: 타원 궤도를 느리게 도는 발광 입자 (stateless)
   * 점수가 높을수록 궤도가 넓어지고 입자가 또렷해짐
   */
  function drawLotusMotes(cx, lotusCY, time, ep) {
    const fx  = window.SPEC.FX || {};
    const n   = fx.LOTUS_MOTE_COUNT || 12;
    const sr2 = renderState.displayScore / 100;
    if (sr2 < 0.15) return;
    const orbitR = 90 + sr2 * 240;

    ctx.save();
    for (let i = 0; i < n; i++) {
      const sp  = 0.00035 + seededRandom(i * 13 + 5) * 0.00045;
      const ang = time * sp + i * (Math.PI * 2 / n);
      const rr  = orbitR * (0.55 + seededRandom(i * 7 + 1) * 0.45);
      const x   = cx + Math.cos(ang) * rr;
      const y   = lotusCY + Math.sin(ang) * rr * 0.38 + Math.sin(time * 0.0012 + i * 1.9) * 9;
      const tw  = 0.5 + 0.5 * Math.sin(time * 0.0025 + i * 2.1);
      ctx.globalAlpha = (0.30 + tw * 0.45) * sr2 * (fx.AMBIENT_ALPHA || 0.75);
      ctx.fillStyle   = i % 3 === 0 ? ep.orbSpecial : ep.orbAltColor;
      ctx.shadowBlur  = 10; ctx.shadowColor = ep.glowColor;
      ctx.beginPath(); ctx.arc(x, y, 1.2 + tw * 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ═══════════════════════════════════════════════════════════════
  /**
   * 수면 위 떠다니는 꽃잎: 분리된 꽃잎이 물결 따라 흘러감 (stateless)
   */
  function drawDriftingPetals(cx, cy, time, ep) {
    const fx = window.SPEC.FX || {};
    const n  = fx.LOTUS_DRIFT_PETALS || 6;

    ctx.save();
    for (let i = 0; i < n; i++) {
      const sp   = 0.012 + seededRandom(i * 17 + 3) * 0.022;
      const x    = ((time * sp + i * 431) % (canvas.width + 160)) - 80;
      const bob  = Math.sin(time * 0.001 + i * 1.7) * 7;             // 물결 위 출렁임
      const y    = cy + bob + (seededRandom(i * 7 + 2) - 0.5) * 26;
      const rot  = Math.sin(time * 0.0008 + i * 2.1) * 0.6;
      const size = 7 + seededRandom(i * 5 + 9) * 9;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.55 * (fx.AMBIENT_ALPHA || 0.75);
      ctx.fillStyle   = i % 2 === 0 ? ep.tipColorA : ep.tipColorB;
      ctx.beginPath();
      ctx.ellipse(0, 0, size, size * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 꽃잎 아래 수면 반사 잔영
      ctx.globalAlpha = 0.16;
      ctx.fillStyle   = ep.tipColorA;
      ctx.beginPath();
      ctx.ellipse(x, y + 9, size * 0.85, size * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ─── 테마: 심해덩굴 ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  /**
   * 상승 기포: 덩굴 뿌리에서 올라오는 기포 (stateless, 흔들리며 상승)
   */
  function drawVineBubbles(cx, cy, time, ep) {
    const fx = window.SPEC.FX || {};
    const n  = fx.VINE_BUBBLE_COUNT || 15;
    const riseMax = canvas.height * 0.80;

    ctx.save();
    for (let i = 0; i < n; i++) {
      const sp   = 0.018 + seededRandom(i * 11 + 2) * 0.05;
      const rise = (time * sp + i * 977) % riseMax;
      const x    = cx + (seededRandom(i * 5 + 1) - 0.5) * canvas.width * 0.62
                   + Math.sin(time * 0.002 + i * 1.4) * 13;   // 좌우 흔들림
      const y    = cy - rise;
      const r    = 1.5 + seededRandom(i * 3 + 7) * 4;
      const a    = Math.max(0, 0.55 * (1 - rise / riseMax)) + 0.08;

      ctx.globalAlpha = a;
      ctx.strokeStyle = ep.tipColorB;
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();

      // 기포 안 하이라이트 (좌상단 빛 반사)
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = ep.orbSpecial;
      ctx.lineWidth   = 0.8;
      ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, Math.PI * 0.8, Math.PI * 1.6); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 하단 원근 안개: 심해 깊이감 (카메라 변환 안에서도 커버되도록 여유 영역)
   */
  function drawVineFog(ep) {
    const g = ctx.createLinearGradient(0, canvas.height * 0.55, 0, canvas.height);
    g.addColorStop(0, 'rgba(0,8,18,0)');
    g.addColorStop(1, 'rgba(0,8,18,0.60)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(-canvas.width, canvas.height * 0.55, canvas.width * 3, canvas.height);
    ctx.restore();
  }

  /**
   * 심해덩굴 메인 드로우
   * - 여러 갈래 줄기가 화면 하단에서 상승
   * - Math.sin() 으로 각 줄기가 독립적으로 해초처럼 흔들림
   * - 분기점에 생물발광 노드, 덩굴손 끝에 나선형 컬
   */
  function drawVine(cx, cy, time, ep) {
    const gp           = Math.min(1, growthProgress / Math.max(growthTarget, 0.01));
    const score        = renderState.displayScore;
    // score 구간별 덩굴 개체수: 4 → 7개로 점진 증가
    const strandCount  = 4 + Math.min(3, Math.floor(score / 30));
    const maxHeight    = canvas.height * Math.min(0.86, 0.52 + score * 0.004);
    const totalLen     = maxHeight * gp;
    if (totalLen < 10) return;

    for (let s = 0; s < strandCount; s++) {
      // 개체수가 늘수록 간격 살짝 좁혀서 화면 안에 자연스럽게 배치
      const spreadMul = Math.max(0.10, 0.15 - strandCount * 0.006);
      const spreadX   = (s - (strandCount - 1) / 2) * (canvas.width * spreadMul);
      const baseX     = cx + spreadX;
      // 각 덩굴마다 개성 있는 위상·주파수·진폭 (s값이 클수록 변형 증가)
      const phase   = s * 2.1 + 3.7;
      const freq    = 0.00075 + s * 0.00015;
      const amp     = 48 + s * 28;
      const segs    = 10;
      const segLen  = totalLen / segs;

      // ── 다주파수 흔들림: 3개 사인파를 합성해서 유기적 해초 운동 ──
      // 저주파(느린 큰 흔들) + 중주파(리드미컬) + 고주파(미세 떨림)
      function swayAt(t, phaseOffset) {
        const slow = Math.sin(time * freq          + t * 3.5  + phaseOffset) * amp * 0.60;
        const mid  = Math.sin(time * freq * 3.1    + t * 6.2  + phaseOffset * 1.4) * amp * 0.28;
        const fast = Math.sin(time * freq * 8.7    + t * 11.0 + phaseOffset * 0.6) * amp * 0.12;
        return (slow + mid + fast) * (t * 0.55 + 0.45);
      }

      const pts = [];
      for (let i = 0; i <= segs; i++) {
        const t  = i / segs;
        const y  = cy - t * totalLen;
        const sx = swayAt(t, phase);
        pts.push({ x: baseX + sx, y, t });
      }

      // ── 줄기 그리기 ──────────────────────────────────────────────
      // 원근 디밍: 홀수 인덱스 덩굴은 뒤쪽 레이어 → 어둡고 얇게 (깊이감)
      const depthDim = s % 2 === 1 ? 0.55 : 1.0;

      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i], p1 = pts[i + 1];
        const t  = p0.t;
        // 위로 갈수록 얇아지되 뿌리는 두껍게
        const lw = (6.5 - t * 4.5) * (depthDim === 1 ? 1 : 0.75);
        const al = (0.35 + t * 0.62) * depthDim;

        // 아래(뿌리 색) → 위(끝 색) 그라데이션
        const col = t < 0.35
          ? hexToRgba(ep.tipColorA, al)
          : t < 0.70
          ? hexToRgba(ep.tipColorB, al)
          : hexToRgba(ep.orbSpecial, al * 0.85);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
        ctx.quadraticCurveTo(p0.x, my, p1.x, p1.y);
        ctx.lineWidth   = Math.max(0.5, lw);
        ctx.strokeStyle = col;
        ctx.shadowBlur  = ep.glowBlur * 0.38 * t;
        ctx.shadowColor = ep.glowColor;
        ctx.stroke();
        ctx.restore();

        // ── 생물발광 펄스: 뿌리 → 끝으로 빛이 흘러가는 효과 ──
        // time * 속도 - t * PI: t=0(뿌리)에서 시작해 t=1(끝)로 이동하는 펄스
        const pulseTrav = (Math.sin(time * 0.0018 - t * Math.PI * 2 + phase) + 1) * 0.5;
        const nodeR     = Math.max(0.6, (3.2 - t * 1.8) * (0.4 + pulseTrav * 0.6));
        if (i > 0) {
          ctx.save();
          ctx.globalAlpha = t * (0.45 + pulseTrav * 0.50);
          ctx.shadowBlur  = 10 + pulseTrav * 18; ctx.shadowColor = ep.orbColor;
          ctx.fillStyle   = pulseTrav > 0.7 ? ep.orbSpecial : ep.orbColor;
          ctx.beginPath(); ctx.arc(p0.x, p0.y, nodeR, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }

        // ── 덩굴손: 격 세그먼트에서 좌우로 분기 + 끝에 나선형 컬 ──
        if (i > 1 && i % 2 === 1) {
          const side  = ((i % 4 < 2 ? 1 : -1)) * (s % 2 === 0 ? 1 : -1);
          const tLen  = (52 + s * 28) * t;
          const tGf   = Math.min(1, (gp - 0.12) * 1.5);
          if (tGf > 0.05) {
            // 덩굴손 기본 경로
            const tx  = p0.x + side * tLen * 0.85;
            const ty  = p0.y - tLen * 0.40;
            ctx.save();
            ctx.globalAlpha = t * tGf * 0.80;
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.bezierCurveTo(p0.x + side * tLen * 0.30, p0.y - tLen * 0.15,
                              p0.x + side * tLen * 0.70, p0.y - tLen * 0.60,
                              tx, ty);
            ctx.strokeStyle = hexToRgba(ep.orbAltColor, 0.70);
            ctx.lineWidth   = 1.2;
            ctx.shadowBlur  = 8; ctx.shadowColor = ep.glowColor;
            ctx.stroke();

            // 나선형 컬: 덩굴손 끝에서 꼬이는 작은 원호
            // 생물발광 펄스가 지나갈 때 컬이 살짝 부풀어 오름 (빛에 반응하는 생명감)
            const curlR   = tLen * 0.12 * (1 + Math.max(0, pulseTrav - 0.7) * 0.9);
            const curlAng = time * 0.0015 * side + phase;
            ctx.beginPath();
            ctx.arc(tx, ty, curlR, curlAng, curlAng + Math.PI * 1.5, side < 0);
            ctx.strokeStyle = hexToRgba(ep.orbSpecial, 0.55 * tGf);
            ctx.lineWidth   = 0.8;
            ctx.shadowBlur  = 5;
            ctx.stroke();
            ctx.restore();

            treeTips.push({ x: tx, y: ty, angle: -Math.PI / 2 + side * 0.5, gf: tGf, id: (s + 1) * 30 + i, li: s });
          }
        }
      }

      // ── 고사리 새순: 줄기 꼭대기에 말려 있다가 자라면서 풀리는 나선 ──
      const tip = pts[pts.length - 1];
      if (tip) {
        const dir   = s % 2 === 0 ? 1 : -1;
        const turns = 1.6 + (1 - gp) * 1.2;        // 어릴수록 더 단단히 감김
        const spR   = (7 + s * 2.5) * (0.5 + gp);
        ctx.save();
        ctx.beginPath();
        for (let k = 0; k <= 24; k++) {
          const tt  = k / 24;
          const ang = tt * Math.PI * 2 * turns * dir;
          const rr  = spR * tt * 0.9;
          const sx2 = tip.x + Math.sin(ang) * rr;
          const sy2 = (tip.y - spR * 0.8) - Math.cos(ang) * rr;
          if (k === 0) ctx.moveTo(sx2, sy2); else ctx.lineTo(sx2, sy2);
        }
        ctx.strokeStyle = hexToRgba(ep.orbSpecial, 0.20 + 0.55 * gp);
        ctx.lineWidth   = 1.1;
        ctx.shadowBlur  = 10; ctx.shadowColor = ep.glowColor;
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        // 나선 중심 발광점
        ctx.beginPath(); ctx.arc(tip.x, tip.y - spR * 0.8, 1.6, 0, Math.PI * 2);
        ctx.fillStyle  = ep.orbSpecial;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.restore();

        treeTips.push({ x: tip.x, y: tip.y, angle: -Math.PI / 2, gf: gp, id: (s + 1) * 1000, li: 0 });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ─── 테마: 홀로그램다육이 ──────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  /**
   * 홀로그램 스캔라인 오버레이 (수평 선 스크롤)
   */
  function drawHologramScanlines(cx, cy, time, ep) {
    const cdW    = getStateWeight('COOLDOWN');
    const bp2    = breathPulse(time);
    // COOLDOWN: 스캔라인 간격 좁아지고(촘촘) 알파 증가 → 홀로그램이 노이즈 뿜음
    const gap    = 22 - cdW * 10;   // 22px → 12px
    const alpha  = (0.038 + cdW * 0.055) * bp2;
    const scroll = (time * (0.025 + cdW * 0.018)) % gap; // COOLDOWN: 빠르게 스크롤
    const halfH  = canvas.height * 0.38;
    const halfW  = canvas.width  * 0.28;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ep.tipColorA;
    ctx.lineWidth   = 0.5;
    for (let i = 0; i < (halfH * 2) / gap + 1; i++) {
      const y = cy - halfH + i * gap + scroll;
      if (y < 0 || y > canvas.height) continue;
      // COOLDOWN: 일부 라인에 글리치(랜덤 끊김) 효과
      if (cdW > 0.2 && Math.sin(i * 137.5 + time * 0.003) > 0.75) {
        ctx.globalAlpha = alpha * 2.5; // 글리치 라인 강조
      } else {
        ctx.globalAlpha = alpha;
      }
      ctx.beginPath();
      ctx.moveTo(cx - halfW, y);
      ctx.lineTo(cx + halfW, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 홀로그램 사구아로 — Western Movie × Cute 리디자인
   *
   * 팔 3개 구성 (클래식 서부 실루엣):
   *   - 왼팔: 중간 높이, 크고 통통한 팔꿈치 처짐 (iconic western pose)
   *   - 오른 하단팔: 낮은 위치, 짧고 귀여운 stub
   *   - 오른 상단팔: 높은 위치, 길고 상향 곡선 (classic "hands-up" arm)
   * + 정수리에 귀여운 홀로그램 새 실루엣 (서부 영화 고정 소품)
   */
  function drawSucculent(cx, cy, time, ep) {
    const gp         = Math.min(1, growthProgress / Math.max(growthTarget, 0.01));
    const score      = renderState.displayScore;
    const baseY      = cy;
    const cooldownW  = getStateWeight('COOLDOWN');
    const overheatW  = getStateWeight('OVERHEAT');  // 61~90 구간 가중치
    const dormantW   = getStateWeight('DORMANT');
    const bp         = breathPulse(time);

    if (gp < 0.02) return;

    // DORMANT: 전체 알파 감쇠 (10~20점에서 희미하게)
    const dormantDim = 1 - dormantW * 0.55;

    // OVERHEAT: 빠른 떨림 추가 (시간 기반 진동)
    const heatShake  = overheatW * Math.sin(time * 0.018) * 3.5;

    // score 60 초과 시 트렁크 보너스 성장 (OVERHEAT 구간)
    const s60raw  = Math.max(0, (score - 60) / 40);
    const s60ease = s60raw * s60raw * s60raw;
    const trunkH  = canvas.height * (0.10 + gp * 0.58 + s60ease * 0.22);
    const trunkW  = Math.max(18, canvas.height * (0.018 + gp * 0.100 + s60ease * 0.042));
    const hw      = trunkW / 2;
    const trunkGp = Math.min(1, gp * 2.5);
    const armGp   = Math.max(0, Math.min(1, (gp - 0.32) * 3.2));

    const tiltX       = trunkW * 0.10;
    const growingTopY = baseY - trunkH * trunkGp;
    const topX        = cx - tiltX;

    // ── 색상: 상태별 뚜렷한 구분 ──────────────────────────────────
    // OPTIMAL: 민트(160°)↔핑크(330°) 느린 왕복
    // OVERHEAT: 노란-주황(45~65°) 빠른 맥박 + 채도 폭발
    // COOLDOWN: 따뜻한 노을빛(30°) 느린 호흡
    const cuteOsc   = (Math.sin(time * 0.0008) + 1) * 0.5;
    const heatOsc   = (Math.sin(time * 0.0045) + 1) * 0.5;  // OVERHEAT: 더 빠른 진동
    const baseHueOK = 160 + cuteOsc * 170;                   // OPTIMAL 색조
    const baseHueOH = 40  + heatOsc * 25;                    // OVERHEAT 색조: 노랑~주황
    const baseHue   = baseHueOK * (1 - overheatW) + baseHueOH * overheatW;
    const hue       = baseHue * (1 - cooldownW) + 35 * cooldownW;

    // OVERHEAT: 심박처럼 강렬하게 깜빡이는 shimmer
    const shimmerBase = (0.70 + 0.30 * Math.sin(time * 0.0028));
    const shimmerHeat = (0.60 + 0.40 * Math.abs(Math.sin(time * 0.0120)));  // 빠른 맥박
    const shimmer     = (shimmerBase * (1 - overheatW) + shimmerHeat * overheatW)
                        * (1 - cooldownW * 0.42) * bp * dormantDim;

    // COOLDOWN 처짐 / OVERHEAT 긴장(반대)
    const cdDroop  =  cooldownW * 0.30;
    const ohTense  = -overheatW * 0.15;  // OVERHEAT: 팔이 살짝 위로 긴장

    const armSize = armGp * (0.80 + gp * 0.75);

    // ── 3개 팔: COOLDOWN=처짐, OVERHEAT=긴장(위로) ──────────────
    const armDroop = cdDroop + ohTense;
    const armCfg = [
      {
        side: -1,
        jT:   0.42,
        len:  canvas.height * 0.23 * armSize,
        h:    canvas.height * (0.26 - cooldownW * 0.06) * armSize,
        w:    Math.max(11, trunkW * 0.84),
        sag:  0.64 + armDroop,
      },
      {
        side: +1,
        jT:   0.26,
        len:  canvas.height * 0.16 * armSize,
        h:    canvas.height * (0.18 - cooldownW * 0.04) * armSize,
        w:    Math.max(10, trunkW * 0.74),
        sag:  0.55 + armDroop,
      },
      {
        side: +1,
        jT:   0.58,
        len:  canvas.height * 0.26 * armSize,
        h:    canvas.height * (0.30 - cooldownW * 0.07) * armSize,
        w:    Math.max(10, trunkW * 0.64),
        sag:  0.34 + armDroop,
      },
    ];

    // ── 홀로그램 글리치: OPTIMAL 4.3초, OVERHEAT 0.9초 주기 ────────
    const glitchPeriod = 4300 - overheatW * 3400;  // OVERHEAT: 훨씬 잦아짐
    const glitchPhase  = time % glitchPeriod;
    const glitchDur    = 80  + overheatW * 120;     // OVERHEAT: 더 오래 지속
    const inGlitch     = glitchPhase < glitchDur;
    const glitchAmp    = 7   + overheatW * 10;      // OVERHEAT: 더 크게 흔들림
    const glitchX      = (inGlitch ? Math.sin(time * 0.9) * glitchAmp : 0) + heatShake;

    // ── 프로젝터 콘: 바닥 발광 원반에서 위로 퍼지는 빛 (식물 뒤) ──
    {
      const coneTopY = growingTopY - hw;
      const coneBotW = trunkW * 0.9;
      const coneTopW = trunkW * 2.6;
      const cg = ctx.createLinearGradient(0, baseY, 0, coneTopY);
      cg.addColorStop(0, ep.glowColor.replace(/[\d.]+\)$/, `${0.16 * trunkGp * bp})`));
      cg.addColorStop(1, ep.glowColor.replace(/[\d.]+\)$/, '0)'));
      ctx.save();
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(cx - coneBotW, baseY);
      ctx.lineTo(cx + coneBotW, baseY);
      ctx.lineTo(cx + coneTopW, coneTopY);
      ctx.lineTo(cx - coneTopW, coneTopY);
      ctx.closePath();
      ctx.fill();

      // 발광 원반 (프로젝터 베이스)
      const discPulse = 0.7 + 0.3 * Math.sin(time * 0.003);
      ctx.globalAlpha = 0.55 * trunkGp * discPulse * bp;
      const dg = ctx.createRadialGradient(cx, baseY + 3, 0, cx, baseY + 3, trunkW * 2.0);
      dg.addColorStop(0, ep.tipColorA);
      dg.addColorStop(0.4, ep.glowColor.replace(/[\d.]+\)$/, '0.30)'));
      dg.addColorStop(1, 'transparent');
      ctx.fillStyle = dg;
      ctx.beginPath();
      ctx.ellipse(cx, baseY + 3, trunkW * 2.0, trunkW * 0.40, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 글리치 지터: 이후 모든 선인장 본체 드로잉에 적용 (drawSucculent 끝에서 restore)
    ctx.save();
    ctx.translate(glitchX, 0);

    drawHologramScanlines(cx, baseY - trunkH * 0.5, time, ep);

    // ─── 배럴 트렁크: 통통 귀여운 원기둥 + 얼굴 ───────────────────
    function drawBarrel(bx, topY, botY, w, alpha) {
      if (alpha < 0.01) return;
      const bhw   = w / 2;
      const bulge = w * 0.28; // 더 볼록하게 (0.13 → 0.28)
      const h     = botY - topY;
      ctx.save();

      // 몸통: 더 통통한 배럴 실루엣
      ctx.beginPath();
      ctx.moveTo(bx - bhw, botY);
      ctx.bezierCurveTo(
        bx - bhw - bulge, botY - h * 0.25,
        bx - bhw - bulge, botY - h * 0.72,
        bx - bhw * 0.78, topY
      );
      ctx.arc(bx, topY, bhw * 0.78, Math.PI, 0, false);
      ctx.bezierCurveTo(
        bx + bhw + bulge, botY - h * 0.72,
        bx + bhw + bulge, botY - h * 0.25,
        bx + bhw, botY
      );
      ctx.closePath();

      const sat  = 82 - cooldownW * 28 + overheatW * 15;  // OVERHEAT: 채도 폭발
      const lCtr = 52 - cooldownW * 18 + overheatW * 8;   // OVERHEAT: 더 밝게
      const bpA  = bp * alpha * dormantDim;
      const grad = ctx.createLinearGradient(bx - bhw, 0, bx + bhw, 0);
      grad.addColorStop(0,    `hsla(${hue},          ${sat}%, 14%, ${0.94 * bpA})`);
      grad.addColorStop(0.20, `hsla(${(hue+22)%360}, ${sat+4}%, 30%, ${0.90 * bpA})`);
      grad.addColorStop(0.50, `hsla(${(hue+50)%360}, ${sat+10}%, ${lCtr}%, ${0.82 * bpA})`);
      grad.addColorStop(0.80, `hsla(${(hue+22)%360}, ${sat+4}%, 30%, ${0.90 * bpA})`);
      grad.addColorStop(1,    `hsla(${hue},          ${sat}%, 14%, ${0.94 * bpA})`);
      ctx.shadowBlur = ep.glowBlur * 0.60 * bp; ctx.shadowColor = ep.glowColor;
      ctx.fillStyle  = grad; ctx.fill();
      ctx.globalAlpha = 0.82 * shimmer * bpA;
      ctx.strokeStyle = `hsl(${(hue + 65) % 360}, 100%, 85%)`;
      ctx.lineWidth   = 2.5; ctx.shadowBlur = 18 * bp; ctx.stroke();
      ctx.restore();

      // ── 귀여운 얼굴: 상태별 표정 변화 ────────────────────────────
      if (alpha > 0.3 && trunkGp > 0.5) {
        const faceY   = topY + h * 0.38;
        const eyeR    = Math.max(2, bhw * 0.14);
        const eyeOffX = bhw * 0.38;

        // OVERHEAT: 빠른 눈 떨림 / COOLDOWN: 졸린 눈 / OPTIMAL: 깜빡임
        const blinkT  = Math.sin(time * (0.0012 + overheatW * 0.014) + 1.5);
        const blink   = blinkT > 0.93 ? Math.max(0, 1 - (blinkT - 0.93) * 40) : 1;
        // COOLDOWN: 눈이 반쯤 감김
        const eyeScaleY = 1 * (1 - cooldownW * 0.55) * blink;
        const eyeA      = bpA * 0.92 * dormantDim;

        ctx.save();
        ctx.shadowBlur = 10 * bp; ctx.shadowColor = `hsl(${(hue+60)%360}, 100%, 90%)`;
        ctx.fillStyle  = `hsl(${(hue+60)%360}, 100%, 88%)`;

        ctx.globalAlpha = eyeA;
        ctx.beginPath(); ctx.ellipse(bx - eyeOffX, faceY, eyeR, eyeR * eyeScaleY, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(bx + eyeOffX, faceY, eyeR, eyeR * eyeScaleY, 0, 0, Math.PI * 2); ctx.fill();

        // OVERHEAT: 이마에 땀방울 + 불안한 눈썹 (기울어진 선)
        if (overheatW > 0.3) {
          ctx.globalAlpha = eyeA * overheatW;
          ctx.strokeStyle = `hsl(50, 100%, 80%)`;
          ctx.lineWidth   = Math.max(1, eyeR * 0.55);
          ctx.lineCap     = 'round';
          // 왼쪽 눈썹 (안쪽이 내려간 걱정 모양)
          ctx.beginPath();
          ctx.moveTo(bx - eyeOffX - eyeR, faceY - eyeR * 2.2);
          ctx.lineTo(bx - eyeOffX + eyeR, faceY - eyeR * 1.5);
          ctx.stroke();
          // 오른쪽 눈썹
          ctx.beginPath();
          ctx.moveTo(bx + eyeOffX - eyeR, faceY - eyeR * 1.5);
          ctx.lineTo(bx + eyeOffX + eyeR, faceY - eyeR * 2.2);
          ctx.stroke();
          // 땀방울
          const sweatY = faceY - eyeR * 3.5;
          ctx.fillStyle = `hsl(200, 100%, 75%)`;
          ctx.shadowColor = `rgba(100,200,255,0.8)`; ctx.shadowBlur = 8;
          ctx.beginPath(); ctx.arc(bx + eyeOffX * 1.5, sweatY + Math.sin(time * 0.003) * 3, eyeR * 0.65, 0, Math.PI * 2); ctx.fill();
        }

        // 볼 블러셔 (COOLDOWN엔 작아짐, OVERHEAT엔 빨개짐)
        const blushHue = 340 + overheatW * (-295); // OVERHEAT: 빨강(45°쪽)
        ctx.globalAlpha = bpA * (0.30 - overheatW * 0.10) * dormantDim;
        ctx.fillStyle   = `hsl(${blushHue}, 100%, 72%)`;
        ctx.shadowBlur  = 14; ctx.shadowColor = `hsl(${blushHue}, 100%, 60%)`;
        ctx.beginPath(); ctx.arc(bx - eyeOffX * 1.6, faceY + eyeR * 2.2, eyeR * 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(bx + eyeOffX * 1.6, faceY + eyeR * 2.2, eyeR * 1.5, 0, Math.PI * 2); ctx.fill();

        // 입: OPTIMAL=미소, OVERHEAT=일자/당황, COOLDOWN=처진 입꼬리
        ctx.globalAlpha = eyeA * 0.75;
        ctx.strokeStyle = `hsl(${(hue+60)%360}, 100%, 88%)`;
        ctx.lineWidth   = Math.max(1, eyeR * 0.7);
        ctx.lineCap     = 'round'; ctx.shadowBlur = 6;
        const mouthY = faceY + eyeR * 2.8;
        const smileDir = 1 - overheatW * 1.0 - cooldownW * 2.0; // 1=미소, 0=일자, -1=처짐
        ctx.beginPath();
        ctx.arc(bx, mouthY, eyeR * 1.4,
          smileDir > 0 ? 0.2 : -0.2,
          smileDir > 0 ? Math.PI - 0.2 : Math.PI + 0.2,
          smileDir < 0
        );
        ctx.stroke();
        ctx.restore();
      }
    }

    // ─── 유기적 팔: quadratic bezier 곡선 3패스 ─────────────────
    function drawArmCurve(sx, sy, elbowX, elbowY, tipX, tipY, w, alpha) {
      if (w < 1 || alpha < 0.01) return;
      // 수평 구간: 아래로 살짝 처지는 제어점
      const cp1x = (sx + elbowX) * 0.50, cp1y = sy + w * 0.20;
      // 수직 구간: 팔꿈치에서 부드럽게 올라가는 제어점
      const cp2x = elbowX - (tipX - elbowX) * 0.08, cp2y = (elbowY + tipY) * 0.52;

      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      function makePath() {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(cp1x, cp1y, elbowX, elbowY);
        ctx.quadraticCurveTo(cp2x, cp2y, tipX, tipY);
      }

      const bpA2 = bp * alpha;
      // Pass 1 – 바디
      makePath();
      ctx.lineWidth   = w;
      ctx.strokeStyle = `hsla(${hue}, 88%, 20%, ${0.92 * bpA2})`;
      ctx.shadowBlur  = ep.glowBlur * 0.52 * bp; ctx.shadowColor = ep.glowColor;
      ctx.globalAlpha = 1; ctx.stroke();

      // Pass 2 – 중앙 하이라이트
      makePath();
      ctx.lineWidth   = w * 0.46;
      ctx.strokeStyle = `hsla(${(hue + 40) % 360}, 95%, 63%, ${0.50 * bpA2})`;
      ctx.shadowBlur  = 5 * bp; ctx.stroke();

      // Pass 3 – 이색 테두리
      makePath();
      ctx.lineWidth   = 2.0;
      ctx.strokeStyle = `hsl(${(hue + 72) % 360}, 100%, 84%)`;
      ctx.shadowBlur  = 18 * bp; ctx.globalAlpha = 0.82 * shimmer * bpA2; ctx.stroke();

      ctx.restore();
    }

    // ─── 꽃봉오리: 귀여운 5-꽃잎 발광 ──────────────────────────
    function drawBud(x, y, r, alpha) {
      if (r < 1 || alpha < 0.05) return;
      const pulseSpeed = 0.006 * (1 - cooldownW * 0.65);
      const p    = (0.72 + 0.28 * Math.sin(time * pulseSpeed)) * bp;
      const rot  = time * 0.0008; // 꽃이 천천히 회전
      ctx.save();
      ctx.globalAlpha = alpha * p;

      // 꽃잎 8장 — 각자 독립적인 크기·속도·위상으로 팔딱팔딱
      const petalColors = [
        `hsl(330, 100%, 78%)`, // 핑크
        `hsl(280, 100%, 78%)`, // 연보라
        `hsl(200, 100%, 78%)`, // 하늘
        `hsl(160, 100%, 72%)`, // 민트
      ];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + rot;

        // 각 꽃잎마다 다른 위상·속도 → 파도처럼 순서대로 피었다 오므라듦
        const petalPhase  = i * (Math.PI * 2 / 8);               // 꽃잎 위상 오프셋
        const petalFreq   = 0.004 + i * 0.00035;                 // 꽃잎마다 조금씩 다른 맥박 속도
        const petalPulse  = 0.60 + 0.40 * Math.sin(time * petalFreq + petalPhase);  // 0.20 ~ 1.0
        // 짝수 꽃잎은 길고(outward), 홀수는 약간 짧아서 안쪽-바깥쪽 교대 느낌
        const baseLen     = i % 2 === 0 ? 2.2 : 1.65;
        const dynLen      = baseLen * (0.75 + petalPulse * 0.45); // 길이 동적 변화
        const dynW        = (i % 2 === 0 ? 0.70 : 0.52) * (0.80 + petalPulse * 0.35);
        const dynH        = (i % 2 === 0 ? 0.52 : 0.40) * (0.80 + petalPulse * 0.35);

        const px  = x + Math.cos(a) * r * dynLen;
        const py  = y + Math.sin(a) * r * dynLen;
        const col = petalColors[i % petalColors.length];

        ctx.fillStyle   = col;
        ctx.shadowBlur  = (16 + petalPulse * 18) * bp;
        ctx.shadowColor = col;
        ctx.globalAlpha = alpha * p * (0.65 + petalPulse * 0.30);
        ctx.beginPath();
        ctx.ellipse(px, py, r * dynW, r * dynH, a, 0, Math.PI * 2);
        ctx.fill();
      }

      // 중심 노란 orb
      ctx.globalAlpha = alpha * p;
      ctx.fillStyle   = `hsl(55, 100%, 82%)`;
      ctx.shadowBlur  = 28 * bp; ctx.shadowColor = `hsl(55, 100%, 90%)`;
      ctx.beginPath(); ctx.arc(x, y, r * 0.80, 0, Math.PI * 2); ctx.fill();

      // 반짝이 하이라이트
      ctx.globalAlpha = alpha * p * 0.6;
      ctx.fillStyle   = '#fff';
      ctx.shadowBlur  = 6;
      ctx.beginPath(); ctx.arc(x - r * 0.28, y - r * 0.28, r * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ─── 서부 영화 귀여운 새 (정수리 포인트) ────────────────────────
    // 선인장 꼭대기에 앉은 홀로그램 새 — 서부 영화 필수 소품
    function drawWesternBird(x, y, scale, alpha) {
      if (alpha < 0.05 || scale < 1) return;
      // COOLDOWN: 새가 졸음 → 느리게 호흡, 고개가 아래로 처짐
      const sleepSpeed = 0.004 * (1 - cooldownW * 0.70);
      const p   = (0.7 + 0.3 * Math.sin(time * sleepSpeed + x * 0.01)) * bp;
      // COOLDOWN: bob 진폭 증가 + 전체적으로 아래로 처짐 (꾸벅꾸벅)
      const bobAmp = scale * (0.18 + cooldownW * 0.38);
      const bob = Math.sin(time * (0.0035 - cooldownW * 0.002)) * bobAmp;
      const droopY = cooldownW * scale * 0.55; // 아래로 처지는 양
      const by  = y - scale * 2.2 + bob + droopY;

      ctx.save();
      ctx.globalAlpha = alpha * p; // p에 이미 bp 포함됨
      ctx.shadowBlur  = 14 * bp; ctx.shadowColor = ep.orbSpecial;
      ctx.strokeStyle = ep.orbSpecial;
      ctx.fillStyle   = ep.orbSpecial;
      ctx.lineCap     = 'round'; ctx.lineJoin = 'round';

      // 몸통 (작은 타원)
      const bw = scale * 0.9, bh = scale * 0.6;
      ctx.beginPath();
      ctx.ellipse(x, by, bw, bh, 0, 0, Math.PI * 2);
      ctx.fill();

      // 머리
      ctx.beginPath();
      ctx.arc(x + bw * 0.72, by - bh * 0.4, scale * 0.52, 0, Math.PI * 2);
      ctx.fill();

      // 부리
      ctx.beginPath();
      ctx.moveTo(x + bw * 1.18, by - bh * 0.35);
      ctx.lineTo(x + bw * 1.72, by - bh * 0.28);
      ctx.lineWidth = scale * 0.22;
      ctx.stroke();

      // 꼬리 (뒤쪽)
      ctx.beginPath();
      ctx.moveTo(x - bw * 0.92, by);
      ctx.quadraticCurveTo(x - bw * 1.6, by - bh * 0.8, x - bw * 1.8, by - bh * 1.1);
      ctx.lineWidth = scale * 0.18;
      ctx.stroke();

      // 날개 (접힌 선)
      ctx.globalAlpha *= 0.6;
      ctx.beginPath();
      ctx.moveTo(x - bw * 0.2, by - bh * 0.1);
      ctx.quadraticCurveTo(x + bw * 0.3, by + bh * 0.55, x + bw * 0.7, by + bh * 0.1);
      ctx.lineWidth = scale * 0.28;
      ctx.stroke();

      // 눈 (반짝)
      ctx.globalAlpha = alpha * p * 1.2;
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = '#fff';
      ctx.beginPath();
      ctx.arc(x + bw * 0.88, by - bh * 0.52, scale * 0.16, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    // ─── areole 가시 클러스터 (3방향) ───────────────────────────
    function areole(ex, sy, w, side) {
      // COOLDOWN: 가시가 천천히 빛을 잃음
      const pls = (0.48 + 0.52 * Math.sin(time * 0.003 + sy * 0.013)) * bp;
      ctx.save();
      ctx.globalAlpha = 0.88 * shimmer * pls;
      ctx.shadowBlur  = 9; ctx.shadowColor = ep.orbSpecial;
      ctx.strokeStyle = ep.orbSpecial;
      ctx.lineWidth   = 0.95; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ex, sy); ctx.lineTo(ex + side * w * 0.60, sy - w * 0.42); ctx.stroke(); // 위 대각
      ctx.beginPath(); ctx.moveTo(ex, sy); ctx.lineTo(ex + side * w * 0.72, sy + w * 0.02); ctx.stroke(); // 수평
      ctx.beginPath(); ctx.moveTo(ex, sy); ctx.lineTo(ex + side * w * 0.52, sy + w * 0.36); ctx.stroke(); // 아래 대각
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = ep.orbSpecial;
      ctx.beginPath(); ctx.arc(ex, sy, Math.max(1, w * 0.08), 0, Math.PI * 2); ctx.fill(); // areole 중심
      ctx.restore();
    }

    // ─── 팔 렌더 (Painter: 트렁크 뒤) ───────────────────────────
    if (armGp > 0.02) {
      armCfg.forEach(arm => {
        const jY     = baseY - trunkH * arm.jT;
        const startX = cx + arm.side * hw * 0.42 + tiltX * arm.jT;
        const elbowX = startX + arm.side * arm.len;
        const elbowY = jY + arm.w * arm.sag;
        const tipX   = elbowX;
        const tipY   = jY - arm.h;

        drawArmCurve(startX, jY, elbowX, elbowY, tipX, tipY, arm.w, armGp);
        drawBud(tipX, tipY, arm.w * 0.55, armGp);

        // 팔 수직 구간 areole
        const spCnt = Math.max(2, Math.floor(arm.h / (arm.w * 1.4)));
        for (let i = 0; i < spCnt; i++) {
          const sy = elbowY - (i + 0.5) * arm.h / spCnt;
          areole(elbowX - arm.w / 2, sy, arm.w, -1);
          areole(elbowX + arm.w / 2, sy, arm.w, +1);
        }

        treeTips.push({ x: tipX, y: tipY - arm.w * 0.5, angle: -Math.PI / 2, gf: armGp, id: 9990 + arm.side * 10 + Math.round(arm.jT * 10), li: 1 });
      });
    }

    // ─── 배럴 트렁크 렌더 (팔 위에) ─────────────────────────────
    drawBarrel(cx + tiltX * 0.45, growingTopY, baseY, trunkW, trunkGp);

    // 트렁크 세로 리브
    const ribCount = 5;
    for (let r = 0; r < ribCount; r++) {
      const rx  = cx - hw + (r + 1) * trunkW / (ribCount + 1);
      const rY0 = baseY - 8;
      const rY1 = growingTopY + hw * 0.5;
      if (rY1 >= rY0) continue;
      ctx.save();
      ctx.globalAlpha = 0.17 * shimmer;
      ctx.strokeStyle = `hsl(${(hue + r * 25) % 360}, 100%, 80%)`;
      ctx.lineWidth   = 0.8; ctx.shadowBlur = 3;
      ctx.beginPath(); ctx.moveTo(rx, rY0); ctx.lineTo(rx, rY1); ctx.stroke();
      ctx.restore();
    }

    // 트렁크 areole 가시
    const spCount = Math.max(3, Math.floor((trunkH * trunkGp) / (trunkW * 1.3)));
    for (let i = 0; i < spCount; i++) {
      const sy = baseY - (i + 0.5) * (trunkH * trunkGp) / spCount;
      areole(cx - hw, sy, trunkW, -1);
      areole(cx + hw, sy, trunkW, +1);
    }

    // 트렁크 꼭대기 꽃봉오리 (더 크게: 0.85 → 1.3)
    drawBud(topX, growingTopY, hw * 1.3, trunkGp);

    // 팔 끝 꽃봉오리도 크게
    // (armCfg forEach 내에서 이미 drawBud 호출하므로 여기선 트렁크만)

    // 서부 영화 새: 성장 완료 후 정수리 왼쪽에 앉음
    drawWesternBird(topX - hw * 1.8, growingTopY, hw * 0.65, trunkGp * Math.min(1, (trunkGp - 0.7) * 3.3));

    // ── 하트 파티클: 선인장에서 ♥ 떠오름 ─────────────────────────
    if (trunkGp > 0.6) {
      const heartCount = 5;
      for (let i = 0; i < heartCount; i++) {
        const seed   = i * 137.5 + time * 0.0004;
        const hx     = topX + Math.sin(seed * 3.1) * hw * 2.2;
        const phase  = (seed * 0.17) % 1;               // 0~1 부유 주기
        const hy     = growingTopY - phase * canvas.height * 0.22;
        const hAlpha = (1 - phase) * trunkGp * 0.65 * bp;
        const hSize  = Math.max(1.5, hw * 0.22 * (1 - phase * 0.5));
        if (hAlpha < 0.02) continue;
        const heartHue = 330 + i * 22;

        ctx.save();
        ctx.globalAlpha = hAlpha;
        ctx.fillStyle   = `hsl(${heartHue % 360}, 100%, 80%)`;
        ctx.shadowBlur  = 12; ctx.shadowColor = ctx.fillStyle;
        // 하트: 두 원 + 역삼각형 근사
        ctx.beginPath();
        ctx.arc(hx - hSize * 0.5, hy - hSize * 0.25, hSize * 0.55, Math.PI, 0);
        ctx.arc(hx + hSize * 0.5, hy - hSize * 0.25, hSize * 0.55, Math.PI, 0);
        ctx.lineTo(hx, hy + hSize * 1.1);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // ── 데이터 링: 식물 주위를 도는 발광 타원 궤도 2개 ──────────────
    if (trunkGp > 0.4) {
      for (let ri = 0; ri < 2; ri++) {
        const ringY  = baseY - trunkH * (0.35 + ri * 0.30) * trunkGp;
        const ringRx = trunkW * (1.7 + ri * 0.5);
        const ringRy = ringRx * 0.20;
        const wobble = Math.sin(time * 0.0012 + ri * 2.5) * 0.10;
        const ringA  = (0.30 + 0.18 * Math.sin(time * 0.0026 + ri * 3)) * trunkGp * bp;

        ctx.save();
        ctx.translate(cx, ringY);
        ctx.rotate(wobble);
        ctx.globalAlpha = ringA;
        ctx.strokeStyle = ri === 0 ? ep.tipColorA : ep.tipColorB;
        ctx.lineWidth   = 1.1;
        ctx.setLineDash([14, 9]);                       // 데이터 스트림 느낌의 점선
        ctx.lineDashOffset = -time * 0.02 * (ri === 0 ? 1 : -1); // 서로 반대로 회전
        ctx.beginPath();
        ctx.ellipse(0, 0, ringRx, ringRy, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── 글리치 수평 바: 글리치 순간에만 식물 위로 노이즈 밴드 ──────
    if (inGlitch) {
      ctx.save();
      for (let gi = 0; gi < 3; gi++) {
        const gy = baseY - trunkH * seededRandom(Math.floor(time / 40) * 3 + gi) * trunkGp;
        ctx.globalAlpha = 0.22;
        ctx.fillStyle   = ep.tipColorA;
        ctx.fillRect(cx - trunkW * 2.5, gy, trunkW * 5, 2 + seededRandom(gi * 7) * 3);
      }
      ctx.restore();
    }

    ctx.restore(); // 글리치 지터 translate 해제

    treeTips.push({ x: topX, y: growingTopY - hw * 0.6, angle: -Math.PI / 2, gf: trunkGp, id: 9999, li: 0 });
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

    // 별: 작은 별 223개는 정적 캐시 레이어 1회 드로우 (성능 최적화)
    if (starLayer) ctx.drawImage(starLayer, 0, 0);

    // 큰 별 37개만 매 프레임 트윙클 (기존 260개 → 37개로 드로우콜 86% 감소)
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 260; i += 7) {
      const sx = Math.abs(Math.sin(i * 127.1)) * canvas.width;
      const sy = Math.abs(Math.sin(i * 311.7)) * canvas.height;
      const tw = 0.3 + Math.abs(Math.sin(time * 0.0018 + i * 0.7)) * 0.7;
      ctx.globalAlpha = tw * ((window.SPEC.FX || {}).STAR_ALPHA_LARGE || 0.20);
      ctx.beginPath(); ctx.arc(sx, sy, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ═══════════════════════════════════════════════════════════════
  // ─── 공통 분위기 레이어 (전 테마 적용, 3배 강화 버전) ─────────────
  // ═══════════════════════════════════════════════════════════════

  /**
   * 바닥 반사: 식물 영역을 수직 반전 복사해 유리 바닥에 비친 효과
   * 캔버스 자신을 drawImage로 재사용 → 식물 재드로우 없이 드로우콜 1회
   */
  function drawGroundReflection(ep) {
    const baseY = Math.round(canvas.height * 0.88);
    const reflH = Math.round(canvas.height * 0.11);
    if (reflH < 8) return;

    const fx    = window.SPEC.FX || {};
    // 연꽃은 수면이므로 반사 더 선명하게
    const alpha = currentTheme === 'NEON_LOTUS' ? 0.60 : (fx.REFLECTION_ALPHA || 0.45);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, baseY * 2);
    ctx.scale(1, -1);
    // baseY 바로 위 영역을 그대로 아래로 반전 복사
    ctx.drawImage(canvas, 0, baseY - reflH, canvas.width, reflH,
                          0, baseY - reflH, canvas.width, reflH);
    ctx.restore();

    // 아래로 갈수록 배경색에 잠기는 페이드 마스크
    const m = ctx.createLinearGradient(0, baseY, 0, baseY + reflH);
    m.addColorStop(0, hexToRgba(ep.bgEdge, 0.10));
    m.addColorStop(1, hexToRgba(ep.bgEdge, 0.95));
    ctx.fillStyle = m;
    ctx.fillRect(0, baseY, canvas.width, reflH);
  }

  /**
   * 반딧불: 식물 주변을 부유하는 발광 입자 (코어+글로우 2패스, shadowBlur 미사용)
   * 좌표는 time 기반 stateless 계산 → 별도 배열 관리 불필요
   */
  function drawFireflies(time, ep) {
    const fx    = window.SPEC.FX || {};
    const count = fx.FIREFLY_COUNT || 66;
    const cx    = canvas.width / 2;
    const baseY = canvas.height * 0.88;
    const cdW   = getStateWeight('COOLDOWN');

    ctx.save();
    for (let i = 0; i < count; i++) {
      const s1 = seededRandom(i * 7 + 1);
      const s2 = seededRandom(i * 13 + 5);
      const s3 = seededRandom(i * 29 + 11);

      const orbitW = canvas.width * (0.06 + s1 * 0.34);
      const speed  = (0.00010 + s2 * 0.00018) * (1 - cdW * 0.5); // COOLDOWN: 느리게
      const ph     = i * 2.39;

      const x  = cx + Math.sin(time * speed + ph) * orbitW;
      const y  = baseY - canvas.height * (0.06 + s3 * 0.58)
                 + Math.sin(time * speed * 1.7 + ph * 1.3) * 34;
      const tw = 0.5 + 0.5 * Math.sin(time * 0.002 + i * 1.3);
      const a  = tw * 0.55 * (fx.AMBIENT_ALPHA || 0.75);
      if (a < 0.04) continue;
      const r  = 1.1 + s2 * 1.9;

      // 글로우 패스 (큰 원, 낮은 알파)
      ctx.globalAlpha = a * 0.22;
      ctx.fillStyle   = ep.orbColor;
      ctx.beginPath(); ctx.arc(x, y, r * 3.4, 0, Math.PI * 2); ctx.fill();

      // 코어 패스
      ctx.globalAlpha = a;
      ctx.fillStyle   = i % 5 === 0 ? ep.orbSpecial : ep.orbAltColor;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 갓레이: 화면 상단에서 내려오는 부채꼴 빛줄기 (score 비례 강도)
   */
  function drawGodRays(time, ep) {
    const sr = renderState.displayScore / 100;
    if (sr < 0.08) return;
    const fx = window.SPEC.FX || {};
    const n  = fx.GODRAY_COUNT || 9;
    const cx = canvas.width / 2;

    ctx.save();
    for (let i = 0; i < n; i++) {
      const off    = i - (n - 1) / 2;
      const sway   = Math.sin(time * 0.00010 + i * 1.9) * canvas.width * 0.04;
      const topX   = cx + off * canvas.width * 0.105 + sway;
      const spread = canvas.width * (0.045 + seededRandom(i * 13 + 4) * 0.05);
      const botX   = topX + off * canvas.width * 0.055;
      const pulse  = 0.6 + 0.4 * Math.sin(time * 0.0006 + i * 2.2);
      const a      = (fx.GODRAY_ALPHA || 0.13) * sr * pulse;

      const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
      g.addColorStop(0,    ep.glowColor.replace(/[\d.]+\)$/, `${a})`));
      g.addColorStop(0.75, ep.glowColor.replace(/[\d.]+\)$/, '0)'));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(topX - 9, -12);
      ctx.lineTo(topX + 9, -12);
      ctx.lineTo(botX + spread, canvas.height);
      ctx.lineTo(botX - spread, canvas.height);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 작은 별들을 오프스크린 캔버스에 미리 렌더 (init·resize 시 1회 호출)
   * 매 프레임 sin() 계산 + arc 드로우 260회를 drawImage 1회로 대체
   */
  function buildStarLayer() {
    starLayer        = document.createElement('canvas');
    starLayer.width  = canvas.width;
    starLayer.height = canvas.height;
    const sctx = starLayer.getContext('2d');
    sctx.fillStyle   = '#ffffff';
    sctx.globalAlpha = (window.SPEC.FX || {}).STAR_ALPHA_SMALL || 0.10; // 트윙클 평균 밝기로 고정
    for (let i = 0; i < 260; i++) {
      if (i % 7 === 0) continue; // 큰 별은 메인 루프에서 트윙클 렌더
      const sx = Math.abs(Math.sin(i * 127.1)) * starLayer.width;
      const sy = Math.abs(Math.sin(i * 311.7)) * starLayer.height;
      sctx.beginPath(); sctx.arc(sx, sy, 0.9, 0, Math.PI * 2); sctx.fill();
    }
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

  // 비네트: 외곽을 은은하게만 — 과하면 화사함과 글래스 패널을 죽임
  function drawVignette() {
    const fx = window.SPEC.FX || {};
    const va = fx.VIGNETTE_ALPHA !== undefined ? fx.VIGNETTE_ALPHA : 0.55;
    const g = ctx.createRadialGradient(
      canvas.width/2, canvas.height/2, canvas.height * 0.18,
      canvas.width/2, canvas.height/2, canvas.height * 0.95
    );
    g.addColorStop(0, 'transparent'); g.addColorStop(1, `rgba(0,0,0,${va})`);
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
  const SEED_MAX = window.SPEC.SEED_MAX || 40; // 화면에 상주하는 최대 씨앗 수

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
      // 주변 씨앗은 앰비언트 감광 적용 — 주인공(식물)보다 밝게 경쟁하지 않도록
      const dimA         = s.energized ? 1 : ((window.SPEC.FX || {}).AMBIENT_ALPHA || 0.75);
      const displayAlpha = Math.min(1, s.baseAlpha * s.life * energyAlpha * seedBreath) * dimA;

      ctx.save();
      ctx.globalAlpha = displayAlpha;
      ctx.shadowBlur  = displaySize * (s.energized ? 18 : (4 + cdW * 6)); // COOLDOWN에서 부드러운 후광
      ctx.shadowColor = s.color;
      ctx.fillStyle   = s.color;
      if (currentTheme === 'HOLOGRAM_SUCCULENT') {
        // 픽셀 스파클: 홀로그램 세계관(직선·디지털)에 맞춘 사각 점멸 — 유기체 섬모와 충돌 방지
        const pxSz = displaySize * 1.7;
        ctx.fillRect(s.x - pxSz / 2, s.y - pxSz / 2, pxSz, pxSz);
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, displaySize, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── 우드스프라이트 섬모: 코어 아래로 늘어지는 가는 발광 가닥 (해파리형) ──
      // 에너자이즈(폭발) 상태와 홀로그램다육이(픽셀 스파클) 테마는 제외
      if (!s.energized && currentTheme !== 'HOLOGRAM_SUCCULENT') {
        const cilN = 4;
        ctx.lineWidth   = 0.6;
        ctx.strokeStyle = s.color;
        ctx.shadowBlur  = 4;
        for (let c = 0; c < cilN; c++) {
          const spreadC = (c - (cilN - 1) / 2) * 0.55;            // 좌우 부챗살
          const wob     = Math.sin(time * 0.003 + s.phase + c * 1.7) * 2.5;
          const cilLen  = displaySize * 2.2 + 5;
          ctx.globalAlpha = displayAlpha * 0.50;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y + displaySize * 0.5);
          ctx.quadraticCurveTo(
            s.x + spreadC * cilLen * 0.5 + wob,        s.y + cilLen * 0.55,
            s.x + spreadC * cilLen      + wob * 1.6,   s.y + cilLen
          );
          ctx.stroke();
        }
      }

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

  // ─── 가상 카메라 업데이트 ─────────────────────────────────────
  /**
   * 테마별로 식물 예상 높이를 계산해 필요한 줌 스케일을 구하고
   * 스프링 물리로 cam.scale / cam.panY를 부드럽게 수렴시킨다.
   *
   * 피벗 포인트: 식물 뿌리(canvas.height * 0.88) 고정
   *   → 줌아웃해도 식물 뿌리가 화면 아래 같은 위치에 유지됨
   */
  function updateCamera() {
    const sr = Math.max(0, Math.min(1, renderState.displayScore / 100));
    let targetScale;

    switch (currentTheme) {
      case 'NEON_LOTUS':
        // 연꽃: 점수 25% 이후 빠르게 줌아웃 (꽃잎 반지름이 크게 성장)
        targetScale = Math.max(0.48, 1.0 - Math.max(0, sr - 0.22) * 0.68);
        break;
      case 'DEEP_VINE':
        // 덩굴: canvas.height 85%까지 자람
        targetScale = Math.max(0.64, 1.0 - Math.max(0, sr - 0.30) * 0.50);
        break;
      case 'HOLOGRAM_SUCCULENT':
        // 선인장: 줌아웃 완화 (0.55→0.28) → score 60 이후 성장이 화면에서 실제로 보임
        targetScale = Math.max(0.70, 1.0 - Math.max(0, sr - 0.22) * 0.28);
        break;
      default: // GLOWING_TREE (2 그루)
        // 트렁크 + 가지 = 대략 trunkH * 3 수직 높이
        targetScale = Math.max(0.55, 1.0 - Math.max(0, sr - 0.28) * 0.62);
        break;
    }

    // 식물이 클수록 살짝 위로 패닝 → 화면 상단도 보임
    const targetPanY = -canvas.height * 0.06 * sr;

    // 스프링 보간 (k=0.032, d=0.84)
    cam.scaleVel += (targetScale - cam.scale) * 0.032;
    cam.scaleVel *= 0.84;
    cam.scale    += cam.scaleVel;
    cam.scale     = Math.max(0.40, Math.min(1.08, cam.scale));

    cam.panYVel += (targetPanY - cam.panY) * 0.032;
    cam.panYVel *= 0.84;
    cam.panY    += cam.panYVel;
  }

  /**
   * ctx 에 카메라 변환 적용 (save() 후 호출, restore()로 해제)
   *
   * 수식 증명:
   *   피벗 py = canvas.height * 0.88 (식물 뿌리)
   *   screen_y(뿌리) = canvasMid + (py - canvasMid)*(1-s) + s*(py-canvasMid) + panY
   *                  = py + panY   → 뿌리 위치 고정(panY만큼만 이동)
   */
  function applyCameraTransform() {
    const s       = cam.scale;
    const midX    = canvas.width  / 2;
    const midY    = canvas.height / 2;
    const baseY   = canvas.height * 0.88;          // 식물 뿌리
    const fixedOY = (baseY - midY) * (1 - s);      // 뿌리를 고정하는 보정값

    ctx.translate(midX, midY + fixedOY + cam.panY);
    ctx.scale(s, s);
    ctx.translate(-midX, -midY);
  }

  // burst 파티클 주기적 방출 (씨앗 보충은 updateSeeds 내부에서 자체 관리)
  function spawnAmbient(ep) {
    const grown = treeTips.filter(t => t.gf > 0.8);
    if (grown.length === 0) return;
    if (currentState === 'OVERHEAT' && Math.random() < 0.78)       spawnParticles(8, 'focus', ep);
    else if (currentState === 'OPTIMAL' && Math.random() < 0.45)   spawnParticles(5, 'focus', ep);
    else if (currentState === 'COOLDOWN' && Math.random() < 0.14)  spawnParticles(2, 'focus', ep);
    else if (currentState === 'DORMANT' && Math.random() < 0.10)   spawnParticles(2, 'focus', ep);

    // 잎 끝에서 꽃가루처럼 흩날리는 추가 파티클 (OPTIMAL·OVERHEAT)
    // spawnSeed(energized, ep) 시그니처 — 주변(ambient) 씨앗으로 생성, 위치는 내부에서 잎 끝 선택
    if ((currentState === 'OPTIMAL' || currentState === 'OVERHEAT') && Math.random() < 0.30) {
      spawnSeed(false, ep);
    }
  }

  // ─── 메인 루프 ───────────────────────────────────────────────
  function animate() {
    const time = Date.now();
    updateGrowthProgress();
    updateCamera();                          // 카메라 스프링 업데이트
    const ep = buildEffectivePalette();

    // ── 배경·대기 효과: 항상 풀스크린 (카메라 미적용) ──────────
    drawBackground(time, ep);
    drawAurora(time, ep);
    drawGodRays(time, ep);          // 빛줄기: 식물 뒤 배경 레이어

    // ── 식물·씨앗·파티클: 카메라 변환 안에서 렌더 ──────────────
    ctx.save();
    applyCameraTransform();
    drawTree(time, ep);
    updateFallingLeaves(time, ep);  // 낙엽 (글로잉나무 전용, 월드 좌표)
    updateSeeds(time, ep);
    updateParticles();
    ctx.restore();

    // ── 공통 분위기 레이어: 화면 공간 ────────────────────────────
    drawGroundReflection(ep);       // 식물이 그려진 후 캔버스 반전 복사
    drawFireflies(time, ep);

    // ── 화면 공간 오버레이: 카메라 미적용 (항상 엣지에 고정) ────
    drawOverheatEdge(time, ep);
    drawCooldownVeil(time, ep);
    drawVignette();
    spawnAmbient(ep);
    requestAnimationFrame(animate);
  }

  /**
   * 테마 전환: 팔레트를 교체하고 색상 Lerp 전환 시작
   * localStorage 에 저장하여 새로고침 후에도 유지
   */
  function setTheme(name) {
    if (!THEMES || !THEMES[name]) {
      console.warn(`[D-Garden] 알 수 없는 테마: ${name}`);
      return;
    }
    prevPalette  = buildEffectivePalette();   // 현재 색상 스냅샷
    currentTheme = name;
    PALETTE      = THEMES[name];
    currPalette  = PALETTE[currentState];
    transitionT  = 0;
    try { localStorage.setItem('d-garden-theme', name); } catch (_) {}
  }

  function init(canvasEl) {
    if (!window.SPEC || !window.SPEC.PALETTE) {
      console.error('[D-Garden] SPEC.PALETTE 로드 실패. spec.json을 확인하세요.');
      return;
    }

    // GLOWING_TREE = 기존 PALETTE 재사용 (spec.json 중복 없음)
    THEMES = window.SPEC.THEMES || {};
    THEMES.GLOWING_TREE = window.SPEC.PALETTE;

    // localStorage에 저장된 테마 복원
    try {
      const saved = localStorage.getItem('d-garden-theme');
      if (saved && THEMES[saved]) currentTheme = saved;
    } catch (_) {}

    PALETTE     = THEMES[currentTheme];
    prevPalette = PALETTE.OPTIMAL;
    currPalette = PALETTE.OPTIMAL;

    // renderState를 SPEC 초기값으로 시드: 첫 프레임부터 정상 수치 보장
    const initScore = (window.SPEC.INITIAL_SCORE != null) ? window.SPEC.INITIAL_SCORE : 50;
    renderState.displayScore   = initScore;
    renderState.effectiveDepth = getMaxDepth(initScore, 'OPTIMAL');

    canvas = canvasEl; ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    buildStarLayer();
    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth; canvas.height = window.innerHeight;
      buildStarLayer(); // 캔버스 크기 변경 시 별 레이어 재생성
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

  return { init, update, spawnParticles, energizeSeeds, getBadgeColor, triggerTipGrowth, setTheme };
})();
