import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AuthActor,
  AzureEnvironmentSettings,
  AzureEnvironmentStatus,
  AzureLoginStatus,
  AzureSettingsResponse,
  AzureSubscriptionSummary
} from "@/types";
import { execAzureCliJson, execAzureCliText, resolveAzureCliPath } from "./azure-command";
import { getAzureEnvironmentSettings, saveAzureEnvironmentSettings } from "./repository";

type AzureLoginState = AzureLoginStatus & {
  child: ChildProcess | null;
};

type AzureLoginGlobal = typeof globalThis & {
  __azureCertGuiAzureLoginState?: AzureLoginState;
};

const MAX_LOG_LINES = 80;
export const AZURE_CLOUD_OPTIONS = ["AzureCloud", "AzureUSGovernment", "AzureChinaCloud"] as const;

interface AzureAccountRaw {
  id?: string | null;
  name?: string | null;
  tenantId?: string | null;
  environmentName?: string | null;
  state?: string | null;
  isDefault?: boolean | null;
  user?: {
    name?: string | null;
  } | null;
}

interface AzureCloudRaw {
  name?: string | null;
}

function initialLoginState(): AzureLoginState {
  return {
    runId: null,
    status: "idle",
    message: "No Azure login is running",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    verificationUrl: null,
    userCode: null,
    logs: [],
    child: null
  };
}

function loginState(): AzureLoginState {
  const globalState = globalThis as AzureLoginGlobal;
  if (!globalState.__azureCertGuiAzureLoginState) {
    globalState.__azureCertGuiAzureLoginState = initialLoginState();
  }
  return globalState.__azureCertGuiAzureLoginState;
}

export function getAzureLoginStatus(): AzureLoginStatus {
  const current = loginState();
  return {
    runId: current.runId,
    status: current.status,
    message: current.message,
    startedAt: current.startedAt,
    finishedAt: current.finishedAt,
    exitCode: current.exitCode,
    verificationUrl: current.verificationUrl,
    userCode: current.userCode,
    logs: current.logs
  };
}

export async function getAzureSettingsResponse(canManage: boolean): Promise<AzureSettingsResponse> {
  return {
    settings: getAzureEnvironmentSettings(),
    status: await getAzureEnvironmentStatus(),
    login: getAzureLoginStatus(),
    canManage
  };
}

