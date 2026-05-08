import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execAzureCliJson } from "../src/lib/azure-command";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const JSON_BUFFER_BYTES = 1024 * 1024 * 20;
const DEFAULT_PREFIX = "Azure Cert GUI Seed";
const SEED_SECRET_PREFIX = "AZCGUI-SEED:";
const SEED_CERT_PREFIX = "AZCGUI-SEED-CERT:";
const SEED_PUBLIC_CERT_DER_BASE64 =
  "MIIDNTCCAh2gAwIBAgIUWW9kq/2QrwJ/fAUlMzPmm0PtGa4wDQYJKoZIhvcNAQELBQAwKjEoMCYGA1UEAwwfQXp1cmUgQ2VydCBHVUkgU2VlZCBDZXJ0aWZpY2F0ZTAeFw0yNjA1MDgwMTM3NDlaFw0zNjA1MDUwMTM3NDlaMCoxKDAmBgNVBAMMH0F6dXJlIENlcnQgR1VJIFNlZWQgQ2VydGlmaWNhdGUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDnz0VsdWZkdtS0Ej8kwvOoTvg4umewravhJ1EqiATF9Z9imbguxzvMPlT/s2Y6K6/T8Drr+KkFOn9hLAjsyLr18A5aURDxLQ+nI/MGocjHT8DaGRPi7WfTbI2+zM0TmaqZBL+0fA5xlS0S98AUTkln1r0hUC15o2Q7doTfu0j4jY4Q5H5I4McR2uLvVNqczUIqMk78/5XsmK6PIFVO8xKSHPsxn7JTJB1CDIhrycxbTxqb2XqwI3IVZjnOQNYSgEOViNnKaDhz+TB/Vtx2RxASeoO4rgzAjxD9jyEibC6c1N4q+SsYxuE+v+P2DJrHjn7naLFvn5INpwqtM3tJjz7tAgMBAAGjUzBRMB0GA1UdDgQWBBTJKY+SBV5Wu+NTscWZt3Gur7wXpzAfBgNVHSMEGDAWgBTJKY+SBV5Wu+NTscWZt3Gur7wXpzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCbuWZK12hT5SgHmoVVSKIhIU1mokHN7lI0RNcWrgrKJXQsG3ScU6qEtEvD6Mc761rDyrhOrAZfSzRUNYHuU3KWnIJR5Bindr5N4RiA/1lhJqFlMjitNFmg5yJzfYaFgHbPn8ygA25HiAnuTxFwrP1v8pfRD99Ix4sskmQAZybNoFycaPEFveqkaT4inru4gMRQSWWQAMQkoQWSP2XHklvINi3OiEpZuf2d5LzvaQ5Wcppc8RIH32GgSjQ17+uhkQ3BW+qKMzM/lm7jnUsfFOYvgR6xEgIPAFuMgJHYpEIbaZtE+bl3ev2tibpuWp7AWAb24pdEw0qt4KMDL4BzdxKp";
const execFileAsync = promisify(execFile);

type OwnerMode = "current_user" | "tagged" | "none";

interface Args {
  prefix: string;
  yes: boolean;
  cleanup: boolean;
  dryRun: boolean;
  syncAfter: boolean;
  preserveOwners: boolean;
  keyVaultName: string | null;
  keyVaultSubscription: string | null;
  verbose: boolean;
}

interface GraphListResponse<T> {
  value?: T[];
}

interface GraphApplication {
  id: string;
  appId: string;
  displayName: string;
  passwordCredentials?: GraphPasswordCredential[];
  keyCredentials?: GraphKeyCredential[];
  tags?: string[];
}

interface GraphServicePrincipal {
  id: string;
  appId: string;
  displayName: string;
  passwordCredentials?: GraphPasswordCredential[];
  keyCredentials?: GraphKeyCredential[];
  tags?: string[];
}

interface GraphPasswordCredential {
  keyId?: string | null;
  displayName?: string | null;
  endDateTime?: string | null;
}

