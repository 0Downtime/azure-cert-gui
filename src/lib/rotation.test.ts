import { describe, expect, it } from "vitest";
import { classifyRotation, isRenewalActionable } from "./rotation";

describe("rotation classification", () => {
  it("marks managed identity service principal credentials as platform managed", () => {
    const rotation = classifyRotation({
      source: "service_principal",
      credentialType: "client_secret",
      metadata: { servicePrincipalType: "ManagedIdentity" }
    });

    expect(rotation.mode).toBe("platform_managed");
    expect(isRenewalActionable(rotation.mode)).toBe(false);
  });

  it("marks Microsoft first-party service principal credentials as platform managed", () => {
    const rotation = classifyRotation({
      source: "service_principal",
      credentialType: "certificate",
      metadata: { appOwnerOrganizationId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a" }
    });

    expect(rotation.mode).toBe("platform_managed");
  });

  it("marks issuer-managed Key Vault certificates as source-system rotation", () => {
    const rotation = classifyRotation({
      source: "key_vault_certificate",
      credentialType: "certificate",
      metadata: { certificateIssuerName: "DigiCert" }
    });

    expect(rotation.mode).toBe("rotate_in_source_system");
    expect(rotation.reason).toContain("DigiCert");
  });

  it("uses source metadata override when present", () => {
    const rotation = classifyRotation({
      source: "key_vault_secret",
      credentialType: "secret",
      metadata: {
        rotationMode: "rotate_in_source_system",
        rotationModeReason: "Renew in the source SaaS system"
      }
    });

    expect(rotation).toEqual({
      mode: "rotate_in_source_system",
      reason: "Renew in the source SaaS system"
    });
  });
});
