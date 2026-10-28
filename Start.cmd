@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Для запуску потрібен Node.js 22 або новіший: https://nodejs.org/
  echo Після встановлення знову відкрийте Start.cmd.
  pause
  exit /b 1
)
node -e "if(!(Number(process.versions.node.split('.')[0])>=22)) process.exit(1)"
if errorlevel 1 (
  echo Оновіть Node.js до версії 22 або новішої: https://nodejs.org/
  pause
  exit /b 1
)
node server.mjs --open
pause
