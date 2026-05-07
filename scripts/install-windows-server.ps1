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
  [string]$TaskName = "Azure Cert GUI",
  [switch]$ConfigureOidc,
  [ValidateSet("oidc", "hybrid")]
  [string]$AuthMode = "oidc",
  [string]$TenantId,
  [string]$OidcAppDisplayName = "Azure Cert GUI",
  [string]$ApplicationObjectId,
  [string]$ClientId,
  [ValidateRange(1, 120)]
  [int]$ClientSecretMonths = 12,
  [string]$PublicOrigin,
  [string]$ViewerGroupObjectId,
  [string]$ViewerGroupName = "Azure Cert GUI Viewers",
  [string]$OperatorGroupObjectId,
  [string]$OperatorGroupName = "Azure Cert GUI Operators",
  [string]$AdminGroupObjectId,
  [string]$AdminGroupName = "Azure Cert GUI Admins"
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
    $version = Get-AzureCliVersion -AzPath $az
    if ($version) {
      Write-Host "Azure CLI $version is already installed."
    } else {
      Write-Host "Azure CLI is already installed."
    }
    return
  }
  Install-MsiFromUri -Name "Azure CLI" -Uri "https://aka.ms/installazurecliwindowsx64"
}

function Get-AzureCliVersion {
  param([string]$AzPath)
  $versionJson = (& $AzPath version -o json 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($versionJson)) {
    return $null
  }
  try {
    $versionInfo = $versionJson | ConvertFrom-Json
    return $versionInfo.'azure-cli'
  } catch {
    return $null
  }
}

function Invoke-AzJson {
  param(
    [string[]]$Arguments,
    [switch]$AllowEmpty
  )
  $az = Get-ExecutablePath @("az.cmd", "az")
  if (-not $az) {
    throw "Azure CLI is not installed."
  }

  $output = (& $az @Arguments --only-show-errors --output json) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "az $($Arguments -join ' ') failed with code $LASTEXITCODE."
  }
  if ([string]::IsNullOrWhiteSpace($output)) {
    if ($AllowEmpty) {
      return $null
    }
    throw "az $($Arguments -join ' ') returned no JSON output."
  }
  return $output | ConvertFrom-Json
}

