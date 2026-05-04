"use server";

import { revalidatePath } from "next/cache";
import type { WorkflowStatus } from "@/types";
import { updateStatus, upsertOwnerOverride, upsertOwnerOverridesForParents } from "@/lib/repository";

const VALID_STATUSES: WorkflowStatus[] = [
  "not_started",
  "owner_contacted",
  "rotation_scheduled",
  "rotated",
  "ignored"
];

export async function updateCredentialStatus(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = formData.get("status") as WorkflowStatus;
  if (!Number.isFinite(id) || !VALID_STATUSES.includes(status)) return;
  updateStatus(id, status);
  revalidatePath("/");
}

export async function saveOwnerOverride(formData: FormData): Promise<void> {
  const matchType = String(formData.get("matchType") ?? "");
  const matchValue = String(formData.get("matchValue") ?? "");
  const ownerName = String(formData.get("ownerName") ?? "").trim();
  const ownerEmail = String(formData.get("ownerEmail") ?? "").trim();
  if (!matchType || !matchValue || !ownerName) return;
  upsertOwnerOverride({
    matchType,
    matchValue,
    ownerName,
    ownerEmail: ownerEmail || null,
    notes: "Created from dashboard"
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
