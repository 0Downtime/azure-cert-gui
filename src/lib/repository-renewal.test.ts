import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRenewalCase, listDashboardItems, markRenewalValidated, recordRenewalRotation, upsertCredentials } from "./repository";
import { SecretValueLeakError } from "./secret-guard";

function useTempDb(): void {
  process.env.GSTACK_DB_PATH = join(mkdtempSync(join(tmpdir(), "gstack-renewal-")), "test.sqlite");
}

function seedCredential(): number {
  upsertCredentials(
    [
      {
        naturalKey: "tenant:application:app:secret",
        source: "entra_application",
        sourceTenantId: "tenant",
        subscriptionId: null,
        resourceGroup: null,
        parentId: "app",
        parentName: "App",
        credentialId: "secret",
        credentialName: "client-secret",
        credentialType: "client_secret",
        expiresAt: "2026-06-01T00:00:00Z",
        ownerHint: "Owner",
        ownerEmail: "owner@example.com",
        ownerConfidence: "high",
        ownerSignalSource: "entra_owner",
        ownerEvidence: "test",
        sourceUpdatedAt: null,
        metadata: {}
      }
    ],
    "entra_application"
  );
  return listDashboardItems()[0].id;
}

describe("renewal cases", () => {
  it("creates an active renewal case and syncs dashboard status", () => {
    useTempDb();
    const credentialItemId = seedCredential();

    const renewalCase = createRenewalCase({
      credentialItemId,
      dueAt: "2026-05-20",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      notes: "rotate before sprint end",
      reminderAt: "2026-05-15",
      lastContactedAt: "2026-05-10",
      escalationOwner: "Security Ops",
      handoffStatus: "waiting_on_owner",
      actor: {
        username: "operator@example.com",
        displayName: "Test Operator",
        source: "oidc",
        accessLevel: "Operator"
      }
    });

    const [item] = listDashboardItems();
    expect(renewalCase.status).toBe("open");
    expect(renewalCase.handoffStatus).toBe("waiting_on_owner");
    expect(renewalCase.reminderAt).toBe("2026-05-15");
    expect(renewalCase.escalationOwner).toBe("Security Ops");
    expect(item.status).toBe("owner_contacted");
    expect(item.renewalCase?.events[0].eventType).toBe("case_created");
    expect(item.renewalCase?.events[0].createdBy).toBe("Test Operator <operator@example.com> (oidc:Operator)");
    expect(item.statusHistory[0].changedBy).toBe("Test Operator <operator@example.com> (oidc:Operator)");
  });

  it("records replacement metadata without storing secret values", () => {
    useTempDb();
    const credentialItemId = seedCredential();
    const renewalCase = createRenewalCase({ credentialItemId });

    recordRenewalRotation({
      caseId: renewalCase.id,
      replacementCredentialId: "new-key-id",
      replacementExpiresAt: "2027-01-01T00:00:00Z",
      details: { operation: "graph.addPassword" },
      actor: {
        username: "operator@example.com",
        displayName: null,
        source: "oidc",
        accessLevel: "Operator"
      }
    });
    const [item] = listDashboardItems();

    expect(item.status).toBe("rotation_scheduled");
    expect(item.renewalCase?.replacementCredentialId).toBe("new-key-id");
    expect(item.renewalCase?.events[0].details).toMatchObject({ operation: "graph.addPassword" });
    expect(item.renewalCase?.events[0].createdBy).toBe("operator@example.com (oidc:Operator)");
  });

  it("rejects secret-bearing renewal event details", () => {
    useTempDb();
    const credentialItemId = seedCredential();
    const renewalCase = createRenewalCase({ credentialItemId });

    expect(() =>
      recordRenewalRotation({
        caseId: renewalCase.id,
        details: { secretText: "must-not-persist" } as never
      })
    ).toThrow(SecretValueLeakError);
  });

  it("marks validation as rotated", () => {
    useTempDb();
    const credentialItemId = seedCredential();
    const renewalCase = createRenewalCase({ credentialItemId });

    markRenewalValidated(renewalCase.id);

    expect(listDashboardItems()[0].status).toBe("rotated");
  });
});