function Invoke-AzRestJson {
  param(
    [ValidateSet("GET", "POST", "PATCH")]
    [string]$Method,
    [string]$Uri,
    [hashtable]$Body
  )
  $arguments = @("rest", "--method", $Method, "--url", $Uri)
  $bodyPath = $null
  if ($Body) {
    $bodyPath = Join-Path $env:TEMP ("azure-cert-gui-graph-{0}.json" -f ([Guid]::NewGuid().ToString("N")))
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    [System.IO.File]::WriteAllText($bodyPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    $arguments += @("--headers", "Content-Type=application/json")
    $arguments += @("--body", "@$bodyPath")
  }
  try {
    return Invoke-AzJson -Arguments $arguments -AllowEmpty:($Method -eq "PATCH")
  } finally {
    if ($bodyPath -and (Test-Path $bodyPath)) {
      Remove-Item -Path $bodyPath -Force
    }
  }
}

function Ensure-AzureCliLogin {
  param([string]$RequestedTenantId)
  try {
    $account = Invoke-AzJson -Arguments @("account", "show")
  } catch {
    $loginArgs = @("login", "--allow-no-subscriptions")
    if (-not [string]::IsNullOrWhiteSpace($RequestedTenantId)) {
      $loginArgs += @("--tenant", $RequestedTenantId)
    }
    Write-Host "Azure CLI is not logged in. Starting az login..." -ForegroundColor Cyan
    Invoke-AzJson -Arguments $loginArgs | Out-Null
    $account = Invoke-AzJson -Arguments @("account", "show")
  }

  if (-not [string]::IsNullOrWhiteSpace($RequestedTenantId) -and
      -not [string]::Equals([string]$account.tenantId, $RequestedTenantId, [System.StringComparison]::OrdinalIgnoreCase)) {
    Invoke-AzJson -Arguments @("login", "--allow-no-subscriptions", "--tenant", $RequestedTenantId) | Out-Null
    $account = Invoke-AzJson -Arguments @("account", "show")
  }

  if ([string]::IsNullOrWhiteSpace([string]$account.tenantId)) {
    throw "Azure CLI did not return a tenant id. Sign in with a work or school Entra account."
  }
  return [string]$account.tenantId
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

function Get-RuntimeEnvPath {
  return Join-Path (Join-Path $AppRoot ".runtime") "azure-cert-gui.env.ps1"
}

function Read-RuntimeEnvValue {
  param(
    [string]$Path,
    [string]$Name
  )
  if (-not (Test-Path $Path)) {
    return $null
  }
  foreach ($line in Get-Content -Path $Path) {
    if ($line -match "^\s*`$env:$([regex]::Escape($Name))\s*=\s*'(.*)'\s*$") {
      return ($Matches[1] -replace "''", "'")
    }
    if ($line -match "^\s*`$env:$([regex]::Escape($Name))\s*=\s*`"(.*)`"\s*$") {
      return ($Matches[1] -replace '``"', '"')
    }
  }
  return $null
}

function New-SecretValue {
  param([int]$Bytes = 48)
  $buffer = New-Object byte[] ($Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($buffer)
}

function Write-RuntimeEnvFile {
  param([hashtable]$Values)
  $runtimeDir = Join-Path $AppRoot ".runtime"
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $path = Get-RuntimeEnvPath
  $lines = @(
    '$ErrorActionPreference = "Stop"',
    "# Local runtime environment generated by scripts/install-windows-server.ps1.",
    "# This file can contain secrets and is intentionally ignored by Git."
  )
  foreach ($key in ($Values.Keys | Sort-Object)) {
    $lines += "`$env:$key = $(Quote-PowerShellString ([string]$Values[$key]))"
  }
  Set-Content -Path $path -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
  return $path
}

function Test-IsLoopbackHost {
  param([string]$HostName)
  return $HostName -in @("localhost", "127.0.0.1", "::1", "[::1]")
}

function Format-UrlHost {
  param([string]$HostName)
  if ($HostName.Contains(":") -and -not ($HostName.StartsWith("[") -and $HostName.EndsWith("]"))) {
    return "[$HostName]"
  }
  return $HostName
}

function Resolve-PublicOrigin {
  if (-not [string]::IsNullOrWhiteSpace($PublicOrigin)) {
    return $PublicOrigin.TrimEnd("/")
  }
  $scheme = if (Test-IsLoopbackHost -HostName $UiHost) { "http" } else { "https" }
  return "{0}://{1}:{2}" -f $scheme, (Format-UrlHost -HostName $UiHost), $Port
}

function Join-UniqueStrings {
  param([string[]]$Values)
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $result = New-Object "System.Collections.Generic.List[string]"
  foreach ($value in $Values) {
    if (-not [string]::IsNullOrWhiteSpace($value) -and $seen.Add($value)) {
      $result.Add($value) | Out-Null
    }
  }
  return $result.ToArray()
}

function Get-GraphCollection {
  param([string]$Uri)
  $items = @()
  $next = $Uri
  while (-not [string]::IsNullOrWhiteSpace($next)) {
    $response = Invoke-AzRestJson -Method GET -Uri $next
    if ($null -ne $response.value) {
      $items += @($response.value)
    }
    $nextProperty = $response.PSObject.Properties["@odata.nextLink"]
    $next = if ($nextProperty) { [string]$nextProperty.Value } else { $null }
  }
  return $items
}

function Get-SingleGraphItemByPropertyValue {
  param(
    [string]$Collection,
    [string]$PropertyName,
    [string]$PropertyValue
  )
  $items = @(Get-GraphCollection -Uri "https://graph.microsoft.com/v1.0/$Collection")
  $matches = @($items | Where-Object {
    $candidate = $_.$PropertyName
    -not [string]::IsNullOrWhiteSpace([string]$candidate) -and
      [string]::Equals([string]$candidate, $PropertyValue, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($matches.Count -gt 1) {
    throw "Graph query '${Collection}.${PropertyName}=$PropertyValue' returned multiple objects."
  }
  if ($matches.Count -eq 0) {
    return $null
  }
  return $matches[0]
}

function Resolve-ExistingApplication {
  param(
    [string]$ObjectId,
    [string]$AppId,
    [string]$DisplayName,
    [string]$RedirectUri
  )
  if (-not [string]::IsNullOrWhiteSpace($ObjectId)) {
    Write-Host "Searching Entra application by object id $ObjectId..."
    return Invoke-AzRestJson -Method GET -Uri "https://graph.microsoft.com/v1.0/applications/$ObjectId"
  }

  if (-not [string]::IsNullOrWhiteSpace($AppId)) {
    Write-Host "Searching Entra application by client id $AppId..."
    $match = Get-SingleGraphItemByPropertyValue -Collection "applications" -PropertyName "appId" -PropertyValue $AppId
    if ($match) {
      return Invoke-AzRestJson -Method GET -Uri "https://graph.microsoft.com/v1.0/applications/$($match.id)"
    }
  }

  Write-Host "Searching Entra application by display name '$DisplayName'..."
  $displayNameMatch = Get-SingleGraphItemByPropertyValue -Collection "applications" -PropertyName "displayName" -PropertyValue $DisplayName
  if ($displayNameMatch) {
    return Invoke-AzRestJson -Method GET -Uri "https://graph.microsoft.com/v1.0/applications/$($displayNameMatch.id)"
  }

  Write-Host "Searching Entra applications by redirect URI..."
  $applications = @(Get-GraphCollection -Uri "https://graph.microsoft.com/v1.0/applications")
  $matches = @($applications | Where-Object {
    $web = $_.PSObject.Properties["web"]
    if (-not $web -or -not $web.Value -or -not $web.Value.redirectUris) {
      return $false
    }
    foreach ($candidate in @($web.Value.redirectUris)) {
      if ([string]::Equals([string]$candidate, $RedirectUri, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
    return $false
  })

  if ($matches.Count -gt 1) {
    $labels = ($matches | ForEach-Object { "$($_.displayName) ($($_.appId))" }) -join ", "
    throw "Redirect URI search matched multiple Entra applications: $labels. Re-run with -ClientId or -ApplicationObjectId."
  }
  if ($matches.Count -eq 1) {
    return Invoke-AzRestJson -Method GET -Uri "https://graph.microsoft.com/v1.0/applications/$($matches[0].id)"
  }
  return $null
}

function Ensure-OidcApplication {
  param(
    [string]$DisplayName,
    [string]$RedirectUri
  )
  $application = Resolve-ExistingApplication -ObjectId $ApplicationObjectId -AppId $ClientId -DisplayName $DisplayName -RedirectUri $RedirectUri
  if (-not $application) {
    Write-Host "Creating Entra application '$DisplayName'..."
    $application = Invoke-AzRestJson -Method POST -Uri "https://graph.microsoft.com/v1.0/applications" -Body @{
      displayName = $DisplayName
      signInAudience = "AzureADMyOrg"
      groupMembershipClaims = "SecurityGroup"
      web = @{
        redirectUris = @($RedirectUri)
        implicitGrantSettings = @{
          enableAccessTokenIssuance = $false
          enableIdTokenIssuance = $false
        }
      }
    }
  } else {
    Write-Host "Reusing Entra application '$($application.displayName)' ($($application.appId))."
  }

  $existingRedirects = @()
  if ($application.web -and $application.web.redirectUris) {
    $existingRedirects = @($application.web.redirectUris | ForEach-Object { [string]$_ })
  }
  $redirectUris = Join-UniqueStrings -Values (@($existingRedirects) + @($RedirectUri))
  Invoke-AzRestJson -Method PATCH -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)" -Body @{
    groupMembershipClaims = "SecurityGroup"
    web = @{
      redirectUris = $redirectUris
      implicitGrantSettings = @{
        enableAccessTokenIssuance = $false
        enableIdTokenIssuance = $false
      }
    }
  } | Out-Null

  return Invoke-AzRestJson -Method GET -Uri "https://graph.microsoft.com/v1.0/applications/$($application.id)"
}

function Ensure-ServicePrincipal {
  param([string]$AppId)
  $servicePrincipal = Get-SingleGraphItemByPropertyValue -Collection "servicePrincipals" -PropertyName "appId" -PropertyValue $AppId
  if ($servicePrincipal) {
    return $servicePrincipal
  }
  Write-Host "Creating enterprise application service principal..."
  return Invoke-AzRestJson -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals" -Body @{ appId = $AppId }
}

function New-GroupMailNickname {
  param([string]$DisplayName)
  $base = ($DisplayName.ToLowerInvariant() -replace "[^a-z0-9]", "")
  if ([string]::IsNullOrWhiteSpace($base)) {
    $base = "azurecertgui"
  }
  if ($base.Length -gt 48) {
    $base = $base.Substring(0, 48)
  }
  return "{0}{1}" -f $base, ([Guid]::NewGuid().ToString("N").Substring(0, 8))
}

function Ensure-SecurityGroup {
  param(
    [string]$ObjectId,
    [string]$DisplayName
  )
  if (-not [string]::IsNullOrWhiteSpace($ObjectId)) {
    return Invoke-AzRestJson -Method GET -Uri "https://graph.microsoft.com/v1.0/groups/$ObjectId"
  }

  $group = Get-SingleGraphItemByPropertyValue -Collection "groups" -PropertyName "displayName" -PropertyValue $DisplayName
  if ($group) {
    Write-Host "Reusing Entra group '$($group.displayName)' ($($group.id))."
    return $group
  }

  Write-Host "Creating Entra security group '$DisplayName'..."
  return Invoke-AzRestJson -Method POST -Uri "https://graph.microsoft.com/v1.0/groups" -Body @{
    displayName = $DisplayName
    mailEnabled = $false
    mailNickname = (New-GroupMailNickname -DisplayName $DisplayName)
    securityEnabled = $true
  }
}

function Ensure-ClientSecret {
  param([string]$AppObjectId)
  $runtimeEnvPath = Get-RuntimeEnvPath
  $existing = Read-RuntimeEnvValue -Path $runtimeEnvPath -Name "AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET"
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    Write-Host "Reusing OIDC client secret from $runtimeEnvPath."
    return $existing
  }

  $endDate = [DateTimeOffset]::UtcNow.AddMonths($ClientSecretMonths).ToString("o")
  $secret = Invoke-AzRestJson -Method POST -Uri "https://graph.microsoft.com/v1.0/applications/$AppObjectId/addPassword" -Body @{
    passwordCredential = @{
      displayName = "Azure Cert GUI bootstrap"
      endDateTime = $endDate
    }
  }
  if ([string]::IsNullOrWhiteSpace([string]$secret.secretText)) {
    throw "Graph did not return a client secret value."
  }
  return [string]$secret.secretText
}

function Configure-Oidc {
  Write-Step "Configuring Entra ID OIDC"
  $resolvedTenantId = Ensure-AzureCliLogin -RequestedTenantId $TenantId
  $origin = Resolve-PublicOrigin
  $redirectUri = "$origin/api/auth/callback"
  if (($origin -notmatch "^https://") -and ($origin -notmatch "^http://(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$")) {
    throw "OIDC redirect origins must use HTTPS unless they are localhost loopback. Pass -PublicOrigin https://<dns-name> for shared Windows Server access."
  }

  $application = Ensure-OidcApplication -DisplayName $OidcAppDisplayName -RedirectUri $redirectUri
  $servicePrincipal = Ensure-ServicePrincipal -AppId ([string]$application.appId)
  $viewerGroup = Ensure-SecurityGroup -ObjectId $ViewerGroupObjectId -DisplayName $ViewerGroupName
  $operatorGroup = Ensure-SecurityGroup -ObjectId $OperatorGroupObjectId -DisplayName $OperatorGroupName
  $adminGroup = Ensure-SecurityGroup -ObjectId $AdminGroupObjectId -DisplayName $AdminGroupName
  $clientSecret = Ensure-ClientSecret -AppObjectId ([string]$application.id)

  $cookieSecret = Read-RuntimeEnvValue -Path (Get-RuntimeEnvPath) -Name "AZURE_CERT_GUI__AUTH__COOKIESECRET"
  if ([string]::IsNullOrWhiteSpace($cookieSecret)) {
    $cookieSecret = New-SecretValue
  }

  $values = @{
    AZURE_CERT_GUI__AUTH__MODE = $AuthMode
    AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION = $(if ($AuthMode -eq "hybrid") { "true" } else { "false" })
    AZURE_CERT_GUI__AUTH__COOKIESECRET = $cookieSecret
    AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY = "https://login.microsoftonline.com/$resolvedTenantId/v2.0"
    AZURE_CERT_GUI__AUTH__OIDC__CLIENTID = [string]$application.appId
    AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET = $clientSecret
    AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0 = [string]$viewerGroup.id
    AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0 = [string]$operatorGroup.id
    AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0 = [string]$adminGroup.id
  }
  $runtimeEnvPath = Write-RuntimeEnvFile -Values $values

  Write-Host "OIDC authority:      $($values.AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY)"
  Write-Host "OIDC client id:      $($values.AZURE_CERT_GUI__AUTH__OIDC__CLIENTID)"
  Write-Host "OIDC redirect URI:   $redirectUri"
  Write-Host "Enterprise app id:   $($servicePrincipal.id)"
  Write-Host "Runtime env file:    $runtimeEnvPath"
  Write-Host "Role groups:"
  Write-Host "  Viewer:   $($viewerGroup.displayName) ($($viewerGroup.id))"
  Write-Host "  Operator: $($operatorGroup.displayName) ($($operatorGroup.id))"
  Write-Host "  Admin:    $($adminGroup.displayName) ($($adminGroup.id))"
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

`$runtimeEnvPath = Join-Path $(Quote-PowerShellString (Join-Path $AppRoot ".runtime")) "azure-cert-gui.env.ps1"
if (Test-Path `$runtimeEnvPath) {
  . `$runtimeEnvPath
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

if ($ConfigureOidc) {
  if ($SkipAzureCli) {
    throw "-ConfigureOidc requires Azure CLI. Remove -SkipAzureCli or install Azure CLI before running."
  }
  Configure-Oidc
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
