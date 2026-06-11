/**
 * D-Garden Agent — 전역 입력 브리지 (로컬 백그라운드)
 *
 * 컴퓨터 전체의 키보드/마우스 입력 "횟수"를 듣고(uiohook-napi),
 * 127.0.0.1:7331 의 SSE 엔드포인트로 D-Garden 페이지에 중계한다.
 * 어떤 앱에서 일하든(Cursor·브라우저·메모장 등) 나무가 반응한다.
 *
 * 프라이버시 원칙:
 *   - 외부 네트워크 전송 없음 (127.0.0.1 바인딩)
 *   - 키 "내용"은 절대 읽지 않음 — 눌렸다는 사실(횟수)과 삭제 여부만 집계
 *
 * 페이지 쪽 수신: engine/editor-bridge.js (포트는 spec.json EDITOR_BRIDGE_URL과 동일)
 */

const http = require('http');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { classifyKeydown, shouldCountMouseMove } = require('./keycount');

const PORT = Number(process.env.DGARDEN_PORT) || 7331;
const FLUSH_MS = 250;        // 입력 배치 전송 주기
const HEARTBEAT_MS = 25000;  // SSE 연결 유지 핑
const MOUSE_THROTTLE_MS = 200;

// 삭제 계열 키 (오타율 집계에 반영)
const DELETE_KEYS = [UiohookKey.Backspace, UiohookKey.Delete];

const clients = new Set();
let pending = { keys: 0, backspaces: 0, mouse: 0 };
let lastMouseTime = 0;
let flushTimer = null;

function broadcast(frame) {
  for (const res of clients) res.write(frame);
}

function flush() {
  flushTimer = null;
  if (pending.keys > 0) {
    broadcast(`data: ${JSON.stringify({ type: 'keys', keys: pending.keys, backspaces: pending.backspaces })}\n\n`);
  }
  if (pending.mouse > 0) {
    broadcast(`data: ${JSON.stringify({ type: 'mouse', moves: pending.mouse })}\n\n`);
  }
  pending = { keys: 0, backspaces: 0, mouse: 0 };
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

// ── SSE 서버 ──────────────────────────────
const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.url !== '/events')    { res.writeHead(404, cors); res.end(); return; }

  res.writeHead(200, {
    ...cors,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(': d-garden agent connected\n\n');
  clients.add(res);
  console.log(`[D-Garden Agent] 페이지 연결됨 (구독 ${clients.size}개)`);
  req.on('close', () => {
    clients.delete(res);
    console.log(`[D-Garden Agent] 페이지 연결 해제 (구독 ${clients.size}개)`);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[D-Garden Agent] 포트 ${PORT} 사용 중입니다. Cursor 확장(d-garden-bridge)이 아직 켜져 있으면 제거 후 Cursor를 재시작하세요.`);
  } else {
    console.error('[D-Garden Agent] 서버 오류:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[D-Garden Agent] 전역 입력 감지 시작 → http://127.0.0.1:${PORT}/events`);
  console.log('[D-Garden Agent] (키 내용은 읽지 않습니다 — 횟수만 집계)');
});

setInterval(() => broadcast(': ping\n\n'), HEARTBEAT_MS);

// ── 전역 입력 후킹 ────────────────────────
uIOhook.on('keydown', (e) => {
  const k = classifyKeydown(e.keycode, DELETE_KEYS);
  pending.keys += k.keys;
  pending.backspaces += k.backspaces;
  scheduleFlush();
});

uIOhook.on('mousemove', (e) => {
  const now = e.time || Date.now();
  if (!shouldCountMouseMove(lastMouseTime, now, MOUSE_THROTTLE_MS)) return;
  lastMouseTime = now;
  pending.mouse += 1;
  scheduleFlush();
});

uIOhook.start();

function shutdown() {
  console.log('\n[D-Garden Agent] 종료 중…');
  try { uIOhook.stop(); } catch (_) {}
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
