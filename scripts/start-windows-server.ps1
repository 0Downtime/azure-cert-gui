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
  throw "Node.js was not found on PATH. Install Node.js 22 on the Windows Server 2022 target."
}

$loginMode = $env:AZURE_CERT_GUI_AZ_LOGIN_MODE
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

if ($loginMode -eq "managed-identity") {
  if (-not $az) {
    throw "Azure CLI was not found. Install Azure CLI on the Windows Server 2022 target."
  }

  $loginArgs = @("login", "--identity", "--allow-no-subscriptions", "--only-show-errors")
  if (-not [string]::IsNullOrWhiteSpace($env:AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID)) {
    $loginArgs += @("--username", $env:AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID)
  }

  & $az.Source @loginArgs *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Azure CLI managed-identity login failed for the Windows Server runtime account."
  }
} elseif ($loginMode -eq "existing") {
  if (-not $az) {
    throw "Azure CLI was not found. Install Azure CLI on the Windows Server 2022 target."
  }
  & $az.Source account show --only-show-errors *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "The configured existing Azure CLI login is not available to the Windows Server runtime account."
  }
} else {
  throw "Unsupported AZURE_CERT_GUI_AZ_LOGIN_MODE '$loginMode'. Use managed-identity or existing."
}

$tsx = Join-Path $releaseRoot "node_modules\tsx\dist\cli.mjs"
$startScript = Join-Path $releaseRoot "scripts\build-and-start.mjs"
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
  throw "Runtime dependency tsx is missing from the deployed artifact: $tsx"
}
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
  throw "The production start script is missing from the deployed artifact: $startScript"
}

& $node $startScript
exit $LASTEXITCODE
