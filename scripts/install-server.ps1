#requires -Version 5.1

$scriptPath = Join-Path $PSScriptRoot "install-windows-server.ps1"
& $scriptPath @args
exit $LASTEXITCODE
