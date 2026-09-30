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
import { cloudAccountRequest, cloudAgentGrant, createCloudWorkspaceDocument } from "../cloud-workspaces";

const session = { access_token: "synthetic-session", user: { sub: "test-user" } };
beforeEach(() => { state.generation = 0; state.session.mockReset(); state.source.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("cloud request account boundaries", () => {
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
