<h1 align="center">[Alpha] Azure Cert GUI</h1>

<p align="center">
  <img src="src/app/azure-cert-logo-light.png#gh-light-mode-only" alt="Azure Cert GUI" width="220" />
  <img src="src/app/azure-cert-logo-dark.png#gh-dark-mode-only" alt="Azure Cert GUI" width="220" />
</p>

<p align="center">
  <strong>Local-first credential-expiration workbench for Microsoft Entra and Azure Key Vault.</strong><br />
  Next.js operator UI, Azure CLI metadata sync, SQLite runtime state, and review-first renewal workflows.
</p>

<p align="center">
  <a href="#current-state">Current State</a> •
  <a href="#local-development">Local Development</a> •
  <a href="#windows-server-bootstrap">Windows Server</a> •
  <a href="#daily-use">Daily Use</a> •
  <a href="#real-azure-setup">Real Azure Setup</a> •
  <a href="#configuration">Configuration</a> •
  <a href="CONTRIBUTING.md">Contributing</a> •
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/repository-local--first-2f7d32" alt="Repository: local-first" />
  <img src="https://img.shields.io/badge/language-TypeScript-2f7d32" alt="Language: TypeScript" />
  <img src="https://img.shields.io/badge/package-v0.1.0-2f7d32" alt="Package Version: v0.1.0" />
  <img src="https://img.shields.io/badge/Next.js-15.5-2f7d32" alt="Next.js 15.5" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-2f7d32" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/license-MIT-2f7d32" alt="License: MIT" />
</p>

`Azure Cert GUI` is a local-first dashboard for tracking expiring Microsoft Entra app credentials, service principal credentials, and Azure Key Vault secrets, certificates, and keys.

> [!WARNING]
> [Alpha] This software is in active development and is intended for internal operator workflows first.
> Validate Azure permissions, sync scope, and renewal behavior against a non-production tenant or a tightly scoped subscription before relying on it for operational rotations.

## Current State

- The active implementation is a Next.js 15 and React 19 app with SQLite-backed runtime state through `node:sqlite`.
- The repository contains an operator-facing dashboard for credential triage, owner mapping, renewal case tracking, source coverage, audit exports, and UI-triggered Azure metadata refreshes.
- Local development can run entirely from synthetic fixture data, so Azure credentials are not required to try the dashboard.
- Real Azure sync and renewal actions use the current Azure CLI login. The app reads metadata by default and avoids collecting secret values or certificate private keys.
- Local development defaults to loopback-only operator mode. Shared or remotely reachable deployments should use OIDC with Entra group mappings for Viewer, Operator, and Admin access.
- Public repo guardrails include MIT licensing, contribution guidance, security reporting guidance, changelog tracking, CI, production dependency audit, and secret scanning.

## Goals

- Keep the product local-first, private, and practical for one operator or a small platform team.
- Make expiring credentials visible before adding automation-heavy behavior.
- Preserve owner handoff, dry-run rotation, typed confirmation, validation, and auditability as first-class capabilities.
- Treat source coverage gaps as visible operational data instead of silently hiding inaccessible Graph or Key Vault resources.

## Current Stack

- Runtime: Node.js 22+ with Next.js 15
- Operator UI: React 19 app router with server actions
- Frontend components: local TypeScript components plus `lucide-react` icons
- Runtime state: SQLite through `node:sqlite`
- Azure integration: Azure CLI commands for Microsoft Graph and Azure Resource Manager / Key Vault metadata
- Tests: Vitest unit coverage for normalization, risk buckets, repository behavior, Azure CLI parsing, and rotation guardrails
- Scheduling: generated macOS LaunchAgent for daily metadata sync

## App Shape

- `src/app`: Next.js app shell, server actions, route handlers, global styles, icons, and logo assets
- `src/components/dashboard.tsx`: main operator dashboard with inventory, renewals, owners, and coverage views
- `src/lib/azure-cli.ts`: Azure CLI collection layer for Graph, subscriptions, vaults, and Key Vault objects
- `src/lib/normalize.ts`: source-specific normalization into credential inventory records
- `src/lib/repository.ts`: SQLite persistence for inventory, owner overrides, status history, renewal cases, and coverage
- `src/lib/azure-rotation.ts`: guarded renewal actions for supported Azure credential types
- `scripts/*`: migration, fixture sync, live Azure sync, database reset, and LaunchAgent generation
- `fixtures/*`: synthetic Graph and Key Vault data for local demo runs

