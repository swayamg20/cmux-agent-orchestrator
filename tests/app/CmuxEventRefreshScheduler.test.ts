import { describe, expect, it, vi } from "vitest";
import { CmuxEventRefreshScheduler } from "../../src/app/CmuxEventRefreshScheduler";

function harness() {
  const refreshAll = vi.fn(async () => undefined);
  const refreshTopology = vi.fn(async () => undefined);
  const refreshNotifications = vi.fn(async () => undefined);
  const refreshLifecycle = vi.fn(async () => undefined);
  const onError = vi.fn();
  const scheduler = new CmuxEventRefreshScheduler(
    { refreshAll, refreshTopology, refreshNotifications, refreshLifecycle, onError },
    60_000
  );
  return {
    scheduler,
    refreshAll,
    refreshTopology,
    refreshNotifications,
    refreshLifecycle,
    onError
  };
}

describe("CmuxEventRefreshScheduler", () => {
  it("coalesces topology and notification bursts into one authoritative full refresh", async () => {
    const current = harness();
    current.scheduler.request("topology");
    current.scheduler.request("topology");
    current.scheduler.request("notifications");
    await current.scheduler.flushNow();

    expect(current.refreshAll).toHaveBeenCalledOnce();
    expect(current.refreshTopology).not.toHaveBeenCalled();
    expect(current.refreshNotifications).not.toHaveBeenCalled();
    current.scheduler.dispose();
  });

  it("uses the smallest snapshot refresh for one scope", async () => {
    const current = harness();
    current.scheduler.request("notifications");
    await current.scheduler.flushNow();
    expect(current.refreshNotifications).toHaveBeenCalledOnce();
    expect(current.refreshAll).not.toHaveBeenCalled();

    current.scheduler.request("lifecycle");
    await current.scheduler.flushNow();
    expect(current.refreshLifecycle).toHaveBeenCalledOnce();
    current.scheduler.dispose();
  });

  it("always treats a cursor gap as a full resync", async () => {
    const current = harness();
    current.scheduler.request("lifecycle");
    current.scheduler.request("resync");
    await current.scheduler.flushNow();
    expect(current.refreshAll).toHaveBeenCalledOnce();
    expect(current.refreshLifecycle).not.toHaveBeenCalled();
    current.scheduler.dispose();
  });

  it("queues one follow-up pass when an event arrives during refresh", async () => {
    let release!: () => void;
    const first = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const current = harness();
    current.refreshTopology.mockImplementationOnce(() => first);
    current.scheduler.request("topology");
    const pending = current.scheduler.flushNow();
    await Promise.resolve();
    current.scheduler.request("notifications");
    release();
    await pending;
    await current.scheduler.flushNow();

    expect(current.refreshTopology).toHaveBeenCalledOnce();
    expect(current.refreshNotifications).toHaveBeenCalledOnce();
    current.scheduler.dispose();
  });

  it("drops queued work after disposal", async () => {
    const current = harness();
    current.scheduler.request("resync");
    current.scheduler.dispose();
    await current.scheduler.flushNow();
    expect(current.refreshAll).not.toHaveBeenCalled();
  });

  it("reports a refresh failure and remains usable for the next event", async () => {
    const current = harness();
    current.refreshTopology.mockRejectedValueOnce(new Error("simulated refresh failure"));

    current.scheduler.request("topology");
    await current.scheduler.flushNow();

    expect(current.onError).toHaveBeenCalledOnce();
    expect(current.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "simulated refresh failure"
    }));

    current.scheduler.request("notifications");
    await current.scheduler.flushNow();
    expect(current.refreshNotifications).toHaveBeenCalledOnce();
    current.scheduler.dispose();
  });

  it("suppresses in-flight errors and queued follow-up work after disposal", async () => {
    let rejectRefresh!: (error: Error) => void;
    const inFlight = new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const current = harness();
    current.refreshTopology.mockImplementationOnce(() => inFlight);
    current.scheduler.request("topology");
    const pending = current.scheduler.flushNow();
    await Promise.resolve();

    current.scheduler.request("notifications");
    current.scheduler.dispose();
    rejectRefresh(new Error("late failure"));
    await pending;

    expect(current.onError).not.toHaveBeenCalled();
    expect(current.refreshNotifications).not.toHaveBeenCalled();
  });
});
