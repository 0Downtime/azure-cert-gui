import { migrate, openDatabase } from "../src/lib/db";
import {
  type AzureVault,
  azureSyncConfigFromEnv,
  collectGraphApplications,
  collectKeyVaultCertificates,
  collectKeyVaultSecrets,
  collectServicePrincipals,
  currentTenantId,
  listKeyVaults,
  parseAzureResourceId
} from "../src/lib/azure-cli";
import {
  normalizeGraphApplications,
  normalizeKeyVaultCertificates,
  normalizeKeyVaultSecrets,
  normalizeServicePrincipals
} from "../src/lib/normalize";
import { clearCoverageForSource, recordCoverage, upsertCredentials } from "../src/lib/repository";
import type { InventorySource, NormalizedCredential } from "../src/types";

const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose");
const graphOnly = args.has("--graph-only");
const keyVaultOnly = args.has("--keyvault-only");
const skipGraph = keyVaultOnly;
const skipKeyVault = graphOnly;

if (args.has("--help")) {
  console.log(`Usage: npm run sync:azure -- [--verbose] [--graph-only|--keyvault-only]

Uses the current Azure CLI login to sync metadata only:
- Microsoft Graph application/service principal credentials
- Azure Key Vault secret/certificate metadata

Configure scope with AZURE_SUBSCRIPTION_IDS and AZURE_KEYVAULT_RESOURCE_IDS.`);
  process.exit(0);
}

if (graphOnly && keyVaultOnly) {
  console.error("Choose either --graph-only or --keyvault-only, not both.");
  process.exit(1);
}

const db = openDatabase();
migrate(db);

async function main(): Promise<void> {
  const config = azureSyncConfigFromEnv();
  const tenantId = await currentTenantId(config).catch(() => config.tenantId);

  if (!skipGraph) {
    await syncGraphSource("entra_application", "Microsoft Graph applications", async () =>
      normalizeGraphApplications(await collectGraphApplications(config))
    );
    await syncGraphSource("service_principal", "Microsoft Graph service principals", async () =>
      normalizeServicePrincipals(await collectServicePrincipals(config))
    );
  }

  if (!skipKeyVault) {
    await syncKeyVaultSources(config, tenantId);
  }
}