interface AddPasswordResponse {
  keyId?: string | null;
  endDateTime?: string | null;
  secretText?: string | null;
}

interface GraphKeyCredential {
  keyId?: string | null;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  type?: string | null;
  usage?: string | null;
  key?: string | null;
}

interface DirectoryObject {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

interface SeedSecret {
  displayName: string;
  daysFromNow: number;
}

interface SeedCertificate {
  displayName: string;
  daysFromNow: number;
}

interface SeedScenario {
  nameSuffix: string;
  ownerMode: OwnerMode;
  ownerName?: string;
  ownerEmail?: string;
  rotationMode?: string;
  rotationModeReason?: string;
  appSecrets: SeedSecret[];
  appCertificates?: SeedCertificate[];
  servicePrincipalSecrets?: SeedSecret[];
  servicePrincipalCertificates?: SeedCertificate[];
}

interface AzureVault {
  id?: string | null;
  name?: string | null;
  resourceGroup?: string | null;
}

interface KeyVaultPolicy {
  issuerParameters?: {
    name?: string;
  };
  keyProperties?: {
    keyType?: string;
    keySize?: number;
    exportable?: boolean;
    reuseKey?: boolean;
  };
  secretProperties?: {
    contentType?: string;
  };
  x509CertificateProperties?: {
    subject?: string;
    validityInMonths?: number;
  };
  lifetimeActions?: Array<{
    action?: {
      actionType?: string;
    };
    trigger?: {
      daysBeforeExpiry?: number;
    };
  }>;
}

interface KeyVaultSeedKey {
  name: string;
  daysFromNow: number;
  ownerName: string;
  ownerEmail: string;
}

interface KeyVaultSeedCertificate {
  name: string;
  validityMonths: number;
  ownerName: string;
  ownerEmail: string;
}

let seededKeyVaultResourceId: string | null = null;

const scenarios: SeedScenario[] = [
  {
    nameSuffix: "01 Expired Unknown Owner",
    ownerMode: "none",
    appSecrets: [{ displayName: "expired-client-secret", daysFromNow: -14 }],
    appCertificates: [{ displayName: "expired-signing-certificate", daysFromNow: -10 }]
  },
  {
    nameSuffix: "02 Critical Current Owner",
    ownerMode: "current_user",
    appSecrets: [{ displayName: "current-owner-7-day-secret", daysFromNow: 7 }],
    appCertificates: [{ displayName: "current-owner-14-day-certificate", daysFromNow: 14 }]
  },
  {
    nameSuffix: "03 Tagged Owner",
    ownerMode: "tagged",
    ownerName: "Identity Automation",
    ownerEmail: "identity-automation@example.com",
    appSecrets: [{ displayName: "tagged-owner-25-day-secret", daysFromNow: 25 }],
    appCertificates: [{ displayName: "tagged-owner-35-day-certificate", daysFromNow: 35 }]
  },
  {
    nameSuffix: "04 Overlap Renewal",
    ownerMode: "tagged",
    ownerName: "Payments Platform",
    ownerEmail: "payments-platform@example.com",
    appSecrets: [
      { displayName: "old-overlap-secret-12-day", daysFromNow: 12 },
      { displayName: "replacement-overlap-secret-180-day", daysFromNow: 180 }
    ],
    appCertificates: [
      { displayName: "old-overlap-certificate-20-day", daysFromNow: 20 },
      { displayName: "replacement-overlap-certificate-210-day", daysFromNow: 210 }
    ]
  },
  {
    nameSuffix: "05 Coordinated High Risk",
    ownerMode: "tagged",
    ownerName: "Security Engineering",
    ownerEmail: "security-engineering@example.com",
    rotationMode: "coordinated_high_risk",
    rotationModeReason: "Synthetic high-risk credential for workflow testing",
    appSecrets: [{ displayName: "coordinated-45-day-secret", daysFromNow: 45 }],
    appCertificates: [{ displayName: "coordinated-60-day-certificate", daysFromNow: 60 }]
  },
  {
    nameSuffix: "06 Enterprise App Secret",
    ownerMode: "tagged",
    ownerName: "Release Engineering",
    ownerEmail: "release-engineering@example.com",
    appSecrets: [{ displayName: "app-registration-90-day-secret", daysFromNow: 90 }],
    appCertificates: [{ displayName: "app-registration-120-day-certificate", daysFromNow: 120 }],
    servicePrincipalSecrets: [{ displayName: "enterprise-app-18-day-secret", daysFromNow: 18 }],
    servicePrincipalCertificates: [{ displayName: "enterprise-app-75-day-certificate", daysFromNow: 75 }]
  }
];

const keyVaultKeys: KeyVaultSeedKey[] = [
  {
    name: "azcg-seed-key-expired",
    daysFromNow: -7,
    ownerName: "Data Platform",
    ownerEmail: "data-platform@example.com"
  },
  {
    name: "azcg-seed-key-urgent",
    daysFromNow: 21,
    ownerName: "Data Platform",
    ownerEmail: "data-platform@example.com"
  },
  {
    name: "azcg-seed-key-90day",
    daysFromNow: 89,
    ownerName: "Security Engineering",
    ownerEmail: "security-engineering@example.com"
  }
];

const keyVaultCertificates: KeyVaultSeedCertificate[] = [
  {
    name: "azcg-seed-cert-30day",
    validityMonths: 1,
    ownerName: "Shared Services",
    ownerEmail: "shared-services@example.com"
  },
  {
    name: "azcg-seed-cert-90day",
    validityMonths: 3,
    ownerName: "Shared Services",
    ownerEmail: "shared-services@example.com"
  },
  {
    name: "azcg-seed-cert-long",
    validityMonths: 12,
    ownerName: "Platform Ops",
    ownerEmail: "platform-ops@example.com"
  }
];

const args = parseArgs(process.argv.slice(2));

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  if (!args.yes && !args.dryRun) {
    printHelp();
    throw new Error("Refusing to mutate Entra without --yes. Use --dry-run to preview.");
  }

