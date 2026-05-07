import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  configureRefreshSchedule,
  getRefreshScheduleStatus,
  MAX_REFRESH_INTERVAL_MINUTES,
  MIN_REFRESH_INTERVAL_MINUTES,
  resetRefreshScheduleForTests
} from "./refresh-runner";

describe("refresh schedule", () => {
  beforeEach(() => {
    process.env.AZURE_CERT_GUI_DB_PATH = join(mkdtempSync(join(tmpdir(), "azure-cert-gui-refresh-")), "test.sqlite");
    resetRefreshScheduleForTests();
  });

  afterEach(() => {
    configureRefreshSchedule({ enabled: false, intervalMinutes: 60, updatedBy: "test" });
    resetRefreshScheduleForTests();
  });

  it("clamps intervals and records schedule metadata", () => {
    const low = configureRefreshSchedule({ enabled: true, intervalMinutes: 1, updatedBy: "operator@example.com" });
    expect(low.enabled).toBe(true);
    expect(low.intervalMinutes).toBe(MIN_REFRESH_INTERVAL_MINUTES);
    expect(low.nextRunAt).toBeTruthy();
    expect(low.updatedBy).toBe("operator@example.com");

    const high = configureRefreshSchedule({ enabled: true, intervalMinutes: 99999, updatedBy: "operator@example.com" });
    expect(high.intervalMinutes).toBe(MAX_REFRESH_INTERVAL_MINUTES);
  });

  it("can disable an active schedule", () => {
    configureRefreshSchedule({ enabled: true, intervalMinutes: 30, updatedBy: "operator@example.com" });

    const stopped = configureRefreshSchedule({ enabled: false, updatedBy: "operator@example.com" });

    expect(stopped.enabled).toBe(false);
    expect(stopped.nextRunAt).toBeNull();
    expect(stopped.lastRunAt).toBeNull();
    expect(getRefreshScheduleStatus().message).toBe("Automatic refresh is off");
  });

  it("persists schedule state and audit events", () => {
    configureRefreshSchedule({ enabled: true, intervalMinutes: 30, updatedBy: "operator@example.com" });
    resetRefreshScheduleForTests();

    const restored = getRefreshScheduleStatus();
    expect(restored.enabled).toBe(true);
    expect(restored.intervalMinutes).toBe(30);
    expect(restored.updatedBy).toBe("operator@example.com");

    const db = new DatabaseSync(process.env.AZURE_CERT_GUI_DB_PATH ?? "");
    const events = db.prepare("SELECT event_type, created_by FROM refresh_schedule_events ORDER BY id").all() as {
      event_type: string;
      created_by: string;
    }[];
    expect(events.map((event) => event.event_type)).toContain("enabled");
    expect(events.map((event) => event.event_type)).toContain("restored");
  });
});
