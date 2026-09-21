import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withWorkOSProviderLocks } from "./workos-provider-locks.js";
import { withSystemTx } from "./db.js";
import { fetchWithHeldWorkOSProviderLock } from "./workos-provider-lock-context.js";
afterEach(() => vi.unstubAllGlobals());

function fixture(onAcquire?: () => void) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        onAcquire?.();
        return { rows: [{ acquired: true }] };
      }
      return { rows: [{ unlocked: true }] };
    }),
    release: vi.fn(),
  });
  const pool = {
    options: { max: 5 },
    connect: vi.fn(async () => client),
  } as unknown as pg.Pool;
  return { client, pool };
}
describe("WorkOS owned lock connections", () => {
  it("rolls back SQL work if its enclosing provider lock was lost", async () => {
    const f = fixture(),
      transaction = {
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      };
    const pool = {
      connect: vi.fn(async () => transaction),
    } as unknown as pg.Pool;
    await expect(
      withWorkOSProviderLocks(f.pool, ["target"], () =>
        withSystemTx(pool, async () => {
          f.client.emit("end");
          return "unacknowledged";
        }),
      ),
    ).rejects.toMatchObject({ code: "workos_provider_lock_lost" });
    expect(transaction.query).toHaveBeenCalledWith("ROLLBACK");
    expect(transaction.query).not.toHaveBeenCalledWith("COMMIT");
  });
  it("cancels an in-flight SDK request and prevents its retry after connection loss", async () => {
    const f = fixture();
    let observed: AbortSignal | undefined;
    const requestFetch = vi.fn(async (_input: unknown, init: RequestInit) => {
      observed = init.signal!;
      f.client.emit("end");
      return new Response("{}", { status: 503 });
    });
    vi.stubGlobal("fetch", requestFetch);
    await expect(
      withWorkOSProviderLocks(f.pool, ["target"], async () => {
        await expect(
          fetchWithHeldWorkOSProviderLock("https://workos.example.test/users", {
            method: "POST",
          }),
        ).rejects.toMatchObject({ code: "workos_provider_lock_lost" });
        await fetchWithHeldWorkOSProviderLock(
          "https://workos.example.test/users",
          { method: "POST" },
        );
      }),
    ).rejects.toMatchObject({ code: "workos_provider_lock_lost" });
    expect(observed?.aborted).toBe(true);
    expect(requestFetch).toHaveBeenCalledOnce();
  });
  it("prevents protected work from opening a new write transaction after lock loss", async () => {
    const f = fixture(),
      transaction = {
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      },
      connect = vi.fn(async () => transaction);
    const pool = { connect } as unknown as pg.Pool;
    await expect(
      withWorkOSProviderLocks(f.pool, ["target"], async () => {
        f.client.emit("end");
        return withSystemTx(pool, async () => "late write");
      }),
    ).rejects.toMatchObject({ code: "workos_provider_lock_lost" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("releases every lock when cancellation arrives with the final acquisition response", async () => {
    const controller = new AbortController(),
      f = fixture(() => controller.abort()),
      work = vi.fn();
    await expect(
      withWorkOSProviderLocks(f.pool, ["target"], work, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "workos_provider_lock_aborted" });
    expect(work).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it.each(["error", "end"])(
    "fails closed when its checked-out lock connection emits %s during protected work",
    async (event) => {
      const f = fixture();
      let entered!: () => void, finish!: () => void;
      const started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
      const result = withWorkOSProviderLocks(f.pool, ["target"], async () => {
        entered();
        await gate;
        return "must-not-acknowledge";
      }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      await started;
      let emittedError: unknown;
      try {
        f.client.emit(event, new Error("private connection failure"));
      } catch (error) {
        emittedError = error;
      } finally {
        finish();
      }
      const settled = await result;
      expect(emittedError).toBeUndefined();
      expect(settled.error).toMatchObject({
        code: "workos_provider_lock_lost",
      });
      expect(settled.value).toBeNull();
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
});
