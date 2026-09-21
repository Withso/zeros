import { describe, expect, it } from "vitest";
import {
  planCloudComputeGrant,
  applyCloudComputeGrant,
} from "./manage-cloud-compute-credit.js";
import type pg from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const document = {
  channel: "development",
  fundingScope: "organization",
  organizationId: "11111111-1111-4111-8111-111111111111",
  expectedOrganizationSlug: "fixture-org",
  userId: "22222222-2222-4222-8222-222222222222",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: "2026-10-01T00:00:00Z",
  amountMicroUsd: 20_000_000,
  policyId: "seat-credit-v1",
  idempotencyKey: "invoice-fixture-seat-1",
  reason: "Fixture monthly seat credit grant",
};
describe("compute credit operator plan", () => {
  it.skipIf(process.platform === "win32")("refuses a FIFO grant document without waiting for a writer", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-grant-fifo-"));
    const file = path.join(directory, "grant.json");
    try {
      expect(spawnSync("mkfifo", [file]).status).toBe(0);
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./manage-cloud-compute-credit.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { PATH: process.env.PATH, CLOUD_COMPUTE_GRANT_FILE: file, DATABASE_URL: "postgres://operator@127.0.0.1/fixture" },
        timeout: 3_000, encoding: "utf8", maxBuffer: 8_192,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[cloud-compute-credit] request failed");
      expect(result.stdout).toBe("");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("requires an explicit funding scope for a new operator plan", () => {
    const { fundingScope: _scope, ...ambiguous } = document;
    expect(() => planCloudComputeGrant("postgres://operator@127.0.0.1/a", ambiguous)).toThrow();
  });
  it("funds a Pro user independently of organization membership", () => {
    const { organizationId: _id, expectedOrganizationSlug: _slug, ...user } = document;
    expect(planCloudComputeGrant("postgres://operator@127.0.0.1/a", { ...user, fundingScope: "user" }).request)
      .toMatchObject({ fundingScope: "user", userId: document.userId });
    expect(() => planCloudComputeGrant("postgres://operator@127.0.0.1/a", { ...user, fundingScope: "organization" })).toThrow();
  });
  it("binds the exact grant to its deployment and database without printing credentials", () => {
    const a = planCloudComputeGrant(
      "postgres://operator:private@127.0.0.1/a",
      document,
    );
    expect(JSON.stringify(a)).not.toContain("private");
    expect(JSON.stringify(a)).not.toContain("127.0.0.1");
    expect(
      planCloudComputeGrant(
        "postgres://operator:rotated@127.0.0.1/a",
        document,
      ).digest,
    ).toBe(a.digest);
    expect(
      planCloudComputeGrant(
        "postgres://operator:private@127.0.0.1/b",
        document,
      ).digest,
    ).not.toBe(a.digest);
    expect(
      planCloudComputeGrant("postgres://operator:private@127.0.0.1/a", {
        ...document,
        amountMicroUsd: 21_000_000,
      }).digest,
    ).not.toBe(a.digest);
  });
  it.each([
    { amountMicroUsd: -1 },
    { amountMicroUsd: 0.5 },
    { amountMicroUsd: Number.MAX_SAFE_INTEGER },
    { endsAt: document.startsAt },
    { extra: "ignored" },
  ])("rejects invalid or ambiguous grants %j", (overrides) => {
    expect(() =>
      planCloudComputeGrant("postgres://operator@127.0.0.1/a", {
        ...document,
        ...overrides,
      }),
    ).toThrow();
  });
  it("rejects cross-channel execution and mismatched plan hashes before database access", async () => {
    expect(() =>
      planCloudComputeGrant(
        "postgres://operator@127.0.0.1/a",
        document,
        "production",
      ),
    ).toThrow(/channel/);
    const plan = planCloudComputeGrant(
      "postgres://operator@127.0.0.1/a",
      document,
    );
    await expect(
      applyCloudComputeGrant({} as pg.Pool, plan, "0".repeat(64)),
    ).rejects.toThrow(/plan changed/);
  });
});
