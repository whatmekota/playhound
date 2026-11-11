# The Android toolchain for this PowerShell session only; see env.cmd.
# Use:  . .\android\env.ps1
$T = if ($env:PH_ANDROID_TOOLS) { $env:PH_ANDROID_TOOLS } else { 'F:\tools\android' }
$Tmp = if ($env:PH_ANDROID_TMP) { $env:PH_ANDROID_TMP } else { 'F:\tools\tmp\mobile' }

$env:JAVA_HOME = "$T\jdk-21"
$env:ANDROID_HOME = "$T\sdk"
$env:ANDROID_SDK_ROOT = "$T\sdk"
$env:GRADLE_USER_HOME = "$T\gradle"
$env:ANDROID_USER_HOME = "$T\user-home"
$env:ANDROID_AVD_HOME = "$T\user-home\avd"
$env:JAVA_TOOL_OPTIONS = "-Duser.home=$T\home -Djava.io.tmpdir=$Tmp"
$env:APPDATA = "$T\appdata"
$env:TEMP = $Tmp
$env:TMP = $Tmp
$env:npm_config_cache = "$Tmp\npm-cache"
$env:CAPACITOR_TELEMETRY = 'false'
$env:PATH = "$T\jdk-21\bin;$T\sdk\platform-tools;$T\sdk\cmdline-tools\latest\bin;$env:PATH"

foreach ($d in $env:GRADLE_USER_HOME, $env:ANDROID_AVD_HOME, "$T\home", $env:APPDATA, $Tmp) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
}
