import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresSecurityEventBroker, SecurityEventPublisher, waitForSecurityEventWake } from "./security-events.js";

function fixture(query = vi.fn(async (_sql: string) => ({ rows: [] }))) {
  const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as pg.Pool;
  return { client, connect, broker: new PostgresSecurityEventBroker(pool) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps an empty security outbox quiet for sixty seconds and wakes on a change", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let pending = false;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes(" AS delay_ms ")) return { rows: [{ delay_ms: pending ? 0 : null }], rowCount: 1 };
    const published = pending && sql.includes("UPDATE security_events e SET delivery_sequence");
    if (published) pending = false;
    return { rows: [], rowCount: published ? 1 : 0 };
  });
  const client = { query, release: vi.fn() };
  const publisher = new SecurityEventPublisher({ connect: async () => client } as unknown as pg.Pool);
  const stop = publisher.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    const initial = query.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(query).toHaveBeenCalledTimes(initial);
    await vi.advanceTimersByTimeAsync(1);
    expect(query.mock.calls.length).toBeGreaterThan(initial);
    pending = true;
    publisher.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toBe(false);
  } finally { await stop(); }
});

describe("security event listener lifecycle", () => {
  it("waits sixty seconds when idle and wakes immediately for a notification", async () => {
    vi.useFakeTimers();
    const { client, broker } = fixture();
    await broker.start();
    const wake = vi.fn();
    const waiting = waitForSecurityEventWake(broker, new AbortController().signal, broker.revision()).then(wake);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await waiting;
    expect(wake).toHaveBeenCalledOnce();
    const notified = waitForSecurityEventWake(broker, new AbortController().signal, broker.revision()).then(wake);
    client.emit("notification", { channel: "zeros_security_event" });
    await notified;
    expect(wake).toHaveBeenCalledTimes(2);
    await broker.stop();
  });
  it("wakes catalog replay without repeating authority checks, and wakes both on a gap", async () => {
    const { client, broker } = fixture(), feed = vi.fn(), authority = vi.fn();
    broker.subscribe(feed);
    broker.subscribe(authority, "authority");
    await broker.start();
    const before = broker.revision();
    client.emit("notification", { channel: "zeros_cloud_v2_catalog" });
    expect(feed).toHaveBeenCalledOnce();
    expect(authority).not.toHaveBeenCalled();
    expect(broker.revision()).toBe(before + 1);
    client.emit("notification", { channel: "zeros_security_event" });
    expect(feed).toHaveBeenCalledTimes(2);
    expect(authority).toHaveBeenCalledOnce();
    client.emit("error", new Error("synthetic gap"));
    expect(feed).toHaveBeenCalledTimes(3);
    expect(authority).toHaveBeenCalledTimes(2);
    await broker.stop();
  });

  it("does not lose a notification arriving between replay and waiter subscription", async () => {
    vi.useFakeTimers();
    const { client, broker } = fixture();
    await broker.start();
    const beforeReplay = broker.revision();
    client.emit("notification", { channel: "zeros_security_event" });
    let woke = false;
    const waiting = waitForSecurityEventWake(broker, new AbortController().signal, beforeReplay).then(() => { woke = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(woke).toBe(true);
    await waiting;
    await broker.stop();
  });
  it("discards the checked-out connection after LISTEN fails", async () => {
    const { client, broker } = fixture(
      vi.fn(async () => {
        throw new Error("LISTEN failed");
      }),
    );
    await expect(broker.start()).rejects.toThrow("LISTEN failed");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.healthy()).toBe(false);
    await broker.stop();
  });

  it("releases a failed listener exactly once and wakes subscribers", async () => {
    const { client, broker } = fixture();
    const wake = vi.fn();
    broker.subscribe(wake);
    await broker.start();
    client.emit("error", new Error("failover"));
    expect(broker.healthy()).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(wake).toHaveBeenCalledOnce();
    await broker.stop();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not publish a listener when stop races the LISTEN acknowledgement", async () => {
    let acknowledge!: () => void;
    const query = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      return { rows: [] };
    });
    const { client, broker } = fixture(query);
    const starting = broker.start();
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const stopping = broker.stop();
    acknowledge();
    await starting;
    expect(broker.healthy()).toBe(false);
    await stopping;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cannot acquire another connection after stopping", async () => {
    const { connect, broker } = fixture();
    await broker.stop();
    await broker.start();
    expect(connect).not.toHaveBeenCalled();
  });

  it("retires a continuously checked-out listener before the provider lifetime limit", async () => {
    vi.useFakeTimers();
    const { client, broker } = fixture();
    const wake = vi.fn();
    broker.subscribe(wake);
    await broker.start();
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(broker.healthy()).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(wake).toHaveBeenCalledOnce();
    await broker.stop();
  });
});
