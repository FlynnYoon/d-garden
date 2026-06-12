/**
 * D-Garden Bridge — Cursor/VS Code 확장
 *
 * 에디터에서 발생하는 타이핑(onDidChangeTextDocument)을 키 입력으로 추론해
 * 127.0.0.1:7331 의 SSE(Server-Sent Events) 엔드포인트로 브로드캐스트한다.
 * D-Garden 페이지(engine/editor-bridge.js)가 EventSource로 구독한다.
 *
 * 포트는 spec.json의 EDITOR_BRIDGE_URL과 맞춰야 한다.
 */

const vscode = require('vscode');
const http = require('http');
const { inferKeystrokes } = require('./keystrokes');

const PORT = 7331;
const FLUSH_MS = 250;        // 키 입력 배치 전송 주기
const HEARTBEAT_MS = 25000;  // SSE 연결 유지용 핑 주기

let server = null;
let statusItem = null;
let flushTimer = null;
let heartbeatTimer = null;
const clients = new Set();
let pending = { keys: 0, backspaces: 0 };

function broadcast(frame) {
  for (const res of clients) res.write(frame);
}

function flush() {
  flushTimer = null;
  if (pending.keys === 0) return;
  broadcast(`data: ${JSON.stringify({ type: 'keys', keys: pending.keys, backspaces: pending.backspaces })}\n\n`);
  pending = { keys: 0, backspaces: 0 };
}

function updateStatus() {
  if (!statusItem) return;
  if (clients.size > 0) {
    statusItem.text = '$(heart-filled) D-Garden';
    statusItem.tooltip = `D-Garden 연결됨 (구독 ${clients.size}개) — 타이핑이 가든으로 전송되는 중`;
  } else {
    statusItem.text = '$(plug) D-Garden';
    statusItem.tooltip = `D-Garden 대기 중 — 페이지가 http://127.0.0.1:${PORT}/events 구독을 기다리는 중`;
  }
}

function activate(context) {
  server = http.createServer((req, res) => {
    // 배포된 https 페이지에서도 localhost 접근이 가능하도록 CORS/PNA 허용
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
    res.write(': d-garden bridge connected\n\n');
    clients.add(res);
    updateStatus();
    req.on('close', () => { clients.delete(res); updateStatus(); });
  });
  server.on('error', (err) => {
    vscode.window.showWarningMessage(`D-Garden 브리지 서버 시작 실패 (포트 ${PORT}): ${err.message}`);
  });
  server.listen(PORT, '127.0.0.1');

  heartbeatTimer = setInterval(() => broadcast(': ping\n\n'), HEARTBEAT_MS);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  updateStatus();
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      // 출력/로그 패널의 자동 갱신은 타이핑이 아니므로 제외
      const scheme = e.document.uri.scheme;
      if (scheme === 'output' || scheme === 'log') return;

      for (const change of e.contentChanges) {
        const k = inferKeystrokes(change);
        pending.keys += k.keys;
        pending.backspaces += k.backspaces;
      }
      if (!flushTimer && pending.keys > 0) flushTimer = setTimeout(flush, FLUSH_MS);
    })
  );
}

function deactivate() {
  if (flushTimer) clearTimeout(flushTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const res of clients) res.end();
  clients.clear();
  if (server) server.close();
}

module.exports = { activate, deactivate };
