# Azure Secret Expiration Dashboard

Internal dashboard for tracking expiring Microsoft Entra app credentials, service principal credentials, and Azure Key Vault secrets/certificates.

The MVP uses synthetic fixture data first. It does not need Azure credentials to run locally.

## Quickstart

```bash
npm install
npm run db:migrate
npm run fixtures:sync
npm run dev
```

Open `http://localhost:3000`.

If you run `npm run build` while `npm run dev` is already running, restart the dev server before
testing forms again. Next dev and Next build both write to `.next`, so a live dev server can serve
stale asset paths after a production build.

## Local Reset

```bash
npm run db:reset
npm run fixtures:sync -- --verbose
npm test
```

## What It Stores

The app stores metadata only: resource names, source IDs, expiration dates, owner hints, local owner overrides, workflow status, and sync health.

It must never store secret values, certificate private keys, or raw Key Vault secret contents.

## Real Azure Setup

The Azure sync uses your local Azure CLI session. It reads metadata only and does not request Key Vault
secret values or certificate private keys.

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
- Key Vault secrets and certificates across enabled Azure CLI subscriptions.
- Current Key Vault versions only. Set `AZURE_KEYVAULT_INCLUDE_VERSIONS=true` to inventory every version.

Recommended read-only permissions:

- Microsoft Graph: application and service principal read access, plus owner read access if you want Entra owners.
- Azure RBAC or Key Vault access policy: vault list/read plus `secrets/list` and `certificates/list`.

Use `.env.example` as the configuration template. Do not commit `.env`.

For a focused rollout, set `AZURE_SUBSCRIPTION_IDS` and/or `AZURE_KEYVAULT_RESOURCE_IDS` before the first
real sync. If a vault is unreachable, the sync records a coverage gap and avoids marking unseen Key Vault
items as removed.
