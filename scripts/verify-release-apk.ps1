param(
  [Parameter(Mandatory=$true)][string]$Apk,
  [string]$BuildTools,
  [switch]$AllowUnsigned
)
$ErrorActionPreference = 'Stop'
$artifactPath = (Resolve-Path -LiteralPath $Apk).Path
if (!$BuildTools) {
  $sdkPath = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
  if (!$sdkPath) { throw 'Set ANDROID_HOME or pass -BuildTools.' }
  $BuildTools = (Get-ChildItem -LiteralPath (Join-Path $sdkPath 'build-tools') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
}
$aapt = Join-Path $BuildTools 'aapt.exe'
$badging = & $aapt dump badging $artifactPath
if ($LASTEXITCODE -ne 0) { throw 'aapt could not inspect the APK.' }
if ($badging -match 'application-debuggable') { throw 'APK is debuggable.' }
$manifest = & $aapt dump xmltree $artifactPath AndroidManifest.xml
if ($LASTEXITCODE -ne 0) { throw 'Manifest inspection failed.' }
foreach ($name in @('allowBackup', 'usesCleartextTraffic')) {
  if (!(($manifest | Select-String "android:$name\(").Line -match '0x0$')) { throw "$name is not explicitly disabled." }
}
$permissions = & $aapt dump permissions $artifactPath
if ($permissions -match 'READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE') { throw 'Unexpected shared-storage permission.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($artifactPath)
try {
  $bundles = @($zip.Entries | Where-Object { $_.FullName -match '\.(bundle|jsbundle)$' })
  if ($bundles.Count -ne 1 -or $bundles[0].FullName -ne 'assets/index.android.bundle') { throw 'Unexpected or duplicate JS bundle.' }
  if ($zip.Entries | Where-Object { $_.FullName -match '(\.map$|\.keystore$|\.jks$|\.env($|\.)|(^|/)mapping\.txt$|\.(ts|tsx|jsx)$)' }) { throw 'APK contains source/debug/signing material.' }
  $stream = $bundles[0].Open()
  try {
    $buffer = [IO.MemoryStream]::new(); $stream.CopyTo($buffer); $bytes = $buffer.ToArray(); $buffer.Dispose()
  } finally { $stream.Dispose() }
  # Hermes bytecode magic: little-endian 0x1F1903C103BC1FC6.
  if ([BitConverter]::ToString($bytes[0..7]) -ne 'C6-1F-BC-03-C1-03-19-1F') { throw 'Bundle is readable JS instead of Hermes bytecode.' }
  if ([Text.Encoding]::UTF8.GetString($bytes) -match 'nodereal\.io/v1/|BEGIN (RSA |EC |)PRIVATE KEY') { throw 'Embedded credential marker found.' }
} finally { $zip.Dispose() }
$signature = & (Join-Path $BuildTools 'apksigner.bat') verify --print-certs $artifactPath 2>&1
if ($LASTEXITCODE -ne 0) {
  if (!$AllowUnsigned) { throw 'APK is unsigned or has an invalid signature.' }
  Write-Host 'UNSIGNED review artifact: signing was not verified.'
} elseif ($signature -match 'CN=Android Debug') { throw 'APK uses the default debug signing certificate.' }
Write-Host 'Release APK verified: Hermes bundle, no source-map/signing files or known credential markers, non-debuggable, backups/cleartext/storage permissions disabled.'
$global:LASTEXITCODE = 0
