import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withWorkOSProviderLocks } from "./workos-provider-locks.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function queryBeforeStarvationTimeout(pool: pg.Pool): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("provider lock holder starved by waiter")),
          500,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

d("WorkOS provider locks", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  });

  afterAll(async () => pool.end());

  it("does not let same-target waiters starve the lock holder's database work", async () => {
    const key = `workos-provider-test:${randomUUID()}`;
    const holderEntered = deferred();
    const releaseHolder = deferred();
    let waiterRan = false;

    const holder = withWorkOSProviderLocks(pool, [key], async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
      await queryBeforeStarvationTimeout(pool);
    });
    await holderEntered.promise;

    const waiter = withWorkOSProviderLocks(pool, [key], async () => {
      waiterRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseHolder.resolve();

    const results = await Promise.allSettled([holder, waiter]);
    expect(results).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    expect(waiterRan).toBe(true);
  });

  it("reserves pool capacity for database work across distinct targets", async () => {
    const firstKey = `workos-provider-test:${randomUUID()}`;
    const secondKey = `workos-provider-test:${randomUUID()}`;
    const firstEntered = deferred();
    const allowFirstQuery = deferred();

    const first = withWorkOSProviderLocks(pool, [firstKey], async () => {
      firstEntered.resolve();
      await allowFirstQuery.promise;
      await queryBeforeStarvationTimeout(pool);
    });
    await firstEntered.promise;

    const second = withWorkOSProviderLocks(pool, [secondKey], async () => {
      await queryBeforeStarvationTimeout(pool);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    allowFirstQuery.resolve();

    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("bounds how long a contended provider lock can wait", async () => {
    const key = `workos-provider-test:${randomUUID()}`;
    const holderEntered = deferred();
    const releaseHolder = deferred();
    const holder = withWorkOSProviderLocks(pool, [key], async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    await holderEntered.promise;

    const releaseTimer = setTimeout(releaseHolder.resolve, 150);
    try {
      await expect(
        withWorkOSProviderLocks(pool, [key], async () => undefined, {
          timeoutMs: 25,
        }),
      ).rejects.toMatchObject({
        name: "WorkOSProviderLockTimeoutError",
        code: "workos_provider_lock_timeout",
      });
    } finally {
      clearTimeout(releaseTimer);
      releaseHolder.resolve();
      await holder;
    }
  });
});
