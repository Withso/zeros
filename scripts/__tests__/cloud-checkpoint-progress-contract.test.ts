import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as shared from "../../packages/protocol/src/cloud-checkpoint-progress.js";
import * as controlPlane from "../../apps/control-plane/src/cloud-workspaces/checkpoint-progress-contract.js";

const input = {
  version: 1,
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  sequence: 1, stage: "checkpoint_received", state: "running", reason: "none", elapsedMs: 0,
};

describe("checkpoint diagnostic contract parity", () => {
  it("keeps the standalone CP mirror and package export exact", () => {
    const source = (url: URL) => readFileSync(url, "utf8").replace(/Mirrored in [^\n]+/, "Mirrored contract.");
    expect(source(new URL("../../apps/control-plane/src/cloud-workspaces/checkpoint-progress-contract.ts", import.meta.url)))
      .toBe(source(new URL("../../packages/protocol/src/cloud-checkpoint-progress.ts", import.meta.url)));
    const metadata = JSON.parse(readFileSync(new URL("../../packages/protocol/package.json", import.meta.url), "utf8"));
    expect(metadata.exports["./cloud-checkpoint-progress"]).toBe("./src/cloud-checkpoint-progress.ts");
    expect(controlPlane.CLOUD_WORKSPACE_ENGINE_CHECKPOINT_PROGRESS_PATH)
      .toBe(shared.CLOUD_WORKSPACE_ENGINE_CHECKPOINT_PROGRESS_PATH);
  });

  it.each([shared, controlPlane])("accepts finite closed stage edges, not arbitrary diagnostics", contract => {
    const schema = contract.CloudCheckpointProgressSchema;
    for (const stage of [
      "checkpoint_received", "service_pause", "process_starts", "setup_stop", "run_stop",
      "agent_retirement", "workload_drain", "terminal_drain", "record_flush", "boot_quiesce",
      "native_pump", "command_drain", "event_flush", "record_handoff", "mirror_flush",
      "seal_create", "normal_freeze", "seal_ack", "checkpoint_capture", "durability_capture", "final_completion",
    ]) {
      expect(schema.parse({ ...input, stage })).toEqual({ ...input, stage });
      expect(schema.safeParse({ ...input, stage, state: "completed", sequence: 64, elapsedMs: 300_000 }).success).toBe(true);
    }
    for (const reason of ["deadline", "authority_rejected", "native_custody", "pending_work", "storage", "mirror", "unknown"]) {
      expect(schema.safeParse({ ...input, state: "failed", reason }).success).toBe(true);
    }
    for (const value of [
      { ...input, privateText: "PRIVATE-DIAGNOSTIC-CANARY" },
      { ...input, stage: "PRIVATE-DIAGNOSTIC-CANARY" },
      { ...input, reason: "PRIVATE-DIAGNOSTIC-CANARY" },
      { ...input, state: "failed" }, { ...input, reason: "storage" },
      { ...input, state: "completed", reason: "deadline" },
      { ...input, sequence: 0 }, { ...input, sequence: 65 }, { ...input, sequence: 1.5 },
      { ...input, elapsedMs: -1 }, { ...input, elapsedMs: 300_001 },
      { ...input, generation: 0 }, { ...input, workspaceId: "local/path" },
      { ...input, organizationId: null }, { ...input, version: 2 },
    ]) expect(schema.safeParse(value).success).toBe(false);
  });
});
