@echo off
chcp 65001 >nul
title Pinyin Dictionary (pinyin-search)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

echo Starting... the browser will open automatically. Close this window to stop the server.
node server.js --open
pause
