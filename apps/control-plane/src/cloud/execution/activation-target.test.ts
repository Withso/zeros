import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db.js";
import { parseDatabaseTarget } from "../../database-target.js";
import { executionActivationTarget } from "./activation-target.js";

describe("stable execution activation target", () => {
  const owner = { database: "postgres", principal: "postgres" };
  const target = (login = "temporary.branch1", host = "primary.psdb.cloud") =>
    parseDatabaseTarget(`postgres://${login}@${host}:5432/postgres?sslmode=verify-full`);

  it("retains the PlanetScale branch route while excluding the temporary login", async () => {
    const tx = { query: vi.fn() } as unknown as Tx;
    const first = await executionActivationTarget(tx, target(), owner, "alpha");
    expect(first.fingerprint).toMatch(/^v2:[a-f0-9]{16}$/);
    expect(await executionActivationTarget(tx, target("next.branch1"), owner, "alpha")).toEqual(first);
    expect(tx.query).not.toHaveBeenCalled();
    for (const [url, identity, channel] of [
      [target("temporary.branch2"), owner, "alpha"],
      [target("temporary.branch1", "another.psdb.cloud"), owner, "alpha"],
      [target(), { ...owner, database: "another" }, "alpha"],
      [target(), { ...owner, principal: "another_owner" }, "alpha"],
      [target(), owner, "production"],
    ] as const) expect(await executionActivationTarget(tx, url, identity, channel)).not.toEqual(first);
  });

  it("refuses a PlanetScale login without a branch route instead of binding to the login itself", async () => {
    const tx = { query: vi.fn() } as unknown as Tx;
    // parseDatabaseTarget already refuses these; the target identity must not depend on that caller.
    for (const login of ["temporary", "temporary.", ".branch1"])
      await expect(executionActivationTarget(tx, new URL(`postgres://${login}@primary.psdb.cloud:5432/postgres`), owner, "alpha")).rejects.toThrow(/identity/);
  });

  it("reads the actual non-PlanetScale cluster identity and refuses an unknown identity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ identity: "1234567890123456789" }] });
    const tx = { query } as unknown as Tx;
    const first = await executionActivationTarget(tx, target("temporary", "127.0.0.1"), owner, "development");
    expect(await executionActivationTarget(tx, target("next", "127.0.0.1"), owner, "development")).toEqual(first);
    expect(query).toHaveBeenCalledWith("SELECT system_identifier::text AS identity FROM pg_control_system()");
    query.mockResolvedValue({ rows: [{ identity: "9876543210987654321" }] });
    expect(await executionActivationTarget(tx, target("temporary", "127.0.0.1"), owner, "development")).not.toEqual(first);
    query.mockResolvedValue({ rows: [] });
    await expect(executionActivationTarget(tx, target("temporary", "127.0.0.1"), owner, "development")).rejects.toThrow(/identity/);
    query.mockRejectedValue(Object.assign(new Error("Permission denied"), { code: "42501" }));
    await expect(executionActivationTarget(tx, target("temporary", "127.0.0.1"), owner, "development")).rejects.toMatchObject({ code: "42501" });
  });
});
