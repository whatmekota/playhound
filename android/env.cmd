@echo off
rem The Android toolchain for this shell only: JDK, SDK, Gradle and every
rem cache they keep live under one folder (F:\tools\android unless
rem PH_ANDROID_TOOLS says otherwise), so nothing lands in the user profile.
rem Nothing system-wide changes. Use:  call android\env.cmd
rem Then:  pnpm mobile:apk   (or pnpm mobile:sync, pnpm mobile:install)

if "%PH_ANDROID_TOOLS%"=="" set "PH_ANDROID_TOOLS=F:\tools\android"
if "%PH_ANDROID_TMP%"=="" set "PH_ANDROID_TMP=F:\tools\tmp\mobile"
set "T=%PH_ANDROID_TOOLS%"

set "JAVA_HOME=%T%\jdk-21"
set "ANDROID_HOME=%T%\sdk"
set "ANDROID_SDK_ROOT=%T%\sdk"
set "GRADLE_USER_HOME=%T%\gradle"
set "ANDROID_USER_HOME=%T%\user-home"
set "ANDROID_AVD_HOME=%T%\user-home\avd"
rem Java tools that write under user.home (Kotlin, lint, sdk tools) go here too.
set "JAVA_TOOL_OPTIONS=-Duser.home=%T%\home -Djava.io.tmpdir=%PH_ANDROID_TMP%"
rem The Capacitor CLI keeps its sysconfig.json under %APPDATA%.
set "APPDATA=%T%\appdata"
set "TEMP=%PH_ANDROID_TMP%"
set "TMP=%PH_ANDROID_TMP%"
set "npm_config_cache=%PH_ANDROID_TMP%\npm-cache"
set "CAPACITOR_TELEMETRY=false"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\cmdline-tools\latest\bin;%PATH%"
set "T="

if not exist "%GRADLE_USER_HOME%" mkdir "%GRADLE_USER_HOME%"
if not exist "%ANDROID_AVD_HOME%" mkdir "%ANDROID_AVD_HOME%"
if not exist "%PH_ANDROID_TOOLS%\home" mkdir "%PH_ANDROID_TOOLS%\home"
if not exist "%APPDATA%" mkdir "%APPDATA%"
if not exist "%PH_ANDROID_TMP%" mkdir "%PH_ANDROID_TMP%"