export async function getAzureEnvironmentStatus(): Promise<AzureEnvironmentStatus> {
  const checkedAt = new Date().toISOString();
  const azureCliPath = await resolveAzureCliPath();
  if (!azureCliPath) {
    return {
      checkedAt,
      azureCliPath: null,
      signedIn: false,
      cloudName: null,
      tenantId: null,
      subscriptionId: null,
      subscriptionName: null,
      username: null,
      availableSubscriptions: [],
      message: "Azure CLI was not found on the server host"
    };
  }

  const cloudName = await execAzureCliJson<AzureCloudRaw>(["cloud", "show"])
    .then((cloud) => cloud.name ?? null)
    .catch(() => null);

  try {
    const [account, accounts] = await Promise.all([
      execAzureCliJson<AzureAccountRaw>(["account", "show"]),
      execAzureCliJson<AzureAccountRaw[]>(["account", "list"])
    ]);
    return {
      checkedAt,
      azureCliPath,
      signedIn: true,
      cloudName: account.environmentName ?? cloudName,
      tenantId: account.tenantId ?? null,
      subscriptionId: account.id ?? null,
      subscriptionName: account.name ?? null,
      username: account.user?.name ?? null,
      availableSubscriptions: accounts.map(subscriptionSummary).filter((subscription) => subscription.id),
      message: "Azure CLI is signed in"
    };
  } catch (error) {
    return {
      checkedAt,
      azureCliPath,
      signedIn: false,
      cloudName,
      tenantId: null,
      subscriptionId: null,
      subscriptionName: null,
      username: null,
      availableSubscriptions: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function saveAzureEnvironmentConfiguration(
  input: Omit<AzureEnvironmentSettings, "updatedAt" | "updatedBy">,
  actor: AuthActor
): Promise<AzureSettingsResponse> {
  const settings = saveAzureEnvironmentSettings(normalizeAzureSettings(input), actor);
  if (settings.cloudName) {
    await execAzureCliText(["cloud", "set", "--name", settings.cloudName]).catch(() => "");
  }
  if (settings.subscriptionIds[0]) {
    await execAzureCliText(["account", "set", "--subscription", settings.subscriptionIds[0]]).catch(() => "");
  }
  return getAzureSettingsResponse(true);
}

export async function startAzureDeviceLogin(input: {
  tenantId?: string | null;
  cloudName?: string | null;
}): Promise<AzureLoginStatus> {
  const current = loginState();
  if (current.status === "running") return getAzureLoginStatus();

  const azureCliPath = await resolveAzureCliPath();
  if (!azureCliPath) {
    Object.assign(current, {
      ...initialLoginState(),
      status: "failed",
      message: "Azure CLI was not found on the server host",
      finishedAt: new Date().toISOString()
    });
    return getAzureLoginStatus();
  }

  const cloudName = normalizeCloudName(input.cloudName);
  if (cloudName) {
    await execAzureCliText(["cloud", "set", "--name", cloudName]).catch(() => "");
  }

  const args = ["login", "--use-device-code", "--allow-no-subscriptions"];
  const tenantId = input.tenantId?.trim();
  if (tenantId) args.push("--tenant", tenantId);

  Object.assign(current, {
    ...initialLoginState(),
    runId: randomUUID(),
    status: "running",
    message: "Waiting for Azure device-code sign-in",
    startedAt: new Date().toISOString(),
    logs: [`Starting ${azureCliPath} ${args.join(" ")}`]
  } satisfies AzureLoginState);

  const child = spawn(azureCliPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  current.child = child;

  child.stdout.on("data", (chunk: Buffer) => handleLoginOutput(current, chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => handleLoginOutput(current, chunk.toString("utf8")));
  child.on("error", (error) => {
    current.status = "failed";
    current.message = error.message;
    current.finishedAt = new Date().toISOString();
    current.child = null;
    appendLog(current, `error: ${error.message}`);
  });
  child.on("close", (code) => {
    current.status = code === 0 ? "succeeded" : "failed";
    current.message = code === 0 ? "Azure CLI sign-in complete" : `Azure CLI sign-in failed with exit code ${code ?? "unknown"}`;
    current.finishedAt = new Date().toISOString();
    current.exitCode = code;
    current.child = null;
  });

  return getAzureLoginStatus();
}

export function normalizeAzureSettings(
  input: Omit<AzureEnvironmentSettings, "updatedAt" | "updatedBy">
): Omit<AzureEnvironmentSettings, "updatedAt" | "updatedBy"> {
  return {
    tenantId: clean(input.tenantId),
    subscriptionIds: uniqueStrings(input.subscriptionIds),
    keyVaultResourceIds: uniqueStrings(input.keyVaultResourceIds),
    cloudName: normalizeCloudName(input.cloudName),
    includeGraphOwners: input.includeGraphOwners !== false,
    includeGraphOwnerDirectory: input.includeGraphOwnerDirectory !== false,
    includeKeyVaultVersions: input.includeKeyVaultVersions === true
  };
}

function handleLoginOutput(current: AzureLoginState, text: string): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    appendLog(current, line);
    const url = /(https:\/\/(?:microsoft\.com\/devicelogin|aka\.ms\/devicelogin)[^\s]*)/i.exec(line)?.[1];
    const code = /(?:code|enter the code)\s+([A-Z0-9-]{6,})/i.exec(line)?.[1];
    if (url) current.verificationUrl = url;
    if (code) current.userCode = code;
    if (url || code) current.message = "Open the verification URL and enter the device code";
  }
}

function appendLog(current: AzureLoginState, line: string): void {
  current.logs = [...current.logs, line].slice(-MAX_LOG_LINES);
}

function subscriptionSummary(account: AzureAccountRaw): AzureSubscriptionSummary {
  return {
    id: account.id ?? "",
    name: account.name ?? account.id ?? "",
    tenantId: account.tenantId ?? null,
    state: account.state ?? null,
    isDefault: account.isDefault === true
  };
}

function normalizeCloudName(value: string | null | undefined): string | null {
  const cleanValue = clean(value);
  if (!cleanValue) return null;
  return AZURE_CLOUD_OPTIONS.find((option) => option.toLowerCase() === cleanValue.toLowerCase()) ?? null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text || null;
}
