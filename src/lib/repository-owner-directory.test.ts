import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listOwnerSuggestions,
  resolveOwnerIdentity,
  upsertCredentials,
  upsertOwnerDirectory,
  upsertOwnerOverride
} from "./repository";

function useTempDb(): void {
  process.env.GSTACK_DB_PATH = join(mkdtempSync(join(tmpdir(), "gstack-owner-directory-")), "test.sqlite");
}

describe("owner directory", () => {
  it("lists Entra users, manual mappings, and Entra owner signals as owner suggestions", () => {
    useTempDb();
    upsertOwnerDirectory([
      { ownerName: "Ada Lovelace", ownerEmail: "ada@example.com", source: "entra_user" },
      { ownerName: "Grace Hopper", ownerEmail: "grace@example.com", source: "entra_user" },
      { ownerName: "Certificate Owners", ownerEmail: "cert-owners@example.com", source: "entra_group" }
    ]);
    upsertOwnerOverride({
      matchType: "parent_id",
      matchValue: "manual-app",
      ownerName: "Platform Ops",
      ownerEmail: "platform@example.com"
    });
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
          credentialName: "Secret",
          credentialType: "client_secret",
          expiresAt: "2026-06-01T00:00:00Z",
          ownerHint: "Source Owner",
          ownerEmail: "source@example.com",
          ownerConfidence: "high",
          ownerSignalSource: "entra_owner",
          ownerEvidence: "test",
          sourceUpdatedAt: null,
          metadata: {}
        }
      ],
      "entra_application"
    );

    expect(listOwnerSuggestions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerName: "Ada Lovelace", ownerEmail: "ada@example.com", source: "entra_user" }),
        expect.objectContaining({ ownerName: "Grace Hopper", ownerEmail: "grace@example.com", source: "entra_user" }),
        expect.objectContaining({ ownerName: "Certificate Owners", ownerEmail: "cert-owners@example.com", source: "entra_group" }),
        expect.objectContaining({ ownerName: "Platform Ops", ownerEmail: "platform@example.com", source: "manual_override" }),
        expect.objectContaining({ ownerName: "Source Owner", ownerEmail: "source@example.com", source: "entra_owner" })
      ])
    );
  });

  it("resolves a single owner field from a name or email address", () => {
    useTempDb();
    upsertOwnerDirectory([
      { ownerName: "Certificate Owners", ownerEmail: "cert-owners@example.com", source: "entra_group" }
    ]);

    expect(resolveOwnerIdentity("Certificate Owners")).toEqual({
      ownerName: "Certificate Owners",
      ownerEmail: "cert-owners@example.com"
    });
    expect(resolveOwnerIdentity("cert-owners@example.com")).toEqual({
      ownerName: "Certificate Owners",
      ownerEmail: "cert-owners@example.com"
    });
    expect(resolveOwnerIdentity("new-owner@example.com")).toEqual({
      ownerName: "new-owner@example.com",
      ownerEmail: "new-owner@example.com"
    });
  });
});
