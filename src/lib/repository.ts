import type { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "./db";
import { daysUntilExpiry, riskBucket } from "./risk";
import { classifyRotation, isRenewalActionable } from "./rotation";
import type {
  DashboardCoverage,
  DashboardItem,
  DashboardOwnerOverride,
  DashboardStatusHistory,
  DashboardSummary,
  InventorySource,
  NormalizedCredential,
  RenewalCase,
  RenewalCaseStatus,
  RenewalEvent,
  RenewalEventType,
  RenewalHandoffStatus,
  WorkflowStatus
} from "@/types";
import { assertNoSecretValueFields } from "./secret-guard";

function nowIso(): string {
  return new Date().toISOString();
}

export function upsertCredentials(
  credentials: NormalizedCredential[],
  source: string,
  db: DatabaseSync = openDatabase(),
  options: { markMissingRemoved?: boolean } = {}
): { seen: number; changed: number } {
  migrate(db);
  const markMissingRemoved = options.markMissingRemoved ?? true;
  const startedAt = nowIso();
  const syncInsert = db.prepare(
    "INSERT INTO sync_runs (source, started_at, status) VALUES (?, ?, 'partial')"
  );
  const syncRun = syncInsert.run(source, startedAt);
  const seenKeys = new Set(credentials.map((credential) => credential.naturalKey));
  if (seenKeys.size !== credentials.length) {
    throw new Error("DuplicateNaturalKeyError");
  }

  let changed = 0;
  const select = db.prepare("SELECT id FROM credential_items WHERE natural_key = ?");
  const insert = db.prepare(`
    INSERT INTO credential_items (
      natural_key, source, source_tenant_id, subscription_id, resource_group,
      parent_id, parent_name, credential_id, credential_name, credential_type,
      expires_at, owner_hint, first_seen_at, last_seen_at, source_updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE credential_items
    SET source_tenant_id = ?, subscription_id = ?, resource_group = ?,
        parent_id = ?, parent_name = ?, credential_id = ?, credential_name = ?,
        credential_type = ?, expires_at = ?, owner_hint = ?, last_seen_at = ?,
        source_updated_at = ?, removed_at = NULL, removal_reason = NULL, metadata_json = ?
    WHERE natural_key = ?
  `);
  const deleteSignals = db.prepare("DELETE FROM owner_signals WHERE credential_item_id = ?");
  const insertSignal = db.prepare(`
    INSERT INTO owner_signals (
      credential_item_id, source, owner_name, owner_email, confidence, evidence, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    db.exec("BEGIN");
    for (const credential of credentials) {
      const existing = select.get(credential.naturalKey) as { id: number } | undefined;
      let id = existing?.id;
      if (id) {
        update.run(
          credential.sourceTenantId,
          credential.subscriptionId,
          credential.resourceGroup,
          credential.parentId,
          credential.parentName,
          credential.credentialId,
          credential.credentialName,
          credential.credentialType,
          credential.expiresAt,
          credential.ownerHint,
          startedAt,
          credential.sourceUpdatedAt,
          JSON.stringify(credential.metadata),
          credential.naturalKey
        );
      } else {
        const result = insert.run(
          credential.naturalKey,
          credential.source,
          credential.sourceTenantId,
          credential.subscriptionId,
          credential.resourceGroup,
          credential.parentId,
          credential.parentName,
          credential.credentialId,
          credential.credentialName,
          credential.credentialType,
          credential.expiresAt,
          credential.ownerHint,
          startedAt,
          startedAt,
          credential.sourceUpdatedAt,
          JSON.stringify(credential.metadata)
        );
        id = Number(result.lastInsertRowid);
      }
      deleteSignals.run(id);
      insertSignal.run(
        id,
        credential.ownerSignalSource,
        credential.ownerHint,
        credential.ownerEmail,
        credential.ownerConfidence,
        credential.ownerEvidence,
        startedAt
      );
      changed += 1;
    }

    if (markMissingRemoved) {
      const staleRows = db
        .prepare("SELECT id, natural_key FROM credential_items WHERE source = ? AND removed_at IS NULL")
        .all(source) as { id: number; natural_key: string }[];
      const markRemoved = db.prepare(
        "UPDATE credential_items SET removed_at = ?, removal_reason = 'no_longer_visible' WHERE id = ?"
      );
      for (const row of staleRows) {
        if (!seenKeys.has(row.natural_key)) {
          markRemoved.run(startedAt, row.id);
        }
      }
    }

    db.prepare(
      "UPDATE sync_runs SET finished_at = ?, status = 'success', items_seen = ?, items_changed = ? WHERE id = ?"
    ).run(startedAt, credentials.length, changed, syncRun.lastInsertRowid);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { seen: credentials.length, changed };
}

export function recordCoverage(
  input: {
    source: string;
    tenantId?: string | null;
    subscriptionId?: string | null;
    resourceId: string;
    resourceName: string;
    configured: boolean;
    reachable: boolean;
    itemsSeen: number;
    itemsSkipped?: number;
    skipReason?: string | null;
    errorCode?: string | null;
  },
  db: DatabaseSync = openDatabase()
): void {
  migrate(db);
  const attempted = nowIso();
  db.prepare(`
    INSERT INTO source_coverage (
      source, tenant_id, subscription_id, resource_id, resource_name, configured, reachable,
      last_successful_sync_at, last_attempt_at, items_seen, items_skipped, skip_reason, error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, resource_id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      subscription_id = excluded.subscription_id,
      resource_name = excluded.resource_name,
      configured = excluded.configured,
      reachable = excluded.reachable,
      last_successful_sync_at = excluded.last_successful_sync_at,
      last_attempt_at = excluded.last_attempt_at,
      items_seen = excluded.items_seen,
      items_skipped = excluded.items_skipped,
      skip_reason = excluded.skip_reason,
      error_code = excluded.error_code
  `).run(
    input.source,
    input.tenantId ?? null,
    input.subscriptionId ?? null,
    input.resourceId,
    input.resourceName,
    input.configured ? 1 : 0,
    input.reachable ? 1 : 0,
    input.reachable ? attempted : null,
    attempted,
    input.itemsSeen,
    input.itemsSkipped ?? 0,
    input.skipReason ?? null,
    input.errorCode ?? null
  );
}

export function clearCoverageForSource(source: string, db: DatabaseSync = openDatabase()): void {
  migrate(db);
  db.prepare("DELETE FROM source_coverage WHERE source = ?").run(source);
}

export function listDashboardItems(db: DatabaseSync = openDatabase()): DashboardItem[] {
  migrate(db);
  const rows = db
    .prepare(
      `
      SELECT
        ci.id, ci.natural_key, ci.source, ci.source_tenant_id, ci.subscription_id, ci.resource_group,
        ci.parent_id, ci.parent_name,
        ci.credential_id, ci.credential_name, ci.credential_type,
        ci.expires_at, ci.status, ci.last_seen_at, ci.source_updated_at, ci.removed_at, ci.metadata_json,
        COALESCE(oo.owner_name, os.owner_name) AS owner_name,
        COALESCE(oo.owner_email, os.owner_email) AS owner_email,
        CASE WHEN oo.id IS NOT NULL THEN 'high' ELSE COALESCE(os.confidence, 'unknown') END AS owner_confidence,
        CASE WHEN oo.id IS NOT NULL THEN 'Manual override' ELSE os.evidence END AS owner_evidence
      FROM credential_items ci
      LEFT JOIN owner_overrides oo
        ON (
          (oo.match_type = 'credential_id' AND oo.match_value = ci.credential_id) OR
          (oo.match_type = 'parent_id' AND oo.match_value = ci.parent_id) OR
          (oo.match_type = 'parent_name' AND oo.match_value = ci.parent_name) OR
          (oo.match_type = 'vault_name' AND oo.match_value = ci.parent_name)
        )
      LEFT JOIN owner_signals os ON os.credential_item_id = ci.id
      WHERE ci.removed_at IS NULL
      ORDER BY
        CASE
          WHEN ci.expires_at IS NULL THEN 5
          WHEN date(ci.expires_at) < date('now') THEN 0
          WHEN julianday(ci.expires_at) - julianday('now') <= 30 THEN 1
          WHEN julianday(ci.expires_at) - julianday('now') <= 60 THEN 2
          WHEN julianday(ci.expires_at) - julianday('now') <= 90 THEN 3
          ELSE 4
        END,
        ci.expires_at ASC,
        ci.parent_name ASC
    `
    )
    .all() as Array<Record<string, unknown>>;

  const histories = statusHistoryByItemId(
    rows.map((row) => Number(row.id)),
    db
  );
  const renewalCases = renewalCasesByItemId(
    rows.map((row) => Number(row.id)),
    db
  );

  return rows.map((row) => {
    const days = daysUntilExpiry(row.expires_at as string | null);
    const id = Number(row.id);
    const metadata = parseMetadata(row.metadata_json);
    const rotation = classifyRotation({
      source: row.source as DashboardItem["source"],
      credentialType: String(row.credential_type),
      metadata
    });
    return {
      id,
      naturalKey: String(row.natural_key),
      source: row.source as DashboardItem["source"],
      sourceTenantId: row.source_tenant_id as string | null,
      subscriptionId: row.subscription_id as string | null,
      resourceGroup: row.resource_group as string | null,
      parentId: String(row.parent_id),
      parentName: String(row.parent_name),
      credentialId: String(row.credential_id),
      credentialName: String(row.credential_name),
      credentialType: row.credential_type as DashboardItem["credentialType"],
      expiresAt: row.expires_at as string | null,
      daysUntilExpiry: days,
      riskBucket: riskBucket(days),
      ownerName: row.owner_name as string | null,
      ownerEmail: row.owner_email as string | null,
      ownerConfidence: row.owner_confidence as DashboardItem["ownerConfidence"],
      ownerEvidence: row.owner_evidence as string | null,
      status: row.status as WorkflowStatus,
      lastSeenAt: String(row.last_seen_at),
      sourceUpdatedAt: row.source_updated_at as string | null,
      removedAt: row.removed_at as string | null,
      metadata,
      rotationMode: rotation.mode,
      rotationModeReason: rotation.reason,
      renewalCase: renewalCases.get(id) ?? null,
      coverageState: "ok",
      statusHistory: histories.get(id) ?? []
    };
  });
}

function parseMetadata(value: unknown): DashboardItem["metadata"] {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string | number | boolean | null] => {
        const item = entry[1];
        return item === null || ["string", "number", "boolean"].includes(typeof item);
      })
    );
  } catch {
    return {};
  }
}

function statusHistoryByItemId(ids: number[], db: DatabaseSync): Map<number, DashboardStatusHistory[]> {
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isFinite(id));
  const histories = new Map<number, DashboardStatusHistory[]>();
  if (!uniqueIds.length) return histories;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT credential_item_id, from_status, to_status, note, changed_at, changed_by
      FROM status_history
      WHERE credential_item_id IN (${placeholders})
      ORDER BY changed_at DESC, id DESC
    `
    )
    .all(...uniqueIds) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const id = Number(row.credential_item_id);
    const existing = histories.get(id) ?? [];
    if (existing.length >= 3) continue;
    existing.push({
      fromStatus: row.from_status as WorkflowStatus | null,
      toStatus: row.to_status as WorkflowStatus,
      note: row.note as string | null,
      changedAt: String(row.changed_at),
      changedBy: String(row.changed_by)
    });
    histories.set(id, existing);
  }

  return histories;
}

function renewalCasesByItemId(ids: number[], db: DatabaseSync): Map<number, RenewalCase> {
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isFinite(id));
  const cases = new Map<number, RenewalCase>();
  if (!uniqueIds.length) return cases;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT
        id, credential_item_id, status, due_at, owner_name, owner_email, notes,
        reminder_at, last_contacted_at, escalation_owner, handoff_status,
        replacement_credential_id, replacement_expires_at,
        key_vault_copy_vault_name, key_vault_copy_secret_name,
        created_at, updated_at, closed_at
      FROM renewal_cases
      WHERE credential_item_id IN (${placeholders})
        AND closed_at IS NULL
      ORDER BY updated_at DESC, id DESC
    `
    )
    .all(...uniqueIds) as Array<Record<string, unknown>>;

  const events = renewalEventsByCaseId(
    rows.map((row) => Number(row.id)),
    db
  );
  for (const row of rows) {
    const credentialItemId = Number(row.credential_item_id);
    if (cases.has(credentialItemId)) continue;
    cases.set(credentialItemId, renewalCaseFromRow(row, events.get(Number(row.id)) ?? []));
  }
  return cases;
}

function renewalEventsByCaseId(caseIds: number[], db: DatabaseSync): Map<number, RenewalEvent[]> {
  const uniqueIds = [...new Set(caseIds)].filter((id) => Number.isFinite(id));
  const events = new Map<number, RenewalEvent[]>();
  if (!uniqueIds.length) return events;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      SELECT id, renewal_case_id, event_type, note, details_json, created_at, created_by
      FROM renewal_events
      WHERE renewal_case_id IN (${placeholders})
      ORDER BY created_at DESC, id DESC
    `
    )
    .all(...uniqueIds) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const renewalCaseId = Number(row.renewal_case_id);
    const existing = events.get(renewalCaseId) ?? [];
    if (existing.length >= 6) continue;
    existing.push(renewalEventFromRow(row));
    events.set(renewalCaseId, existing);
  }
  return events;
}

