import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({ generation: 0, session: vi.fn(), source: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: state.session }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../cloud-github", () => ({ authorizeCloudGithubSource: state.source }));
vi.mock("../../features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
import { CloudWorkspaceDocumentSchema, cloudAccountRequest, cloudAgentGrant, createCloudWorkspaceDocument, getCloudWorkspaceDocument,
  getCloudRuntimeUpgradeAvailability, upgradeCloudWorkspaceRuntime } from "../cloud-workspaces";

const session = { access_token: "synthetic-session", user: { sub: "test-user" } };
beforeEach(() => { state.generation = 0; state.session.mockReset(); state.source.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("cloud request account boundaries", () => {
  it("rejects local workspace targets before authentication or HTTP for runtime discovery and updates", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const target = { organizationId: "personal", workspaceId: "/local/workspace" };
    await expect(getCloudRuntimeUpgradeAvailability(target)).rejects.toThrow();
    await expect(upgradeCloudWorkspaceRuntime(target, { expectedGeneration: 1,
      operationId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow();
    expect(state.session).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads staff runtime availability for the exact workspace and rejects a changed identity", async () => {
    state.session.mockResolvedValue(session);
    const organizationId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
    const result = { organizationId, workspaceId, generation: 1, currentRuntimeId: `r1-${"a".repeat(64)}`,
      latestRuntimeId: `r1-${"b".repeat(64)}`, updateAvailable: true, unavailableReason: null, transition: null };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...result, workspaceId: organizationId }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await getCloudRuntimeUpgradeAvailability({ organizationId, workspaceId })).toEqual(result);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.example.test/v1/organizations/${organizationId}/cloud-workspaces/${workspaceId}/runtime-upgrade`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
    await expect(getCloudRuntimeUpgradeAvailability({ organizationId, workspaceId })).rejects.toThrow("workspace identity");
  });
  it("posts only the explicit CAS and operation ID and validates the returned receipt", async () => {
    state.session.mockResolvedValue(session);
    const id = "11111111-1111-4111-8111-111111111111", target = { organizationId: id, workspaceId: id };
    const input = { expectedGeneration: 3, operationId: id };
    const result = { operationId: id, sourceGeneration: 3, generation: 4, runtimeId: `r1-${"b".repeat(64)}`,
      transitionId: id, unchanged: false };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...result, sourceGeneration: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await upgradeCloudWorkspaceRuntime(target, input)).toEqual(result);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("Idempotency-Key")).toBe(id);
    await expect(upgradeCloudWorkspaceRuntime(target, input)).rejects.toThrow("different operation");
  });
  it("preserves optional server-derived edit access without inferring it from legacy write access", () => {
    const capabilities = { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null };
    expect(CloudWorkspaceDocumentSchema.shape.capabilities.parse(capabilities).canEdit).toBeUndefined();
    for (const canEdit of [true, false]) expect(CloudWorkspaceDocumentSchema.shape.capabilities.parse({ ...capabilities, canEdit }).canEdit).toBe(canEdit);
  });
  it("retains server-derived admin metadata in a fetched workspace DTO", async () => {
    state.session.mockResolvedValue(session);
    const id = "11111111-1111-4111-8111-111111111111";
    const workspace = {
      id, organizationId: id, teamId: id, name: "Configure Cloud Computer", createdBy: id,
      ownerUserId: id, adminWorkspace: { creatorUserId: id }, placement: "cloud", status: "provisioning",
      capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: "workspace_not_stopped" },
      repository: { forge: "github.com", owner: "sample", name: "repo", revision: "main" },
      generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
        observedState: "unknown", lastObservedAt: null },
      version: 1, error: null, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", deletedAt: null,
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace })));
    expect((await getCloudWorkspaceDocument({ organizationId: id, workspaceId: id })).adminWorkspace).toEqual({ creatorUserId: id });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace: { ...workspace, adminWorkspace: { creatorUserId: "invalid" } } })));
    await expect(getCloudWorkspaceDocument({ organizationId: id, workspaceId: id })).rejects.toThrow();
  });
  it("chooses the proven account grant even when a newer unqualified API-key grant matches the same model", async () => {
    state.session.mockResolvedValue(session);
    const qualified = "44444444-4444-4444-8444-444444444444";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ delegations: [
      { id: "22222222-2222-4222-8222-222222222222", kind: "codex-api-key", models: ["gpt-5.6-luna"], expiresAt: new Date(Date.now() + 60_000).toISOString(), runtimeQualified: false },
      { id: qualified, kind: "codex-chatgpt", models: ["gpt-5.6-luna"], expiresAt: new Date(Date.now() + 60_000).toISOString(), runtimeQualified: true },
    ] })));
    expect(await cloudAgentGrant({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333" }, "codex", "gpt-5.6-luna")).toBe(qualified);
  });
  it("explains an unqualified workspace image before queueing an agent command", async () => {
    state.session.mockResolvedValue(session);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ delegations: [{
      id: "22222222-2222-4222-8222-222222222222", kind: "claude-setup-token",
      models: ["claude-haiku-4-5"], expiresAt: new Date(Date.now() + 60_000).toISOString(),
      runtimeQualified: false,
    }] })));
    await expect(cloudAgentGrant({
      organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    }, "claude", "claude-haiku-4-5")).rejects.toThrow(/workspace.*runtime.*update/i);
  });

  it("keeps a qualified cloud grant usable", async () => {
    state.session.mockResolvedValue(session);
    const id = "22222222-2222-4222-8222-222222222222";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ delegations: [{
      id, kind: "codex-chatgpt", models: ["gpt-5.6-luna"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), runtimeQualified: true,
    }] })));
    await expect(cloudAgentGrant({
      organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    }, "codex", "gpt-5.6-luna")).resolves.toBe(id);
  });

  it("retains the runtime upgrade flag and explains it before a command can be queued", async () => {
    state.session.mockResolvedValue(session);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ delegations: [{
      id: "22222222-2222-4222-8222-222222222222", kind: "codex-chatgpt", models: ["gpt-5.6-sol"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), runtimeQualified: false, runtimeUpgradeRequired: true,
    }] })));
    await expect(cloudAgentGrant({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333" }, "codex", "gpt-5.6-sol"))
      .rejects.toMatchObject({ code: "cloud_runtime_upgrade_required" });
  });

  it.each([false, true])("separates missing credentials from model consent (connected=%s)", async connected => {
    state.session.mockResolvedValue(session);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ delegations: connected ? [{
      id: "22222222-2222-4222-8222-222222222222", kind: "codex-chatgpt", models: ["gpt-5.5"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), runtimeQualified: true,
    }] : [] })));
    await expect(cloudAgentGrant({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "33333333-3333-4333-8333-333333333333" }, "codex", "gpt-6.1-sol"))
      .rejects.toMatchObject({ code: connected ? "cloud_agent_model_not_authorized" : "cloud_agent_credential_required" });
  });

  it("captures the account before its first asynchronous boundary", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    state.session.mockResolvedValue(session);
    const pending = cloudAccountRequest("/v1/test", z.object({ ok: z.boolean() }), {
      body: {}, idempotencyKey: "clicked-under-original-account",
    });
    state.generation++;
    await expect(pending).rejects.toThrow(/account changed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not dispatch a mutation when the account changes during token refresh", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    state.session.mockImplementation(async () => { state.generation++; return session; });
    await expect(cloudAccountRequest("/v1/test", z.object({ ok: z.boolean() }), {
      body: {}, idempotencyKey: "test-operation",
    })).rejects.toThrow(/account changed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not publish a response from a retired account", async () => {
    state.session.mockResolvedValue(session);
    vi.stubGlobal("fetch", vi.fn(async () => { state.generation++; return Response.json({ ok: true }); }));
    await expect(cloudAccountRequest("/v1/test", z.object({ ok: z.boolean() }))).rejects.toThrow(/account changed/i);
  });

  it("does not retry workspace creation under a replacement account after a source probe", async () => {
    state.session.mockResolvedValue(session);
    const fetch = vi.fn(async () => Response.json({ error: {
      code: "github_cloud_source_authorization_required", message: "Refresh source access",
    } }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    state.source.mockImplementation(async () => { state.generation++; });
    await expect(createCloudWorkspaceDocument({
      organizationId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "workspace-intent",
      repository: { forge: "github.com", owner: "example", name: "repository", revision: "main",
        githubInstallationId: "22222222-2222-4222-8222-222222222222" },
    })).rejects.toThrow(/account changed/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