## What Works Today

- Inventory view for Entra applications, service principals, Key Vault secrets, certificates, and keys
- Risk buckets for expired, 30-day, 60-day, 90-day, long-range, and no-expiry credentials
- Daily triage filters, search, row selection, bulk owner assignment, status updates, and credential detail actions
- Renewal worklist with case creation, owner handoff metadata, reminders, escalation owner, validation, and close steps
- Dry-run and typed-confirmation renewal flow for supported Azure mutations
- Owner override management with export and copy-friendly worklists for unknown owners
- Coverage and audit view for Graph and Key Vault reachability, skipped metadata, current sync scope, and TSV / JSON exports
- Browser-triggered refresh that runs the Azure sync from the web UI and reports progress back to the dashboard

## Status

The MVP uses synthetic fixture data first. It does not need Azure credentials to run locally.

The app is not a general hosted service and does not include centralized secret storage or automated old-credential cleanup. V1 intentionally avoids removing, disabling, or deleting old credentials. Use renewal validation and case closure to record owner confirmation first; old credential cleanup should be added later as a separate typed-confirmation action.

The default `local` auth mode is intended for `localhost` / `127.0.0.1` development only. Use `oidc` before exposing the UI beyond a trusted local browser session.

Live Azure rotations are disabled by default even for Operators. Dry-run previews remain available, but non-dry-run rotations require `AZURE_CERT_GUI__ROTATION__LIVEENABLED=true`.

## Local Development

Install dependencies once:

```bash
npm install
```

Build only when the app has changed, then start the UI in loopback-only break-glass local mode:

```bash
AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION=true npm run ui
```

The command prints a clickable local URL such as `http://127.0.0.1:3000`. Set `PORT=3001` if you prefer a different starting port; if that port is busy, the script uses the next open one. Do not set `UI_HOST` to a non-loopback address when using local auth.

Start against your current Azure CLI tenant/subscription:

```bash
npm run local:azure
```

Open `http://localhost:3000`.

For demo data instead of live Azure metadata:

```bash
npm run local:fixtures
```

Reset local state, reload fixtures, and run tests:

```bash
npm run db:reset
npm run fixtures:sync -- --verbose
npm test
```

Run the standard verification commands:

```bash
npm run typecheck
npm test
npm run build
```

If you run `npm run build` while `npm run dev` is already running, restart the dev server before testing forms again. Next dev and Next build both write to `.next`, so a live dev server can serve stale asset paths after a production build.

## Windows Server Bootstrap

Run the Windows Server bootstrap from an elevated PowerShell session in a checkout of this repository:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\install-windows-server.ps1
```

The script installs Node.js 22 and Azure CLI when they are missing, runs `npm ci`, migrates the SQLite database, builds the app, and writes a local run helper at `.runtime\start-azure-cert-gui.ps1`.

Useful options:

```powershell
.\scripts\install-windows-server.ps1 -SyncAzure
.\scripts\install-windows-server.ps1 -LoadFixtures
.\scripts\install-windows-server.ps1 -InstallLogonTask
.\scripts\install-windows-server.ps1 -Start
```

By default the generated helper binds the UI to `127.0.0.1:3000` with local break-glass auth.

To provision Microsoft Entra ID OIDC for the current or requested Azure CLI tenant:

```powershell
.\scripts\install-windows-server.ps1 `
  -ConfigureOidc `
  -TenantId <tenant-id> `
  -PublicOrigin https://azure-cert-gui.contoso.com
```

`-ConfigureOidc` reuses an existing app registration by object id, client id, display name, or redirect URI, or creates a new app registration when none exists. It creates or reuses Viewer, Operator, and Admin security groups, enables security-group claims in the token, creates the enterprise app, creates a client secret when no local runtime secret exists, and writes the app runtime values to ignored `.runtime\azure-cert-gui.env.ps1`.

