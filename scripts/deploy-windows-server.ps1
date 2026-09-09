[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath,

  [string]$InstallRoot = "C:\ProgramData\AzureCertGui",
  [string]$ListenHost = "127.0.0.1",
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [string]$TaskName = "AzureCertGui",
  [string]$SyncTaskName = "AzureCertGui-Sync",
  [string]$SyncTime = "07:30",
  [bool]$UseManagedIdentity = $true,
  [bool]$RunInitialSync = $true,
  [string]$AzureCliLoginMode = "",
  [string]$AzureCliServicePrincipalAppId = "",
  [string]$AzureCliCertificatePath = ""
)

$ErrorActionPreference = "Stop"

function Get-ProcessEnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }
  if ($value -match '^\$\([^)]+\)$') {
    return $null
  }
  return $value.Trim()
}

function Require-ProcessEnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $value = Get-ProcessEnvironmentValue -Name $Name
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required deployment variable '$Name' is missing. Store it in Azure DevOps pipeline variables or a protected variable group."
  }
  return $value
}

function Add-OptionalRuntimeValue {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Values,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $value = Get-ProcessEnvironmentValue -Name $Name
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $Values[$Name] = $value
  }
}

function Quote-PowerShellString {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Write-RuntimeEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][hashtable]$Values
  )

  $lines = foreach ($entry in $Values.GetEnumerator() | Sort-Object Key) {
    "`$env:$($entry.Key) = $(Quote-PowerShellString ([string]$entry.Value))"
  }
  Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

function Protect-RuntimeDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  & icacls.exe $Path /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to protect runtime configuration directory: $Path"
  }
}

function Protect-CredentialDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  & icacls.exe $Path /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to protect Azure CLI certificate directory: $Path"
  }
}

function Stop-TaskIfPresent {
  param([Parameter(Mandatory = $true)][string]$Name)

  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $task) {
    return
  }
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
}

function Stop-ExistingAppProcesses {
  param([Parameter(Mandatory = $true)][string]$Root)

  $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Backup-Database {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$BackupRoot
  )

  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    return $null
  }

  $backupPath = Join-Path $BackupRoot (Get-Date -Format "yyyyMMdd-HHmmss")
  New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
  foreach ($suffix in @("", "-wal", "-shm")) {
    $source = "$DatabasePath$suffix"
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Copy-Item -LiteralPath $source -Destination $backupPath -Force
    }
  }
  return $backupPath
}

function Register-AppTask {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$ScriptPath
  )

  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Register-SyncTask {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$At
  )

  $parsedTime = [DateTime]::ParseExact($At, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $trigger = New-ScheduledTaskTrigger -Daily -At $parsedTime
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Wait-ForHealth {
  param([Parameter(Mandatory = $true)][string]$Uri)

  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      # The process may still be starting. The final attempt reports the useful failure.
    }
    Start-Sleep -Seconds 2
  }
  throw "Azure Cert GUI did not become healthy at $Uri."
}

if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Container)) {
  throw "Deployment artifact directory was not found: $ArtifactPath"
}

$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -notmatch "Windows Server 2022") {
  throw "This deployment is restricted to Windows Server 2022. Detected: $($os.Caption)"
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($node)) {
  throw "Node.js 22 is required on the preprovisioned Windows Server 2022 target."
}
$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -notmatch '^v22\.') {
  throw "Node.js 22 is required on the target. Detected: $nodeVersion"
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($npm)) {
  throw "npm is required on the preprovisioned Windows Server 2022 target."
}

$az = $null
$configuredAzureCliPath = Get-ProcessEnvironmentValue -Name "AZURE_CLI_PATH"
if ($configuredAzureCliPath -and (Test-Path -LiteralPath $configuredAzureCliPath)) {
  $az = Get-Command $configuredAzureCliPath -ErrorAction SilentlyContinue
}
if (-not $az) {
  $az = Get-Command az.cmd -ErrorAction SilentlyContinue
}
if (-not $az) {
  $az = Get-Command az.exe -ErrorAction SilentlyContinue
}
if (-not $az) {
  throw "Azure CLI is required on the preprovisioned Windows Server 2022 target."
}

$tenantId = Require-ProcessEnvironmentValue -Name "AZURE_TENANT_ID"
$subscriptionIds = Require-ProcessEnvironmentValue -Name "AZURE_SUBSCRIPTION_IDS"
$authMode = Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__MODE"
if ($authMode -ne "oidc") {
  throw "Enterprise deployment requires AZURE_CERT_GUI__AUTH__MODE=oidc."
}

