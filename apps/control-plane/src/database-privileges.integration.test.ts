import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import {
  resolveWorkOSProviderLockKeys,
  workOSUserProviderLockKey,
} from "./workos-provider-locks.js";

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;

database("runtime credentials without RLS bypass", () => {
  let admin: pg.Pool;
  let runtime: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 2 });
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(admin);
    // Startup SET ROLE models the production unprivileged login even when
    // the disposable test database authenticates its admin using trust.
    runtime = new pg.Pool({
      connectionString: url,
      max: 2,
      options: "-c role=zeros_app",
    });
  });
  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("resolves provider deletion locks even when forced RLS hides identities outside system transactions", async () => {
    const subject = `user_runtime_${randomUUID()}`;
    const account = await ensureUser(admin, {
      provider: "workos",
      providerSubject: subject,
      email: `runtime-${randomUUID()}@example.com`,
      displayName: "Runtime fixture",
    });
    expect(
      (
        await runtime.query(
          "SELECT 1 FROM user_identities WHERE provider_sub = $1",
          [subject],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      await resolveWorkOSProviderLockKeys(runtime, { userIds: [subject] }),
    ).toContain(workOSUserProviderLockKey(account.id));
  });
});
