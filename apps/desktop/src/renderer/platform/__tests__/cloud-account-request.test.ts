import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const state = vi.hoisted(() => ({ generation: 0, session: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: state.session }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../../features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {},
}));
import { cloudAccountRequest } from "../cloud-workspaces";

const session = { access_token: "synthetic-session", user: { sub: "test-user" } };
beforeEach(() => { state.generation = 0; state.session.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("cloud request account boundaries", () => {
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
});