function renewalCaseFromRow(row: Record<string, unknown>, events: RenewalEvent[]): RenewalCase {
  return {
    id: Number(row.id),
    credentialItemId: Number(row.credential_item_id),
    status: row.status as RenewalCaseStatus,
    dueAt: row.due_at as string | null,
    ownerName: row.owner_name as string | null,
    ownerEmail: row.owner_email as string | null,
    notes: row.notes as string | null,
    reminderAt: row.reminder_at as string | null,
    lastContactedAt: row.last_contacted_at as string | null,
    escalationOwner: row.escalation_owner as string | null,
    handoffStatus: (row.handoff_status as RenewalHandoffStatus | null) ?? "not_contacted",
    replacementCredentialId: row.replacement_credential_id as string | null,
    replacementExpiresAt: row.replacement_expires_at as string | null,
    keyVaultCopyVaultName: row.key_vault_copy_vault_name as string | null,
    keyVaultCopySecretName: row.key_vault_copy_secret_name as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    closedAt: row.closed_at as string | null,
    events
  };
}

function renewalEventFromRow(row: Record<string, unknown>): RenewalEvent {
  return {
    id: Number(row.id),
    renewalCaseId: Number(row.renewal_case_id),
    eventType: row.event_type as RenewalEventType,
    note: row.note as string | null,
    details: parseMetadata(row.details_json),
    createdAt: String(row.created_at),
    createdBy: String(row.created_by)
  };
}

