#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

if command -v pwsh >/dev/null 2>&1; then
  exec pwsh "$script_dir/install-server.ps1" "$@"
fi

cat >&2 <<'EOF'
PowerShell 7 (pwsh) is required to run the cross-platform bootstrap.

Install it, then rerun this script:
  macOS:  brew install --cask powershell
  Debian/Ubuntu: install the Microsoft PowerShell package, then run pwsh
  RHEL/Fedora/SUSE: install the Microsoft PowerShell package, then run pwsh

You can also run the PowerShell entry point directly:
  pwsh ./scripts/install-server.ps1
EOF
exit 127
