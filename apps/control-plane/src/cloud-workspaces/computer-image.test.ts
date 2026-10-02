import { describe, expect, it, vi } from "vitest";
import {
  assertComputerImageAttestation,
  reserveComputerImageSlot,
  computerImageFailure,
} from "./computer-image.js";
import { CloudProviderError } from "./provider.js";

const hash = "a".repeat(64);
describe("Cloud Computer image trust boundary", () => {
  it("never treats workspace readiness as image attestation", () => {
    expect(() =>
      assertComputerImageAttestation({ status: "ready" }, hash, "b".repeat(40)),
    ).toThrow();
  });
  it("binds fresh-clone attestation to the measured build and source contract", () => {
    const report = {
      qualified: true,
      profile: "zeros-cloud-worker-v3",
      setupQualification: { secure: true },
      metadata: {
        buildSha256: hash,
        build: {
          source: { commit: "b".repeat(40), contractSha256: "c".repeat(64) },
          imageContractSha256: "d".repeat(64),
        },
      },
    };
    expect(
      assertComputerImageAttestation(report, hash, "b".repeat(40)),
    ).toMatchObject({ sourceContract: "c".repeat(64) });
    expect(() =>
      assertComputerImageAttestation(report, "e".repeat(64), "b".repeat(40)),
    ).toThrow();
    expect(() =>
      assertComputerImageAttestation(
        { ...report, setupQualification: { secure: false } },
        hash,
        "b".repeat(40),
      ),
    ).toThrow();
  });
  it("keeps the account lock and complete name union without imposing a provider quota", async () => {
    const inventory = Array.from({ length: 25 }, (_, i) => ({ name: `release-${i}` }));
    const events: string[] = [];
    const tx = { query: vi.fn(async (query: string, parameters: string[]) => {
      expect(parameters).toEqual(["fixture-account"]);
      if (query.includes("pg_advisory_xact_lock")) { events.push("locked"); return { rows: [] }; }
      expect(query).toContain("state<>'retired'"); events.push("reservations");
      return { rows: [{ snapshot_name: "release-0" }, { snapshot_name: "pending" }] };
    }) };
    const driver = { inventory: vi.fn(async () => { events.push("inventory"); return inventory; }), assertCapacity: vi.fn(async (_names: string[]) => {}) };
    await expect(reserveComputerImageSlot(tx as any, "fixture-account", driver as any)).resolves.toBeUndefined();
    expect(events).toEqual(["locked", "inventory", "reservations"]);
    expect(new Set(driver.assertCapacity.mock.calls[0]![0])).toEqual(new Set([...inventory.map(row => row.name), "pending"]));
  });
  it.each(["provider_rate_limited", "provider_budget_exhausted"])("retains safe %s classification without reflecting provider text", code => {
    expect(computerImageFailure(new CloudProviderError(code, "synthetic-private-canary", true))).toBe(code);
    expect(computerImageFailure(Object.assign(new Error("synthetic-private-canary"), { code }))).toBe("image_build_failed");
  });
  it("never reflects recipe or provider output in failure messages", () => {
    expect(computerImageFailure(new Error("synthetic-private-canary"))).toBe(
      "image_build_failed",
    );
  });
});
