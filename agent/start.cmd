@echo off
REM D-Garden Agent — 전역 입력 브리지 실행기
REM 더블클릭하면 백그라운드 입력 감지가 시작됩니다. 끄려면 이 창을 닫으세요.
cd /d "%~dp0"
echo D-Garden Agent 시작 중... (이 창을 닫으면 종료됩니다)
node index.js
pause
