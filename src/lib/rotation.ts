import type { InventorySource, RotationMode } from "@/types";

type MetadataValue = string | number | boolean | null;

interface RotationInput {
  source: InventorySource;
  credentialType: string;
  metadata: Record<string, MetadataValue>;
}

const MICROSOFT_FIRST_PARTY_TENANT_ID = "f8cdef31-a31e-4b4a-93e4-5f571e91255a";

const ROTATION_MODE_VALUES = new Set<RotationMode>([
  "owner_rotates",
  "platform_managed",
  "rotate_in_source_system",
  "coordinated_high_risk",
  "federated_no_secret"
]);

export function classifyRotation(input: RotationInput): {
  mode: RotationMode;
  reason: string;
} {
  const override = asRotationMode(input.metadata.rotationMode);
  if (override) {
    return {
      mode: override,
      reason: stringValue(input.metadata.rotationModeReason) ?? "Rotation mode set by source metadata"
    };
  }

  if (input.source === "service_principal") {
    const servicePrincipalType = stringValue(input.metadata.servicePrincipalType)?.toLowerCase();
    if (servicePrincipalType === "managedidentity") {
      return {
        mode: "platform_managed",
        reason: "Managed identity credentials are issued and rotated by Azure"
      };
    }

    const appOwnerOrganizationId = stringValue(input.metadata.appOwnerOrganizationId)?.toLowerCase();
    if (appOwnerOrganizationId === MICROSOFT_FIRST_PARTY_TENANT_ID) {
      return {
        mode: "platform_managed",
        reason: "Microsoft first-party service principal credential"
      };
    }
  }

  if (input.source === "key_vault_certificate") {
    const issuerName = stringValue(input.metadata.certificateIssuerName);
    const lifetimeAction = stringValue(input.metadata.certificateLifetimeAction);
    if (lifetimeAction?.toLowerCase() === "autorenew") {
      return {
        mode: "rotate_in_source_system",
        reason: "Key Vault certificate has an auto-renew lifetime action"
      };
    }
    if (issuerName && issuerName.toLowerCase() !== "self") {
      return {
        mode: "rotate_in_source_system",
        reason: `Key Vault certificate is issued through ${issuerName}`
      };
    }
  }

  return {
    mode: "owner_rotates",
    reason: "Credential should be renewed by the owning application team"
  };
}

export function isRenewalActionable(mode: RotationMode): boolean {
  return mode === "owner_rotates" || mode === "coordinated_high_risk";
}

function asRotationMode(value: MetadataValue | undefined): RotationMode | null {
  if (typeof value !== "string") return null;
  return ROTATION_MODE_VALUES.has(value as RotationMode) ? (value as RotationMode) : null;
}

function stringValue(value: MetadataValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