Use `-AuthMode hybrid` only when you want local loopback break-glass auth left available. Keep the default `-AuthMode oidc` before exposing the app beyond loopback.

## Daily Use

Refresh live Azure metadata and start the dashboard:

```bash
npm run local:azure
```

Run the sync without starting the UI:

```bash
npm run sync:azure -- --verbose
```

Schedule the sync daily on macOS:

```bash
mkdir -p logs ~/Library/LaunchAgents
npm run schedule:launchagent > ~/Library/LaunchAgents/com.local.azure-cert-gui.sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.azure-cert-gui.sync.plist
launchctl kickstart -k gui/$(id -u)/com.local.azure-cert-gui.sync
```

By default the generated LaunchAgent runs at 7:30 AM. Set `SYNC_HOUR` and `SYNC_MINUTE` when generating the file to use a different local time.

In the dashboard:

- Use `Refresh data` to run `sync:azure` from the web UI with the current Azure CLI login. The dashboard shows refresh progress, recent sync output, and a done or failed message when the run finishes.
- Use `Automatic refresh` to run the same sync on a fixed interval while the UI server process is running. The selected schedule and schedule events are stored in SQLite and restored when the app next handles schedule/status traffic, but the in-process timer is not a daemon replacement. For a schedule that runs without an open UI session or after machine restarts, use the macOS LaunchAgent option above.
- Use the `Inventory` tab for daily triage: quick queues, filters, row selection, bulk owner assignment, status updates, and credential table actions.
- Use the `Renewals` tab for active renewal cases and actionable credentials due within 90 days. Open the shared detail drawer there to create a case, track owner handoff/reminders/escalation, dry-run or run a modal-confirmed rotation, and validate or close the case.
- Use the `Owners` tab to review, add, export, and remove manual owner mappings, or copy the current owner-gap worklist.
- Use the `Coverage & Audit` tab to confirm Graph and Key Vault syncs are reachable, current, and not skipping metadata, and to copy inventory TSV, status audit TSV, source coverage JSON, and owner mapping TSV.
- In `Inventory`, use `Copy unknowns` to copy a tab-separated worklist of rows that still need owner mapping.
- In `Inventory`, select rows and use `Copy renewal request`, `Copy owner packets`, or `Copy by owner` to generate owner-facing rotation drafts and owner-grouped renewal worklists.

## Storage And Secret Handling

The app stores metadata only: resource names, source IDs, expiration dates, owner hints, local owner overrides, workflow status, renewal case metadata, and sync health.

It must never store secret values, certificate private keys, raw Key Vault secret contents, or one-time Entra `secretText` values. Rotation output values are shown once in the browser so the operator can copy them, then discarded.

Local SQLite files live under `data/` and are ignored by Git.

## Real Azure Setup

The Azure sync and renewal actions use your local Azure CLI session. Sync reads metadata only and does not request Key Vault secret values or certificate private keys. Renewal actions require typing the credential name before any Azure mutation runs.

```bash
az login
npm run db:migrate
npm run sync:azure -- --verbose
npm run dev
```

Useful scoped runs:

```bash
npm run sync:azure -- --graph-only
npm run sync:azure -- --keyvault-only
```

The default behavior scans:

- Microsoft Graph applications and service principals, including password/key credential metadata.
- Key Vault secrets, certificates, and keys across enabled Azure CLI subscriptions.
- Current Key Vault versions only by default. Set `AZURE_KEYVAULT_INCLUDE_VERSIONS=true` to inventory every version.
  The `Source coverage` panel records whether a sync used current-only or all-version Key Vault collection.

Recommended read-only permissions:

- Microsoft Graph: application and service principal read access, plus owner read access if you want Entra owners.
- Microsoft Graph user and group read access if you want owner autocomplete populated from Entra users and mail-enabled groups.
- Azure RBAC or Key Vault access policy: vault list/read plus `secrets/list`, `certificates/list`, and `keys/list`.

## OIDC Access Control

Azure Cert GUI uses the same role-mapping shape as SyncFactors: Viewer, Operator, and Admin roles are resolved from configured OIDC group claims, and unmatched users receive no access by default.

Use `local` mode only for local development:

```bash
AZURE_CERT_GUI__AUTH__MODE=local
```

