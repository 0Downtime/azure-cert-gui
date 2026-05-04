import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/lib/db";
import {
  normalizeGraphApplications,
  normalizeKeyVaultCertificates,
  normalizeKeyVaultSecrets,
  normalizeServicePrincipals
} from "../src/lib/normalize";
import { clearCoverageForSource, recordCoverage, upsertCredentials } from "../src/lib/repository";

const verbose = process.argv.includes("--verbose");
const fixtureRoot = join(process.cwd(), "fixtures");

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
}

const db = openDatabase();
migrate(db);

const graphApps = normalizeGraphApplications(readJson("graph-applications.json"));
const servicePrincipals = normalizeServicePrincipals(readJson("service-principals.json"));
const keyVaultSecrets = normalizeKeyVaultSecrets(readJson("keyvault-secrets.json"));
const keyVaultCertificates = normalizeKeyVaultCertificates(readJson("keyvault-certificates.json"));

const results = [
  ["entra_application", graphApps] as const,
  ["service_principal", servicePrincipals] as const,
  ["key_vault_secret", keyVaultSecrets] as const,
  ["key_vault_certificate", keyVaultCertificates] as const
].map(([source, credentials]) => {
  clearCoverageForSource(source, db);
  const result = upsertCredentials(credentials, source, db);
  return { source, ...result };
});

recordCoverage(
  {
    source: "entra_application",
    tenantId: "tenant-fixture",
    resourceId: "graph-applications",
    resourceName: "Microsoft Graph applications",
    configured: true,
    reachable: true,
    itemsSeen: graphApps.length
  },
  db
);

recordCoverage(
  {
    source: "service_principal",
    tenantId: "tenant-fixture",
    resourceId: "graph-service-principals",
    resourceName: "Microsoft Graph service principals",
    configured: true,
    reachable: true,
    itemsSeen: servicePrincipals.length
  },
  db
);

recordCoverage(
  {
    source: "key_vault_secret",
    tenantId: "tenant-fixture",
    subscriptionId: "sub-fixture",
    resourceId: "/subscriptions/sub-fixture/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/kv-payments-prod",
    resourceName: "kv-payments-prod",
    configured: true,
    reachable: true,
    itemsSeen: keyVaultSecrets.length,
    itemsSkipped: 1,
    skipReason: "One synthetic secret has no expiration metadata"
  },
  db
);

recordCoverage(
  {
    source: "key_vault_certificate",
    tenantId: "tenant-fixture",
    subscriptionId: "sub-fixture",
    resourceId: "/subscriptions/sub-fixture/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/kv-shared-prod",
    resourceName: "kv-shared-prod",
    configured: true,
    reachable: true,
    itemsSeen: keyVaultCertificates.length
  },
  db
);

for (const result of results) {
  console.log(`${result.source}: ${result.seen} seen, ${result.changed} upserted`);
}

if (verbose) {
  console.log("Fixture sync complete. Sources inserted into source_coverage.");
}