export function dashboardSummary(db: DatabaseSync = openDatabase()): DashboardSummary {
  const items = listDashboardItems(db);
  const renewalItems = items.filter((item) => isRenewalActionable(item.rotationMode));
  const coverageRows = db
    .prepare("SELECT reachable, items_skipped FROM source_coverage")
    .all() as { reachable: number; items_skipped: number }[];
  const lastRun = db
    .prepare("SELECT finished_at FROM sync_runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1")
    .get() as { finished_at: string } | undefined;

  return {
    total: items.length,
    expired: renewalItems.filter((item) => item.riskBucket === "expired").length,
    next30: renewalItems.filter((item) => item.riskBucket === "0-30").length,
    next60: renewalItems.filter((item) => item.riskBucket === "31-60").length,
    next90: renewalItems.filter((item) => item.riskBucket === "61-90").length,
    unknownOwners: renewalItems.filter((item) => !item.ownerName).length,
    lowConfidenceOwners: renewalItems.filter((item) => item.ownerConfidence === "low").length,
    excludedFromRenewal: items.filter((item) => !isRenewalActionable(item.rotationMode)).length,
    coverageGaps: coverageRows.filter((row) => !row.reachable || row.items_skipped > 0).length,
    lastSuccessfulSyncAt: lastRun?.finished_at ?? null
  };
}

