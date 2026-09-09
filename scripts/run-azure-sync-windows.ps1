$ErrorActionPreference = "Stop"

$releaseRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $releaseRoot

$runtimeEnvPath = Join-Path $releaseRoot ".runtime\azure-cert-gui.env.ps1"
if (-not (Test-Path -LiteralPath $runtimeEnvPath -PathType Leaf)) {
  throw "Runtime environment file was not found: $runtimeEnvPath"
}
. $runtimeEnvPath

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($node)) {
  throw "Node.js was not found on PATH."
}

$az = $null
if (-not [string]::IsNullOrWhiteSpace($env:AZURE_CLI_PATH) -and (Test-Path -LiteralPath $env:AZURE_CLI_PATH)) {
  $az = Get-Command $env:AZURE_CLI_PATH -ErrorAction SilentlyContinue
}
if (-not $az) {
  $az = Get-Command az.cmd -ErrorAction SilentlyContinue
}
if (-not $az) {
  $az = Get-Command az.exe -ErrorAction SilentlyContinue
}
if (-not $az) {
  throw "Azure CLI was not found."
}

if ($env:AZURE_CERT_GUI_AZ_LOGIN_MODE -eq "managed-identity") {
  $loginArgs = @("login", "--identity", "--allow-no-subscriptions", "--only-show-errors")
  if (-not [string]::IsNullOrWhiteSpace($env:AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID)) {
    $loginArgs += @("--username", $env:AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID)
  }
  & $az.Source @loginArgs *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI managed-identity login failed for the Windows Server runtime account."
  }
} elseif ($env:AZURE_CERT_GUI_AZ_LOGIN_MODE -eq "existing") {
  & $az.Source account show --only-show-errors *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "The configured existing Azure CLI login is not available to the Windows Server runtime account."
  }
} elseif ($env:AZURE_CERT_GUI_AZ_LOGIN_MODE -eq "service-principal-certificate") {
  if ([string]::IsNullOrWhiteSpace($env:AZURE_CERT_GUI_SP_APP_ID)) {
    throw "AZURE_CERT_GUI_SP_APP_ID is required for service-principal-certificate login."
  }
  if ([string]::IsNullOrWhiteSpace($env:AZURE_CERT_GUI_SP_CERTIFICATE_PATH)) {
    throw "AZURE_CERT_GUI_SP_CERTIFICATE_PATH is required for service-principal-certificate login."
  }
  if (-not (Test-Path -LiteralPath $env:AZURE_CERT_GUI_SP_CERTIFICATE_PATH -PathType Leaf)) {
    throw "The Azure service principal certificate file was not found."
  }
  if ([string]::IsNullOrWhiteSpace($env:AZURE_TENANT_ID)) {
    throw "AZURE_TENANT_ID is required for service-principal-certificate login."
  }

  $loginArgs = @(
    "login",
    "--service-principal",
    "--username", $env:AZURE_CERT_GUI_SP_APP_ID,
    "--certificate", $env:AZURE_CERT_GUI_SP_CERTIFICATE_PATH,
    "--tenant", $env:AZURE_TENANT_ID,
    "--allow-no-subscriptions",
    "--only-show-errors"
  )
  & $az.Source @loginArgs *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI service-principal certificate login failed for the Windows Server runtime account."
  }
} else {
  throw "Unsupported Azure CLI login mode. Use managed-identity, existing, or service-principal-certificate."
}

$logs = Join-Path $releaseRoot "logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$logPath = Join-Path $logs ("sync-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$tsx = Join-Path $releaseRoot "node_modules\tsx\dist\cli.mjs"

& $node $tsx (Join-Path $releaseRoot "scripts\sync-azure.ts") --verbose *>&1 |
  Tee-Object -FilePath $logPath
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  throw "Azure metadata sync failed with exit code $exitCode. See $logPath"
}
