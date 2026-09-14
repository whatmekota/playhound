@echo off
title MWHOPlayer
cd /d "%~dp0"
echo time to goon...
echo.
start "" cmd /c "node es-proxy.mjs"
start "" http://localhost:6969
npx vite --host --port 6969
pause
