# Changelog

All notable changes to Azure Cert GUI will be documented here.

## Unreleased

- Fixed Windows deployment rebuilding the app on the target: deployed releases now start from the CI-built `.next` output via `AZURE_CERT_GUI_SKIP_BUILD`.
- Windows deploy now rolls back to the previous release when migration or the health check fails, and prunes old releases.
- Windows scheduled tasks no longer inherit the 72-hour execution limit, so the web server keeps running.
- Windows deploy requires Node.js 22.13 or newer (needed for `node:sqlite`).
- Added optional `AZURE_CERT_GUI__AUTH__OIDC__PUBLICORIGIN` to pin the OIDC redirect origin behind a reverse proxy.
- Deployment pipeline now passes variables through task `env` instead of interpolating them into inline PowerShell.
- Added OIDC access control with Viewer, Operator, and Admin role mapping.
- Added same-origin and operator checks for mutating dashboard actions.
- Added explicit opt-in for live Azure rotations through `AZURE_CERT_GUI__ROTATION__LIVEENABLED`.
- Added authenticated actor attribution for renewal and status audit events.
- Added public repository documentation for security, contribution, and release notes.
