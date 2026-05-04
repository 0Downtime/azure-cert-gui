const FORBIDDEN_KEY_PATTERNS = [
  "secrettext",
  "secret_text",
  "secretvalue",
  "secret_value",
  "clientsecret",
  "client_secret",
  "value",
  "privatekey",
  "private_key",
  "password"
];

export class SecretValueLeakError extends Error {
  constructor(path: string) {
    super(`Collector payload contains forbidden secret-bearing field: ${path}`);
    this.name = "SecretValueLeakError";
  }
}

export function assertNoSecretValueFields(value: unknown, path = "payload"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretValueFields(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-\s]/g, "_");
    if (FORBIDDEN_KEY_PATTERNS.includes(normalized)) {
      throw new SecretValueLeakError(`${path}.${key}`);
    }
    assertNoSecretValueFields(nested, `${path}.${key}`);
  }
}

export function pickMetadata(
  source: Record<string, unknown>,
  allowedKeys: string[]
): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of allowedKeys) {
    const value = source[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      metadata[key] = value;
    }
  }
  return metadata;
}
