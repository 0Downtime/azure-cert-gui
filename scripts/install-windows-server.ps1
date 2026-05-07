#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [ValidatePattern("^\d+$")]
  [string]$NodeMajorVersion = "22",
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [string]$UiHost = "127.0.0.1",
  [string]$DatabasePath,
  [switch]$SkipSystemDependencies,
  [switch]$SkipAzureCli,
  [switch]$SkipNpmInstall,
  [switch]$SkipBuild,
  [switch]$LoadFixtures,
  [switch]$SyncAzure,
  [switch]$InstallLogonTask,
  [switch]$Start,
  [string]$TaskName = "Azure Cert GUI"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Windows {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This bootstrap script is intended for Windows Server."
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Enable-Tls12 {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

function Update-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $paths = @()
  if ($machinePath) { $paths += $machinePath }
  if ($userPath) { $paths += $userPath }
  $nodePath = Join-Path $env:ProgramFiles "nodejs"
  if ((Test-Path $nodePath) -and ($paths -notcontains $nodePath)) {
    $paths = @($nodePath) + $paths
  }
  $env:Path = ($paths -join ";")
}

function Get-ExecutablePath {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }
  return $null
}

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  Write-Host "Running: $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') exited with code $LASTEXITCODE."
  }
}

function Install-MsiFromUri {
  param(
    [string]$Name,
    [string]$Uri
  )
  $tempDir = Join-Path $env:TEMP "azure-cert-gui-bootstrap"
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $msiPath = Join-Path $tempDir "$($Name -replace '[^a-zA-Z0-9.-]', '-').msi"

  Write-Host "Downloading $Name from $Uri"
  Invoke-WebRequest -Uri $Uri -OutFile $msiPath -UseBasicParsing

  Write-Host "Installing $Name"
  $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $msiPath, "/qn", "/norestart") -Wait -PassThru
  if (($process.ExitCode -ne 0) -and ($process.ExitCode -ne 3010)) {
    throw "$Name installer exited with code $($process.ExitCode)."
  }
  if ($process.ExitCode -eq 3010) {
    Write-Warning "$Name requested a reboot. Continue after reboot if a later step fails."
  }
  Update-ProcessPath
}

function Get-NodeMajor {
  $node = Get-ExecutablePath @("node.exe", "node")
  if (-not $node) {
    return $null
  }
  $versionText = & $node --version 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  if ($versionText -match "^v(\d+)\.") {
    return [int]$Matches[1]
  }
  return $null
}

function Get-LatestNodeMsiUri {
  param([string]$MajorVersion)
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
  foreach ($release in $index) {
    $files = @($release.files)
    if (($release.version -like "v$MajorVersion.*") -and ($files -contains "win-x64-msi")) {
      return "https://nodejs.org/dist/$($release.version)/node-$($release.version)-x64.msi"
    }
  }
  throw "Could not find a Node.js v$MajorVersion Windows x64 MSI release."
}

function Ensure-Node {
  $major = Get-NodeMajor
  if ($major -eq [int]$NodeMajorVersion) {
    $node = Get-ExecutablePath @("node.exe", "node")
    $nodeVersion = & $node --version
    Write-Host "Node.js $nodeVersion is already installed."
    return
  }

  $uri = Get-LatestNodeMsiUri -MajorVersion $NodeMajorVersion
  Install-MsiFromUri -Name "Node.js $NodeMajorVersion" -Uri $uri

  $major = Get-NodeMajor
  if ($major -ne [int]$NodeMajorVersion) {
    throw "Node.js v$NodeMajorVersion was not available on PATH after installation."
  }
}

function Ensure-AzureCli {
  $az = Get-ExecutablePath @("az.cmd", "az")
  if ($az) {
    $version = & $az version --query '"azure-cli"' -o tsv 2>$null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Azure CLI $version is already installed."
    } else {
      Write-Host "Azure CLI is already installed."
    }
    return
  }
  Install-MsiFromUri -Name "Azure CLI" -Uri "https://aka.ms/installazurecliwindowsx64"
}

function Get-NpmPath {
  $npm = Get-ExecutablePath @("npm.cmd", "npm")
  if (-not $npm) {
    throw "npm was not found on PATH after Node.js setup."
  }
  return $npm
}

function Invoke-Npm {
  param([string[]]$Arguments)
  $npm = Get-NpmPath
  Push-Location $AppRoot
  try {
    Invoke-Checked -Command $npm -Arguments $Arguments
  } finally {
    Pop-Location
  }
}

function Resolve-AppPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return Join-Path $AppRoot "data\azure-cert-gui.sqlite"
  }
  if ([IO.Path]::IsPathRooted($PathValue)) {
    return [IO.Path]::GetFullPath($PathValue)
  }
  return [IO.Path]::GetFullPath((Join-Path $AppRoot $PathValue))
}

