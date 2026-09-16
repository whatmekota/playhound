@echo off
setlocal
title playhound
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  playhound launcher
rem
rem  Starts everything in one go:
rem    6969  the app itself (vite, --host so the LAN can reach it)
rem    7071  EroScripts proxy        \  both live in es-proxy.mjs, which runs
rem    7072  remote relay (WebSocket) /  in its own minimised window
rem
rem  Closing this window shuts the relay down too.
rem ---------------------------------------------------------------------------

echo.
echo   time to goon...
echo.

rem -- Prerequisites ----------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [x] node is not on PATH. Install Node.js and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   [!] node_modules is missing - installing dependencies first.
  echo.
  call pnpm install
  if errorlevel 1 (
    echo.
    echo   [x] install failed.
    pause
    exit /b 1
  )
  echo.
)

rem -- Anything still holding the ports? --------------------------------------
rem  A relay left over from a previous run keeps 7072 and the new one dies
rem  silently, so say so rather than letting it fail quietly.
set PORT_BUSY=
for %%P in (6969 7071 7072) do (
  netstat -ano -p tcp | findstr /r /c:"LISTENING" | findstr /c:":%%P " >nul 2>&1
  if not errorlevel 1 (
    echo   [!] port %%P is already in use - is playhound running in another window?
    set PORT_BUSY=1
  )
)
if defined PORT_BUSY echo.

rem -- Relay + EroScripts proxy ----------------------------------------------
rem  Keep the PID: taskkill's WINDOWTITLE filter does not match minimised
rem  console windows, so killing by title leaves the relay running.
set RELAY_PID=
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "(Start-Process node -ArgumentList 'es-proxy.mjs' -WorkingDirectory '%CD%' -WindowStyle Minimized -PassThru).Id"`) do set RELAY_PID=%%p
if not defined RELAY_PID echo   [!] could not start the relay - the phone remote and CYD will not connect.

rem -- Where the phone and the CYD should point ------------------------------
rem  Only physical adapters that are up: this box has a pile of VPN and VMware
rem  interfaces, and none of them are reachable from a phone on the sofa.
echo   app      http://localhost:6969
echo   LAN:
for /f "usebackq tokens=*" %%I in (`powershell -NoProfile -Command "Get-NetAdapter | Where-Object { -not $_.Virtual -and $_.Status -eq 'Up' } | ForEach-Object { Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue } | Where-Object { $_.IPAddress -notlike '169.254.*' } | ForEach-Object { 'http://{0}:6969   ({1})' -f $_.IPAddress, $_.InterfaceAlias }"`) do echo     %%I
echo.
echo   That address is what the phone remote opens, and what PH_HOST
echo   should be in firmware\cyd-face\config.h.
echo.

rem -- The app (foreground: this window is the dev server) --------------------
call npx vite --host --port 6969 --open

rem -- Tidy up ---------------------------------------------------------------
echo.
echo   shutting the relay down...
if defined RELAY_PID taskkill /f /t /pid %RELAY_PID% >nul 2>&1
endlocal
