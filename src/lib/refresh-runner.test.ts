import { configureRefreshSchedule, getRefreshScheduleStatus, MAX_REFRESH_INTERVAL_MINUTES, MIN_REFRESH_INTERVAL_MINUTES } from "./refresh-runner";

describe("refresh schedule", () => {
  afterEach(() => {
    configureRefreshSchedule({ enabled: false, intervalMinutes: 60, updatedBy: "test" });
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
});
