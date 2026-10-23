import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { createCloudV2AgentLogins, createCloudV2CodexRefresh } from "./agent-logins.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64") } };

d("cloud v2 agent logins", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  it("reads nothing and renews nothing for a creator without a connected login", async () => {
    const reserve = vi.fn(), complete = vi.fn();
    const refresh = createCloudV2CodexRefresh(pool, keys as never, { reserve, complete } as never);
    await refresh(randomUUID(), randomUUID());
    expect(reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await createCloudV2AgentLogins(pool, keys as never)(randomUUID(), randomUUID(), "codex")).toBeNull();
  });
});
