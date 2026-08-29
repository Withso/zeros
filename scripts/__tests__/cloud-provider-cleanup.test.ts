import { describe, expect, it } from "vitest";
import {
  runBoundedProviderOperation,
  verifySandboxAbsent,
  verifySnapshotNameAbsent,
  waitForResourceAbsence,
} from "../cloud-workspace-validation/lib/provider-cleanup";

describe("cloud provider cleanup verification", () => {
  it("bounds a paid provider mutation that never settles", async () => {
    await expect(
      runBoundedProviderOperation(
        "snapshot build",
        () => new Promise<void>(() => undefined),
        10,
      ),
    ).rejects.toThrow(/snapshot build.*timed out/i);
  });

  it("waits through eventual consistency until inventory proves absence", async () => {
    let checks = 0;
    await waitForResourceAbsence("sandbox test", async () => ++checks < 3, {
      timeoutMs: 100,
      pollMs: 1,
    });
    expect(checks).toBe(3);
  });

  it("fails closed when a deleted resource remains in provider inventory", async () => {
    await expect(
      waitForResourceAbsence("snapshot test", async () => true, {
        timeoutMs: 10,
        pollMs: 1,
      }),
    ).rejects.toThrow(/snapshot test.*still present/i);
  });

  it("bounds a provider inventory request that never settles", async () => {
    await expect(
      waitForResourceAbsence(
        "stalled inventory",
        () => new Promise<boolean>(() => undefined),
        { timeoutMs: 100, pollMs: 1, checkTimeoutMs: 10 },
      ),
    ).rejects.toThrow(/inventory.*timed out/i);
  });

  it("checks the exact sandbox id through fresh provider inventory", async () => {
    let polls = 0;
    const queries: unknown[] = [];
    const inventory = {
      list(query: unknown) {
        queries.push(query);
        polls++;
        const present = polls === 1;
        return (async function* () {
          yield { id: "unrelated-sandbox" };
          if (present) yield { id: "sandbox-target" };
        })();
      },
    };

    await verifySandboxAbsent(inventory, "sandbox-target", {
      timeoutMs: 100,
      pollMs: 1,
    });
    expect(polls).toBe(2);
    expect(queries).toEqual([
      { id: "sandbox-target", limit: 100 },
      { id: "sandbox-target", limit: 100 },
    ]);
  });

  it("checks every snapshot page until the exact name disappears", async () => {
    let polls = 0;
    const inventory = {
      async list(page: number) {
        if (page === 1) polls++;
        return {
          items:
            polls === 1 && page === 2
              ? [{ name: "zeros-zsr-ci-123-1" }]
              : [{ name: "unrelated-snapshot" }],
          totalPages: 2,
        };
      },
    };

    await verifySnapshotNameAbsent(inventory, "zeros-zsr-ci-123-1", {
      timeoutMs: 100,
      pollMs: 1,
    });
    expect(polls).toBe(2);
  });
});