export function listCoverage(db: DatabaseSync = openDatabase()): DashboardCoverage[] {
  migrate(db);
  const rows = db
    .prepare(
      `
      SELECT
        source, tenant_id, subscription_id, resource_id, resource_name, configured, reachable,
        last_successful_sync_at, last_attempt_at, items_seen, items_skipped, skip_reason, error_code
      FROM source_coverage
      ORDER BY
        CASE
          WHEN reachable = 0 THEN 0
          WHEN items_skipped > 0 THEN 1
          ELSE 2
        END,
        source ASC,
        resource_name ASC
    `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const reachable = Boolean(row.reachable);
    const itemsSkipped = Number(row.items_skipped);
    const lastAttemptAt = String(row.last_attempt_at);
    return {
      source: row.source as InventorySource,
      tenantId: row.tenant_id as string | null,
      subscriptionId: row.subscription_id as string | null,
      resourceId: row.resource_id as string | null,
      resourceName: String(row.resource_name),
      configured: Boolean(row.configured),
      reachable,
      itemsSeen: Number(row.items_seen),
      itemsSkipped,
      skipReason: row.skip_reason as string | null,
      errorCode: row.error_code as string | null,
      lastSuccessfulSyncAt: row.last_successful_sync_at as string | null,
      lastAttemptAt,
      health: coverageHealth(reachable, itemsSkipped, lastAttemptAt)
    };
  });
}

