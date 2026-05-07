import { describe, expect, it } from "vitest";
import { executeAzureRotation, type AzureRotationRunner } from "./azure-rotation";
import type { DashboardItem } from "@/types";

function item(overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    id: 1,
    naturalKey: "tenant:application:app:secret",
    source: "entra_application",
    sourceTenantId: "tenant",
    subscriptionId: null,
    resourceGroup: null,
    parentId: "app-object-id",
    parentName: "App",
    credentialId: "old-secret-id",
    credentialName: "client-secret",
    credentialType: "client_secret",
    expiresAt: "2026-06-01T00:00:00Z",
    daysUntilExpiry: 30,
    riskBucket: "0-30",
    ownerName: "Owner",
    ownerEmail: "owner@example.com",
    ownerConfidence: "high",
    ownerEvidence: "test",
    status: "not_started",
    lastSeenAt: "2026-05-01T00:00:00Z",
    sourceUpdatedAt: null,
    removedAt: null,
    metadata: {},
    rotationMode: "owner_rotates",
    rotationModeReason: "test",
    renewalCase: null,
    coverageState: "ok",
    statusHistory: [],
    ...overrides
  };
}

function runner(response: unknown): {
  calls: string[][];
  setSecretCalls: { vaultName: string; secretName: string; secretValue: string; expiresAt: string | null }[];
  runner: AzureRotationRunner;
} {
  const calls: string[][] = [];
  const setSecretCalls: { vaultName: string; secretName: string; secretValue: string; expiresAt: string | null }[] = [];
  return {
    calls,
    setSecretCalls,
    runner: {
      async azJson<T>(args: string[]): Promise<T> {
        calls.push(args);
        return response as T;
      },
      async setKeyVaultSecret(input) {
        setSecretCalls.push(input);
        return response as Awaited<ReturnType<NonNullable<AzureRotationRunner["setKeyVaultSecret"]>>>;
      }
    }
  };
}

describe("Azure rotation helpers", () => {
  it("builds a Microsoft Graph addPassword request and returns the one-time secret", async () => {
    const fake = runner({
      keyId: "new-key",
      secretText: "one-time-secret",
      endDateTime: "2027-01-01T00:00:00Z"
    });

    const result = await executeAzureRotation({
      item: item(),
      confirmation: "client-secret",
      runner: fake.runner
    });

    expect(fake.calls[0]).toContain("post");
    expect(fake.calls[0]).toContain("https://graph.microsoft.com/v1.0/applications/app-object-id/addPassword");
    expect(result.replacementCredentialId).toBe("new-key");
    expect(result.oneTimeSecretValue).toBe("one-time-secret");
    expect(result.details).not.toHaveProperty("secretText");
  });

  it("rejects mismatched typed confirmation", async () => {
    await expect(
      executeAzureRotation({
        item: item(),
        confirmation: "wrong",
        runner: runner({}).runner
      })
    ).rejects.toThrow("RotationConfirmationMismatch");
  });

  it("rejects platform-managed credentials", async () => {
    await expect(
      executeAzureRotation({
        item: item({ rotationMode: "platform_managed" }),
        confirmation: "client-secret",
        runner: runner({}).runner
      })
    ).rejects.toThrow("RotationModeNotActionable");
  });

  it("previews a dry run without calling Azure", async () => {
    const fake = runner({});
    const result = await executeAzureRotation({
      item: item(),
      confirmation: "client-secret",
      dryRun: true,
      runner: fake.runner
    });

    expect(fake.calls).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.summary).toContain("No Azure changes");
  });

  it("builds Key Vault key rotation command", async () => {
    const fake = runner({ kid: "https://vault.vault.azure.net/keys/cmk/version" });
    const result = await executeAzureRotation({
      item: item({
        source: "key_vault_key",
        parentName: "vault",
        credentialName: "cmk",
        credentialType: "key",
        rotationMode: "owner_rotates"
      }),
      confirmation: "cmk",
      runner: fake.runner
    });

    expect(fake.calls[0]).toEqual(["keyvault", "key", "rotate", "--vault-name", "vault", "--name", "cmk"]);
    expect(result.replacementCredentialId).toContain("/keys/cmk/");
  });

  it("sets Key Vault secrets without putting secret values in Azure CLI argv", async () => {
    const fake = runner({
      id: "https://vault.vault.azure.net/secrets/api-token/version"
    });
    const result = await executeAzureRotation({
      item: item({
        source: "key_vault_secret",
        parentName: "vault",
        credentialName: "api-token",
        credentialType: "secret"
      }),
      confirmation: "api-token",
      secretMode: "provided",
      providedSecretValue: "provided-secret",
      runner: fake.runner
    });

    expect(fake.calls.flat()).not.toContain("provided-secret");
    expect(fake.setSecretCalls).toEqual([
      {
        vaultName: "vault",
        secretName: "api-token",
        secretValue: "provided-secret",
        expiresAt: null
      }
    ]);
    expect(result.oneTimeSecretValue).toBeNull();
    expect(result.details).not.toHaveProperty("value");
    expect(result.details).not.toHaveProperty("secretText");
  });
});
