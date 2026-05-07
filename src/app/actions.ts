"use server";

import { revalidatePath } from "next/cache";
import type { OwnerMatchType, RenewalHandoffStatus, WorkflowStatus } from "@/types";
import { executeAzureRotation as rotateInAzure } from "@/lib/azure-rotation";
import { AuthError, requireOperatorAccess } from "@/lib/auth";
import {
  closeRenewalCase as closeCase,
  createRenewalCase as openRenewalCase,
  deleteOwnerOverride as removeOwnerOverride,
  getCredentialForRenewal,
  getRenewalCase,
  markRenewalValidated as validateRenewalCase,
  recordRenewalRotation,
  resolveOwnerIdentity,
  updateStatus,
  updateRenewalCase as saveRenewalCase,
  upsertOwnerOverride,
  upsertOwnerOverridesForParents
} from "@/lib/repository";

const VALID_STATUSES: WorkflowStatus[] = [
  "not_started",
  "owner_contacted",
  "rotation_scheduled",
  "rotated",
  "ignored"
];
const VALID_MATCH_TYPES: OwnerMatchType[] = ["credential_id", "parent_id", "parent_name", "vault_name"];
const VALID_HANDOFF_STATUSES: RenewalHandoffStatus[] = [
  "not_contacted",
  "contacted",
  "waiting_on_owner",
  "escalated",
  "ready_to_validate"
];

export async function updateCredentialStatus(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const id = Number(formData.get("id"));
  const status = formData.get("status") as WorkflowStatus;
  if (!Number.isFinite(id) || !VALID_STATUSES.includes(status)) return;
  updateStatus(id, status);
  revalidatePath("/");
}

export async function saveOwnerOverride(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const matchType = String(formData.get("matchType") ?? "") as OwnerMatchType;
  const matchValue = String(formData.get("matchValue") ?? "");
  const owner = ownerFromForm(formData);
  const notes = String(formData.get("notes") ?? "").trim();
  if (!VALID_MATCH_TYPES.includes(matchType) || !matchValue || !owner) return;
  upsertOwnerOverride({
    matchType,
    matchValue,
    ownerName: owner.ownerName,
    ownerEmail: owner.ownerEmail,
    notes: notes || "Created from dashboard"
  });
  revalidatePath("/");
}

export async function saveBulkOwnerOverride(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const parentIds = formData.getAll("parentId").map((value) => String(value));
  const owner = ownerFromForm(formData);
  if (!parentIds.length || !owner) return;

  upsertOwnerOverridesForParents({
    parentIds,
    ownerName: owner.ownerName,
    ownerEmail: owner.ownerEmail,
    notes: "Bulk assigned from dashboard"
  });
  revalidatePath("/");
}

export async function deleteOwnerOverride(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  removeOwnerOverride(id);
  revalidatePath("/");
}

export async function createRenewalCase(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const credentialItemId = Number(formData.get("credentialItemId"));
  if (!Number.isFinite(credentialItemId)) return;
  const owner = ownerFromForm(formData);
  openRenewalCase({
    credentialItemId,
    dueAt: clean(formData.get("dueAt")),
    ownerName: owner?.ownerName ?? clean(formData.get("ownerName")),
    ownerEmail: owner?.ownerEmail ?? clean(formData.get("ownerEmail")),
    notes: clean(formData.get("notes")),
    reminderAt: clean(formData.get("reminderAt")),
    lastContactedAt: clean(formData.get("lastContactedAt")),
    escalationOwner: clean(formData.get("escalationOwner")),
    handoffStatus: cleanHandoffStatus(formData.get("handoffStatus"))
  });
  revalidatePath("/");
}

