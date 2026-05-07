import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { DashboardItem } from "@/types";
import { isRenewalActionable } from "./rotation";

const execFileAsync = promisify(execFile);
const JSON_BUFFER_BYTES = 1024 * 1024 * 20;
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export interface AzureRotationRunner {
  azJson<T>(args: string[]): Promise<T>;
  setKeyVaultSecret?(input: KeyVaultSecretSetInput): Promise<KeyVaultSetSecretResponse>;
}

export interface AzureRotationRequest {
  item: DashboardItem;
  confirmation: string;
  secretMode?: "generated" | "provided";
  providedSecretValue?: string;
  newCredentialDisplayName?: string;
  replacementExpiresAt?: string | null;
  keyVaultCopyVaultName?: string | null;
  keyVaultCopySecretName?: string | null;
  dryRun?: boolean;
  runner?: AzureRotationRunner;
}

export interface AzureRotationResult {
  replacementCredentialId: string | null;
  replacementExpiresAt: string | null;
  oneTimeSecretValue: string | null;
  keyVaultCopyVaultName: string | null;
  keyVaultCopySecretName: string | null;
  dryRun: boolean;
  summary: string;
  details: Record<string, string | number | boolean | null>;
}

interface GraphPasswordResponse {
  keyId?: string | null;
  secretText?: string | null;
  endDateTime?: string | null;
}

interface KeyVaultSetSecretResponse {
  id?: string | null;
  attributes?: {
    expires?: string | number | null;
    exp?: string | number | null;
  };
}

interface KeyVaultSecretSetInput {
  vaultName: string;
  secretName: string;
  secretValue: string;
  expiresAt: string | null;
}

interface KeyVaultRotateResponse {
  kid?: string | null;
  id?: string | null;
  attributes?: {
    expires?: string | number | null;
  };
}

interface KeyVaultCertificateShowResponse {
  policy?: unknown;
}

export async function executeAzureRotation(input: AzureRotationRequest): Promise<AzureRotationResult> {
  validateConfirmation(input.item, input.confirmation);
  validateSupportedRotation(input.item);

  if (input.dryRun) {
    return previewAzureRotation(input);
  }

  const runner = input.runner ?? defaultRunner;
  if (input.item.source === "entra_application" || input.item.source === "service_principal") {
    return rotateGraphClientSecret(input, runner);
  }
  if (input.item.source === "key_vault_secret") {
    return rotateKeyVaultSecret(input, runner);
  }
  if (input.item.source === "key_vault_key") {
    return rotateKeyVaultKey(input, runner);
  }
  if (input.item.source === "key_vault_certificate") {
    return renewKeyVaultCertificate(input, runner);
  }
  throw new Error("UnsupportedRotationSource");
}

function previewAzureRotation(input: AzureRotationRequest): AzureRotationResult {
  return {
    replacementCredentialId: `dry-run:${input.item.source}:${input.item.credentialName}`,
    replacementExpiresAt: input.replacementExpiresAt ?? null,
    oneTimeSecretValue: null,
    keyVaultCopyVaultName: input.keyVaultCopyVaultName?.trim() || null,
    keyVaultCopySecretName: input.keyVaultCopySecretName?.trim() || null,
    dryRun: true,
    summary: `Dry run complete for ${input.item.credentialName}. No Azure changes were made.`,
    details: {
      operation: "dry_run.rotation.preview",
      source: input.item.source,
      credentialType: input.item.credentialType
    }
  };
}

function validateConfirmation(item: DashboardItem, confirmation: string): void {
  if (confirmation.trim() !== item.credentialName) {
    throw new Error("RotationConfirmationMismatch");
  }
}

function validateSupportedRotation(item: DashboardItem): void {
  if (item.rotationMode === "platform_managed" || item.rotationMode === "federated_no_secret") {
    throw new Error("RotationModeNotActionable");
  }
  if ((item.source === "entra_application" || item.source === "service_principal") && item.credentialType !== "client_secret") {
    throw new Error("OnlyClientSecretRotationSupported");
  }
  if (item.source === "key_vault_certificate" && !isManagedKeyVaultCertificate(item)) {
    throw new Error("UnsupportedCertificateRenewal");
  }
  if (item.source !== "key_vault_certificate" && !isRenewalActionable(item.rotationMode)) {
    throw new Error("RotationModeNotActionable");
  }
}

