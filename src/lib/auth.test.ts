import { afterEach, vi } from "vitest";
import {
  authOptionsFromEnv,
  isLiveRotationEnabled,
  resolveAccessLevel,
  resolveOidcRoles,
  validateAuthConfiguration
} from "./auth";

describe("auth configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses SyncFactors-style OIDC role group arrays with the Azure Cert GUI prefix", () => {
    const options = authOptionsFromEnv({
      AZURE_CERT_GUI__AUTH__MODE: "oidc",
      AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY: "https://login.microsoftonline.com/tenant/v2.0",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTID: "client-id",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET: "client-secret",
      AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0: "viewer-group",
      AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0: "operator-group",
      AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0: "admin-group"
    });

    expect(options.mode).toBe("oidc");
    expect(options.oidc.viewerGroups).toEqual(["viewer-group"]);
    expect(options.oidc.operatorGroups).toEqual(["operator-group"]);
    expect(options.oidc.adminGroups).toEqual(["admin-group"]);
  });

  it("resolves OIDC roles from configured groups without defaulting unmatched users to Viewer", () => {
    const options = authOptionsFromEnv({
      AZURE_CERT_GUI__AUTH__MODE: "oidc",
      AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY: "https://login.microsoftonline.com/tenant/v2.0",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTID: "client-id",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET: "client-secret",
      AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0: "viewer-group",
      AZURE_CERT_GUI__AUTH__OIDC__OPERATORGROUPS__0: "operator-group",
      AZURE_CERT_GUI__AUTH__OIDC__ADMINGROUPS__0: "admin-group"
    });

    expect(resolveOidcRoles({ groups: ["operator-group"] }, options)).toEqual(["Operator"]);
    expect(resolveOidcRoles({ groups: ["unmapped-group"] }, options)).toEqual([]);
    expect(resolveAccessLevel([])).toBe("No Access");
  });

  it("requires role mappings when OIDC is enabled", () => {
    const options = authOptionsFromEnv({
      AZURE_CERT_GUI__AUTH__MODE: "oidc",
      AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY: "https://login.microsoftonline.com/tenant/v2.0",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTID: "client-id",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET: "client-secret"
    });

    expect(() => validateAuthConfiguration(options)).toThrow(/ViewerGroups, OperatorGroups, or AdminGroups/);
  });

  it("rejects local auth in production unless break-glass is explicit", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() =>
      validateAuthConfiguration(
        authOptionsFromEnv({
          AZURE_CERT_GUI__AUTH__MODE: "local"
        })
      )
    ).toThrow(/Local auth is disabled/);

    expect(() =>
      validateAuthConfiguration(
        authOptionsFromEnv({
          AZURE_CERT_GUI__AUTH__MODE: "local",
          AZURE_CERT_GUI__AUTH__ALLOWLOCALINPRODUCTION: "true"
        })
      )
    ).not.toThrow();
  });

  it("accepts a valid OIDC public origin and rejects malformed ones", () => {
    const base = {
      AZURE_CERT_GUI__AUTH__MODE: "oidc",
      AZURE_CERT_GUI__AUTH__OIDC__AUTHORITY: "https://login.example.com/tenant/v2.0",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTID: "client-id",
      AZURE_CERT_GUI__AUTH__OIDC__CLIENTSECRET: "client-secret",
      AZURE_CERT_GUI__AUTH__OIDC__VIEWERGROUPS__0: "group-id"
    };

    const ok = authOptionsFromEnv({ ...base, AZURE_CERT_GUI__AUTH__OIDC__PUBLICORIGIN: "https://gui.example.com/" });
    expect(ok.oidc.publicOrigin).toBe("https://gui.example.com/");
    expect(() => validateAuthConfiguration(ok)).not.toThrow();

    for (const bad of ["gui.example.com", "https://gui.example.com/app", "ftp://gui.example.com"]) {
      expect(() =>
        validateAuthConfiguration(authOptionsFromEnv({ ...base, AZURE_CERT_GUI__AUTH__OIDC__PUBLICORIGIN: bad }))
      ).toThrow(/PUBLICORIGIN/);
    }
  });

  it("requires an explicit opt-in flag for live Azure rotations", () => {
    expect(isLiveRotationEnabled({})).toBe(false);
    expect(isLiveRotationEnabled({ AZURE_CERT_GUI__ROTATION__LIVEENABLED: "false" })).toBe(false);
    expect(isLiveRotationEnabled({ AZURE_CERT_GUI__ROTATION__LIVEENABLED: "true" })).toBe(true);
  });
});
