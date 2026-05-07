import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RefreshScheduleStatus, RefreshRunStatus } from "@/types";
import { dbPath, migrate, openDatabase } from "./db";

type RefreshState = RefreshRunStatus & {
  child: ChildProcess | null;
};

type RefreshScheduleState = RefreshScheduleStatus & {
  timer: NodeJS.Timeout | null;
  loadedDbPath: string | null;
};

type RefreshGlobal = typeof globalThis & {
  __gstackRefreshState?: RefreshState;
  __gstackRefreshScheduleState?: RefreshScheduleState;
};

const MAX_LOG_LINES = 80;
export const MIN_REFRESH_INTERVAL_MINUTES = 5;
export const MAX_REFRESH_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;

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

function initialScheduleState(): RefreshScheduleState {
  return {
    enabled: false,
    intervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
    nextRunAt: null,
    lastRunAt: null,
    updatedAt: null,
    updatedBy: null,
    message: "Automatic refresh is off",
    minimumIntervalMinutes: MIN_REFRESH_INTERVAL_MINUTES,
    maximumIntervalMinutes: MAX_REFRESH_INTERVAL_MINUTES,
    timer: null,
    loadedDbPath: null
  };
}

function scheduleState(): RefreshScheduleState {
  const globalState = globalThis as RefreshGlobal;
  const currentDbPath = dbPath();
  if (!globalState.__gstackRefreshScheduleState || globalState.__gstackRefreshScheduleState.loadedDbPath !== currentDbPath) {
    globalState.__gstackRefreshScheduleState = {
      ...initialScheduleState(),
      ...loadPersistedSchedule(),
      loadedDbPath: currentDbPath
    };
    if (globalState.__gstackRefreshScheduleState.enabled) {
      scheduleNextRun(globalState.__gstackRefreshScheduleState);
      persistSchedule(globalState.__gstackRefreshScheduleState, "restored", "scheduler");
    }
  }
  return globalState.__gstackRefreshScheduleState;
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

export function getRefreshScheduleStatus(): RefreshScheduleStatus {
  const current = scheduleState();
  return {
    enabled: current.enabled,
    intervalMinutes: current.intervalMinutes,
    nextRunAt: current.nextRunAt,
    lastRunAt: current.lastRunAt,
    updatedAt: current.updatedAt,
    updatedBy: current.updatedBy,
    message: current.message,
    minimumIntervalMinutes: current.minimumIntervalMinutes,
    maximumIntervalMinutes: current.maximumIntervalMinutes
  };
}

export function configureRefreshSchedule(input: {
  enabled: boolean;
  intervalMinutes?: number | null;
  updatedBy?: string | null;
}): RefreshScheduleStatus {
  const current = scheduleState();
  clearScheduleTimer(current);

  const timestamp = new Date().toISOString();
  current.intervalMinutes = normalizeInterval(input.intervalMinutes ?? current.intervalMinutes);
  current.enabled = input.enabled;
  current.updatedAt = timestamp;
  current.updatedBy = input.updatedBy?.trim() || "operator";
  current.lastRunAt = input.enabled ? current.lastRunAt : null;

  if (!input.enabled) {
    current.nextRunAt = null;
    current.message = "Automatic refresh is off";
    persistSchedule(current, "disabled", current.updatedBy ?? "operator");
    return getRefreshScheduleStatus();
  }

  scheduleNextRun(current);
  current.message = `Automatic refresh every ${current.intervalMinutes} minutes`;
  persistSchedule(current, "enabled", current.updatedBy ?? "operator");
  return getRefreshScheduleStatus();
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

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REFRESH_INTERVAL_MINUTES;
  return Math.min(MAX_REFRESH_INTERVAL_MINUTES, Math.max(MIN_REFRESH_INTERVAL_MINUTES, Math.trunc(value)));
}

function clearScheduleTimer(current: RefreshScheduleState): void {
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
}

function scheduleNextRun(current: RefreshScheduleState): void {
  clearScheduleTimer(current);
  const nextRun = new Date(Date.now() + current.intervalMinutes * 60_000);
  current.nextRunAt = nextRun.toISOString();
  current.timer = setTimeout(() => {
    runScheduledRefresh();
  }, current.intervalMinutes * 60_000);
  current.timer.unref?.();
}

function runScheduledRefresh(): void {
  const current = scheduleState();
  if (!current.enabled) return;

  current.lastRunAt = new Date().toISOString();
  const before = getRefreshStatus();
  startAzureRefresh();
  current.message =
    before.status === "running"
      ? `Automatic refresh checked every ${current.intervalMinutes} minutes; previous refresh still running`
      : `Automatic refresh started every ${current.intervalMinutes} minutes`;
  scheduleNextRun(current);
  persistSchedule(current, before.status === "running" ? "run_skipped" : "run_started", current.updatedBy ?? "scheduler");
}

export function resetRefreshScheduleForTests(): void {
  const globalState = globalThis as RefreshGlobal;
  if (globalState.__gstackRefreshScheduleState?.timer) {
    clearTimeout(globalState.__gstackRefreshScheduleState.timer);
  }
  globalState.__gstackRefreshScheduleState = undefined;
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

function loadPersistedSchedule(): Partial<RefreshScheduleState> {
  const db = openDatabase();
  migrate(db);
  const row = db.prepare("SELECT * FROM refresh_schedule WHERE id = 1").get() as
    | {
        enabled: number;
        interval_minutes: number;
        next_run_at: string | null;
        last_run_at: string | null;
        updated_at: string | null;
        updated_by: string | null;
        message: string;
      }
    | undefined;
  if (!row) return {};
  return {
    enabled: row.enabled === 1,
    intervalMinutes: normalizeInterval(row.interval_minutes),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    message: row.message
  };
}

function persistSchedule(current: RefreshScheduleState, eventType: string, actor: string): void {
  const db = openDatabase();
  migrate(db);
  const timestamp = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO refresh_schedule (
      id, enabled, interval_minutes, next_run_at, last_run_at, updated_at, updated_by, message
    )
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      enabled = excluded.enabled,
      interval_minutes = excluded.interval_minutes,
      next_run_at = excluded.next_run_at,
      last_run_at = excluded.last_run_at,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by,
      message = excluded.message
  `
  ).run(
    current.enabled ? 1 : 0,
    current.intervalMinutes,
    current.nextRunAt,
    current.lastRunAt,
    current.updatedAt,
    current.updatedBy,
    current.message
  );
  db.prepare(
    `
    INSERT INTO refresh_schedule_events (
      event_type, enabled, interval_minutes, next_run_at, last_run_at, message, created_at, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    eventType,
    current.enabled ? 1 : 0,
    current.intervalMinutes,
    current.nextRunAt,
    current.lastRunAt,
    current.message,
    timestamp,
    actor
  );
}
