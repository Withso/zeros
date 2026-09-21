import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresSecurityEventBroker, waitForSecurityEventWake } from "./security-events.js";

function fixture(query = vi.fn(async (_sql: string) => ({ rows: [] }))) {
  const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as pg.Pool;
  return { client, connect, broker: new PostgresSecurityEventBroker(pool) };
}

afterEach(() => vi.useRealTimers());

describe("security event listener lifecycle", () => {
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
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(broker.healthy()).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(wake).toHaveBeenCalledOnce();
    await broker.stop();
  });
});