  console.log(`Seeding Microsoft Entra application credentials with prefix "${args.prefix}"`);
  if (args.dryRun && !args.cleanup) {
    for (const scenario of scenarios) {
      console.log(`dry-run: would ensure ${displayNameFor(scenario)}`);
    }
    if (args.keyVaultName) {
      console.log(`dry-run: would seed ${keyVaultKeys.length} key(s) in Key Vault ${args.keyVaultName}`);
      console.log(`dry-run: would seed ${keyVaultCertificates.length} certificate(s) in Key Vault ${args.keyVaultName}`);
    }
    return;
  }

  if (args.cleanup) {
    await cleanupSeedApps();
    return;
  }

  const currentUser = await currentUserOrNull();
  for (const scenario of scenarios) {
    await seedScenario(scenario, currentUser);
  }

  if (args.keyVaultName) {
    await seedKeyVault();
  }

  console.log("Seed complete. Secret values returned by Graph were discarded and not printed.");
  console.log(
    args.keyVaultName
      ? "Run `npm run sync:azure -- --verbose` to populate the UI from these Azure credentials."
      : "Run `npm run sync:azure -- --graph-only --verbose` to populate the UI from these Entra credentials."
  );

  if (args.syncAfter) {
    await runSyncAfter();
  }
}

async function seedScenario(scenario: SeedScenario, currentUser: DirectoryObject | null): Promise<void> {
  const displayName = displayNameFor(scenario);
  const app = await ensureApplication(displayName, tagsForScenario(scenario));
  await reconcileOwners("applications", app.id, scenario, currentUser);
  await replaceSeedPasswords("applications", app.id, scenario.appSecrets);
  await replaceSeedKeyCredentials("applications", app.id, scenario.appCertificates ?? []);
  console.log(
    `application: ${displayName}: ${scenario.appSecrets.length} seed secret(s), ${scenario.appCertificates?.length ?? 0} seed cert(s)`
  );

  if (scenario.servicePrincipalSecrets?.length) {
    const servicePrincipal = await ensureServicePrincipal(app, tagsForScenario(scenario));
    await reconcileOwners("servicePrincipals", servicePrincipal.id, scenario, currentUser);
    await replaceSeedPasswords("servicePrincipals", servicePrincipal.id, scenario.servicePrincipalSecrets);
    await replaceSeedKeyCredentials("servicePrincipals", servicePrincipal.id, scenario.servicePrincipalCertificates ?? []);
    console.log(
      `servicePrincipal: ${displayName}: ${scenario.servicePrincipalSecrets.length} seed secret(s), ${scenario.servicePrincipalCertificates?.length ?? 0} seed cert(s)`
    );
  }
}

