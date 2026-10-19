import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0, session: vi.fn(), forget: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: state.session }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../cloud-workspace-access", async original => ({
  ...await original<typeof import("../cloud-workspace-access")>(), forgetCloudWorkspacePortForwarding: state.forget,
}));
vi.mock("../../features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
import { changeCloudWorkspaceLifecycleWithReceipt, restartCloudWorkspaceLifecycle } from "../cloud-workspaces";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const laterId = "44444444-4444-4444-8444-444444444444";
const session = { access_token: "synthetic-session" };
const target = () => ({ organizationId, workspaceId });
const document = {
  id: workspaceId, organizationId, teamId: organizationId, createdBy: organizationId,
  name: "Lifecycle fixture", placement: "cloud", status: "ready", version: 1, lifecycleVersion: 1,
  error: null, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", deletedAt: null,
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
  generation: { number: 2, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "ready", lastObservedAt: null },
  capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: "workspace_not_stopped" },
  acceptedOperation: { version: 1, id: laterId, kind: "archive", sourceGeneration: 2, phase: "saving", state: "pending" },
};
const acceptance = (kind: "stop" | "archive" | "delete" | "restart" = "restart") => ({
  workspace: structuredClone(document), operation: { version: 1, id: operationId, kind, sourceGeneration: 1 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  state.generation = 0;
  state.session.mockReset().mockResolvedValue(session);
  state.forget.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("accepted cloud lifecycle HTTP boundary", () => {
  it.each(["stop", "archive", "delete"] as const)("preserves the original %s receipt separately from a later projection", async kind => {
    const result = acceptance(kind), fetcher = vi.fn(async () => Response.json(result));
    vi.stubGlobal("fetch", fetcher);
    expect(await changeCloudWorkspaceLifecycleWithReceipt(target(), kind, "fixture-original-key")).toMatchObject(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `https://api.example.test/v1/organizations/${organizationId}/cloud-workspaces/${workspaceId}${kind === "delete" ? "" : `/${kind}`}`,
      expect.objectContaining({ method: kind === "delete" ? "DELETE" : "POST", body: "{}",
        headers: expect.objectContaining({ "idempotency-key": "fixture-original-key" }) }),
    );
    expect(state.forget).not.toHaveBeenCalled();
  });

  it("retains the original Restart body and receipt across a later generation and accepted action", async () => {
    const fetcher = vi.fn(async () => Response.json(acceptance()));
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < 2; i++) {
      expect(await restartCloudWorkspaceLifecycle(target(), { version: 1, expectedGeneration: 1 }, "fixture-original-key"))
        .toMatchObject(acceptance());
    }
    expect(fetcher.mock.calls).toHaveLength(2);
    for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[0]).toMatch(/\/restart$/);
      expect(call[1]).toMatchObject({ method: "POST", body: '{"version":1,"expectedGeneration":1}',
        headers: expect.objectContaining({ "idempotency-key": "fixture-original-key" }) });
    }
  });

  it("freezes the Restart input before a held session refresh", async () => {
    const held = deferred<typeof session>();
    state.session.mockReturnValue(held.promise);
    const fetcher = vi.fn(async () => Response.json(acceptance()));
    vi.stubGlobal("fetch", fetcher);
    const input = { version: 1 as const, expectedGeneration: 1 };
    const result = restartCloudWorkspaceLifecycle(target(), input, "fixture-original-key");
    input.expectedGeneration = 2;
    held.resolve(session);
    await expect(result).resolves.toMatchObject({ operation: { sourceGeneration: 1 } });
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/restart$/),
      expect.objectContaining({ body: '{"version":1,"expectedGeneration":1}' }));
  });

  it.each(["stop", "restart"] as const)("pins the original target through held %s authentication", async kind => {
    const held = deferred<typeof session>();
    state.session.mockReturnValue(held.promise);
    const fetcher = vi.fn(async () => Response.json(acceptance(kind)));
    vi.stubGlobal("fetch", fetcher);
    const initiatingTarget = target();
    const result = kind === "restart"
      ? restartCloudWorkspaceLifecycle(initiatingTarget, { version: 1, expectedGeneration: 1 }, "fixture-original-key")
      : changeCloudWorkspaceLifecycleWithReceipt(initiatingTarget, kind, "fixture-original-key");
    initiatingTarget.workspaceId = laterId;
    held.resolve(session);
    await expect(result).resolves.toMatchObject({ workspace: { id: workspaceId } });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/cloud-workspaces/${workspaceId}/`), expect.anything());
  });

  it.each(["stop", "restart"] as const)("refuses a foreign %s reply even if the caller mutates its target to match", async kind => {
    const held = deferred<Response>(), sent = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(() => { sent.resolve(); return held.promise; }));
    const initiatingTarget = target();
    const result = kind === "restart"
      ? restartCloudWorkspaceLifecycle(initiatingTarget, { version: 1, expectedGeneration: 1 }, "fixture-original-key")
      : changeCloudWorkspaceLifecycleWithReceipt(initiatingTarget, kind, "fixture-original-key");
    await sent.promise;
    initiatingTarget.workspaceId = laterId;
    held.resolve(Response.json({ ...acceptance(kind), workspace: { ...document, id: laterId } }));
    await expect(result).rejects.toThrow("identity");
  });

  it.each(["authentication", "response"] as const)("fences account retirement during held %s", async boundary => {
    const heldSession = deferred<typeof session>(), heldResponse = deferred<Response>(), sent = deferred<void>();
    state.session.mockReturnValue(boundary === "authentication" ? heldSession.promise : Promise.resolve(session));
    const fetcher = vi.fn(() => { sent.resolve(); return heldResponse.promise; });
    vi.stubGlobal("fetch", fetcher);
    const result = restartCloudWorkspaceLifecycle(target(), { version: 1, expectedGeneration: 1 }, "fixture-original-key");
    if (boundary === "response") await sent.promise;
    state.generation++;
    heldSession.resolve(session); heldResponse.resolve(Response.json(acceptance()));
    await expect(result).rejects.toThrow("account changed");
    expect(fetcher).toHaveBeenCalledTimes(boundary === "response" ? 1 : 0);
  });

  it.each(["not-found", "unavailable", "malformed", "missing-receipt", "foreign-generation", "foreign-kind"] as const)(
    "does not create a legacy Stop/Wake after a %s Restart response", async failure => {
      const response = failure === "not-found" || failure === "unavailable"
        ? Response.json({ error: { code: failure, message: "Synthetic refusal" } }, { status: failure === "not-found" ? 404 : 503 })
        : failure === "malformed" ? new Response("{")
          : failure === "missing-receipt" ? Response.json({ workspace: document })
            : Response.json({ ...acceptance(), operation: { ...acceptance().operation,
              ...(failure === "foreign-generation" ? { sourceGeneration: 2 } : { kind: "stop" }) } });
      const fetcher = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetcher);
      await expect(restartCloudWorkspaceLifecycle(target(), { version: 1, expectedGeneration: 1 }, "fixture-original-key")).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/restart$/), expect.objectContaining({ body: '{"version":1,"expectedGeneration":1}' }));
      expect(state.forget).not.toHaveBeenCalled();
    },
  );

  it("rejects Local and organization-local paths before account or HTTP work", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const organization of ["personal", organizationId]) {
      const local = { organizationId: organization, workspaceId: "/local/workspace" };
      await expect(restartCloudWorkspaceLifecycle(local, { version: 1, expectedGeneration: 1 }, "fixture-original-key")).rejects.toThrow();
      await expect(changeCloudWorkspaceLifecycleWithReceipt(local, "delete", "fixture-original-key")).rejects.toThrow();
    }
    expect(state.session).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
