#requires -Version 5.1
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$RuntimeDir = '',
  [int]$Port = 0,
  [int]$WaitSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
if (-not $RuntimeDir) {
  $RuntimeDir = Join-Path ([IO.Path]::GetTempPath()) "oracle-service-test-$PID"
}
$RuntimeDir = [IO.Path]::GetFullPath($RuntimeDir)
if ($Port -le 0) { $Port = Get-Random -Minimum 18000 -Maximum 28000 }

$Manager = Join-Path $RepoRoot 'scripts\windows\oracle-service.ps1'
$TaskName = "Fantasy Football Oracle Test $PID"
$PidPath = Join-Path $RuntimeDir 'service\oracle.pid'
$ShutdownPath = Join-Path $RuntimeDir 'service\shutdown.request'
$StdoutPath = Join-Path $RuntimeDir 'service\oracle.out.log'
$StderrPath = Join-Path $RuntimeDir 'service\oracle.err.log'

function Invoke-Manager {
  param([string]$Action)
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
    -File $Manager -Action $Action -RepoRoot $RepoRoot `
    -TaskName $TaskName -RuntimeDir $RuntimeDir -Port $Port `
    -WaitSeconds $WaitSeconds -StopWaitSeconds 25
  if ($LASTEXITCODE -ne 0) {
    throw "Oracle service action '$Action' failed with exit code $LASTEXITCODE"
  }
}
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = [string]$Port
$env:ORACLE_RUNTIME_DIR = $RuntimeDir
$env:ORACLE_PLATFORM_RUNTIME_DIR = Join-Path $RuntimeDir 'platform'
$env:ORACLE_SHUTDOWN_REQUEST_PATH = $ShutdownPath
$env:ORACLE_NATIVE_REQUIRED = 'true'
$env:ORACLE_STRICT_ARTIFACT_INTEGRITY = 'true'

$arguments = @(
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', ('"{0}"' -f $Manager),
  '-Action', 'run',
  '-RepoRoot', ('"{0}"' -f $RepoRoot),
  '-TaskName', ('"{0}"' -f $TaskName),
  '-RuntimeDir', ('"{0}"' -f $RuntimeDir),
  '-Port', [string]$Port,
  '-WaitSeconds', [string]$WaitSeconds,
  '-StopWaitSeconds', '25'
) -join ' '
$runner = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList $arguments -WindowStyle Hidden -PassThru
$stopped = $false
$ready = $null

try {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    if ($runner.HasExited) {
      throw "Oracle service runner exited before readiness with code $($runner.ExitCode)"
    }
    try {
      $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ready" `
        -TimeoutSec 3 -UseBasicParsing
      if ($ready.ready -eq $true) { break }
    } catch {}
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if (-not $ready -or $ready.ready -ne $true) {
    throw "Oracle service did not become ready within $WaitSeconds seconds"
  }
  Invoke-Manager -Action 'smoke'
  $statusJson = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
    -File $Manager -Action status -RepoRoot $RepoRoot `
    -TaskName $TaskName -RuntimeDir $RuntimeDir -Port $Port
  if ($LASTEXITCODE -ne 0) { throw 'Oracle service status failed' }
  $status = $statusJson | ConvertFrom-Json
  if (-not $status.ready -or -not $status.processId) {
    throw 'Oracle service status did not report a ready managed process'
  }

  Invoke-Manager -Action 'stop'
  $stopped = $true
  if (-not $runner.WaitForExit(30000)) {
    throw 'Oracle service runner did not exit after graceful stop'
  }
  if ($runner.ExitCode -ne 0) {
    throw "Oracle service runner exited with code $($runner.ExitCode)"
  }
  if (Test-Path -LiteralPath $PidPath) { throw 'Oracle PID file was not removed' }
  if (Test-Path -LiteralPath $ShutdownPath) { throw 'Shutdown request was not removed' }
  [ordered]@{
    ok = $true
    port = $Port
    processId = $status.processId
    gracefulStop = $true
    runtimeDir = $RuntimeDir
  } | ConvertTo-Json
} catch {
  if (Test-Path -LiteralPath $StdoutPath) {
    Write-Error (Get-Content -LiteralPath $StdoutPath -Raw) -ErrorAction Continue
  }
  if (Test-Path -LiteralPath $StderrPath) {
    Write-Error (Get-Content -LiteralPath $StderrPath -Raw) -ErrorAction Continue
  }
  throw
} finally {
  if (-not $stopped) {
    try { Invoke-Manager -Action 'stop' } catch {}
  }
  if (-not $runner.HasExited) {
    Stop-Process -Id $runner.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $RuntimeDir -Recurse -Force -ErrorAction SilentlyContinue
}
