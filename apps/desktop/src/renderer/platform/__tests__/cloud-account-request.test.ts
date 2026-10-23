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
import { CloudWorkspaceDocumentSchema, changeCloudWorkspaceLifecycle, cloudAccountRequest, createCloudWorkspaceDocument,
  getCloudWorkspaceDocument } from "../cloud-workspaces";

function v2Workspace(id: string, state: string) {
  return {
    id, organizationId: id, creatorUserId: id, name: "Workspace", repository: "sample/repo", branch: "zeros/workspace",
    baseBranch: "main", state, errorCode: null, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z",
    version: 2, capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
  };
}
const session = { access_token: "synthetic-session", user: { sub: "user_provider_subject_sentinel", accountId: "55555555-5555-4555-8555-555555555555" } };
beforeEach(() => { state.generation = 0; state.session.mockReset(); state.source.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("cloud request account boundaries", () => {
  it("starts, stops and deletes through the v2 lifecycle endpoints", async () => {
    state.session.mockResolvedValue(session);
    const id = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(async () => Response.json({ workspace: v2Workspace(id, "starting") })); vi.stubGlobal("fetch", fetch);
    const target = { organizationId: id, workspaceId: id };
    expect((await changeCloudWorkspaceLifecycle(target, "wake", "fixture-intent", "interaction")).status).toBe("waking");
    expect(fetch).toHaveBeenLastCalledWith(`https://api.example.test/v1/cloud-v2/workspaces/${id}/start`,
      expect.objectContaining({ method: "POST", body: "{}" }));
    // Archive is its own v2 operation: a plain stop would never become archived.
    await changeCloudWorkspaceLifecycle(target, "archive", "fixture-archive");
    expect(fetch).toHaveBeenLastCalledWith(`https://api.example.test/v1/cloud-v2/workspaces/${id}/archive`, expect.objectContaining({ method: "POST" }));
    await changeCloudWorkspaceLifecycle(target, "delete", "fixture-delete");
    expect(fetch).toHaveBeenLastCalledWith(`https://api.example.test/v1/cloud-v2/workspaces/${id}`, expect.objectContaining({ method: "DELETE" }));
  });
  it("shows a stopped workspace with an archive mark as archived, and only then", async () => {
    state.session.mockResolvedValue(session);
    const id = "11111111-1111-4111-8111-111111111111", target = { organizationId: id, workspaceId: id };
    const archivedAt = "2026-10-05T00:00:00.000Z";
    for (const [state, mark, status] of [["stopped", archivedAt, "archived"], ["failed", archivedAt, "archived"], ["stopping", archivedAt, "stopping"],
      ["stopped", null, "stopped"], ["running", null, "ready"]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace: { ...v2Workspace(id, state), archivedAt: mark } })));
      expect((await getCloudWorkspaceDocument(target)).status).toBe(status);
    }
  });
  it("preserves optional server-derived edit access without inferring it from legacy write access", () => {
    const capabilities = { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null };
    expect(CloudWorkspaceDocumentSchema.shape.capabilities.parse(capabilities).canEdit).toBeUndefined();
    for (const canEdit of [true, false]) expect(CloudWorkspaceDocumentSchema.shape.capabilities.parse({ ...capabilities, canEdit }).canEdit).toBe(canEdit);
  });
  it("maps a v2 workspace into the shared document and rejects a changed identity", async () => {
    state.session.mockResolvedValue(session);
    const id = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace: v2Workspace(id, "running") })));
    const document = await getCloudWorkspaceDocument({ organizationId: id, workspaceId: id });
    expect(CloudWorkspaceDocumentSchema.parse(document)).toMatchObject({
      status: "ready", placement: "cloud", repository: { owner: "sample", name: "repo", revision: "main" },
      capabilities: { canWrite: true, canEdit: true, canStart: false },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace: { ...v2Workspace(id, "running"), id: "22222222-2222-4222-8222-222222222222" } })));
    await expect(getCloudWorkspaceDocument({ organizationId: id, workspaceId: id })).rejects.toThrow("identity");
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

  it("does not use desktop personal source proofs for v2 template creation", async () => {
    state.session.mockResolvedValue(session);
    const fetch = vi.fn(async () => Response.json({ error: {
      code: "github_cloud_source_authorization_required", message: "Refresh source access",
    } }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createCloudWorkspaceDocument({
      organizationId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "workspace-intent",
      repository: { owner: "example", name: "repository" },
    })).rejects.toMatchObject({ code: "github_cloud_source_authorization_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.source).not.toHaveBeenCalled();
  });
});