function Quote-PowerShellString {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Write-RunHelper {
  param(
    [string]$ResolvedDatabasePath,
    [int]$ResolvedPort,
    [string]$ResolvedHost
  )

  $runtimeDir = Join-Path $AppRoot ".runtime"
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $helperPath = Join-Path $runtimeDir "start-azure-cert-gui.ps1"
  $nodePath = Join-Path $env:ProgramFiles "nodejs"

  $content = @"
`$ErrorActionPreference = "Stop"
Set-Location $(Quote-PowerShellString $AppRoot)

`$nodePath = $(Quote-PowerShellString $nodePath)
if (Test-Path `$nodePath) {
  `$env:Path = "`$nodePath;`$env:Path"
}

`$env:AZURE_CERT_GUI_DB_PATH = $(Quote-PowerShellString $ResolvedDatabasePath)
if (-not `$env:AZURE_CERT_GUI__AUTH__MODE) {
  `$env:AZURE_CERT_GUI__AUTH__MODE = "local"
}
if ((`$env:AZURE_CERT_GUI__AUTH__MODE -eq "local") -and (-not `$env:AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION)) {
  `$env:AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION = "true"
}
`$env:UI_HOST = $(Quote-PowerShellString $ResolvedHost)
`$env:PORT = $(Quote-PowerShellString ([string]$ResolvedPort))

& npm.cmd run ui
if (`$LASTEXITCODE -ne 0) {
  exit `$LASTEXITCODE
}
"@

  Set-Content -Path $helperPath -Value $content -Encoding UTF8
  return $helperPath
}

function Assert-AzureLogin {
  $az = Get-ExecutablePath @("az.cmd", "az")
  if (-not $az) {
    throw "Azure CLI is not installed."
  }
  & $az account show --only-show-errors 1>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI is installed, but no account is logged in. Run 'az login' and rerun this script with -SyncAzure."
  }
}

function Register-AppLogonTask {
  param(
    [string]$HelperPath,
    [string]$Name
  )
  $powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $powerShellPath -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$HelperPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Description "Start Azure Cert GUI at user logon." -Force | Out-Null
}

Assert-Windows
Enable-Tls12

$AppRoot = [IO.Path]::GetFullPath($AppRoot)
if (-not (Test-Path (Join-Path $AppRoot "package.json"))) {
  throw "AppRoot does not look like the Azure Cert GUI repository root: $AppRoot"
}

$resolvedDatabasePath = Resolve-AppPath -PathValue $DatabasePath

Write-Step "Preparing Azure Cert GUI under $AppRoot"

if (-not $SkipSystemDependencies) {
  $nodeReady = ((Get-NodeMajor) -eq [int]$NodeMajorVersion)
  $azureCliReady = ($SkipAzureCli -or [bool](Get-ExecutablePath @("az.cmd", "az")))
  if ((-not $nodeReady -or -not $azureCliReady) -and -not (Test-IsAdministrator)) {
    throw "Run this script from an elevated PowerShell session so it can install missing system dependencies, or pass -SkipSystemDependencies when Node.js and Azure CLI are already installed."
  }

  Write-Step "Installing system dependencies"
  Ensure-Node
  if (-not $SkipAzureCli) {
    Ensure-AzureCli
  }
} else {
  Write-Step "Skipping system dependency installation"
}

Write-Step "Installing npm dependencies"
if (-not $SkipNpmInstall) {
  Invoke-Npm -Arguments @("ci")
} else {
  Write-Host "Skipped npm dependency install."
}

Write-Step "Migrating SQLite database"
$env:AZURE_CERT_GUI_DB_PATH = $resolvedDatabasePath
Invoke-Npm -Arguments @("run", "db:migrate")

if ($LoadFixtures) {
  Write-Step "Loading fixture data"
  Invoke-Npm -Arguments @("run", "db:reset")
  $env:AZURE_CERT_GUI_DB_PATH = $resolvedDatabasePath
  Invoke-Npm -Arguments @("run", "fixtures:sync", "--", "--verbose")
}

if ($SyncAzure) {
  Write-Step "Syncing live Azure metadata"
  Assert-AzureLogin
  Invoke-Npm -Arguments @("run", "sync:azure", "--", "--verbose")
}

if (-not $SkipBuild) {
  Write-Step "Building the app"
  Invoke-Npm -Arguments @("run", "build")
}

Write-Step "Writing Windows run helper"
$helperPath = Write-RunHelper -ResolvedDatabasePath $resolvedDatabasePath -ResolvedPort $Port -ResolvedHost $UiHost
Write-Host "Run helper: $helperPath"

if ($InstallLogonTask) {
  Write-Step "Registering scheduled logon task"
  Register-AppLogonTask -HelperPath $helperPath -Name $TaskName
  Write-Host "Registered scheduled task: $TaskName"
}

Write-Step "Bootstrap complete"
Write-Host "Database: $resolvedDatabasePath"
Write-Host "UI host:  $UiHost"
Write-Host "UI port:  $Port"
Write-Host "Start UI: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$helperPath`""

if ($Start) {
  Write-Step "Starting Azure Cert GUI"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helperPath
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
