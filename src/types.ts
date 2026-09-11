export type InventorySource =
  | "entra_application"
  | "service_principal"
  | "key_vault_secret"
  | "key_vault_certificate"
  | "key_vault_key";

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

export type RenewalCaseStatus =
  | "open"
  | "rotation_created"
  | "validated"
  | "closed"
  | "blocked";

export type RenewalHandoffStatus =
  | "not_contacted"
  | "contacted"
  | "waiting_on_owner"
  | "escalated"
  | "ready_to_validate";

export type RenewalEventType =
  | "case_created"
  | "case_updated"
  | "rotation_executed"
  | "validated"
  | "closed"
  | "blocked";

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
  renewalCase: RenewalCase | null;
  coverageState: "ok" | "stale" | "failed" | "unknown";
  statusHistory: DashboardStatusHistory[];
}

export interface RenewalCase {
  id: number;
  credentialItemId: number;
  status: RenewalCaseStatus;
  dueAt: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  notes: string | null;
  reminderAt: string | null;
  lastContactedAt: string | null;
  escalationOwner: string | null;
  handoffStatus: RenewalHandoffStatus;
  replacementCredentialId: string | null;
  replacementExpiresAt: string | null;
  keyVaultCopyVaultName: string | null;
  keyVaultCopySecretName: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  events: RenewalEvent[];
}

export interface RenewalEvent {
  id: number;
  renewalCaseId: number;
  eventType: RenewalEventType;
  note: string | null;
  details: Record<string, string | number | boolean | null>;
  createdAt: string;
  createdBy: string;
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

export interface DashboardOwnerSuggestion {
  ownerName: string;
  ownerEmail: string | null;
  source: string;
  lastSeenAt: string | null;
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

export type RefreshRunState = "idle" | "running" | "succeeded" | "failed";

export interface RefreshRunStatus {
  runId: string | null;
  status: RefreshRunState;
  progress: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  logs: string[];
}

export interface RefreshScheduleStatus {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  message: string;
  minimumIntervalMinutes: number;
  maximumIntervalMinutes: number;
}

export interface AzureEnvironmentSettings {
  tenantId: string | null;
  subscriptionIds: string[];
  keyVaultResourceIds: string[];
  cloudName: string | null;
  includeGraphOwners: boolean;
  includeGraphOwnerDirectory: boolean;
  includeKeyVaultVersions: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AzureSubscriptionSummary {
  id: string;
  name: string;
  tenantId: string | null;
  state: string | null;
  isDefault: boolean;
}

export interface AzureEnvironmentStatus {
  checkedAt: string;
  azureCliPath: string | null;
  signedIn: boolean;
  cloudName: string | null;
  tenantId: string | null;
  subscriptionId: string | null;
  subscriptionName: string | null;
  username: string | null;
  availableSubscriptions: AzureSubscriptionSummary[];
  message: string;
}

export type AzureLoginState = "idle" | "running" | "succeeded" | "failed";

export interface AzureLoginStatus {
  runId: string | null;
  status: AzureLoginState;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  verificationUrl: string | null;
  userCode: string | null;
  logs: string[];
}

export interface AzureSettingsResponse {
  settings: AzureEnvironmentSettings;
  status: AzureEnvironmentStatus;
  login: AzureLoginStatus;
  canManage: boolean;
}

export type AuthRole = "Viewer" | "Operator" | "Admin";

export type AuthAccessLevel = "Viewer" | "Operator" | "Admin" | "No Access";

export interface DashboardAuthState {
  mode: "local" | "oidc" | "hybrid";
  source: "local" | "oidc";
  username: string;
  displayName: string | null;
  accessLevel: AuthAccessLevel;
  canOperate: boolean;
  canAdmin: boolean;
  signInPath: string;
  signOutPath: string;
}

export interface AuthActor {
  username: string;
  displayName: string | null;
  source: "local" | "oidc";
  accessLevel: AuthAccessLevel;
}
