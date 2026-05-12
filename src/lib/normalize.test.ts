import { describe, expect, it } from "vitest";
import {
  normalizeGraphApplications,
  normalizeKeyVaultKeys,
  normalizeKeyVaultSecrets,
  normalizeServicePrincipals
} from "./normalize";
import { SecretValueLeakError } from "./secret-guard";

describe("normalization", () => {
  it("maps graph application secrets and certificates without values", () => {
    const rows = normalizeGraphApplications([
      {
        tenantId: "tenant",
        id: "app-object",
        appId: "app-id",
        displayName: "App",
        owners: [{ displayName: "Owner", mail: "owner@example.com" }],
        passwordCredentials: [
          {
            keyId: "secret-key",
            displayName: "Secret",
            endDateTime: "2026-06-01T00:00:00Z"
          }
        ],
        keyCredentials: [
          {
            keyId: "cert-key",
            displayName: "Cert",
            endDateTime: "2026-07-01T00:00:00Z"
          }
        ]
      }
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0].naturalKey).toBe("tenant:application:app-object:secret-key");
    expect(rows[0].ownerConfidence).toBe("high");
    expect(rows[0].metadata).toMatchObject({ appId: "app-id" });
    expect(rows[0].metadata).not.toHaveProperty("secretText");
    expect(rows[0].metadata).not.toHaveProperty("value");
  });

  it("handles service principals with no credentials", () => {
    const rows = normalizeServicePrincipals([
      {
        tenantId: "tenant",
        id: "sp-object",
        appId: "app-id",
        displayName: "SP",
        passwordCredentials: [],
        keyCredentials: []
      }
    ]);
    expect(rows).toHaveLength(0);
  });

  it("preserves service principal rotation classification metadata", () => {
    const [row] = normalizeServicePrincipals([
      {
        tenantId: "tenant",
        id: "sp-object",
        appId: "app-id",
        displayName: "SP",
        servicePrincipalType: "ManagedIdentity",
        appOwnerOrganizationId: "first-party-tenant",
        passwordCredentials: [
          {
            keyId: "secret-key",
            displayName: "Secret",
            endDateTime: "2026-06-01T00:00:00Z"
          }
        ],
        keyCredentials: []
      }
    ]);

    expect(row.metadata).toMatchObject({
      appId: "app-id",
      servicePrincipalType: "ManagedIdentity",
      appOwnerOrganizationId: "first-party-tenant"
    });
  });

  it("rejects poison secret value fields", () => {
    expect(() =>
      normalizeKeyVaultSecrets([
        {
          tenantId: "tenant",
          subscriptionId: "sub",
          resourceGroup: "rg",
          vaultResourceId: "vault-id",
          vaultName: "vault",
          name: "secret",
          version: "v1",
          expiresAt: "2026-06-01T00:00:00Z",
          value: "must-not-persist"
        } as never
      ])
    ).toThrow(SecretValueLeakError);
  });

  it("uses vault tags as medium confidence owner signals", () => {
    const [row] = normalizeKeyVaultSecrets([
      {
        tenantId: "tenant",
        subscriptionId: "sub",
        resourceGroup: "rg",
        vaultResourceId: "vault-id",
        vaultName: "vault",
        name: "secret",
        version: "v1",
        expiresAt: "2026-06-01T00:00:00Z",
        tags: { owner: "Payments", ownerEmail: "payments@example.com" }
      }
    ]);

    expect(row.ownerHint).toBe("Payments");
    expect(row.ownerEmail).toBe("payments@example.com");
    expect(row.ownerConfidence).toBe("medium");
  });

  it("normalizes Key Vault keys as key inventory", () => {
    const [row] = normalizeKeyVaultKeys([
      {
        tenantId: "tenant",
        subscriptionId: "sub",
        resourceGroup: "rg",
        vaultResourceId: "vault-id",
        vaultName: "vault",
        name: "cmk-orders",
        version: "v3",
        expiresAt: "2026-06-01T00:00:00Z",
        keyType: "RSA",
        keyOperations: "encrypt,decrypt",
        tags: { owner: "Data", ownerEmail: "data@example.com" }
      }
    ]);

    expect(row.source).toBe("key_vault_key");
    expect(row.credentialType).toBe("key");
    expect(row.naturalKey).toBe("sub:vault-id:key:cmk-orders:v3");
    expect(row.metadata).toMatchObject({ keyType: "RSA", keyOperations: "encrypt,decrypt" });
  });
});