$configuredLoginMode = Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI_AZ_LOGIN_MODE"
$loginMode = if (-not [string]::IsNullOrWhiteSpace($AzureCliLoginMode)) {
  $AzureCliLoginMode.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($configuredLoginMode)) {
  $configuredLoginMode
} elseif ($UseManagedIdentity) {
  "managed-identity"
} else {
  "existing"
}
if ($loginMode -notin @("managed-identity", "existing", "service-principal-certificate")) {
  throw "Unsupported Azure CLI login mode '$loginMode'. Use managed-identity, existing, or service-principal-certificate."
}

$servicePrincipalAppId = $null
$certificateSourcePath = $null
if ($loginMode -eq "service-principal-certificate") {
  $servicePrincipalAppId = if (-not [string]::IsNullOrWhiteSpace($AzureCliServicePrincipalAppId)) {
    $AzureCliServicePrincipalAppId.Trim()
  } else {
    Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI_SP_APP_ID"
  }
  $certificateSourcePath = if (-not [string]::IsNullOrWhiteSpace($AzureCliCertificatePath)) {
    $AzureCliCertificatePath.Trim()
  } else {
    Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI_SP_CERTIFICATE_PATH"
  }
  if (-not (Test-Path -LiteralPath $certificateSourcePath -PathType Leaf)) {
    throw "The Azure service principal certificate file was not found."
  }
  $certificateText = Get-Content -LiteralPath $certificateSourcePath -Raw
  if ($certificateText -notmatch "-----BEGIN CERTIFICATE-----" -or
      $certificateText -notmatch "-----BEGIN (?:PRIVATE KEY|RSA PRIVATE KEY)-----") {
    throw "The Azure service principal certificate file must contain a PEM certificate and private key."
  }
}

$requiredAuthValues = @(
  "AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY",
  "AZURE_CERT_GUI__AUTH__OIDC__CLIENTID",
  "AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET",
  "AZURE_CERT_GUI__AUTH__COOKIESECRET"
)
foreach ($name in $requiredAuthValues) {
  [void](Require-ProcessEnvironmentValue -Name $name)
}

