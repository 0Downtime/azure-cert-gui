import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RefreshRunStatus } from "@/types";

type RefreshState = RefreshRunStatus & {
  child: ChildProcess | null;
};

type RefreshGlobal = typeof globalThis & {
  __gstackRefreshState?: RefreshState;
};

const MAX_LOG_LINES = 80;

function initialState(): RefreshState {
  return {
    runId: null,
    status: "idle",
    progress: 0,
    message: "No refresh has run yet",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    logs: [],
    child: null
  };
}

function state(): RefreshState {
  const globalState = globalThis as RefreshGlobal;
  if (!globalState.__gstackRefreshState) {
    globalState.__gstackRefreshState = initialState();
  }
  return globalState.__gstackRefreshState;
}

export function getRefreshStatus(): RefreshRunStatus {
  const current = state();
  return {
    runId: current.runId,
    status: current.status,
    progress: current.progress,
    message: current.message,
    startedAt: current.startedAt,
    finishedAt: current.finishedAt,
    exitCode: current.exitCode,
    logs: current.logs
  };
}

export function startAzureRefresh(): RefreshRunStatus {
  const current = state();
  if (current.status === "running") {
    return getRefreshStatus();
  }

  current.runId = randomUUID();
  current.status = "running";
  current.progress = 5;
  current.message = "Starting Azure metadata refresh";
  current.startedAt = new Date().toISOString();
  current.finishedAt = null;
  current.exitCode = null;
  current.logs = ["Starting npm run sync:azure -- --verbose"];

  const child = spawn("npm", ["run", "sync:azure", "--", "--verbose"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  current.child = child;

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer = handleOutput(current, `${stdoutBuffer}${chunk.toString("utf8")}`, false);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer = handleOutput(current, `${stderrBuffer}${chunk.toString("utf8")}`, true);
  });

  child.on("error", (error) => {
    current.status = "failed";
    current.progress = Math.max(current.progress, 5);
    current.message = error.message;
    current.finishedAt = new Date().toISOString();
    current.exitCode = null;
    current.child = null;
    appendLog(current, `error: ${error.message}`);
  });

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) appendLog(current, stdoutBuffer.trim());
    if (stderrBuffer.trim()) appendLog(current, `error: ${stderrBuffer.trim()}`);
    current.status = code === 0 ? "succeeded" : "failed";
    current.progress = code === 0 ? 100 : Math.max(current.progress, 5);
    current.message = code === 0 ? "Refresh complete" : `Refresh failed with exit code ${code ?? "unknown"}`;
    current.finishedAt = new Date().toISOString();
    current.exitCode = code;
    current.child = null;
  });

  return getRefreshStatus();
}

function handleOutput(current: RefreshState, text: string, isError: boolean): string {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    appendLog(current, isError ? `error: ${trimmed}` : trimmed);
    updateProgress(current, trimmed, isError);
  }
  return remainder;
}

function appendLog(current: RefreshState, line: string): void {
  current.logs = [...current.logs, line].slice(-MAX_LOG_LINES);
}

function updateProgress(current: RefreshState, line: string, isError: boolean): void {
  if (isError) {
    current.message = "Refresh is running with warnings";
    return;
  }
  if (/^entra_application:/.test(line)) {
    current.progress = Math.max(current.progress, 25);
    current.message = "Microsoft Graph applications synced";
    return;
  }
  if (/^service_principal:/.test(line)) {
    current.progress = Math.max(current.progress, 45);
    current.message = "Microsoft Graph service principals synced";
    return;
  }
  if (/^key_vault_secret:/.test(line)) {
    current.progress = Math.max(current.progress, 65);
    current.message = "Key Vault secrets synced";
    return;
  }
  if (/^key_vault_certificate:/.test(line)) {
    current.progress = Math.max(current.progress, 78);
    current.message = "Key Vault certificates synced";
    return;
  }
  if (/^key_vault_key:/.test(line)) {
    current.progress = Math.max(current.progress, 90);
    current.message = "Key Vault keys synced";
  }
}
