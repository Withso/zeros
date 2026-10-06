import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runRuntimeSkewGate, validatePins } from "../runtime-skew/gate.mjs";
import { loadContractSource } from "../runtime-skew/source.mjs";
import { decideScope, loadPolicy, selectJobs } from "../ci/scope.mjs";

describe("source-pinned cloud runtime skew gate", () => {
  it("exercises both released-source directions against the current control-plane routes", async () => {
    const result = await runRuntimeSkewGate();
    expect(result.mode).toBe("source-contracts");
    expect(result.directions).toEqual([
      "current-client/previous-runtime",
      "previous-client/current-runtime",
    ]);
    expect(result.checks).toContain("queued-prompt/claim/settle/stop/approval");
    expect(result.checks).toContain("registration/renewal/service-admission");
  }, 60_000);

  it("exits unsuccessfully for a deliberately incompatible command", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/runtime-skew/check.mjs",
        "--negative-fixture",
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime_skew_incompatible");
    expect(result.stderr).not.toContain("command_dispatch_rejected");
  }, 60_000);

  it("cannot substitute current sources when a required historical pin is missing", () => {
    expect(() =>
      validatePins({
        schemaVersion: 1,
        mode: "source-contracts",
        retainedRuntimes: [],
      }),
    ).toThrow("runtime_skew_pin_invalid");
  });

  it("fails closed when the pinned Git object is unavailable", async () => {
    await expect(
      loadContractSource({
        sourceCommit: "0".repeat(40),
        sourceTree: "0".repeat(40),
      }),
    ).rejects.toThrow("runtime_skew_source_unavailable");
  });

  it.each([
    "apps/control-plane/src/cloud-workspaces/commands.ts",
    "apps/desktop/src/engine/cloud-command-runtime.ts",
    "apps/desktop/src/renderer/platform/bridge/cloud-agent-connection.ts",
    "packages/protocol/src/cloud-commands.ts",
  ])("requires the existing test lane for %s", (file) => {
    const policy = loadPolicy();
    const result = decideScope({
      policy,
      changes: [{ status: "M", path: file }],
    });
    expect(selectJobs(policy, result).vitest).toBe(true);
  });

  it("owns pin and harness edits without the unknown-path full-CI fallback", () => {
    const policy = loadPolicy();
    const result = decideScope({
      policy,
      changes: [{ status: "M", path: "scripts/runtime-skew/pins.json" }],
    });
    expect(result.full).toBe(false);
    expect(result.lanes["cloud-runtime"]).toBe(true);
    expect(selectJobs(policy, result).vitest).toBe(true);
  });
});