export function listOwnerOverrides(db: DatabaseSync = openDatabase()): DashboardOwnerOverride[] {
  migrate(db);
  const rows = db
    .prepare(
      `
      SELECT
        oo.id, oo.match_type, oo.match_value, oo.owner_name, oo.owner_email, oo.notes, oo.created_at, oo.updated_at,
        (
          SELECT COUNT(*)
          FROM credential_items ci
          WHERE ci.removed_at IS NULL
            AND (
              (oo.match_type = 'credential_id' AND oo.match_value = ci.credential_id) OR
              (oo.match_type = 'parent_id' AND oo.match_value = ci.parent_id) OR
              (oo.match_type = 'parent_name' AND oo.match_value = ci.parent_name) OR
              (oo.match_type = 'vault_name' AND oo.match_value = ci.parent_name)
            )
        ) AS active_credential_count
      FROM owner_overrides oo
      ORDER BY oo.owner_name ASC, oo.match_type ASC, oo.match_value ASC
    `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    matchType: row.match_type as DashboardOwnerOverride["matchType"],
    matchValue: String(row.match_value),
    ownerName: String(row.owner_name),
    ownerEmail: row.owner_email as string | null,
    notes: row.notes as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    activeCredentialCount: Number(row.active_credential_count)
  }));
}

function coverageHealth(reachable: boolean, itemsSkipped: number, lastAttemptAt: string): DashboardCoverage["health"] {
  if (!reachable) return "failed";
  const attempted = new Date(lastAttemptAt).getTime();
  if (!Number.isFinite(attempted) || Date.now() - attempted > 36 * 60 * 60 * 1000) return "stale";
  if (itemsSkipped > 0) return "warning";
  return "ok";
}

