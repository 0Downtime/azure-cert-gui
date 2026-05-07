# Contributing

Azure Cert GUI is an alpha local-first operator tool. Keep changes small, auditable, and safe for public review.

## Development Setup

```bash
npm install
npm run db:reset
npm run fixtures:sync -- --verbose
npm run dev
```

Use fixture data for most UI and repository work. Use live Azure sync only when the change specifically needs real Azure metadata behavior.

## Validation

Run the standard checks before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
npm audit
```

If `gitleaks` is installed locally, also run:

```bash
gitleaks detect --source . --redact --no-banner
```

## Security-Sensitive Changes

Changes touching auth, OIDC, server actions, Azure CLI calls, rotation behavior, or repository persistence need extra care:

- Preserve deny-by-default OIDC role mapping.
- Keep live Azure rotations behind `AZURE_CERT_GUI__ROTATION__LIVEENABLED=true`.
- Do not store secret values, certificate private keys, Key Vault secret values, or one-time Entra `secretText`.
- Record the authenticated actor for mutating workflow events.
- Prefer fixture-driven tests unless live Azure behavior is essential.

## Pull Requests

Include a short summary, validation commands, and any security or migration notes. If a change introduces or changes environment variables, update `.env.example` and `README.md` in the same PR.
