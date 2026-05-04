import { describe, expect, it } from "vitest";
import { coerceTagMap, normalizeDate, parseAzureResourceId } from "./azure-cli";

describe("azure cli helpers", () => {
  it("parses Azure resource IDs", () => {
    expect(
      parseAzureResourceId(
        "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/kv-prod"
      )
    ).toEqual({
      subscriptionId: "sub-1",
      resourceGroup: "rg-prod",
      provider: "Microsoft.KeyVault",
      type: "vaults",
      name: "kv-prod"
    });
  });

  it("coerces ARM tag objects and Graph tag arrays", () => {
    expect(coerceTagMap({ owner: "Payments", costCenter: 42 })).toEqual({
      owner: "Payments",
      costCenter: "42"
    });
    expect(coerceTagMap(["owner=Identity", "ownerEmail:identity@example.com", "critical"])).toEqual({
      owner: "Identity",
      ownerEmail: "identity@example.com",
      critical: "true"
    });
  });

  it("normalizes Azure epoch and ISO dates", () => {
    expect(normalizeDate(1772323200)).toBe("2026-03-01T00:00:00.000Z");
    expect(normalizeDate("2026-05-01T12:30:00Z")).toBe("2026-05-01T12:30:00.000Z");
    expect(normalizeDate(undefined)).toBeNull();
  });
});