async function syncGraphSource(
  source: "entra_application" | "service_principal",
  resourceName: string,
  collect: () => Promise<NormalizedCredential[]>
): Promise<void> {
  clearCoverageForSource(source, db);
  try {
    const credentials = await collect();
    const result = upsertCredentials(credentials, source, db);
    recordCoverage(
      {
        source,
        tenantId: credentials[0]?.sourceTenantId ?? null,
        resourceId: source === "entra_application" ? "graph-applications" : "graph-service-principals",
        resourceName,
        configured: true,
        reachable: true,
        itemsSeen: result.seen,
        itemsSkipped: credentials.filter((credential) => !credential.expiresAt).length,
        skipReason: credentials.some((credential) => !credential.expiresAt)
          ? "Some credentials have no expiration metadata"
          : null
      },
      db
    );
    console.log(`${source}: ${result.seen} seen, ${result.changed} upserted`);
  } catch (error) {
    recordCoverage(
      {
        source,
        resourceId: source === "entra_application" ? "graph-applications" : "graph-service-principals",
        resourceName,
        configured: true,
        reachable: false,
        itemsSeen: 0,
        errorCode: error instanceof Error ? error.name : "GraphSyncError",
        skipReason: error instanceof Error ? error.message : String(error)
      },
      db
    );
    console.error(`${source}: failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncKeyVaultSources(
  config: ReturnType<typeof azureSyncConfigFromEnv>,
  fallbackTenantId: string | null
): Promise<void> {
  clearCoverageForSource("key_vault_secret", db);
  clearCoverageForSource("key_vault_certificate", db);
  let vaults: AzureVault[];
  try {
    vaults = await listKeyVaults(config);
  } catch (error) {
    recordCoverageFailure("key_vault_secret", "keyvault-list", "Azure Key Vault discovery", error);
    recordCoverageFailure("key_vault_certificate", "keyvault-list", "Azure Key Vault discovery", error);
    console.error(`key_vault: failed to list vaults: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const allSecrets = [];
  const allCertificates = [];
  let secretFailures = 0;
  let certificateFailures = 0;

  if (vaults.length === 0) {
    const resourceId = `keyvault-discovery:${config.subscriptionIds.join(",") || "default"}`;
    const skipReason = "No Key Vaults discovered in the configured subscription scope";
    recordCoverage(
      {
        source: "key_vault_secret",
        tenantId: fallbackTenantId,
        resourceId,
        resourceName: "No Key Vaults discovered",
        configured: true,
        reachable: true,
        itemsSeen: 0,
        skipReason
      },
      db
    );
    recordCoverage(
      {
        source: "key_vault_certificate",
        tenantId: fallbackTenantId,
        resourceId,
        resourceName: "No Key Vaults discovered",
        configured: true,
        reachable: true,
        itemsSeen: 0,
        skipReason
      },
      db
    );
  }

  for (const vault of vaults) {
    const coverage = vaultCoverage(vault, fallbackTenantId);
    try {
      const secrets = normalizeKeyVaultSecrets(await collectKeyVaultSecrets(vault, config));
      allSecrets.push(...secrets);
      recordCoverage(
        {
          ...coverage,
          source: "key_vault_secret",
          itemsSeen: secrets.length,
          itemsSkipped: secrets.filter((secret) => !secret.expiresAt).length,
          skipReason: keyVaultCoverageNote("secrets", secrets, config)
        },
        db
      );
      if (verbose) console.log(`key_vault_secret:${coverage.resourceName}: ${secrets.length} seen`);
    } catch (error) {
      secretFailures += 1;
      recordCoverageFailure("key_vault_secret", coverage.resourceId, coverage.resourceName, error, coverage);
    }

    try {
      const certificates = normalizeKeyVaultCertificates(await collectKeyVaultCertificates(vault, config));
      allCertificates.push(...certificates);
      recordCoverage(
        {
          ...coverage,
          source: "key_vault_certificate",
          itemsSeen: certificates.length,
          itemsSkipped: certificates.filter((certificate) => !certificate.expiresAt).length,
          skipReason: keyVaultCoverageNote("certificates", certificates, config)
        },
        db
      );
      if (verbose) console.log(`key_vault_certificate:${coverage.resourceName}: ${certificates.length} seen`);
    } catch (error) {
      certificateFailures += 1;
      recordCoverageFailure("key_vault_certificate", coverage.resourceId, coverage.resourceName, error, coverage);
    }
  }

  const secretResult = upsertCredentials(allSecrets, "key_vault_secret", db, {
    markMissingRemoved: secretFailures === 0
  });
  const certificateResult = upsertCredentials(allCertificates, "key_vault_certificate", db, {
    markMissingRemoved: certificateFailures === 0
  });

  console.log(
    `key_vault_secret: ${secretResult.seen} seen, ${secretResult.changed} upserted${
      secretFailures ? `, ${secretFailures} vault failures` : ""
    }`
  );
  console.log(
    `key_vault_certificate: ${certificateResult.seen} seen, ${certificateResult.changed} upserted${
      certificateFailures ? `, ${certificateFailures} vault failures` : ""
    }`
  );
}

function keyVaultCoverageNote(
  label: "secrets" | "certificates",
  credentials: NormalizedCredential[],
  config: ReturnType<typeof azureSyncConfigFromEnv>
): string {
  const notes = [
    config.includeKeyVaultVersions
      ? "All Key Vault versions included"
      : "Current Key Vault versions only; set AZURE_KEYVAULT_INCLUDE_VERSIONS=true for version history"
  ];
  if (credentials.some((credential) => !credential.expiresAt)) {
    notes.unshift(`Some ${label} have no expiration metadata`);
  }
  return notes.join("; ");
}

function vaultCoverage(vault: AzureVault, fallbackTenantId: string | null) {
  const id = vault.id ?? "unknown-vault";
  const parsed = id === "unknown-vault" ? null : parseAzureResourceId(id);
  return {
    tenantId: vault.properties?.tenantId ?? fallbackTenantId,
    subscriptionId: parsed?.subscriptionId ?? null,
    resourceId: id,
    resourceName: vault.name ?? parsed?.name ?? id,
    configured: true,
    reachable: true
  };
}

function recordCoverageFailure(
  source: InventorySource,
  resourceId: string,
  resourceName: string,
  error: unknown,
  base?: ReturnType<typeof vaultCoverage>
): void {
  recordCoverage(
    {
      ...base,
      source,
      resourceId,
      resourceName,
      configured: true,
      reachable: false,
      itemsSeen: 0,
      errorCode: error instanceof Error ? error.name : "AzureSyncError",
      skipReason: error instanceof Error ? error.message : String(error)
    },
    db
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
