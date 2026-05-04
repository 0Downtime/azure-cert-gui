import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GraphApplicationInput,
  GraphCredentialInput,
  GraphOwnerInput,
  GraphServicePrincipalInput,
  KeyVaultItemInput
} from "./normalize";

const execFileAsync = promisify(execFile);
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const JSON_BUFFER_BYTES = 1024 * 1024 * 100;

export interface AzureSyncConfig {
  tenantId: string | null;
  subscriptionIds: string[];
  keyVaultResourceIds: string[];
  includeGraphOwners: boolean;
  includeKeyVaultVersions: boolean;
}

interface GraphListResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

interface GraphOwnerRaw {
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

interface GraphCredentialRaw {
  keyId?: string | null;
  displayName?: string | null;
  endDateTime?: string | null;
  startDateTime?: string | null;
  usage?: string | null;
  type?: string | null;
}

interface GraphApplicationRaw {
  id?: string | null;
  appId?: string | null;
  displayName?: string | null;
  appOwnerOrganizationId?: string | null;
  servicePrincipalType?: string | null;
  tags?: unknown;
  passwordCredentials?: GraphCredentialRaw[];
  keyCredentials?: GraphCredentialRaw[];
}

export interface AzureVault {
  id?: string | null;
  name?: string | null;
  resourceGroup?: string | null;
  tags?: unknown;
  properties?: {
    tenantId?: string | null;
  };
}

interface KeyVaultRawItem {
  id?: string | null;
  name?: string | null;
  attributes?: {
    enabled?: boolean | null;
    expires?: string | number | null;
    updated?: string | number | null;
  };
  policy?: {
    issuerParameters?: {
      name?: string | null;
    };
    keyProperties?: {
      reuseKey?: boolean | null;
      keyType?: string | null;
    };
    lifetimeActions?: Array<{
      action?: {
        actionType?: string | null;
      };
    }>;
  };
  contentType?: string | null;
  tags?: unknown;
}

export class AzureCliError extends Error {
  constructor(args: string[], stderr: string) {
    super(`az ${args.join(" ")} failed: ${stderr.trim() || "no stderr"}`);
    this.name = "AzureCliError";
  }
}

export function azureSyncConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AzureSyncConfig {
  return {
    tenantId: env.AZURE_TENANT_ID?.trim() || null,
    subscriptionIds: csv(env.AZURE_SUBSCRIPTION_IDS),
    keyVaultResourceIds: csv(env.AZURE_KEYVAULT_RESOURCE_IDS),
    includeGraphOwners: env.AZURE_GRAPH_INCLUDE_OWNERS !== "false",
    includeKeyVaultVersions: env.AZURE_KEYVAULT_INCLUDE_VERSIONS === "true"
  };
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function azJson<T>(args: string[]): Promise<T> {
  try {
    const { stdout } = await execFileAsync("az", [...args, "--only-show-errors", "-o", "json"], {
      maxBuffer: JSON_BUFFER_BYTES
    });
    return JSON.parse(stdout || "null") as T;
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
    throw new AzureCliError(args, stderr);
  }
}

async function graphList<T>(url: string): Promise<T[]> {
  const rows: T[] = [];
  let nextUrl: string | undefined = url.startsWith("https://") ? url : `${GRAPH_ROOT}${url}`;

  while (nextUrl) {
    const page: GraphListResponse<T> = await azJson<GraphListResponse<T>>([
      "rest",
      "--method",
      "get",
      "--url",
      nextUrl
    ]);
    rows.push(...(page.value ?? []));
    nextUrl = page["@odata.nextLink"];
  }

  return rows;
}

export async function currentTenantId(config: AzureSyncConfig): Promise<string | null> {
  if (config.tenantId) return config.tenantId;
  const account = await azJson<{ tenantId?: string | null }>(["account", "show"]);
  return account.tenantId ?? null;
}

export async function subscriptionIds(config: AzureSyncConfig): Promise<string[]> {
  if (config.subscriptionIds.length > 0) return config.subscriptionIds;
  const accounts = await azJson<Array<{ id?: string | null; state?: string | null }>>(["account", "list"]);
  return accounts
    .filter((account) => !account.state || account.state.toLowerCase() === "enabled")
    .map((account) => account.id)
    .filter((id): id is string => Boolean(id));
}

export async function collectGraphApplications(
  config: AzureSyncConfig
): Promise<GraphApplicationInput[]> {
  const tenantId = await currentTenantId(config);
  const apps = await graphList<GraphApplicationRaw>(
    "/applications?$select=id,appId,displayName,passwordCredentials,keyCredentials,tags&$top=999"
  );

  return Promise.all(
    apps.map(async (app) => ({
      tenantId: tenantId ?? "unknown-tenant",
      id: required(app.id, "application.id"),
      appId: app.appId ?? "",
      displayName: app.displayName ?? app.appId ?? app.id ?? "Unnamed application",
      tags: coerceTagMap(app.tags),
      owners: config.includeGraphOwners ? await graphOwners("applications", required(app.id, "application.id")) : [],
      passwordCredentials: coerceGraphCredentials(app.passwordCredentials),
      keyCredentials: coerceGraphCredentials(app.keyCredentials)
    }))
  );
}

export async function collectServicePrincipals(
  config: AzureSyncConfig
): Promise<GraphServicePrincipalInput[]> {
  const tenantId = await currentTenantId(config);
  const principals = await graphList<GraphApplicationRaw>(
    "/servicePrincipals?$select=id,appId,displayName,servicePrincipalType,appOwnerOrganizationId,passwordCredentials,keyCredentials,tags&$top=999"
  );

  return Promise.all(
    principals.map(async (principal) => ({
      tenantId: tenantId ?? "unknown-tenant",
      id: required(principal.id, "servicePrincipal.id"),
      appId: principal.appId ?? "",
      displayName: principal.displayName ?? principal.appId ?? principal.id ?? "Unnamed service principal",
      appOwnerOrganizationId: principal.appOwnerOrganizationId ?? null,
      servicePrincipalType: principal.servicePrincipalType ?? undefined,
      tags: coerceTagMap(principal.tags),
      owners: config.includeGraphOwners
        ? await graphOwners("servicePrincipals", required(principal.id, "servicePrincipal.id"))
        : [],
      passwordCredentials: coerceGraphCredentials(principal.passwordCredentials),
      keyCredentials: coerceGraphCredentials(principal.keyCredentials)
    }))
  );
}

async function graphOwners(entity: "applications" | "servicePrincipals", id: string): Promise<GraphOwnerInput[]> {
  try {
    const owners = await graphList<GraphOwnerRaw>(
      `/${entity}/${encodeURIComponent(id)}/owners?$select=displayName,mail,userPrincipalName&$top=1`
    );
    return owners.map((owner) => ({
      displayName: owner.displayName ?? undefined,
      mail: owner.mail ?? undefined,
      userPrincipalName: owner.userPrincipalName ?? undefined
    }));
  } catch {
    return [];
  }
}

function coerceGraphCredentials(credentials: GraphCredentialRaw[] | undefined): GraphCredentialInput[] {
  return (credentials ?? [])
    .filter((credential) => Boolean(credential.keyId))
    .map((credential) => ({
      keyId: required(credential.keyId, "credential.keyId"),
      displayName: credential.displayName ?? undefined,
      endDateTime: normalizeDate(credential.endDateTime),
      startDateTime: normalizeDate(credential.startDateTime),
      usage: credential.usage ?? undefined,
      type: credential.type ?? undefined
    }));
}

export async function listKeyVaults(config: AzureSyncConfig): Promise<AzureVault[]> {
  if (config.keyVaultResourceIds.length > 0) {
    return Promise.all(
      config.keyVaultResourceIds.map(async (resourceId) => {
        const parsed = parseAzureResourceId(resourceId);
        return azJson<AzureVault>([
          "keyvault",
          "show",
          "--name",
          parsed.name,
          "--resource-group",
          parsed.resourceGroup,
          "--subscription",
          parsed.subscriptionId
        ]);
      })
    );
  }

  const subscriptions = await subscriptionIds(config);
  const vaultSets = await Promise.all(
    subscriptions.map((subscriptionId) =>
      azJson<AzureVault[]>(["keyvault", "list", "--subscription", subscriptionId, "--resource-type", "vault"])
    )
  );
  return vaultSets.flat();
}

export async function collectKeyVaultSecrets(
  vault: AzureVault,
  config: AzureSyncConfig
): Promise<KeyVaultItemInput[]> {
  const context = vaultContext(vault);
  const currentSecrets = await azJson<KeyVaultRawItem[]>([
    "keyvault",
    "secret",
    "list",
    "--vault-name",
    context.vaultName,
    "--subscription",
    context.subscriptionId,
    "--maxresults",
    "100"
  ]);

  const rows = config.includeKeyVaultVersions
    ? (
        await Promise.all(
          currentSecrets.map((secret) =>
            azJson<KeyVaultRawItem[]>([
              "keyvault",
              "secret",
              "list-versions",
              "--vault-name",
              context.vaultName,
              "--name",
              required(secret.name, "secret.name"),
              "--subscription",
              context.subscriptionId,
              "--maxresults",
              "100"
            ])
          )
        )
      ).flat()
    : currentSecrets;

  return rows.map((secret) => toKeyVaultItem(secret, context, "secrets"));
}

export async function collectKeyVaultCertificates(
  vault: AzureVault,
  config: AzureSyncConfig
): Promise<KeyVaultItemInput[]> {
  const context = vaultContext(vault);
  const currentCertificates = await azJson<KeyVaultRawItem[]>([
    "keyvault",
    "certificate",
    "list",
    "--vault-name",
    context.vaultName,
    "--subscription",
    context.subscriptionId,
    "--maxresults",
    "100"
  ]);

  const detailsByName = new Map(
    await Promise.all(
      currentCertificates.map(async (certificate) => {
        const name = required(certificate.name, "certificate.name");
        return [name, await keyVaultCertificateDetail(context.vaultName, context.subscriptionId, name)] as const;
      })
    )
  );

  const rows = config.includeKeyVaultVersions
    ? (
        await Promise.all(
          currentCertificates.map((certificate) =>
            azJson<KeyVaultRawItem[]>([
              "keyvault",
              "certificate",
              "list-versions",
              "--vault-name",
              context.vaultName,
              "--name",
              required(certificate.name, "certificate.name"),
              "--subscription",
              context.subscriptionId,
              "--maxresults",
              "100"
            ])
          )
        )
      ).flat()
    : currentCertificates;

  return rows.map((certificate) => {
    const name = required(certificate.name, "certificate.name");
    const detail = detailsByName.get(name);
    return toKeyVaultItem(
      {
        ...certificate,
        policy: certificate.policy ?? detail?.policy,
        tags: certificate.tags ?? detail?.tags,
        contentType: certificate.contentType ?? detail?.contentType
      },
      context,
      "certificates"
    );
  });
}

async function keyVaultCertificateDetail(
  vaultName: string,
  subscriptionId: string,
  name: string
): Promise<KeyVaultRawItem | null> {
  try {
    return await azJson<KeyVaultRawItem>([
      "keyvault",
      "certificate",
      "show",
      "--vault-name",
      vaultName,
      "--name",
      name,
      "--subscription",
      subscriptionId
    ]);
  } catch {
    return null;
  }
}

function vaultContext(vault: AzureVault): {
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  vaultResourceId: string;
  vaultName: string;
  vaultTags: Record<string, string>;
} {
  const id = required(vault.id, "vault.id");
  const parsed = parseAzureResourceId(id);
  return {
    tenantId: vault.properties?.tenantId ?? "unknown-tenant",
    subscriptionId: parsed.subscriptionId,
    resourceGroup: vault.resourceGroup ?? parsed.resourceGroup,
    vaultResourceId: id,
    vaultName: vault.name ?? parsed.name,
    vaultTags: coerceTagMap(vault.tags)
  };
}

function toKeyVaultItem(
  item: KeyVaultRawItem,
  context: ReturnType<typeof vaultContext>,
  collection: "secrets" | "certificates"
): KeyVaultItemInput {
  const name = item.name ?? nameFromKeyVaultId(item.id, collection) ?? "unnamed";
  return {
    tenantId: context.tenantId,
    subscriptionId: context.subscriptionId,
    resourceGroup: context.resourceGroup,
    vaultResourceId: context.vaultResourceId,
    vaultName: context.vaultName,
    name,
    version: versionFromKeyVaultId(item.id, collection) ?? "current",
    expiresAt: normalizeDate(item.attributes?.expires),
    enabled: item.attributes?.enabled ?? undefined,
    updatedAt: normalizeDate(item.attributes?.updated),
    tags: { ...context.vaultTags, ...coerceTagMap(item.tags) },
    contentType: item.contentType ?? undefined,
    certificateIssuerName: item.policy?.issuerParameters?.name ?? undefined,
    certificateReuseKey: item.policy?.keyProperties?.reuseKey ?? undefined,
    certificateLifetimeAction: item.policy?.lifetimeActions?.[0]?.action?.actionType ?? undefined,
    certificatePolicyKeyType: item.policy?.keyProperties?.keyType ?? undefined
  };
}

export function parseAzureResourceId(resourceId: string): {
  subscriptionId: string;
  resourceGroup: string;
  provider: string;
  type: string;
  name: string;
} {
  const parts = resourceId.split("/").filter(Boolean);
  const valueAfter = (key: string) => {
    const index = parts.findIndex((part) => part.toLowerCase() === key.toLowerCase());
    return index >= 0 ? parts[index + 1] : undefined;
  };
  const subscriptionId = valueAfter("subscriptions");
  const resourceGroup = valueAfter("resourceGroups");
  const providerIndex = parts.findIndex((part) => part.toLowerCase() === "providers");
  const provider = providerIndex >= 0 ? parts[providerIndex + 1] : undefined;
  const type = providerIndex >= 0 ? parts[providerIndex + 2] : undefined;
  const name = providerIndex >= 0 ? parts[providerIndex + 3] : undefined;

  if (!subscriptionId || !resourceGroup || !provider || !type || !name) {
    throw new Error(`InvalidAzureResourceId: ${resourceId}`);
  }

  return { subscriptionId, resourceGroup, provider, type, name };
}

export function coerceTagMap(tags: unknown): Record<string, string> {
  if (!tags) return {};
  if (Array.isArray(tags)) {
    return Object.fromEntries(
      tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => {
          const separator = tag.includes("=") ? "=" : tag.includes(":") ? ":" : null;
          if (!separator) return [tag, "true"];
          const [key, ...rest] = tag.split(separator);
          return [key.trim(), rest.join(separator).trim()];
        })
        .filter(([key]) => Boolean(key))
    );
  }
  if (typeof tags === "object") {
    return Object.fromEntries(
      Object.entries(tags)
        .filter((entry): entry is [string, string | number | boolean] =>
          ["string", "number", "boolean"].includes(typeof entry[1])
        )
        .map(([key, value]) => [key, String(value)])
    );
  }
  return {};
}

export function normalizeDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    typeof value === "number" || /^\d+$/.test(String(value))
      ? new Date(Number(value) * 1000)
      : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nameFromKeyVaultId(id: string | null | undefined, collection: "secrets" | "certificates"): string | null {
  const parts = id?.split("/").filter(Boolean) ?? [];
  const index = parts.findIndex((part) => part.toLowerCase() === collection);
  return index >= 0 ? parts[index + 1] ?? null : null;
}

function versionFromKeyVaultId(id: string | null | undefined, collection: "secrets" | "certificates"): string | null {
  const parts = id?.split("/").filter(Boolean) ?? [];
  const index = parts.findIndex((part) => part.toLowerCase() === collection);
  return index >= 0 ? parts[index + 2] ?? null : null;
}

function required(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`MissingAzureField: ${label}`);
  return value;
}
