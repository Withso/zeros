import { describe, expect, it } from "vitest";
import { requireAlphaRanFirst } from "./alpha-first";

const alpha = (head: string, patch: Record<string, unknown> = {}) => async () => ({ version: 1, ready: true, sourceSha: "a".repeat(40), channel: "alpha",
  maintenance: false, migrations: { state: "current", head, expectedHead: head, manifestSha256: "b".repeat(64) },
  cloud: { enabled: true, ready: true, state: "healthy" }, ...patch });

describe("Alpha ran it first", () => {
  it("accepts migrations Alpha has applied, up to and including its head", async () => {
    await expect(requireAlphaRanFirst(["0254_last.sql"], alpha("0260_newer.sql"))).resolves.toBe("0260_newer.sql");
    await expect(requireAlphaRanFirst(["0217_drop_retired_tables.sql", "0260_newer.sql"], alpha("0260_newer.sql"))).resolves.toBe("0260_newer.sql");
  });

  it("refuses a migration Alpha has not run, including another file at Alpha's head number", async () => {
    await expect(requireAlphaRanFirst(["0261_next.sql"], alpha("0260_newer.sql"))).rejects.toThrow(/Alpha has not run 0261_next\.sql/);
    await expect(requireAlphaRanFirst(["0260_other.sql"], alpha("0260_newer.sql"))).rejects.toThrow(/has not run 0260_other\.sql/);
  });

  it.each([
    ["an unready Alpha", alpha("0260_x.sql", { ready: false })],
    ["Alpha in maintenance", alpha("0260_x.sql", { maintenance: true })],
    ["another channel", alpha("0260_x.sql", { channel: "beta" })],
    ["an unreachable Alpha", async () => { throw new Error("offline"); }],
  ])("refuses %s", async (_name, identity) => {
    await expect(requireAlphaRanFirst(["0254_last.sql"], identity)).rejects.toThrow(/Alpha is unavailable or not ready/);
  });

  it("refuses an empty or malformed request", async () => {
    await expect(requireAlphaRanFirst([], alpha("0260_x.sql"))).rejects.toThrow(/invalid/);
    await expect(requireAlphaRanFirst(["drop.sql"], alpha("0260_x.sql"))).rejects.toThrow(/invalid/);
  });
});
