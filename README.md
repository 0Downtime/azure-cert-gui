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

Real collectors are not implemented yet. The planned permissions are read-only:

- Microsoft Graph application/service principal read access.
- Azure Key Vault secret/certificate list and metadata read access.

Use `.env.example` as the configuration template. Do not commit `.env`.
