# Azure Secret Expiration Dashboard

Internal dashboard for tracking expiring Microsoft Entra app credentials, service principal credentials, and Azure Key Vault secrets, certificates, and keys.

The MVP uses synthetic fixture data first. It does not need Azure credentials to run locally.

## Quickstart

```bash
npm install
npm run local:azure
```

Open `http://localhost:3000`.

For demo data instead of your current Azure CLI tenant/subscription:

```bash
npm run local:fixtures
```

If you run `npm run build` while `npm run dev` is already running, restart the dev server before
testing forms again. Next dev and Next build both write to `.next`, so a live dev server can serve
stale asset paths after a production build.

## Local Reset

```bash
npm run db:reset
npm run fixtures:sync -- --verbose
npm test
```

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
npm run schedule:launchagent > ~/Library/LaunchAgents/com.local.azure-secret-dashboard.sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.azure-secret-dashboard.sync.plist
launchctl kickstart -k gui/$(id -u)/com.local.azure-secret-dashboard.sync
```

By default the generated LaunchAgent runs at 7:30 AM. Set `SYNC_HOUR` and `SYNC_MINUTE`
when generating the file to use a different local time.

In the dashboard:

- Use the `Inventory` tab for daily triage: quick queues, filters, row selection, bulk owner assignment, status updates, and credential table actions.
- Use the `Renewals` tab for active renewal cases and actionable credentials due within 90 days. Open the shared detail drawer there to create a case, track owner handoff/reminders/escalation, dry-run or run a modal-confirmed rotation, and validate or close the case.
- Use the `Owners` tab to review, add, export, and remove manual owner mappings, or copy the current owner-gap worklist.
- Use the `Coverage & Audit` tab to confirm Graph and Key Vault syncs are reachable, current, and not skipping metadata, and to copy inventory TSV, status audit TSV, source coverage JSON, and owner mapping TSV.
- In `Inventory`, use `Copy unknowns` to copy a tab-separated worklist of rows that still need owner mapping.
- In `Inventory`, select rows and use `Copy renewal request`, `Copy owner packets`, or `Copy by owner` to generate owner-facing rotation drafts and owner-grouped renewal worklists.

## What It Stores

The app stores metadata only: resource names, source IDs, expiration dates, owner hints, local owner overrides, workflow status, renewal case metadata, and sync health.

It must never store secret values, certificate private keys, raw Key Vault secret contents, or one-time Entra `secretText` values. Rotation output values are shown once in the browser so the operator can copy them, then discarded.

V1 intentionally does not remove, disable, or delete old credentials. Use the renewal case validation and close steps to record owner confirmation first; old credential cleanup should be added later as a separate typed-confirmation action.

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
- Azure RBAC or Key Vault access policy: vault list/read plus `secrets/list`, `certificates/list`, and `keys/list`.

Use `.env.example` as the configuration template. Do not commit `.env`.

For a focused rollout, set `AZURE_SUBSCRIPTION_IDS` and/or `AZURE_KEYVAULT_RESOURCE_IDS` before the first
real sync. If a vault is unreachable, the sync records a coverage gap and avoids marking unseen Key Vault
items as removed.