async function ensureApplication(displayName: string, tags: string[]): Promise<GraphApplication> {
  const existing = await findApplication(displayName);
  if (existing) {
    assertSeedApplication(existing);
    await graphJson<GraphApplication>([
      "rest",
      "--method",
      "patch",
      "--url",
      `${GRAPH_ROOT}/applications/${existing.id}`,
      "--body",
      JSON.stringify({ tags })
    ]);
    return (await findApplication(displayName)) ?? existing;
  }
  return graphJson<GraphApplication>([
    "rest",
    "--method",
    "post",
    "--url",
    `${GRAPH_ROOT}/applications`,
    "--body",
    JSON.stringify({ displayName, tags })
  ]);
}

async function ensureServicePrincipal(app: GraphApplication, tags: string[]): Promise<GraphServicePrincipal> {
  const existing = await findServicePrincipal(app.appId);
  if (existing) {
    await graphJson<GraphServicePrincipal>([
      "rest",
      "--method",
      "patch",
      "--url",
      `${GRAPH_ROOT}/servicePrincipals/${existing.id}`,
      "--body",
      JSON.stringify({ tags })
    ]);
    return (await findServicePrincipal(app.appId)) ?? existing;
  }
  return graphJson<GraphServicePrincipal>([
    "rest",
    "--method",
    "post",
    "--url",
    `${GRAPH_ROOT}/servicePrincipals`,
    "--body",
    JSON.stringify({ appId: app.appId, tags })
  ]);
}

async function replaceSeedPasswords(
  entity: "applications" | "servicePrincipals",
  id: string,
  secrets: SeedSecret[]
): Promise<void> {
  const current = await graphJson<{ passwordCredentials?: GraphPasswordCredential[] }>([
    "rest",
    "--method",
    "get",
    "--url",
    `${GRAPH_ROOT}/${entity}/${id}?$select=passwordCredentials`
  ]);
  for (const credential of current.passwordCredentials ?? []) {
    if (!credential.keyId || !credential.displayName?.startsWith(SEED_SECRET_PREFIX)) continue;
    await graphJson<unknown>([
      "rest",
      "--method",
      "post",
      "--url",
      `${GRAPH_ROOT}/${entity}/${id}/removePassword`,
      "--body",
      JSON.stringify({ keyId: credential.keyId })
    ]);
  }

  for (const secret of secrets) {
    const response = await graphJson<AddPasswordResponse>([
      "rest",
      "--method",
      "post",
      "--url",
      `${GRAPH_ROOT}/${entity}/${id}/addPassword`,
      "--body",
      JSON.stringify({
        passwordCredential: {
          displayName: `${SEED_SECRET_PREFIX} ${secret.displayName}`,
          startDateTime: dateFromNow(-30),
          endDateTime: dateFromNow(secret.daysFromNow)
        }
      })
    ]);
    if (args.verbose) {
      console.log(`  ${entity}/${id}: ${response.keyId ?? "new secret"} expires ${response.endDateTime ?? dateFromNow(secret.daysFromNow)}`);
    }
  }
}

