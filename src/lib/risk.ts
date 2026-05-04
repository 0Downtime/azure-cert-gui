import type { RiskBucket } from "@/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysUntilExpiry(expiresAt: string | null, now = new Date()): number | null {
  if (!expiresAt) return null;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;
  return Math.ceil((expiry.getTime() - now.getTime()) / MS_PER_DAY);
}

export function riskBucket(days: number | null): RiskBucket {
  if (days === null) return "no-expiry";
  if (days < 0) return "expired";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export function bucketSortValue(bucket: RiskBucket): number {
  switch (bucket) {
    case "expired":
      return 0;
    case "0-30":
      return 1;
    case "31-60":
      return 2;
    case "61-90":
      return 3;
    case "90+":
      return 4;
    case "no-expiry":
      return 5;
  }
}