async function rotateGraphClientSecret(
  input: AzureRotationRequest,
  runner: AzureRotationRunner
): Promise<AzureRotationResult> {
  const body = {
    passwordCredential: {
      displayName: input.newCredentialDisplayName?.trim() || `${input.item.credentialName} renewal`,
      endDateTime: input.replacementExpiresAt || undefined
    }
  };
  const entity = input.item.source === "entra_application" ? "applications" : "servicePrincipals";
  const response = await runner.azJson<GraphPasswordResponse>([
    "rest",
    "--method",
    "post",
    "--url",
    `${GRAPH_ROOT}/${entity}/${encodeURIComponent(input.item.parentId)}/addPassword`,
    "--body",
    JSON.stringify(body)
  ]);

  const secretText = response.secretText ?? null;
  let keyVaultCopyVaultName = input.keyVaultCopyVaultName?.trim() || null;
  let keyVaultCopySecretName = input.keyVaultCopySecretName?.trim() || null;
  if (secretText && keyVaultCopyVaultName && keyVaultCopySecretName) {
    await setKeyVaultSecret(runner, keyVaultCopyVaultName, keyVaultCopySecretName, secretText, response.endDateTime ?? null);
  } else {
    keyVaultCopyVaultName = null;
    keyVaultCopySecretName = null;
  }

  return {
    replacementCredentialId: response.keyId ?? null,
    replacementExpiresAt: response.endDateTime ?? input.replacementExpiresAt ?? null,
    oneTimeSecretValue: secretText,
    keyVaultCopyVaultName,
    keyVaultCopySecretName,
    dryRun: false,
    summary: `Created replacement Entra client secret for ${input.item.parentName}`,
    details: {
      operation: "graph.addPassword",
      source: input.item.source,
      copiedToKeyVault: Boolean(keyVaultCopyVaultName && keyVaultCopySecretName)
    }
  };
}

async function rotateKeyVaultSecret(
  input: AzureRotationRequest,
  runner: AzureRotationRunner
): Promise<AzureRotationResult> {
  const secretValue = input.secretMode === "provided" ? input.providedSecretValue ?? "" : generatedSecretValue();
  if (!secretValue) throw new Error("MissingReplacementSecretValue");
  const response = await setKeyVaultSecret(
    runner,
    input.item.parentName,
    input.item.credentialName,
    secretValue,
    input.replacementExpiresAt ?? null
  );

  return {
    replacementCredentialId: response.id ?? null,
    replacementExpiresAt: normalizeDate(response.attributes?.expires ?? response.attributes?.exp) ?? input.replacementExpiresAt ?? null,
    oneTimeSecretValue: input.secretMode === "provided" ? null : secretValue,
    keyVaultCopyVaultName: null,
    keyVaultCopySecretName: null,
    dryRun: false,
    summary: `Created new Key Vault secret version for ${input.item.credentialName}`,
    details: {
      operation: "keyvault.secret.set",
      vaultName: input.item.parentName,
      secretName: input.item.credentialName,
      generatedValue: input.secretMode !== "provided"
    }
  };
}

async function rotateKeyVaultKey(
  input: AzureRotationRequest,
  runner: AzureRotationRunner
): Promise<AzureRotationResult> {
  const response = await runner.azJson<KeyVaultRotateResponse>([
    "keyvault",
    "key",
    "rotate",
    "--vault-name",
    input.item.parentName,
    "--name",
    input.item.credentialName
  ]);
  return {
    replacementCredentialId: response.kid ?? response.id ?? null,
    replacementExpiresAt: normalizeDate(response.attributes?.expires) ?? null,
    oneTimeSecretValue: null,
    keyVaultCopyVaultName: null,
    keyVaultCopySecretName: null,
    dryRun: false,
    summary: `Rotated Key Vault key ${input.item.credentialName}`,
    details: {
      operation: "keyvault.key.rotate",
      vaultName: input.item.parentName,
      keyName: input.item.credentialName
    }
  };
}

