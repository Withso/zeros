import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { consumeRuntimeHandoff, readBootEnvironment } from "../main";

it("keeps crashed private boots fenced until readiness, then allows an ordinary restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "zeros-runtime-boot-"));
  try {
    const handoff = { id: randomUUID(), bootId: randomUUID(), instanceId: randomUUID() };
    const boot = readBootEnvironment({ CLOUD_V2_API_URL: "https://fixture.example.test", CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), ZEROS_WORKSPACE_ID: randomUUID(),
      ZEROS_RUNTIME_HANDOFF: handoff.id, ZEROS_RUNTIME_BOOT: handoff.bootId, ZEROS_RUNTIME_INSTANCE: handoff.instanceId });
    expect(consumeRuntimeHandoff(directory, boot.runtimeHandoff)).toEqual(handoff);
    expect(() => consumeRuntimeHandoff(directory, boot.runtimeHandoff)).toThrow();
    writeFileSync(join(directory, "runtime-handoffs", `completed-${handoff.id}-${handoff.bootId}`), "");
    expect(consumeRuntimeHandoff(directory, boot.runtimeHandoff)).toBeUndefined();
    const rollback = { ...handoff, bootId: randomUUID() };
    expect(consumeRuntimeHandoff(directory, rollback)).toEqual(rollback);
    expect(() => consumeRuntimeHandoff(directory, { ...handoff, bootId: "../other" })).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("reports the runtime it executes from, not only the one it was configured with", () => {
  const environment = { CLOUD_V2_API_URL: "https://fixture.example.test", CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), ZEROS_WORKSPACE_ID: randomUUID() };
  expect(readBootEnvironment(environment, `/opt/zeros/runtime/${"c".repeat(64)}/worker.mjs`).runtimeSha256).toBe("c".repeat(64));
  expect(readBootEnvironment(environment, "/home/user/zeros/apps/cloud-worker/dist/worker.mjs").runtimeSha256).toBe("a".repeat(64));
  expect(readBootEnvironment(environment, undefined).runtimeSha256).toBe("a".repeat(64));
  expect(() => readBootEnvironment({ ...environment, CLOUD_V2_RUNTIME_SHA256: "" }, "/tmp/worker.mjs")).toThrow();
});
