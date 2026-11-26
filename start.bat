@echo off
setlocal
title playhound
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  playhound launcher
rem
rem    start.bat           the desktop app from THIS checkout, as it is now
rem                        (whatever branch is checked out), with live reload:
rem                        Vite on 6969 + Electron, which also serves the
rem                        EroScripts proxy (7071) and the remote relay (7072).
rem                        Closing the app window stops it all.
rem    start.bat built     the built app (release\win-unpacked, from the last
rem                        pnpm app:build) or the installed one, as before.
rem    start.bat browser   the app in your browser: Vite on 6969, and
rem                        es-proxy.mjs (7071 + 7072) in its own minimised window.
rem ---------------------------------------------------------------------------

rem  (No goto/labels: this file has LF line endings, and cmd mis-seeks labels in those.)
set "MODE=dev"
if /i "%~1"=="built" set "MODE=built"
if /i "%~1"=="browser" set "MODE=browser"

rem -- The built or installed app -----------------------------------------------
set "PH_EXE="
if "%MODE%"=="built" if exist "%~dp0release\win-unpacked\playhound.exe" set "PH_EXE=%~dp0release\win-unpacked\playhound.exe"
if "%MODE%"=="built" if not defined PH_EXE if exist "%LOCALAPPDATA%\Programs\playhound\playhound.exe" set "PH_EXE=%LOCALAPPDATA%\Programs\playhound\playhound.exe"
if "%MODE%"=="built" if not defined PH_EXE (
  echo   [x] no built or installed app found. Run pnpm app:build, or start.bat without "built".
  pause
  exit /b 1
)
if defined PH_EXE (
  echo   starting the built desktop app: %PH_EXE%
  start "" "%PH_EXE%"
  endlocal
  exit /b 0
)

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

rem -- Which code this is -----------------------------------------------------
for /f "usebackq tokens=*" %%B in (`git branch --show-current 2^>nul`) do echo   branch   %%B
for /f "usebackq tokens=*" %%V in (`node -p "require('./package.json').version"`) do echo   version  %%V (as package.json says; unreleased changes on top)
echo.

rem -- Anything still holding the ports? --------------------------------------
rem  An installed playhound left running holds all three, and a relay left over
rem  from a previous run keeps 7072: say so rather than failing quietly.
set PORT_BUSY=
for %%P in (6969 7071 7072) do (
  netstat -ano -p tcp | findstr /r /c:"LISTENING" | findstr /c:":%%P " >nul 2>&1
  if not errorlevel 1 (
    echo   [!] port %%P is already in use - is playhound running in another window?
    set PORT_BUSY=1
  )
)
if defined PORT_BUSY echo.

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

rem -- The desktop app from this checkout (foreground) -------------------------
rem  One node process runs Vite and Electron; closing the window ends both.
if "%MODE%"=="dev" (
  node desktop\dev.mjs
  endlocal
  exit /b 0
)

rem -- The browser flow: relay + EroScripts proxy, then Vite ------------------
rem  Keep the PID: taskkill's WINDOWTITLE filter does not match minimised
rem  console windows, so killing by title leaves the relay running.
set RELAY_PID=
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "(Start-Process node -ArgumentList 'es-proxy.mjs' -WorkingDirectory '%CD%' -WindowStyle Minimized -PassThru).Id"`) do set RELAY_PID=%%p
if not defined RELAY_PID echo   [!] could not start the relay - the phone remote and CYD will not connect.

call npx vite --host --port 6969 --open

rem -- Tidy up ---------------------------------------------------------------
echo.
echo   shutting the relay down...
if defined RELAY_PID taskkill /f /t /pid %RELAY_PID% >nul 2>&1
endlocal
