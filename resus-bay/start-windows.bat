@echo off
REM Resus Bay - start the server on Windows. Double-click this file.
REM Needs Node.js 22.13 or newer from https://nodejs.org (LTS installer).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo Starting Resus Bay...  Open http://localhost:3000 in your browser.
echo Other computers on the same network can use http://%COMPUTERNAME%:3000
echo Keep this window open while the app is in use. Press Ctrl+C to stop.
node --disable-warning=ExperimentalWarning server/index.js
pause
