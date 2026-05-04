import type { NormalizedCredential, OwnerConfidence, OwnerSignalSource } from "@/types";
import { assertNoSecretValueFields, pickMetadata } from "./secret-guard";

export interface GraphOwnerInput {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

export interface GraphCredentialInput {
  keyId: string;
  displayName?: string;
  endDateTime?: string | null;
  startDateTime?: string | null;
  usage?: string;
  type?: string;
}

export interface GraphApplicationInput {
  tenantId: string;
  id: string;
  appId: string;
  displayName: string;
  tags?: Record<string, string>;
  owners?: GraphOwnerInput[];
  passwordCredentials?: GraphCredentialInput[];
  keyCredentials?: GraphCredentialInput[];
}

export interface GraphServicePrincipalInput extends GraphApplicationInput {
  servicePrincipalType?: string;
}

export interface KeyVaultItemInput {
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  vaultResourceId: string;
  vaultName: string;
  name: string;
  version: string;
  expiresAt?: string | null;
  enabled?: boolean;
  updatedAt?: string | null;
  tags?: Record<string, string>;
  contentType?: string;
}

function ownerFromGraph(
  owners: GraphOwnerInput[] | undefined,
  tags: Record<string, string> | undefined
): Pick<
  NormalizedCredential,
  "ownerHint" | "ownerEmail" | "ownerConfidence" | "ownerSignalSource" | "ownerEvidence"
> {
  const owner = owners?.[0];
  if (owner) {
    return {
      ownerHint: owner.displayName ?? owner.userPrincipalName ?? owner.mail ?? "Unknown owner",
      ownerEmail: owner.mail ?? owner.userPrincipalName ?? null,
      ownerConfidence: "high",
      ownerSignalSource: "entra_owner",
      ownerEvidence: "First Entra owner returned by source"
    };
  }

  const taggedOwner = tags?.owner ?? tags?.Owner ?? tags?.applicationOwner;
  if (taggedOwner) {
    return {
      ownerHint: taggedOwner,
      ownerEmail: tags?.ownerEmail ?? null,
      ownerConfidence: "medium",
      ownerSignalSource: "app_tag",
      ownerEvidence: "Owner inferred from app tag"
    };
  }

  return unknownOwner();
}

function ownerFromVault(
  tags: Record<string, string> | undefined
): Pick<
  NormalizedCredential,
  "ownerHint" | "ownerEmail" | "ownerConfidence" | "ownerSignalSource" | "ownerEvidence"
> {
  const taggedOwner = tags?.owner ?? tags?.Owner ?? tags?.applicationOwner;
  if (taggedOwner) {
    return {
      ownerHint: taggedOwner,
      ownerEmail: tags?.ownerEmail ?? null,
      ownerConfidence: "medium",
      ownerSignalSource: "vault_tag",
      ownerEvidence: "Owner inferred from Key Vault tag"
    };
  }
  return unknownOwner();
}

function unknownOwner(): Pick<
  NormalizedCredential,
  "ownerHint" | "ownerEmail" | "ownerConfidence" | "ownerSignalSource" | "ownerEvidence"
> {
  return {
    ownerHint: null,
    ownerEmail: null,
    ownerConfidence: "unknown" satisfies OwnerConfidence,
    ownerSignalSource: "unknown" satisfies OwnerSignalSource,
    ownerEvidence: "No owner signal found"
  };
}

function normalizeGraphCredential(
  source: "entra_application" | "service_principal",
  parent: GraphApplicationInput,
  credential: GraphCredentialInput,
  credentialType: "client_secret" | "certificate"
): NormalizedCredential {
  assertNoSecretValueFields(credential, `graph.${parent.id}.${credential.keyId}`);
  const owner = ownerFromGraph(parent.owners, parent.tags);
  const parentKind = source === "entra_application" ? "application" : "servicePrincipal";

  return {
    naturalKey: `${parent.tenantId}:${parentKind}:${parent.id}:${credential.keyId}`,
    source,
    sourceTenantId: parent.tenantId,
    subscriptionId: null,
    resourceGroup: null,
    parentId: parent.id,
    parentName: parent.displayName,
    credentialId: credential.keyId,
    credentialName: credential.displayName ?? credential.keyId,
    credentialType,
    expiresAt: credential.endDateTime ?? null,
    sourceUpdatedAt: null,
    metadata: pickMetadata(credential as unknown as Record<string, unknown>, [
      "keyId",
      "displayName",
      "startDateTime",
      "usage",
      "type"
    ]),
    ...owner
  };
}

export function normalizeGraphApplications(apps: GraphApplicationInput[]): NormalizedCredential[] {
  return apps.flatMap((app) => [
    ...(app.passwordCredentials ?? []).map((credential) =>
      normalizeGraphCredential("entra_application", app, credential, "client_secret")
    ),
    ...(app.keyCredentials ?? []).map((credential) =>
      normalizeGraphCredential("entra_application", app, credential, "certificate")
    )
  ]);
}

export function normalizeServicePrincipals(
  servicePrincipals: GraphServicePrincipalInput[]
): NormalizedCredential[] {
  return servicePrincipals.flatMap((principal) => [
    ...(principal.passwordCredentials ?? []).map((credential) =>
      normalizeGraphCredential("service_principal", principal, credential, "client_secret")
    ),
    ...(principal.keyCredentials ?? []).map((credential) =>
      normalizeGraphCredential("service_principal", principal, credential, "certificate")
    )
  ]);
}

export function normalizeKeyVaultSecrets(secrets: KeyVaultItemInput[]): NormalizedCredential[] {
  return secrets.map((secret) => {
    assertNoSecretValueFields(secret, `keyVaultSecret.${secret.vaultName}.${secret.name}`);
    const owner = ownerFromVault(secret.tags);
    return {
      naturalKey: `${secret.subscriptionId}:${secret.vaultResourceId}:secret:${secret.name}:${secret.version}`,
      source: "key_vault_secret",
      sourceTenantId: secret.tenantId,
      subscriptionId: secret.subscriptionId,
      resourceGroup: secret.resourceGroup,
      parentId: secret.vaultResourceId,
      parentName: secret.vaultName,
      credentialId: `${secret.name}/${secret.version}`,
      credentialName: secret.name,
      credentialType: "secret",
      expiresAt: secret.expiresAt ?? null,
      sourceUpdatedAt: secret.updatedAt ?? null,
      metadata: pickMetadata(secret as unknown as Record<string, unknown>, [
        "version",
        "enabled",
        "contentType"
      ]),
      ...owner
    };
  });
}

export function normalizeKeyVaultCertificates(
  certificates: KeyVaultItemInput[]
): NormalizedCredential[] {
  return certificates.map((certificate) => {
    assertNoSecretValueFields(certificate, `keyVaultCertificate.${certificate.vaultName}.${certificate.name}`);
    const owner = ownerFromVault(certificate.tags);
    return {
      naturalKey: `${certificate.subscriptionId}:${certificate.vaultResourceId}:certificate:${certificate.name}:${certificate.version}`,
      source: "key_vault_certificate",
      sourceTenantId: certificate.tenantId,
      subscriptionId: certificate.subscriptionId,
      resourceGroup: certificate.resourceGroup,
      parentId: certificate.vaultResourceId,
      parentName: certificate.vaultName,
      credentialId: `${certificate.name}/${certificate.version}`,
      credentialName: certificate.name,
      credentialType: "certificate",
      expiresAt: certificate.expiresAt ?? null,
      sourceUpdatedAt: certificate.updatedAt ?? null,
      metadata: pickMetadata(certificate as unknown as Record<string, unknown>, [
        "version",
        "enabled",
        "contentType"
      ]),
      ...owner
    };
  });
}