export async function updateRenewalCase(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const caseId = Number(formData.get("caseId"));
  if (!Number.isFinite(caseId)) return;
  const owner = ownerFromForm(formData);
  saveRenewalCase({
    caseId,
    dueAt: clean(formData.get("dueAt")),
    ownerName: owner?.ownerName ?? clean(formData.get("ownerName")),
    ownerEmail: owner?.ownerEmail ?? clean(formData.get("ownerEmail")),
    notes: clean(formData.get("notes")),
    reminderAt: clean(formData.get("reminderAt")),
    lastContactedAt: clean(formData.get("lastContactedAt")),
    escalationOwner: clean(formData.get("escalationOwner")),
    handoffStatus: cleanHandoffStatus(formData.get("handoffStatus")),
    keyVaultCopyVaultName: clean(formData.get("keyVaultCopyVaultName")),
    keyVaultCopySecretName: clean(formData.get("keyVaultCopySecretName"))
  });
  revalidatePath("/");
}

export async function executeRenewalRotation(formData: FormData): Promise<{
  ok: boolean;
  message: string;
  oneTimeSecretValue: string | null;
  dryRun: boolean;
}> {
  try {
    await requireOperatorAccess();
    const caseId = Number(formData.get("caseId"));
    if (!Number.isFinite(caseId)) {
      return { ok: false, message: "Missing renewal case", oneTimeSecretValue: null, dryRun: false };
    }
    const renewalCase = getRenewalCase(caseId);
    const item = getCredentialForRenewal(renewalCase.credentialItemId);
    if (!item) {
      return { ok: false, message: "Credential is no longer active", oneTimeSecretValue: null, dryRun: false };
    }

    const result = await rotateInAzure({
      item,
      confirmation: String(formData.get("confirmation") ?? ""),
      secretMode: clean(formData.get("secretMode")) === "provided" ? "provided" : "generated",
      providedSecretValue: String(formData.get("providedSecretValue") ?? ""),
      newCredentialDisplayName: clean(formData.get("newCredentialDisplayName")) ?? undefined,
      replacementExpiresAt: clean(formData.get("replacementExpiresAt")),
      keyVaultCopyVaultName: clean(formData.get("keyVaultCopyVaultName")),
      keyVaultCopySecretName: clean(formData.get("keyVaultCopySecretName")),
      dryRun: formData.get("dryRun") === "on"
    });
    if (!result.dryRun) {
      recordRenewalRotation({
        caseId,
        replacementCredentialId: result.replacementCredentialId,
        replacementExpiresAt: result.replacementExpiresAt,
        keyVaultCopyVaultName: result.keyVaultCopyVaultName,
        keyVaultCopySecretName: result.keyVaultCopySecretName,
        note: result.summary,
        details: result.details
      });
    }
    revalidatePath("/");
    return { ok: true, message: result.summary, oneTimeSecretValue: result.oneTimeSecretValue, dryRun: result.dryRun };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof AuthError
          ? "Operator access is required to run renewal rotations"
          : error instanceof Error
            ? error.message
            : String(error),
      oneTimeSecretValue: null,
      dryRun: false
    };
  }
}

export async function markRenewalValidated(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const caseId = Number(formData.get("caseId"));
  if (!Number.isFinite(caseId)) return;
  validateRenewalCase(caseId, clean(formData.get("note")) ?? "Replacement validated");
  revalidatePath("/");
}

export async function closeRenewalCase(formData: FormData): Promise<void> {
  await requireOperatorAccess();
  const caseId = Number(formData.get("caseId"));
  if (!Number.isFinite(caseId)) return;
  closeCase(caseId, clean(formData.get("note")) ?? "Renewal case closed");
  revalidatePath("/");
}

function clean(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function ownerFromForm(formData: FormData): { ownerName: string; ownerEmail: string | null } | null {
  return resolveOwnerIdentity(clean(formData.get("ownerLookup")) ?? clean(formData.get("ownerName")));
}

function cleanHandoffStatus(value: FormDataEntryValue | null): RenewalHandoffStatus | null {
  const text = clean(value) as RenewalHandoffStatus | null;
  return text && VALID_HANDOFF_STATUSES.includes(text) ? text : null;
}