When `NODE_ENV=production`, local or hybrid auth is rejected unless you explicitly set:

```bash
AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION=true
```

Only use that break-glass flag for trusted loopback runs bound to `127.0.0.1`. Do not expose local auth through a reverse proxy or a non-loopback listener.

For Microsoft Entra ID OIDC, configure:

```bash
AZURE_CERT_GUI__AUTH__MODE=oidc
AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY=https://login.microsoftonline.com/<tenant-id>/v2.0
AZURE_CERT_GUI__AUTH__OIDC__CLIENTID=<application-client-id>
AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET=<client-secret>
AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0=<entra-group-object-id>
AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0=<entra-group-object-id>
AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0=<entra-group-object-id>
```

The default callback path is `/api/auth/callback`. The app registration redirect URI must match the UI origin, for example `http://127.0.0.1:3000/api/auth/callback` for local testing or the exact HTTPS origin for shared deployments.

Role behavior:

- Viewer can load the dashboard and read refresh status.
- Operator can refresh Azure metadata, update workflow state, manage owners, and execute renewal rotations.
- Admin inherits Operator and Viewer access.
- Users with no configured group match are denied instead of falling back to Viewer.
- Live Azure rotation mutations also require `AZURE_CERT_GUI__ROTATION__LIVEENABLED=true`; dry runs remain available without that flag.

Optional session settings:

```bash
AZURE_CERT_GUI__AUTH__IDLETIMEOUTMINUTES=480
AZURE_CERT_GUI__AUTH__ABSOLUTESESSIONHOURS=168
AZURE_CERT_GUI__AUTH__COOKIESECRET=<32+ random bytes>
AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION=false
AZURE_CERT_GUI__AUTH__OIDC__ROLESCLAIMTYPE=groups
AZURE_CERT_GUI__ROTATION__LIVEENABLED=false
```

## Configuration

Use `.env.example` as the configuration template. Do not commit `.env`.

For a focused rollout, set `AZURE_SUBSCRIPTION_IDS` and/or `AZURE_KEYVAULT_RESOURCE_IDS` before the first real sync. If a vault is unreachable, the sync records a coverage gap and avoids marking unseen Key Vault items as removed.

Supported environment values:

- `AZURE_CERT_GUI_DB_PATH`: SQLite path. Defaults to `./data/azure-cert-gui.sqlite`.
- `AZURE_TENANT_ID`: optional tenant override. When blank, the Azure CLI current account tenant is used.
- `AZURE_SUBSCRIPTION_IDS`: optional comma-separated subscription IDs. When blank, enabled Azure CLI subscriptions are scanned.
- `AZURE_KEYVAULT_RESOURCE_IDS`: optional comma-separated Key Vault ARM resource IDs. When blank, vaults are discovered from subscriptions.
- `AZURE_GRAPH_INCLUDE_OWNERS`: defaults to `true`. Set `false` if Graph owner reads are not consented yet.
- `AZURE_GRAPH_INCLUDE_OWNER_DIRECTORY`: defaults to `true`. Set `false` if Graph user/group reads are not consented yet.
- `AZURE_KEYVAULT_INCLUDE_VERSIONS`: defaults to `false`. Current Key Vault secrets/certificates are usually enough for rotation tracking.
- `AZURE_CERT_GUI__AUTH__MODE`: `local`, `oidc`, or `hybrid`. `local` is loopback-only and intended for development.
- `AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY`: OIDC authority, such as an Entra tenant `/v2.0` URL.
- `AZURE_CERT_GUI__AUTH__OIDC__CLIENTID`: app registration client ID.
- `AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET`: app registration client secret. Use a secure store in real deployments.
- `AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0`, `OPERATORGROUPS__0`, `ADMINGROUPS__0`: Entra group object IDs mapped to app roles.
- `AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION`: defaults to `false`. Set `true` only for trusted loopback break-glass runs when `NODE_ENV=production` and auth mode is `local` or `hybrid`.
- `AZURE_CERT_GUI__ROTATION__LIVEENABLED`: defaults to `false`. Set `true` only when Operators should be allowed to perform non-dry-run Azure mutations.
