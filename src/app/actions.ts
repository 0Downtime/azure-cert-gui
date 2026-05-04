"use server";

import { revalidatePath } from "next/cache";
import type { OwnerMatchType, WorkflowStatus } from "@/types";
import {
  deleteOwnerOverride as removeOwnerOverride,
  updateStatus,
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

export async function updateCredentialStatus(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = formData.get("status") as WorkflowStatus;
  if (!Number.isFinite(id) || !VALID_STATUSES.includes(status)) return;
  updateStatus(id, status);
  revalidatePath("/");
}

export async function saveOwnerOverride(formData: FormData): Promise<void> {
  const matchType = String(formData.get("matchType") ?? "") as OwnerMatchType;
  const matchValue = String(formData.get("matchValue") ?? "");
  const ownerName = String(formData.get("ownerName") ?? "").trim();
  const ownerEmail = String(formData.get("ownerEmail") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!VALID_MATCH_TYPES.includes(matchType) || !matchValue || !ownerName) return;
  upsertOwnerOverride({
    matchType,
    matchValue,
    ownerName,
    ownerEmail: ownerEmail || null,
    notes: notes || "Created from dashboard"
  });
  revalidatePath("/");
}

export async function saveBulkOwnerOverride(formData: FormData): Promise<void> {
  const parentIds = formData.getAll("parentId").map((value) => String(value));
  const ownerName = String(formData.get("ownerName") ?? "").trim();
  const ownerEmail = String(formData.get("ownerEmail") ?? "").trim();
  if (!parentIds.length || !ownerName) return;

  upsertOwnerOverridesForParents({
    parentIds,
    ownerName,
    ownerEmail: ownerEmail || null,
    notes: "Bulk assigned from dashboard"
  });
  revalidatePath("/");
}

export async function deleteOwnerOverride(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  removeOwnerOverride(id);
  revalidatePath("/");
}
