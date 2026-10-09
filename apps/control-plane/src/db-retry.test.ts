import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withSystemTx } from "./db.js";
import { withRetryableSystemTx } from "./db-retry.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function transactionPool(onQuery?: (sql: string) => void) {
  const events: string[] = [];
  const clients: Array<EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        events.push(sql);
        onQuery?.(sql);
        return { rows: [] };
      }),
      release: vi.fn((discard: boolean) => { events.push(discard ? "discard" : "release"); }),
    });
    clients.push(client);
    return client;
  });
  return { pool: { connect } as unknown as pg.Pool, connect, clients, events };
}

describe("opt-in aborted database transaction retry", () => {
  it.each(["40P01", "40001"])("retries %s in a fresh transaction after rollback and release", async code => {
    const db = transactionPool();
    const error = Object.assign(new Error("private database detail"), { code });
    const work = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("confirmed");
    await expect(withRetryableSystemTx(db.pool, work)).resolves.toBe("confirmed");
    expect(work).toHaveBeenCalledTimes(2);
    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(db.clients[0]!.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(db.clients[0]!.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(db.clients[1]!.query).toHaveBeenLastCalledWith("COMMIT");
    const rollback = db.events.indexOf("ROLLBACK");
    expect(db.events[rollback + 1]).toBe("release");
    expect(db.events[rollback + 2]).toContain("SET LOCAL ROLE zeros_app");
    expect(db.events[rollback + 2]).toContain("set_config('app.system', 'on', true)");
  });

  it.each(["40P01", "40001"])("bounds persistent %s to three attempts and preserves the error", async code => {
    const db = transactionPool();
    const error = Object.assign(new Error("private database detail"), { code });
    const work = vi.fn(async () => { throw error; });
    await expect(withRetryableSystemTx(db.pool, work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(3);
    expect(db.events.filter(sql => sql === "ROLLBACK")).toHaveLength(3);
    expect(db.events.filter(sql => sql === "release")).toHaveLength(3);
    expect(db.events).not.toContain("COMMIT");
  });

  it.each(["23505", "23514", "42501", "42P01", "08006", "ECONNRESET"])("never retries %s", async code => {
    const db = transactionPool();
    const error = Object.assign(new Error("private database detail"), { code });
    const work = vi.fn(async () => { throw error; });
    await expect(withRetryableSystemTx(db.pool, work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledOnce();
    expect(db.connect).toHaveBeenCalledOnce();
  });

  it("does not retry an ambiguous commit or release a second result", async () => {
    const error = new Error("connection lost during commit");
    const db = transactionPool(sql => { if (sql === "COMMIT") throw error; });
    const write = vi.fn(async () => "written");
    await expect(withRetryableSystemTx(db.pool, write)).rejects.toBe(error);
    expect(write).toHaveBeenCalledOnce();
    expect(db.connect).toHaveBeenCalledOnce();
  });

  it("retries a confirmed serialization abort at commit without treating it as connection loss", async () => {
    let commits = 0;
    const db = transactionPool(sql => {
      if (sql === "COMMIT" && ++commits < 3) throw Object.assign(new Error("serialization abort"), { code: "40001" });
    });
    const write = vi.fn(async () => "committed once");
    await expect(withRetryableSystemTx(db.pool, write)).resolves.toBe("committed once");
    expect(write).toHaveBeenCalledTimes(3);
    expect(db.events.filter(sql => sql === "ROLLBACK")).toHaveLength(2);
    expect(db.clients[2]!.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("never retries after an owned connection is lost, even if work throws 40P01", async () => {
    const db = transactionPool();
    const work = vi.fn(async () => {
      db.clients[0]!.emit("end");
      throw Object.assign(new Error("deadlock plus connection loss"), { code: "40P01" });
    });
    await expect(withRetryableSystemTx(db.pool, work)).rejects.toMatchObject({ code: "database_connection_lost" });
    expect(work).toHaveBeenCalledOnce();
    expect(db.clients[0]!.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("leaves the default transaction runner at one attempt", async () => {
    const db = transactionPool();
    const error = Object.assign(new Error("deadlock"), { code: "40P01" });
    const work = vi.fn(async () => { throw error; });
    await expect(withSystemTx(db.pool, work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledOnce();
  });

  it("keeps bounded jitter/backoff outside released transactions", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.99999);
    const db = transactionPool();
    const error = Object.assign(new Error("deadlock"), {code: "40P01"});
    const work = vi.fn(async () => { throw error; });
    const result = expect(withRetryableSystemTx(db.pool, work)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.events.at(-1)).toBe("release");
    await vi.advanceTimersByTimeAsync(98);
    expect(db.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(db.events.at(-1)).toBe("release");
    await vi.advanceTimersByTimeAsync(198);
    expect(db.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(db.connect).toHaveBeenCalledTimes(3);
  });

  it("does not admit backoff beyond the caller's deadline", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const db = transactionPool();
    const error = Object.assign(new Error("deadlock"), {code: "40P01"});
    const work = vi.fn(async () => { throw error; });
    await expect(withRetryableSystemTx(db.pool, work, {deadlineAt: Date.now() + 49})).rejects.toBe(error);
    expect(work).toHaveBeenCalledOnce();
    expect(db.events.at(-1)).toBe("release");
  });

  it("does not start another transaction after the overall retry budget expires", async () => {
    vi.useFakeTimers();
    const db = transactionPool();
    const error = Object.assign(new Error("deadlock"), {code: "40P01"});
    const work = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 1001);
      throw error;
    });
    await expect(withRetryableSystemTx(db.pool, work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledOnce();
    expect(db.events.at(-1)).toBe("release");
  });
});
