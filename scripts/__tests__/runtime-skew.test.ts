import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runRuntimeSkewGate, validatePins } from "../runtime-skew/gate.mjs";
import * as gate from "../runtime-skew/gate.mjs";
import { loadContractSource } from "../runtime-skew/source.mjs";
import { decideScope, loadPolicy, selectJobs } from "../ci/scope.mjs";

describe("source-pinned cloud runtime skew gate", () => {
  let gateResult: ReturnType<typeof runRuntimeSkewGate> | undefined;
  const checked = () => gateResult ??= runRuntimeSkewGate();

  it("pins both previous cohorts to the actual Alpha #406 source tree", async () => {
    const pins = JSON.parse(await readFile(new URL("../runtime-skew/pins.json", import.meta.url), "utf8"));
    expect(pins.previousRuntime).toMatchObject({
      runtimeIdPrefix: "r1-7a4e5161",
      sourceCommit: "c8e60c064ec1e4661254c46dee24bc8cfcc300e5",
      sourceTree: "a3d284577be7d17163a560db8c2b92a0df94f390",
    });
    expect(pins.previousDesktop).toMatchObject({
      sourceCommit: "c8e60c064ec1e4661254c46dee24bc8cfcc300e5",
      sourceTree: "a3d284577be7d17163a560db8c2b92a0df94f390",
    });
    for (const pin of [pins.previousRuntime, pins.previousDesktop]) {
      expect(pin.provenance).toContain("Alpha");
      expect(pin.provenance).toContain("#406");
      expect(pin.provenance).toContain("source");
    }
  });

  it("exercises both released-source directions against the current control-plane routes", async () => {
    const result = await checked();
    expect(result.mode).toBe("source-contracts");
    expect(result.directions).toEqual([
      "current-client/previous-runtime",
      "previous-client/current-runtime",
    ]);
    expect(result.checks).toContain("queued-prompt/claim/settle/stop/approval");
    expect(result.checks).toContain("registration/renewal/service-admission");
  }, 120_000);

  it.each([
    "failure-category-fallback",
    "terminal-receipt-negotiation",
    "permission-question-reply-ownership",
    "renewal-transient-refusal",
  ])("enforces %s in both pinned directions", async check => {
    const result = await checked();
    expect(result.checks).toContain(check);
    expect(result.directions).toEqual([
      "current-client/previous-runtime",
      "previous-client/current-runtime",
    ]);
    expect(result.contracts.map(contract => contract.direction)).toEqual(result.directions);
    for (const contract of result.contracts) {
      if (check === "failure-category-fallback") {
        expect(contract.failures.categories).toBeGreaterThanOrEqual(17);
        expect(contract.failures.codes).toBe(contract.failures.categories * 5);
        expect(contract.failures.receiptFailures).toBe(contract.failures.categories);
        expect(contract.failures.unknownFallback).toBe(true);
      } else if (check === "terminal-receipt-negotiation") {
        expect(contract.receipts).toMatchObject({ directRead: true, snapshot: true });
        expect(result.negotiated.receipts.terminal).toBe(true);
      } else if (check === "permission-question-reply-ownership") {
        expect(contract.replies).toEqual({ permission: true, question: true });
        expect(result.negotiated.replies).toEqual({ permission: true, question: true });
      } else {
        expect(contract.renewal).toMatchObject({ cases: 6, expiredWithoutExtension: true });
        expect(contract.renewal.transient).toBe(contract.direction === "previous-client/current-runtime");
      }
    }
  }, 120_000);

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

  it("captures the actual legacy CP schema dependency closure when negotiated boot schemas precede it", async () => {
    const current = await loadContractSource();
    expect(current.controlCommands.CloudCommandRequestSchema.safeParse({
      kind: "snapshot", conversationId: "legacy-conversation",
    }).success).toBe(true);
    expect(current.controlCommands.CloudCommandSettleSchema.safeParse({
      commandId: "11111111-1111-4111-8111-111111111111",
      claimId: "22222222-2222-4222-8222-222222222222",
      state: "succeeded", resultCode: null,
    }).success).toBe(true);
  }, 30_000);
  it("keeps terminal settlements compatible with the strict Alpha control plane until acknowledgement", async () => {
    const pins = JSON.parse(await readFile(new URL("../runtime-skew/pins.json", import.meta.url), "utf8"));
    const [current, previous] = await Promise.all([loadContractSource(), loadContractSource(pins.previousRuntime)]);
    const proof = await gate.controlPlaneTerminalNegotiation(current, previous);
    expect(proof).toEqual({ oldBody: true, acknowledgedBody: true, forgottenAcknowledgement: true, exactBinding: true });
  }, 30_000);

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
