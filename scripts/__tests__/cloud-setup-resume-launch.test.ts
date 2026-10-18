import { afterEach, expect, it, vi } from "vitest";
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
import { prepareAndLaunchCloudWorkspace, waitForReadiness } from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const material = { execution: { workspaceId: "workspace", organizationId: "org", generation: 1, setupRunId: "run", executionFence: 1 },
  image: { ref: "image", sourceCommit: "a".repeat(40) }, repository: { revision: "main" },
  settings: { version: 1, snapshotSha256: "b".repeat(64) } };

function stages(cached = true) {
  const events: string[] = [];
  return { events, readCompleted: vi.fn(async () => cached ? "c".repeat(40) : null),
    attest: vi.fn(async () => { events.push("fresh_attestation"); }),
    prepare: vi.fn(async () => { events.push("repository_and_hooks"); return "d".repeat(40); }),
    project: vi.fn(() => { events.push("credentials"); }),
    start: vi.fn(async () => { events.push("fresh_launch"); }),
    ready: vi.fn(async () => { events.push("fresh_readiness"); return { instanceId: "new-engine", protocolVersion: 1 }; }),
    saveCompleted: vi.fn(() => { events.push("save_completed"); }) };
}

it.each([true, false])("always attests and launches freshly, reusing only completed preparation (cache=%s)", async cached => {
  const steps = stages(cached), record = vi.fn();
  const result = await prepareAndLaunchCloudWorkspace(material, { version: 4 }, "fresh-session", record, steps);
  expect(steps.events).toEqual([...(cached ? [] : ["fresh_attestation", "repository_and_hooks"]),
    "credentials", "fresh_attestation", "fresh_launch", "fresh_readiness", "save_completed"]);
  expect(steps.start).toHaveBeenCalledWith(material, "fresh-session");
  expect(result.readiness.engine.instanceId).toBe("new-engine");
  expect(steps.prepare).toHaveBeenCalledTimes(cached ? 0 : 1);
});

it.each(["attest", "start", "ready"] as const)("a failed or cancelled resumed %s cannot publish readiness or cache completion", async stage => {
  const steps = stages(), error = new Error("closed failure");
  steps[stage].mockRejectedValueOnce(error);
  await expect(prepareAndLaunchCloudWorkspace(material, { version: 4 }, "fresh-session", vi.fn(), steps)).rejects.toBe(error);
  expect(steps.saveCompleted).not.toHaveBeenCalled();
  if (stage === "attest") expect(steps.start).not.toHaveBeenCalled();
  expect(steps.prepare).not.toHaveBeenCalled();
});

it.each(["transport_error", "http_error", "invalid_response", "not_ready"])("records the final %s probe without accepting readiness", async expected => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (expected === "transport_error") throw new Error("synthetic-private-transport");
    if (expected === "invalid_response") return Response.json({ private: "synthetic-private-response" });
    return new Response("synthetic-private-http", { status: expected === "not_ready" ? 503 : 401 });
  }));
  const observe = vi.fn();
  const failed = expect(waitForReadiness({ ...material, engine: { port: 39393, instanceId: "new-engine", readinessProbeToken: "synthetic" } },
    { version: 4, engineUid: 10003 }, observe)).rejects.toMatchObject({ code: "engine_readiness_failed" });
  await vi.advanceTimersByTimeAsync(90_001); await failed;
  expect(observe).toHaveBeenCalledExactlyOnceWith(expected);
});
