import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
import { prepareAndLaunchCloudWorkspace } from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";

const material = {
  execution: { workspaceId: "workspace", organizationId: "organization", generation: 1, setupRunId: "run", executionFence: 1 },
  image: { ref: "image", sourceCommit: "a".repeat(40) }, repository: { revision: "main" },
  settings: { version: 1, snapshotSha256: "b".repeat(64) },
  engine: { instanceId: "engine-current", protocolVersion: 1, port: 39393, readinessProbeToken: "readiness-fixture" },
};
const ready = { version: 1, audience: "zeros-cloud-engine-readiness-v1", ready: true,
  engine: { version: 1, instanceId: "engine-current", protocolVersion: 1, health: "ready", durableRecordConnected: true } };
const fetchImpl = vi.fn();
function response(value = ready) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
function launch() {
  const saveCompleted = vi.fn();
  const pending = prepareAndLaunchCloudWorkspace(material, { version: 4 }, "new-session", vi.fn(), {
    readCompleted: async () => "c".repeat(40), attest: async () => {}, project: () => {}, start: async () => {}, saveCompleted,
  });
  return { pending, saveCompleted };
}
beforeEach(() => { vi.useFakeTimers(); fetchImpl.mockReset(); vi.stubGlobal("fetch", fetchImpl); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("fresh cloud engine readiness", () => {
  it("observes a newly ready engine within 150 ms after a failed probe", async () => {
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(response());
    const { pending, saveCompleted } = launch();
    let outcome: string | undefined;
    const completed = pending.then(result => { outcome = result.outcome; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(outcome).toBe("ready");
    await completed;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(saveCompleted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["instance", "protocol", "durable sync", "health"])("does not accept a successful health response with mismatched %s", async mismatch => {
    const invalid = structuredClone(ready);
    if (mismatch === "instance") invalid.engine.instanceId = "engine-old";
    if (mismatch === "protocol") invalid.engine.protocolVersion = 2;
    if (mismatch === "durable sync") invalid.engine.durableRecordConnected = false;
    if (mismatch === "health") invalid.engine.health = "starting";
    fetchImpl.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response());
    const { pending, saveCompleted } = launch();
    let complete = false;
    const completed = pending.then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCompleted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(complete).toBe(true);
    await completed;
    expect(saveCompleted).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the ninety-second deadline and never saves completion on timeout", async () => {
    fetchImpl.mockImplementation(async () => new Response(null, { status: 503 }));
    const { pending, saveCompleted } = launch();
    const rejected = expect(pending).rejects.toMatchObject({ code: "engine_readiness_failed" });
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(saveCompleted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps each hung request to the remaining ninety-second budget", async () => {
    fetchImpl.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    }));
    const { pending, saveCompleted } = launch();
    let failure: unknown;
    const completed = pending.catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(failure).toMatchObject({ code: "engine_readiness_failed" });
    await completed;
    expect(saveCompleted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