$groupValues = @(
  (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS"),
  (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0"),
  (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS"),
  (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0"),
  (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS"),
  (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if ($groupValues.Count -eq 0) {
  throw "At least one Entra OIDC role group variable is required."
}

$dataPath = Join-Path $InstallRoot "data\azure-cert-gui.sqlite"
$backupRoot = Join-Path $InstallRoot "backups"
$runtimeRoot = Join-Path $InstallRoot "current\.runtime"
$credentialRoot = Join-Path $InstallRoot "credentials"
$releasesRoot = Join-Path $InstallRoot "releases"
$currentRoot = Join-Path $InstallRoot "current"
$releaseName = "release-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
$releaseRoot = Join-Path $releasesRoot $releaseName

New-Item -ItemType Directory -Path $InstallRoot, $releasesRoot, $backupRoot, (Join-Path $InstallRoot "data") -Force | Out-Null
Stop-TaskIfPresent -Name $TaskName
Stop-TaskIfPresent -Name $SyncTaskName
Stop-ExistingAppProcesses -Root $InstallRoot
$databaseBackup = Backup-Database -DatabasePath $dataPath -BackupRoot $backupRoot
if ($databaseBackup) {
  Write-Host "Database backup created at $databaseBackup"
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item -Path (Join-Path $ArtifactPath "*") -Destination $releaseRoot -Recurse -Force

if (Test-Path -LiteralPath $currentRoot) {
  $previousRoot = Join-Path $releasesRoot ("previous-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
  Move-Item -LiteralPath $currentRoot -Destination $previousRoot
}
Copy-Item -LiteralPath $releaseRoot -Destination $currentRoot -Recurse -Force

$runtimeRoot = Join-Path $currentRoot ".runtime"
New-Item -ItemType Directory -Path $runtimeRoot, (Join-Path $currentRoot "logs") -Force | Out-Null

Push-Location -LiteralPath $currentRoot
try {
  & $npm ci --omit=dev --ignore-scripts --no-audit
  if ($LASTEXITCODE -ne 0) {
    throw "Windows production dependency installation failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

$values = @{
  NODE_ENV = "production"
  UI_HOST = $ListenHost
  PORT = [string]$Port
  AZURE_CERT_GUI_DB_PATH = $dataPath
  AZURE_TENANT_ID = $tenantId
  AZURE_SUBSCRIPTION_IDS = $subscriptionIds
  AZURE_CERT_GUI__AUTH__MODE = $authMode
  AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY = Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY"
  AZURE_CERT_GUI__AUTH__OIDC__CLIENTID = Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__CLIENTID"
  AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET = Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET"
  AZURE_CERT_GUI__AUTH__COOKIESECRET = Require-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__AUTH__COOKIESECRET"
  AZURE_CERT_GUI__ROTATION__LIVEENABLED = (Get-ProcessEnvironmentValue -Name "AZURE_CERT_GUI__ROTATION__LIVEENABLED")
  AZURE_CERT_GUI_AZ_LOGIN_MODE = $loginMode
}

if ([string]::IsNullOrWhiteSpace($values.AZURE_CERT_GUI__ROTATION__LIVEENABLED)) {
  $values.AZURE_CERT_GUI__ROTATION__LIVEENABLED = "false"
}
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CLI_PATH"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_KEYVAULT_RESOURCE_IDS"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_GRAPH_INCLUDE_OWNERS"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_GRAPH_INCLUDE_OWNER_DIRECTORY"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_KEYVAULT_INCLUDE_VERSIONS"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__ROLESCLAIMTYPE"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS"
Add-OptionalRuntimeValue -Values $values -Name "AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0"

if ($loginMode -eq "service-principal-certificate") {
  New-Item -ItemType Directory -Path $credentialRoot -Force | Out-Null
  $certificateRuntimePath = Join-Path $credentialRoot "azure-cert-gui-login.pem"
  if ([IO.Path]::GetFullPath($certificateSourcePath) -ne [IO.Path]::GetFullPath($certificateRuntimePath)) {
    Copy-Item -LiteralPath $certificateSourcePath -Destination $certificateRuntimePath -Force
  }
  $values.AZURE_CERT_GUI_SP_APP_ID = $servicePrincipalAppId
  $values.AZURE_CERT_GUI_SP_CERTIFICATE_PATH = $certificateRuntimePath
  Protect-CredentialDirectory -Path $credentialRoot
}

Write-RuntimeEnvironment -Path (Join-Path $runtimeRoot "azure-cert-gui.env.ps1") -Values $values
Protect-RuntimeDirectory -Path $runtimeRoot

foreach ($entry in $values.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
}

$tsx = Join-Path $currentRoot "node_modules\tsx\dist\cli.mjs"
& $node $tsx (Join-Path $currentRoot "scripts\migrate.ts")
if ($LASTEXITCODE -ne 0) {
  throw "Database migration failed with exit code $LASTEXITCODE."
}

$startScript = Join-Path $currentRoot "scripts\start-windows-server.ps1"
$syncScript = Join-Path $currentRoot "scripts\run-azure-sync-windows.ps1"
Register-AppTask -Name $TaskName -ScriptPath $startScript
Register-SyncTask -Name $SyncTaskName -ScriptPath $syncScript -At $SyncTime
Start-ScheduledTask -TaskName $TaskName

Wait-ForHealth -Uri ("http://{0}:{1}/api/health" -f $ListenHost, $Port)

if ($RunInitialSync) {
  $syncStartedAt = Get-Date
  Start-ScheduledTask -TaskName $SyncTaskName
  $deadline = (Get-Date).AddMinutes(15)
  $hasStarted = $false
  do {
    Start-Sleep -Seconds 5
    $taskInfo = Get-ScheduledTaskInfo -TaskName $SyncTaskName
    $task = Get-ScheduledTask -TaskName $SyncTaskName
    $hasStarted = $taskInfo.LastRunTime -ge $syncStartedAt.AddSeconds(-5)
  } while ((-not $hasStarted -or $task.State -eq "Running") -and (Get-Date) -lt $deadline)

  if (-not $hasStarted) {
    throw "Initial Azure metadata sync task did not start within 15 minutes."
  }
  if ($task.State -eq "Running") {
    throw "Initial Azure metadata sync did not finish within 15 minutes."
  }
  if ($taskInfo.LastTaskResult -ne 0) {
    throw "Initial Azure metadata sync failed with task result $($taskInfo.LastTaskResult)."
  }
}

Write-Host "Azure Cert GUI deployed to $currentRoot"
Write-Host "Health check passed at http://$ListenHost`:$Port/api/health"