async function renewKeyVaultCertificate(
  input: AzureRotationRequest,
  runner: AzureRotationRunner
): Promise<AzureRotationResult> {
  const current = await runner.azJson<KeyVaultCertificateShowResponse>([
    "keyvault",
    "certificate",
    "show",
    "--vault-name",
    input.item.parentName,
    "--name",
    input.item.credentialName
  ]);
  if (!current.policy) throw new Error("MissingCertificatePolicy");
  const response = await runner.azJson<KeyVaultRotateResponse>([
    "keyvault",
    "certificate",
    "create",
    "--vault-name",
    input.item.parentName,
    "--name",
    input.item.credentialName,
    "--policy",
    JSON.stringify(current.policy)
  ]);
  return {
    replacementCredentialId: response.id ?? null,
    replacementExpiresAt: normalizeDate(response.attributes?.expires) ?? null,
    oneTimeSecretValue: null,
    keyVaultCopyVaultName: null,
    keyVaultCopySecretName: null,
    dryRun: false,
    summary: `Started Key Vault certificate renewal for ${input.item.credentialName}`,
    details: {
      operation: "keyvault.certificate.create",
      vaultName: input.item.parentName,
      certificateName: input.item.credentialName
    }
  };
}

async function setKeyVaultSecret(
  runner: AzureRotationRunner,
  vaultName: string,
  secretName: string,
  secretValue: string,
  expiresAt: string | null
): Promise<KeyVaultSetSecretResponse> {
  if (runner.setKeyVaultSecret) {
    return runner.setKeyVaultSecret({ vaultName, secretName, secretValue, expiresAt });
  }
  return setKeyVaultSecretWithRest({ vaultName, secretName, secretValue, expiresAt });
}

function isManagedKeyVaultCertificate(item: DashboardItem): boolean {
  return (
    item.source === "key_vault_certificate" &&
    (String(item.metadata.certificateLifetimeAction ?? "").toLowerCase() === "autorenew" ||
      Boolean(item.metadata.certificateIssuerName && String(item.metadata.certificateIssuerName).toLowerCase() !== "self"))
  );
}

function generatedSecretValue(): string {
  return randomBytes(36).toString("base64url");
}

function normalizeDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    typeof value === "number" || /^\d+$/.test(String(value))
      ? new Date(Number(value) * 1000)
      : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const defaultRunner: AzureRotationRunner = {
  async azJson<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync("az", [...args, "--only-show-errors", "-o", "json"], {
      maxBuffer: JSON_BUFFER_BYTES
    });
    return JSON.parse(stdout || "null") as T;
  },
  setKeyVaultSecret: setKeyVaultSecretWithRest
};

async function setKeyVaultSecretWithRest(input: KeyVaultSecretSetInput): Promise<KeyVaultSetSecretResponse> {
  const token = await keyVaultAccessToken();
  const expiresAtEpochSeconds = input.expiresAt ? Math.floor(Date.parse(input.expiresAt) / 1000) : null;
  const attributes =
    expiresAtEpochSeconds && Number.isFinite(expiresAtEpochSeconds) ? { exp: expiresAtEpochSeconds } : undefined;
  const vaultName = safeKeyVaultName(input.vaultName);
  const response = await fetch(
    `https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(input.secretName)}?api-version=7.4`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        value: input.secretValue,
        ...(attributes ? { attributes } : {})
      })
    }
  );
  if (!response.ok) {
    throw new Error(`KeyVaultSecretSetFailed:${response.status}`);
  }
  return (await response.json()) as KeyVaultSetSecretResponse;
}

function safeKeyVaultName(value: string): string {
  const vaultName = value.trim().toLowerCase();
  if (!/^[a-z0-9-]{3,24}$/.test(vaultName)) {
    throw new Error("InvalidKeyVaultName");
  }
  return vaultName;
}

async function keyVaultAccessToken(): Promise<string> {
  const { stdout } = await execFileAsync(
    "az",
    ["account", "get-access-token", "--resource", "https://vault.azure.net", "--query", "accessToken", "-o", "tsv"],
    { maxBuffer: JSON_BUFFER_BYTES }
  );
  const token = stdout.trim();
  if (!token) throw new Error("KeyVaultAccessTokenMissing");
  return token;
}
