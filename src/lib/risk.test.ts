import { describe, expect, it } from "vitest";
import { daysUntilExpiry, riskBucket } from "./risk";

const now = new Date("2026-05-04T00:00:00Z");

describe("risk buckets", () => {
  it.each([
    ["2026-05-03T00:00:00Z", "expired"],
    ["2026-05-04T00:00:00Z", "0-30"],
    ["2026-06-03T00:00:00Z", "0-30"],
    ["2026-06-04T00:00:00Z", "31-60"],
    ["2026-07-03T00:00:00Z", "31-60"],
    ["2026-07-04T00:00:00Z", "61-90"],
    ["2026-08-02T00:00:00Z", "61-90"],
    ["2026-08-03T00:00:00Z", "90+"]
  ])("maps %s to %s", (expiresAt, expected) => {
    expect(riskBucket(daysUntilExpiry(expiresAt, now))).toBe(expected);
  });

  it("handles missing expiration", () => {
    expect(riskBucket(daysUntilExpiry(null, now))).toBe("no-expiry");
  });
});