async function replaceSeedKeyCredentials(
  entity: "applications" | "servicePrincipals",
  id: string,
  certificates: SeedCertificate[]
): Promise<void> {
  const keyCredentials = certificates.map((certificate): GraphKeyCredential => ({
    keyId: randomUuid(),
    displayName: `${SEED_CERT_PREFIX} ${certificate.displayName}`,
    startDateTime: dateFromNow(-30),
    endDateTime: dateFromNow(certificate.daysFromNow),
    type: "AsymmetricX509Cert",
    usage: "Verify",
    key: SEED_PUBLIC_CERT_DER_BASE64
  }));

  await graphJson<unknown>([
    "rest",
    "--method",
    "patch",
    "--url",
    `${GRAPH_ROOT}/${entity}/${id}`,
    "--body",
    JSON.stringify({ keyCredentials })
  ]);

  if (args.verbose) {
    for (const credential of keyCredentials) {
      console.log(`  ${entity}/${id}: ${credential.keyId ?? "new cert"} expires ${credential.endDateTime}`);
    }
  }
}

async function reconcileOwners(
  entity: "applications" | "servicePrincipals",
  id: string,
  scenario: SeedScenario,
  currentUser: DirectoryObject | null
): Promise<void> {
  if (args.preserveOwners) return;
  const owners = await listOwners(entity, id);
  if (scenario.ownerMode === "current_user") {
    if (!currentUser) {
      console.warn(`owner: ${entity}/${id}: current user could not be resolved; owner signal may be unknown`);
      return;
    }
    if (!owners.some((owner) => owner.id === currentUser.id)) {
      await addOwner(entity, id, currentUser.id);
    }
    return;
  }

  for (const owner of owners) {
    await removeOwner(entity, id, owner.id);
  }
}

async function listOwners(entity: "applications" | "servicePrincipals", id: string): Promise<DirectoryObject[]> {
  const response = await graphJson<GraphListResponse<DirectoryObject>>([
    "rest",
    "--method",
    "get",
    "--url",
    `${GRAPH_ROOT}/${entity}/${id}/owners?$select=id,displayName,mail,userPrincipalName`
  ]);
  return response.value ?? [];
}

