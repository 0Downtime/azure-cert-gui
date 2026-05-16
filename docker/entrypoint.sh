#!/usr/bin/env sh
set -eu

mkdir -p "$(dirname "${AZURE_CERT_GUI_DB_PATH:-/tmp/azure-cert-gui.sqlite}")"

if [ "${AZURE_CERT_GUI_AZ_LOGIN_ON_STARTUP:-auto}" != "false" ]; then
  if [ "${AZURE_CERT_GUI_AZ_LOGIN_ON_STARTUP:-auto}" = "true" ] || [ -n "${IDENTITY_ENDPOINT:-}" ] || [ -n "${MSI_ENDPOINT:-}" ]; then
    if [ -n "${AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID:-}" ]; then
      az login --identity --client-id "$AZURE_CERT_GUI_MANAGED_IDENTITY_CLIENT_ID" --allow-no-subscriptions >/dev/null
    else
      az login --identity --allow-no-subscriptions >/dev/null
    fi
  fi
fi

exec "$@"
