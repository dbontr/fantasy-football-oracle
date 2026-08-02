#requires -Version 5.1
param(
  [ValidateSet('run','start','stop','restart','status','install','uninstall','smoke')]
  [string]$Action = 'status',
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$TaskName = 'Fantasy Football Oracle',
  [string]$RuntimeDir = '',
  [int]$Port = 8787,
  [int]$WaitSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
if ($RuntimeDir) {
  $RuntimeDir = [IO.Path]::GetFullPath($RuntimeDir)
} else {
  $RuntimeDir = Join-Path $RepoRoot 'data\runtime'
}
$ServiceDir = Join-Path $RuntimeDir 'service'
$PidPath = Join-Path $ServiceDir 'oracle.pid'
$StdoutPath = Join-Path $ServiceDir 'oracle.out.log'
$StderrPath = Join-Path $ServiceDir 'oracle.err.log'
$EnvPath = Join-Path $RepoRoot '.env.local'
$ScriptPath = $MyInvocation.MyCommand.Path

function Import-OracleEnvironment {
  if (Test-Path -LiteralPath $EnvPath) {
    foreach ($line in Get-Content -LiteralPath $EnvPath) {
      if ($line -match '^\s*$' -or $line -match '^\s*#') { continue }
      if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        throw "Invalid environment entry in ${EnvPath}: $line"
      }
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and $value[0] -eq '"' -and $value[-1] -eq '"') {
        $value = $value.Substring(1, $value.Length - 2)
      }
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

function Set-OracleDefaults {
  if (-not $env:NODE_ENV) { $env:NODE_ENV = 'production' }
  if (-not $env:HOST) { $env:HOST = '0.0.0.0' }
  if (-not $env:PORT) { $env:PORT = [string]$Port }
  if (-not $env:ORACLE_NATIVE_REQUIRED) { $env:ORACLE_NATIVE_REQUIRED = 'true' }
  if (-not $env:ORACLE_STRICT_ARTIFACT_INTEGRITY) {
    $env:ORACLE_STRICT_ARTIFACT_INTEGRITY = 'true'
  }
  if (-not $env:ORACLE_RUNTIME_DIR) {
    $env:ORACLE_RUNTIME_DIR = $RuntimeDir
  }
  if (-not $env:ORACLE_PLATFORM_RUNTIME_DIR) {
    $env:ORACLE_PLATFORM_RUNTIME_DIR = Join-Path $env:ORACLE_RUNTIME_DIR 'platform'
  }
}

function Get-OracleProcess {
  if (-not (Test-Path -LiteralPath $PidPath)) { return $null }
  $rawPid = (Get-Content -LiteralPath $PidPath -Raw).Trim()
  $processId = 0
  if (-not [int]::TryParse($rawPid, [ref]$processId)) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  $expected = [Regex]::Escape((Join-Path $RepoRoot 'server\index.js'))
  if (-not $process -or $process.CommandLine -notmatch $expected) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return $null
  }
  return $process
}

function Test-OracleReady {
  try {
    $effectivePort = if ($env:PORT) { [int]$env:PORT } else { $Port }
    $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$effectivePort/api/ready" `
      -TimeoutSec 3 -UseBasicParsing
    return $ready.ready -eq $true
  } catch {
    return $false
  }
}

function Wait-OracleReady {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    if (Test-OracleReady) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "Oracle did not become ready within $WaitSeconds seconds"
}

function Invoke-OracleDoctor {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  & $node (Join-Path $RepoRoot 'scripts\oracle-doctor.js') --strict --json
  if ($LASTEXITCODE -ne 0) { throw "Oracle doctor failed with exit code $LASTEXITCODE" }
}

function Invoke-Run {
  New-Item -ItemType Directory -Path $ServiceDir -Force | Out-Null
  Import-OracleEnvironment
  Set-OracleDefaults
  Set-Location $RepoRoot
  Invoke-OracleDoctor
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node `
    -ArgumentList @((Join-Path $RepoRoot 'server\index.js')) `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $PidPath -Value $process.Id -NoNewline
  try {
    $process.WaitForExit()
    exit $process.ExitCode
  } finally {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Start {
  Import-OracleEnvironment
  Set-OracleDefaults
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { throw "Scheduled task '$TaskName' is not installed" }
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName }
  Wait-OracleReady
  Write-Output "Oracle is ready on port $env:PORT"
}

function Invoke-Stop {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
  }
  $process = Get-OracleProcess
  if ($process) {
    Stop-Process -Id $process.ProcessId -Force
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 250
    }
  }
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  Write-Output 'Oracle is stopped'
}

function Invoke-Status {
  Import-OracleEnvironment
  Set-OracleDefaults
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $process = Get-OracleProcess
  [ordered]@{
    installed = [bool]$task
    taskState = if ($task) { [string]$task.State } else { 'Missing' }
    processId = if ($process) { $process.ProcessId } else { $null }
    ready = Test-OracleReady
    port = [int]$env:PORT
    repoRoot = $RepoRoot
    stdoutLog = $StdoutPath
    stderrLog = $StderrPath
  } | ConvertTo-Json
}

function Invoke-Install {
  New-Item -ItemType Directory -Path $ServiceDir -Force | Out-Null
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $ScriptPath),
    '-Action', 'run',
    '-RepoRoot', ('"{0}"' -f $RepoRoot),
    '-TaskName', ('"{0}"' -f $TaskName),
    '-RuntimeDir', ('"{0}"' -f $RuntimeDir),
    '-Port', [string]$Port
  ) -join ' '
  $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user `
    -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName `
    -Action $taskAction -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Strict Fantasy Football Oracle service' `
    -Force | Out-Null
  Write-Output "Installed scheduled task '$TaskName' for $user"
  Invoke-Start
}

function Invoke-Uninstall {
  Invoke-Stop
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Output "Uninstalled scheduled task '$TaskName'"
}

function Invoke-Smoke {
  Import-OracleEnvironment
  Set-OracleDefaults
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  & $node (Join-Path $RepoRoot 'scripts\smoke-production.js') `
    --base "http://127.0.0.1:$env:PORT" --strict
  if ($LASTEXITCODE -ne 0) { throw "Production smoke failed with exit code $LASTEXITCODE" }
}

switch ($Action) {
  'run' { Invoke-Run }
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'restart' { Invoke-Stop; Invoke-Start }
  'status' { Invoke-Status }
  'install' { Invoke-Install }
  'uninstall' { Invoke-Uninstall }
  'smoke' { Invoke-Smoke }
}