export function updateStatus(id: number, toStatus: WorkflowStatus, note = "Updated from dashboard"): void {
  const db = openDatabase();
  migrate(db);
  try {
    db.exec("BEGIN");
    updateStatusInTransaction(db, id, toStatus, note);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateStatusInTransaction(db: DatabaseSync, id: number, toStatus: WorkflowStatus, note: string): void {
  const existing = db.prepare("SELECT status FROM credential_items WHERE id = ?").get(id) as
    | { status: WorkflowStatus }
    | undefined;
  if (!existing || existing.status === toStatus) return;
  const timestamp = nowIso();
  db.prepare("UPDATE credential_items SET status = ? WHERE id = ?").run(toStatus, id);
  db.prepare(
    "INSERT INTO status_history (credential_item_id, from_status, to_status, note, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, 'operator')"
  ).run(id, existing.status, toStatus, note, timestamp);
}

export function createRenewalCase(input: {
  credentialItemId: number;
  dueAt?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  notes?: string | null;
  reminderAt?: string | null;
  lastContactedAt?: string | null;
  escalationOwner?: string | null;
  handoffStatus?: RenewalHandoffStatus | null;
}): RenewalCase {
  const db = openDatabase();
  migrate(db);
  const timestamp = nowIso();
  try {
    db.exec("BEGIN");
    const existing = activeRenewalCaseRow(db, input.credentialItemId);
    let caseId: number;
    if (existing) {
      caseId = Number(existing.id);
      db.prepare(
        `
        UPDATE renewal_cases
        SET due_at = ?, owner_name = ?, owner_email = ?, notes = ?,
            reminder_at = ?, last_contacted_at = ?, escalation_owner = ?, handoff_status = ?, updated_at = ?
        WHERE id = ?
      `
      ).run(
        input.dueAt ?? (existing.due_at as string | null) ?? null,
        input.ownerName ?? (existing.owner_name as string | null) ?? null,
        input.ownerEmail ?? (existing.owner_email as string | null) ?? null,
        input.notes ?? (existing.notes as string | null) ?? null,
        input.reminderAt ?? (existing.reminder_at as string | null) ?? null,
        input.lastContactedAt ?? (existing.last_contacted_at as string | null) ?? null,
        input.escalationOwner ?? (existing.escalation_owner as string | null) ?? null,
        input.handoffStatus ?? (existing.handoff_status as RenewalHandoffStatus | null) ?? "not_contacted",
        timestamp,
        caseId
      );
      appendRenewalEventInTransaction(db, caseId, "case_updated", "Renewal case updated", {
        dueAt: input.dueAt ?? null,
        ownerName: input.ownerName ?? null,
        handoffStatus: input.handoffStatus ?? null
      });
    } else {
      const result = db
        .prepare(
          `
          INSERT INTO renewal_cases (
            credential_item_id, status, due_at, owner_name, owner_email, notes,
            reminder_at, last_contacted_at, escalation_owner, handoff_status, created_at, updated_at
          ) VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.credentialItemId,
          input.dueAt ?? null,
          input.ownerName ?? null,
          input.ownerEmail ?? null,
          input.notes ?? null,
          input.reminderAt ?? null,
          input.lastContactedAt ?? null,
          input.escalationOwner ?? null,
          input.handoffStatus ?? "not_contacted",
          timestamp,
          timestamp
        );
      caseId = Number(result.lastInsertRowid);
      appendRenewalEventInTransaction(db, caseId, "case_created", "Renewal case opened", {
        dueAt: input.dueAt ?? null,
        ownerName: input.ownerName ?? null,
        handoffStatus: input.handoffStatus ?? "not_contacted"
      });
    }
    updateStatusInTransaction(db, input.credentialItemId, "owner_contacted", "Renewal case opened");
    db.exec("COMMIT");
    return getRenewalCase(caseId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateRenewalCase(input: {
  caseId: number;
  dueAt?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  notes?: string | null;
  reminderAt?: string | null;
  lastContactedAt?: string | null;
  escalationOwner?: string | null;
  handoffStatus?: RenewalHandoffStatus | null;
  keyVaultCopyVaultName?: string | null;
  keyVaultCopySecretName?: string | null;
}): RenewalCase {
  const db = openDatabase();
  migrate(db);
  const existing = getRenewalCase(input.caseId, db);
  const timestamp = nowIso();
  try {
    db.exec("BEGIN");
    db.prepare(
      `
      UPDATE renewal_cases
      SET due_at = ?, owner_name = ?, owner_email = ?, notes = ?,
          reminder_at = ?, last_contacted_at = ?, escalation_owner = ?, handoff_status = ?,
          key_vault_copy_vault_name = ?, key_vault_copy_secret_name = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(
      input.dueAt ?? existing.dueAt,
      input.ownerName ?? existing.ownerName,
      input.ownerEmail ?? existing.ownerEmail,
      input.notes ?? existing.notes,
      input.reminderAt ?? existing.reminderAt,
      input.lastContactedAt ?? existing.lastContactedAt,
      input.escalationOwner ?? existing.escalationOwner,
      input.handoffStatus ?? existing.handoffStatus,
      input.keyVaultCopyVaultName ?? existing.keyVaultCopyVaultName,
      input.keyVaultCopySecretName ?? existing.keyVaultCopySecretName,
      timestamp,
      input.caseId
    );
    appendRenewalEventInTransaction(db, input.caseId, "case_updated", "Renewal case updated", {
      dueAt: input.dueAt ?? existing.dueAt,
      ownerName: input.ownerName ?? existing.ownerName,
      reminderAt: input.reminderAt ?? existing.reminderAt,
      lastContactedAt: input.lastContactedAt ?? existing.lastContactedAt,
      escalationOwner: input.escalationOwner ?? existing.escalationOwner,
      handoffStatus: input.handoffStatus ?? existing.handoffStatus,
      keyVaultCopyVaultName: input.keyVaultCopyVaultName ?? existing.keyVaultCopyVaultName,
      keyVaultCopySecretName: input.keyVaultCopySecretName ?? existing.keyVaultCopySecretName
    });
    db.exec("COMMIT");
    return getRenewalCase(input.caseId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordRenewalRotation(input: {
  caseId: number;
  replacementCredentialId?: string | null;
  replacementExpiresAt?: string | null;
  keyVaultCopyVaultName?: string | null;
  keyVaultCopySecretName?: string | null;
  note?: string | null;
  details?: Record<string, string | number | boolean | null>;
}): RenewalCase {
  const db = openDatabase();
  migrate(db);
  const existing = getRenewalCase(input.caseId, db);
  const timestamp = nowIso();
  try {
    db.exec("BEGIN");
    db.prepare(
      `
      UPDATE renewal_cases
      SET status = 'rotation_created',
          replacement_credential_id = ?,
          replacement_expires_at = ?,
          key_vault_copy_vault_name = ?,
          key_vault_copy_secret_name = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(
      input.replacementCredentialId ?? existing.replacementCredentialId,
      input.replacementExpiresAt ?? existing.replacementExpiresAt,
      input.keyVaultCopyVaultName ?? existing.keyVaultCopyVaultName,
      input.keyVaultCopySecretName ?? existing.keyVaultCopySecretName,
      timestamp,
      input.caseId
    );
    appendRenewalEventInTransaction(db, input.caseId, "rotation_executed", input.note ?? "Replacement created", {
      replacementCredentialId: input.replacementCredentialId ?? null,
      replacementExpiresAt: input.replacementExpiresAt ?? null,
      keyVaultCopyVaultName: input.keyVaultCopyVaultName ?? null,
      keyVaultCopySecretName: input.keyVaultCopySecretName ?? null,
      ...(input.details ?? {})
    });
    updateStatusInTransaction(db, existing.credentialItemId, "rotation_scheduled", "Replacement created; pending validation");
    db.exec("COMMIT");
    return getRenewalCase(input.caseId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markRenewalValidated(caseId: number, note = "Replacement validated"): RenewalCase {
  const db = openDatabase();
  migrate(db);
  const existing = getRenewalCase(caseId, db);
  const timestamp = nowIso();
  try {
    db.exec("BEGIN");
    db.prepare("UPDATE renewal_cases SET status = 'validated', updated_at = ? WHERE id = ?").run(timestamp, caseId);
    appendRenewalEventInTransaction(db, caseId, "validated", note, {});
    updateStatusInTransaction(db, existing.credentialItemId, "rotated", "Replacement validated");
    db.exec("COMMIT");
    return getRenewalCase(caseId, db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function closeRenewalCase(caseId: number, note = "Renewal case closed"): RenewalCase {
  const db = openDatabase();
  migrate(db);
  const existing = getRenewalCase(caseId, db);
  const timestamp = nowIso();
  try {
    db.exec("BEGIN");
    db.prepare("UPDATE renewal_cases SET status = 'closed', updated_at = ?, closed_at = ? WHERE id = ?").run(
      timestamp,
      timestamp,
      caseId
    );
    appendRenewalEventInTransaction(db, caseId, "closed", note, {});
    updateStatusInTransaction(db, existing.credentialItemId, "rotated", "Renewal case closed");
    db.exec("COMMIT");
    return getRenewalCase(caseId, db, true);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getCredentialForRenewal(id: number): DashboardItem | null {
  return listDashboardItems().find((item) => item.id === id) ?? null;
}

export function getRenewalCase(id: number, db: DatabaseSync = openDatabase(), includeClosed = false): RenewalCase {
  migrate(db);
  const row = db
    .prepare(
      `
      SELECT
        id, credential_item_id, status, due_at, owner_name, owner_email, notes,
        reminder_at, last_contacted_at, escalation_owner, handoff_status,
        replacement_credential_id, replacement_expires_at,
        key_vault_copy_vault_name, key_vault_copy_secret_name,
        created_at, updated_at, closed_at
      FROM renewal_cases
      WHERE id = ?
        ${includeClosed ? "" : "AND closed_at IS NULL"}
    `
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("RenewalCaseNotFound");
  return renewalCaseFromRow(row, renewalEventsByCaseId([id], db).get(id) ?? []);
}

function activeRenewalCaseRow(db: DatabaseSync, credentialItemId: number): Record<string, unknown> | null {
  return (
    (db
      .prepare("SELECT * FROM renewal_cases WHERE credential_item_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(credentialItemId) as Record<string, unknown> | undefined) ?? null
  );
}

function appendRenewalEventInTransaction(
  db: DatabaseSync,
  renewalCaseId: number,
  eventType: RenewalEventType,
  note: string | null,
  details: Record<string, string | number | boolean | null>
): void {
  assertNoSecretValueFields({ note, details }, "renewalEvent");
  const timestamp = nowIso();
  db.prepare(
    `
    INSERT INTO renewal_events (renewal_case_id, event_type, note, details_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, 'operator')
  `
  ).run(renewalCaseId, eventType, note, JSON.stringify(details), timestamp);
}

export function upsertOwnerOverride(input: {
  matchType: string;
  matchValue: string;
  ownerName: string;
  ownerEmail?: string | null;
  notes?: string | null;
}): void {
  const db = openDatabase();
  migrate(db);
  const timestamp = nowIso();
  db.prepare(
    `
    INSERT INTO owner_overrides (match_type, match_value, owner_name, owner_email, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_type, match_value) DO UPDATE SET
      owner_name = excluded.owner_name,
      owner_email = excluded.owner_email,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `
  ).run(
    input.matchType,
    input.matchValue,
    input.ownerName,
    input.ownerEmail ?? null,
    input.notes ?? null,
    timestamp,
    timestamp
  );
}

export function upsertOwnerOverridesForParents(input: {
  parentIds: string[];
  ownerName: string;
  ownerEmail?: string | null;
  notes?: string | null;
}): number {
  const db = openDatabase();
  migrate(db);
  const timestamp = nowIso();
  const parentIds = [...new Set(input.parentIds.map((id) => id.trim()).filter(Boolean))];
  if (!parentIds.length) return 0;

  const upsert = db.prepare(
    `
    INSERT INTO owner_overrides (match_type, match_value, owner_name, owner_email, notes, created_at, updated_at)
    VALUES ('parent_id', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_type, match_value) DO UPDATE SET
      owner_name = excluded.owner_name,
      owner_email = excluded.owner_email,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `
  );

  try {
    db.exec("BEGIN");
    for (const parentId of parentIds) {
      upsert.run(
        parentId,
        input.ownerName,
        input.ownerEmail ?? null,
        input.notes ?? null,
        timestamp,
        timestamp
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return parentIds.length;
}

export function deleteOwnerOverride(id: number): void {
  const db = openDatabase();
  migrate(db);
  db.prepare("DELETE FROM owner_overrides WHERE id = ?").run(id);
}
