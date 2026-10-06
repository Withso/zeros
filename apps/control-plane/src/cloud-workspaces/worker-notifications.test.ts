import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCloudWorkerNotifications } from "./worker-notifications.js";

function client() {
  return Object.assign(new EventEmitter(), { query: vi.fn().mockResolvedValue({}), release: vi.fn() });
}
function fixture() {
  vi.useFakeTimers();
  const first = client(), second = client();
  const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
  const lifecycle = vi.fn(), setup = vi.fn(), warn = vi.fn();
  const stop = startCloudWorkerNotifications({ connect } as unknown as pg.Pool, { lifecycle, setup }, { warn });
  return { first, second, connect, lifecycle, setup, warn, stop };
}
afterEach(() => { vi.useRealTimers(); });

describe("cloud worker notifications", () => {
  it("wakes staging on committed qualification/release hints and after reconnect", async () => {
    vi.useFakeTimers();
    const connection = client(), runtimeStaging = vi.fn();
    const stop = startCloudWorkerNotifications({ connect: async () => connection } as unknown as pg.Pool,
      { lifecycle: vi.fn(), setup: vi.fn(), runtimeStaging });
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("LISTEN zeros_cloud_runtime_staging_work"));
    expect(runtimeStaging).toHaveBeenCalledOnce();
    connection.emit("notification", { channel: "zeros_cloud_runtime_staging_work", payload: "untrusted" });
    expect(runtimeStaging).toHaveBeenCalledOnce();
    connection.emit("notification", { channel: "zeros_cloud_runtime_staging_work", payload: "" });
    expect(runtimeStaging).toHaveBeenCalledTimes(2);
    await stop();
    connection.emit("notification", { channel: "zeros_cloud_runtime_staging_work", payload: "" });
    expect(runtimeStaging).toHaveBeenCalledTimes(2);
  });

  it("listens before repairing the startup gap, and accepts only payload-free worker hints", async () => {
    const { first, lifecycle, setup, stop } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.query).toHaveBeenCalledWith("LISTEN zeros_cloud_lifecycle_work; LISTEN zeros_cloud_setup_work");
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
    lifecycle.mockClear(); setup.mockClear();
    first.emit("notification", { channel: "zeros_cloud_lifecycle_work", payload: "" });
    first.emit("notification", { channel: "zeros_cloud_setup_work", payload: "" });
    first.emit("notification", { channel: "zeros_security_event", payload: "" });
    first.emit("notification", { channel: "zeros_cloud_setup_work", payload: "untrusted" });
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
    await stop();
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("reconnects after errors without returning LISTEN sessions to the request pool", async () => {
    const { first, second, lifecycle, setup, stop } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    first.emit("error", new Error("private driver details"));
    first.emit("end");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.query).toHaveBeenCalledOnce();
    expect(lifecycle).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenCalledTimes(2);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed connection with bounded backoff and closed diagnostics", async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockRejectedValue(new Error("private connection URL"));
    const warn = vi.fn();
    const stop = startCloudWorkerNotifications({ connect } as unknown as pg.Pool,
      { lifecycle: vi.fn(), setup: vi.fn() }, { warn });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(connect).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    await stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(6);
  });

  it("retires long-held connections and suppresses late acquisition after stop", async () => {
    const { first, second, stop } = fixture();
    await vi.advanceTimersByTimeAsync(600_000 + 1_000);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.query).toHaveBeenCalledOnce();
    await stop();

    let resolve!: (value: ReturnType<typeof client>) => void;
    const pending = new Promise<ReturnType<typeof client>>(r => { resolve = r; });
    const late = client(), wake = vi.fn();
    const stopLate = startCloudWorkerNotifications({ connect: () => pending } as unknown as pg.Pool,
      { lifecycle: wake, setup: wake });
    const stopping = stopLate();
    resolve(late);
    await stopping;
    expect(late.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(late.query).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