async function addOwner(entity: "applications" | "servicePrincipals", id: string, ownerId: string): Promise<void> {
  await graphJson<unknown>([
    "rest",
    "--method",
    "post",
    "--url",
    `${GRAPH_ROOT}/${entity}/${id}/owners/$ref`,
    "--body",
    JSON.stringify({ "@odata.id": `${GRAPH_ROOT}/directoryObjects/${ownerId}` })
  ]).catch((error) => {
    if (args.verbose) console.warn(`owner add skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function removeOwner(entity: "applications" | "servicePrincipals", id: string, ownerId: string): Promise<void> {
  await graphJson<unknown>([
    "rest",
    "--method",
    "delete",
    "--url",
    `${GRAPH_ROOT}/${entity}/${id}/owners/${ownerId}/$ref`
  ]).catch((error) => {
    if (args.verbose) console.warn(`owner remove skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function cleanupSeedApps(): Promise<void> {
  if (args.keyVaultName) {
    console.warn("Key Vault cleanup is not automatic because soft-delete/purge settings can block immediate reseeding.");
  }
  const apps = await findSeedApplications();
  if (!apps.length) {
    console.log(`No seed applications found for prefix "${args.prefix}"`);
    return;
  }
  if (args.dryRun) {
    for (const app of apps) console.log(`dry-run: would delete ${app.displayName} (${app.id})`);
    return;
  }
  console.log(`Deleting ${apps.length} seed application(s) with prefix "${args.prefix}"`);
  for (const app of apps) {
    await graphJson<unknown>(["rest", "--method", "delete", "--url", `${GRAPH_ROOT}/applications/${app.id}`]);
    console.log(`deleted: ${app.displayName}`);
  }
}

async function findApplication(displayName: string): Promise<GraphApplication | null> {
  const response = await graphJson<GraphListResponse<GraphApplication>>([
    "rest",
    "--method",
    "get",
    "--url",
    `${GRAPH_ROOT}/applications?$filter=${odataFilter(`displayName eq '${odataString(displayName)}'`)}&$select=id,appId,displayName,passwordCredentials,tags&$top=10`
  ]);
  const matches = response.value ?? [];
  if (matches.length > 1) {
    console.warn(`Multiple applications named "${displayName}" found; using ${matches[0].id}`);
  }
  return matches[0] ?? null;
}

function assertSeedApplication(app: GraphApplication): void {
  if (app.tags?.some((tag) => tag.toLowerCase() === "azure-cert-gui-seed=true")) return;
  throw new Error(
    `Refusing to reuse existing application "${app.displayName}" because it is not tagged azure-cert-gui-seed=true. Choose a different --prefix or tag/delete the conflicting app.`
  );
}

async function findSeedApplications(): Promise<GraphApplication[]> {
  const response = await graphJson<GraphListResponse<GraphApplication>>([
    "rest",
    "--method",
    "get",
    "--url",
    `${GRAPH_ROOT}/applications?$filter=${odataFilter(`startswith(displayName,'${odataString(args.prefix)}')`)}&$select=id,appId,displayName&$top=999`
  ]);
  return response.value ?? [];
}

async function findServicePrincipal(appId: string): Promise<GraphServicePrincipal | null> {
  const response = await graphJson<GraphListResponse<GraphServicePrincipal>>([
    "rest",
    "--method",
    "get",
    "--url",
    `${GRAPH_ROOT}/servicePrincipals?$filter=${odataFilter(`appId eq '${odataString(appId)}'`)}&$select=id,appId,displayName,passwordCredentials,tags&$top=10`
  ]);
  return response.value?.[0] ?? null;
}

async function currentUserOrNull(): Promise<DirectoryObject | null> {
  try {
    return await graphJson<DirectoryObject>([
      "rest",
      "--method",
      "get",
      "--url",
      `${GRAPH_ROOT}/me?$select=id,displayName,mail,userPrincipalName`
    ]);
  } catch {
    return null;
  }
}

async function seedKeyVault(): Promise<void> {
  if (!args.keyVaultName) return;
  const vault = await showKeyVault(args.keyVaultName);
  seededKeyVaultResourceId = vault.id ?? null;

  for (const key of keyVaultKeys) {
    await upsertKeyVaultKey(key);
  }

  for (const certificate of keyVaultCertificates) {
    await ensureKeyVaultCertificate(certificate);
  }
}

async function showKeyVault(vaultName: string): Promise<AzureVault> {
  return azureJson<AzureVault>([
    "keyvault",
    "show",
    "--name",
    vaultName,
    ...subscriptionArgs()
  ]);
}

async function upsertKeyVaultKey(key: KeyVaultSeedKey): Promise<void> {
  const exists = await keyVaultKeyExists(key.name);
  const expiresAt = dateFromNowForAzureCli(key.daysFromNow);
  const tags = keyVaultTags(key.ownerName, key.ownerEmail, "key");
  if (exists) {
    await azureJson<unknown>([
      "keyvault",
      "key",
      "set-attributes",
      "--vault-name",
      requiredKeyVaultName(),
      "--name",
      key.name,
      "--expires",
      expiresAt,
      "--tags",
      ...tags,
      ...subscriptionArgs()
    ]);
    console.log(`keyVaultKey: ${key.name}: updated expiry ${expiresAt}`);
    return;
  }

  await azureJson<unknown>([
    "keyvault",
    "key",
    "create",
    "--vault-name",
    requiredKeyVaultName(),
    "--name",
    key.name,
    "--kty",
    "RSA",
    "--size",
    "2048",
    "--expires",
    expiresAt,
    "--tags",
    ...tags,
    ...subscriptionArgs()
  ]);
  console.log(`keyVaultKey: ${key.name}: created expiry ${expiresAt}`);
}

async function keyVaultKeyExists(name: string): Promise<boolean> {
  try {
    await azureJson<unknown>([
      "keyvault",
      "key",
      "show",
      "--vault-name",
      requiredKeyVaultName(),
      "--name",
      name,
      ...subscriptionArgs()
    ]);
    return true;
  } catch {
    return false;
  }
}

async function ensureKeyVaultCertificate(certificate: KeyVaultSeedCertificate): Promise<void> {
  const exists = await keyVaultCertificateExists(certificate.name);
  const tags = keyVaultTags(certificate.ownerName, certificate.ownerEmail, "certificate");
  if (exists) {
    await azureJson<unknown>([
      "keyvault",
      "certificate",
      "set-attributes",
      "--vault-name",
      requiredKeyVaultName(),
      "--name",
      certificate.name,
      "--tags",
      ...tags,
      ...subscriptionArgs()
    ]);
    console.log(`keyVaultCertificate: ${certificate.name}: exists; refreshed tags`);
    return;
  }

  const policy = await defaultCertificatePolicy(certificate);
  await azureJson<unknown>([
    "keyvault",
    "certificate",
    "create",
    "--vault-name",
    requiredKeyVaultName(),
    "--name",
    certificate.name,
    "--policy",
    JSON.stringify(policy),
    "--validity",
    String(certificate.validityMonths),
    "--tags",
    ...tags,
    ...subscriptionArgs()
  ]);
  console.log(`keyVaultCertificate: ${certificate.name}: created ${certificate.validityMonths} month cert`);
}

async function keyVaultCertificateExists(name: string): Promise<boolean> {
  try {
    await azureJson<unknown>([
      "keyvault",
      "certificate",
      "show",
      "--vault-name",
      requiredKeyVaultName(),
      "--name",
      name,
      ...subscriptionArgs()
    ]);
    return true;
  } catch {
    return false;
  }
}

async function defaultCertificatePolicy(certificate: KeyVaultSeedCertificate): Promise<KeyVaultPolicy> {
  const policy = await azureJson<KeyVaultPolicy>(["keyvault", "certificate", "get-default-policy"]);
  return {
    ...policy,
    issuerParameters: {
      ...policy.issuerParameters,
      name: "Self"
    },
    keyProperties: {
      ...policy.keyProperties,
      keyType: "RSA",
      keySize: 2048,
      exportable: false,
      reuseKey: false
    },
    secretProperties: {
      ...policy.secretProperties,
      contentType: "application/x-pkcs12"
    },
    x509CertificateProperties: {
      ...policy.x509CertificateProperties,
      subject: `CN=${certificate.name}`,
      validityInMonths: certificate.validityMonths
    },
    lifetimeActions: [
      {
        action: {
          actionType: "EmailContacts"
        },
        trigger: {
          daysBeforeExpiry: 30
        }
      }
    ]
  };
}

function keyVaultTags(ownerName: string, ownerEmail: string, credentialType: "key" | "certificate"): string[] {
  return [
    "azure-cert-gui-seed=true",
    `seedCredentialType=${credentialType}`,
    `owner=${ownerName}`,
    `ownerEmail=${ownerEmail}`
  ];
}

function subscriptionArgs(): string[] {
  return args.keyVaultSubscription ? ["--subscription", args.keyVaultSubscription] : [];
}

function requiredKeyVaultName(): string {
  if (!args.keyVaultName) throw new Error("MissingKeyVaultName");
  return args.keyVaultName;
}

function tagsForScenario(scenario: SeedScenario): string[] {
  return [
    "azure-cert-gui-seed=true",
    `seedScenario=${scenario.nameSuffix}`,
    ...(scenario.ownerMode === "tagged" && scenario.ownerName
      ? [`owner=${scenario.ownerName}`, ...(scenario.ownerEmail ? [`ownerEmail=${scenario.ownerEmail}`] : [])]
      : []),
    ...(scenario.rotationMode ? [`rotationMode=${scenario.rotationMode}`] : []),
    ...(scenario.rotationModeReason ? [`rotationModeReason=${scenario.rotationModeReason}`] : [])
  ];
}

function displayNameFor(scenario: SeedScenario): string {
  return `${args.prefix} - ${scenario.nameSuffix}`;
}

function dateFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function dateFromNowForAzureCli(days: number): string {
  return dateFromNow(days).replace(/\.\d{3}Z$/, "Z");
}

function odataString(value: string): string {
  return value.replace(/'/g, "''");
}

function odataFilter(value: string): string {
  return encodeURIComponent(value);
}

async function graphJson<T>(azArgs: string[]): Promise<T> {
  return execAzureCliJson<T>(azArgs, { maxBuffer: JSON_BUFFER_BYTES });
}

async function azureJson<T>(azArgs: string[]): Promise<T> {
  return execAzureCliJson<T>(azArgs, { maxBuffer: JSON_BUFFER_BYTES });
}

function randomUuid(): string {
  return randomUUID();
}

async function runSyncAfter(): Promise<void> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const syncArgs = args.keyVaultName
    ? ["run", "sync:azure", "--", ...(args.verbose ? ["--verbose"] : [])]
    : ["run", "sync:azure", "--", "--graph-only", ...(args.verbose ? ["--verbose"] : [])];
  const { stdout, stderr } = await execFileAsync(
    npmCommand,
    syncArgs,
    {
      maxBuffer: JSON_BUFFER_BYTES,
      env: seededKeyVaultResourceId
        ? {
            ...process.env,
            AZURE_KEYVAULT_RESOURCE_IDS: seededKeyVaultResourceId
          }
        : process.env
    }
  );
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    prefix: DEFAULT_PREFIX,
    yes: false,
    cleanup: false,
    dryRun: false,
    syncAfter: false,
    preserveOwners: false,
    keyVaultName: process.env.AZURE_CERT_GUI_SEED_KEYVAULT_NAME?.trim() || null,
    keyVaultSubscription: process.env.AZURE_CERT_GUI_SEED_KEYVAULT_SUBSCRIPTION?.trim() || null,
    verbose: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prefix") {
      parsed.prefix = requireValue(argv, (index += 1), "--prefix");
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--cleanup") {
      parsed.cleanup = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--sync-after") {
      parsed.syncAfter = true;
    } else if (arg === "--preserve-owners") {
      parsed.preserveOwners = true;
    } else if (arg === "--keyvault-name") {
      parsed.keyVaultName = requireValue(argv, (index += 1), "--keyvault-name");
    } else if (arg === "--keyvault-subscription") {
      parsed.keyVaultSubscription = requireValue(argv, (index += 1), "--keyvault-subscription");
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg !== "--help") {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: npm run seed:entra -- --yes [options]

Creates or reuses synthetic Microsoft Entra app registrations, removes previous
AZCGUI-SEED credentials on those apps, and adds password/certificate credentials
across expired, 0-30, 31-60, 61-90, and 90+ UI buckets. Optionally seeds keys
and self-signed certificates into an existing Key Vault.

Options:
  --yes                 Required for live Entra mutations
  --dry-run             Show the seed app names without changing Entra
  --cleanup             Delete seed applications created with the prefix
  --prefix <name>       Display-name prefix. Default: ${DEFAULT_PREFIX}
  --keyvault-name <name> Also seed Key Vault keys and certificates
  --keyvault-subscription <id>
                        Subscription for --keyvault-name when not the default
  --sync-after          Run the repo Graph sync after seeding
  --preserve-owners     Do not adjust owners on seed app registrations
  --verbose             Print created credential IDs and expiry metadata
`);
}
