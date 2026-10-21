import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerNotifications } from "./worker-notifications.js";

function client() {
  return Object.assign(new EventEmitter(), { query: vi.fn().mockResolvedValue({}), release: vi.fn() });
}
function fixture() {
  vi.useFakeTimers();
  const first = client(), second = client();
  const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
  const workos = vi.fn(), security = vi.fn(), warn = vi.fn();
  const stop = startWorkerNotifications({ connect } as unknown as pg.Pool, { workos, security }, { warn });
  return { first, second, connect, workos, security, warn, stop };
}
afterEach(() => { vi.useRealTimers(); });

describe("background worker notifications", () => {
  it("listens before repairing the startup gap, and accepts only payload-free worker hints", async () => {
    const { first, workos, security, stop } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.query).toHaveBeenCalledWith("LISTEN zeros_account_maintenance_work; LISTEN zeros_security_publication_work");
    expect(workos).toHaveBeenCalledOnce();
    expect(security).toHaveBeenCalledOnce();
    workos.mockClear(); security.mockClear();
    first.emit("notification", { channel: "zeros_account_maintenance_work", payload: "" });
    first.emit("notification", { channel: "zeros_security_publication_work", payload: "" });
    first.emit("notification", { channel: "zeros_security_event", payload: "" });
    first.emit("notification", { channel: "zeros_security_publication_work", payload: "untrusted" });
    expect(workos).toHaveBeenCalledOnce();
    expect(security).toHaveBeenCalledOnce();
    await stop();
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("reconnects after errors without returning LISTEN sessions to the request pool", async () => {
    const { first, second, workos, security, stop } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    first.emit("error", new Error("private driver details"));
    first.emit("end");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.query).toHaveBeenCalledOnce();
    expect(workos).toHaveBeenCalledTimes(2);
    expect(security).toHaveBeenCalledTimes(2);
    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed connection with bounded backoff and closed diagnostics", async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockRejectedValue(new Error("private connection URL"));
    const warn = vi.fn();
    const stop = startWorkerNotifications({ connect } as unknown as pg.Pool,
      { workos: vi.fn(), security: vi.fn() }, { warn });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(connect).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    await stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(6);
  });

  it("retires long-held connections and suppresses late acquisition after stop", async () => {
    const { first, second, stop } = fixture();
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000 + 1_000);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.query).toHaveBeenCalledOnce();
    await stop();

    let resolve!: (value: ReturnType<typeof client>) => void;
    const pending = new Promise<ReturnType<typeof client>>(r => { resolve = r; });
    const late = client(), wake = vi.fn();
    const stopLate = startWorkerNotifications({ connect: () => pending } as unknown as pg.Pool,
      { workos: wake, security: wake });
    const stopping = stopLate();
    resolve(late);
    await stopping;
    expect(late.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(late.query).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shared account queue wakes", () => {
  it("listens and reconnects with only WorkOS registered, without any cloud worker", async () => {
    vi.useFakeTimers();
    const first = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({})),
      release: vi.fn(),
    });
    const second = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({})),
      release: vi.fn(),
    });
    const connect = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValue(second),
      workos = vi.fn();
    const stop = startWorkerNotifications(
      { connect } as unknown as pg.Pool,
      { workos },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(first.query).toHaveBeenCalledExactlyOnceWith(
        "LISTEN zeros_account_maintenance_work",
      );
      expect(workos).toHaveBeenCalledOnce();
      first.emit("notification", {
        channel: "zeros_account_maintenance_work",
        payload: "private",
      });
      expect(workos).toHaveBeenCalledOnce();
      first.emit("notification", {
        channel: "zeros_account_maintenance_work",
        payload: "",
      });
      expect(workos).toHaveBeenCalledTimes(2);
      first.emit("error", new Error("disconnected"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(workos).toHaveBeenCalledTimes(3);
    } finally {
      await stop();
    }
    second.emit("notification", {
      channel: "zeros_account_maintenance_work",
      payload: "",
    });
    expect(workos).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
