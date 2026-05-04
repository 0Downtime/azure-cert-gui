export type InventorySource =
  | "entra_application"
  | "service_principal"
  | "key_vault_secret"
  | "key_vault_certificate";

export type CredentialType = "client_secret" | "certificate" | "key" | "secret" | "unknown";

export type RiskBucket = "expired" | "0-30" | "31-60" | "61-90" | "90+" | "no-expiry";

export type WorkflowStatus =
  | "not_started"
  | "owner_contacted"
  | "rotation_scheduled"
  | "rotated"
  | "ignored";

export type OwnerConfidence = "high" | "medium" | "low" | "unknown";

export type OwnerSignalSource =
  | "entra_owner"
  | "app_tag"
  | "vault_tag"
  | "naming_rule"
  | "manual_override"
  | "unknown";

export type OwnerMatchType = "credential_id" | "parent_id" | "parent_name" | "vault_name";

export type RotationMode =
  | "owner_rotates"
  | "platform_managed"
  | "rotate_in_source_system"
  | "coordinated_high_risk"
  | "federated_no_secret";

export interface NormalizedCredential {
  naturalKey: string;
  source: InventorySource;
  sourceTenantId: string | null;
  subscriptionId: string | null;
  resourceGroup: string | null;
  parentId: string;
  parentName: string;
  credentialId: string;
  credentialName: string;
  credentialType: CredentialType;
  expiresAt: string | null;
  ownerHint: string | null;
  ownerEmail: string | null;
  ownerConfidence: OwnerConfidence;
  ownerSignalSource: OwnerSignalSource;
  ownerEvidence: string;
  sourceUpdatedAt: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface DashboardItem {
  id: number;
  naturalKey: string;
  source: InventorySource;
  sourceTenantId: string | null;
  subscriptionId: string | null;
  resourceGroup: string | null;
  parentId: string;
  parentName: string;
  credentialId: string;
  credentialName: string;
  credentialType: CredentialType;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  riskBucket: RiskBucket;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerConfidence: OwnerConfidence;
  ownerEvidence: string | null;
  status: WorkflowStatus;
  lastSeenAt: string;
  sourceUpdatedAt: string | null;
  removedAt: string | null;
  metadata: Record<string, string | number | boolean | null>;
  rotationMode: RotationMode;
  rotationModeReason: string;
  coverageState: "ok" | "stale" | "failed" | "unknown";
  statusHistory: DashboardStatusHistory[];
}

export interface DashboardStatusHistory {
  fromStatus: WorkflowStatus | null;
  toStatus: WorkflowStatus;
  note: string | null;
  changedAt: string;
  changedBy: string;
}

export interface DashboardSummary {
  total: number;
  expired: number;
  next30: number;
  next60: number;
  next90: number;
  unknownOwners: number;
  lowConfidenceOwners: number;
  excludedFromRenewal: number;
  coverageGaps: number;
  lastSuccessfulSyncAt: string | null;
}

export interface DashboardOwnerOverride {
  id: number;
  matchType: OwnerMatchType;
  matchValue: string;
  ownerName: string;
  ownerEmail: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  activeCredentialCount: number;
}

export type CoverageHealth = "ok" | "warning" | "failed" | "stale";

export interface DashboardCoverage {
  source: InventorySource;
  tenantId: string | null;
  subscriptionId: string | null;
  resourceId: string | null;
  resourceName: string;
  configured: boolean;
  reachable: boolean;
  itemsSeen: number;
  itemsSkipped: number;
  skipReason: string | null;
  errorCode: string | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string;
  health: CoverageHealth;
}
