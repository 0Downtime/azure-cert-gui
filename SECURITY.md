# Security Policy

Azure Cert GUI works with credential metadata and can perform Azure mutations when explicitly enabled. Treat reports involving authorization bypass, stored secret values, unsafe Azure mutations, or tenant data disclosure as security issues.

## Supported Versions

The project is currently alpha. Security fixes target the `main` branch until tagged releases exist.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting when it is enabled for this repository. If that is not available yet, contact the maintainers through a private channel before opening a public issue.

Do not include real tenant IDs, subscription IDs, credential values, Key Vault secret values, one-time Entra `secretText` values, screenshots containing sensitive resource names, or exported local SQLite databases in public reports.

Useful reports include:

- The affected commit or version.
- Whether the app was running in `local`, `oidc`, or `hybrid` auth mode.
- Whether `AZURE_CERT_GUI__ROTATION__LIVEENABLED` was enabled.
- Minimal reproduction steps using fixtures when possible.
- The expected impact and any observed access level, such as Viewer, Operator, or Admin.

## Security Expectations

- Run shared deployments behind OIDC and restrict access with Entra groups.
- Keep `AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET` and `AZURE_CERT_GUI__AUTH__COOKIESECRET` out of Git.
- Keep live rotations disabled unless the operator workflow explicitly requires them.
- Do not commit `data/*.sqlite`, `.env`, Azure CLI tokens, or generated local runtime state.
