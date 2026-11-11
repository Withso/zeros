import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation, getTeamStoreState: () => ({ me: null }) }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
import { cloudV2Document, CloudV2WorkspaceSchema, renameCloudV2Workspace } from "../cloud-v2";
import { listCloudWorkspaceCatalogSnapshot } from "../cloud-workspaces";
import { listCloudWorkspaceFollowers, listOrganizationMembers, setCloudWorkspaceFollowing, setCloudWorkspacePinned } from "../team-sharing";
import { recordOrganizationSharing, resetTeamSharingStateForTests, sharingOrganization } from "../team-sharing-state";

const org = "11111111-1111-4111-8111-111111111111", me = "33333333-3333-4333-8333-333333333333", alex = "44444444-4444-4444-8444-444444444444";
const ws = (id: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: org, creatorUserId: alex, name: "w", repository: "Withso/zeros", branch: "zeros/w", baseBranch: "main",
  state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] }, ...extra });
const shared = { teamSharing: 1, createdByUserId: alex, viewerRole: "member", readOnly: true, canManage: false, following: true, pinned: false, followerIds: [me], followerCount: 1 };
let fetches: Array<{ url: string; init: RequestInit }> = [];
const respond = (...bodies: unknown[]) => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { fetches.push({ url, init }); return Response.json(bodies.length > 1 ? bodies.shift() : bodies[0]); }));
beforeEach(() => { fetches = []; resetTeamSharingStateForTests(); state.generation = 0; });
afterEach(() => vi.unstubAllGlobals());
const header = (index: number) => new Headers(fetches[index]!.init.headers).get("x-zeros-team-sharing");

describe("team sharing in the desktop's documents", () => {
  it("makes a teammate's workspace read-only and unmanaged for a member, and leaves a Creator's document as today", () => {
    const reader = cloudV2Document(CloudV2WorkspaceSchema.parse(ws("22222222-2222-4222-8222-222222222222", shared)));
    expect(reader.capabilities).toMatchObject({ canWrite: false, canEdit: false, canManage: false, canStart: false });
    expect(reader.sharing).toEqual({ createdByUserId: alex, viewerRole: "member", readOnly: true, canManage: false, following: true, pinned: false, followerIds: [me], followerCount: 1 });
    const admin = cloudV2Document(CloudV2WorkspaceSchema.parse(ws("22222222-2222-4222-8222-222222222222", { ...shared, viewerRole: "admin", canManage: true })));
    expect(admin.capabilities).toMatchObject({ canWrite: false, canEdit: true, canManage: true, canStart: false });
    const creator = cloudV2Document(CloudV2WorkspaceSchema.parse(ws("22222222-2222-4222-8222-222222222222")));
    expect(creator.capabilities).toMatchObject({ canWrite: true, canEdit: true, canManage: true, canStart: true });
    expect(creator).not.toHaveProperty("sharing");
    // Malformed sharing fields read as no sharing, never as a writable teammate workspace with half the fields.
    expect(cloudV2Document(CloudV2WorkspaceSchema.parse(ws("22222222-2222-4222-8222-222222222222", { ...shared, viewerRole: "owner" })))).not.toHaveProperty("sharing");
  });

  it("asks for the shared list with the opt-in header, follows its pages, and records the organization as sharing", async () => {
    respond({ workspaces: [ws("22222222-2222-4222-8222-222222222222", shared)], teamSharing: 1, nextCursor: "c2" },
      { workspaces: [ws("55555555-5555-4555-8555-555555555555", { ...shared, viewerRole: "creator", readOnly: false, canManage: true, creatorUserId: me })], teamSharing: 1, nextCursor: null });
    const snapshot = await listCloudWorkspaceCatalogSnapshot(org);
    expect(snapshot.workspaces.map(doc => doc.id)).toEqual(["22222222-2222-4222-8222-222222222222", "55555555-5555-4555-8555-555555555555"]);
    expect(snapshot.complete).toBe(true);
    expect([header(0), header(1)]).toEqual(["1", "1"]);
    expect(fetches[1]!.url).toContain("cursor=c2");
    expect(sharingOrganization(org)).toBe(true);
  });

  it("never lets an N-1 creator-only reply replace a confirmed shared set", async () => {
    recordOrganizationSharing(org, true);
    respond({ workspaces: [ws("55555555-5555-4555-8555-555555555555", { creatorUserId: me })] });
    const snapshot = await listCloudWorkspaceCatalogSnapshot(org);
    expect(snapshot.complete).toBe(false);          // the catalog keeps the teammates' rows it already has
    expect(sharingOrganization(org)).toBe(true);
    // A new account generation forgets sharing; a creator-only reply then is simply the list.
    state.generation = 1;
    respond({ workspaces: [] });
    expect((await listCloudWorkspaceCatalogSnapshot(org)).complete).toBe(true);
    expect(sharingOrganization(org)).toBe(false);
  });

  it("calls follow, pin, followers and the roster with the opt-in, and maps roster names", async () => {
    const target = { organizationId: org, workspaceId: "22222222-2222-4222-8222-222222222222" };
    respond({ following: true }); expect(await setCloudWorkspaceFollowing(target, true)).toBe(true);
    respond({ pinned: false }); expect(await setCloudWorkspacePinned(target, false)).toBe(false);
    respond({ userIds: [me], nextCursor: null }); expect(await listCloudWorkspaceFollowers(target)).toEqual([me]);
    expect(fetches.map(fetch => [fetch.init.method, fetch.url.replace("https://api.example.test", "")])).toEqual([
      ["POST", `/v1/cloud-v2/workspaces/${target.workspaceId}/follow`], ["POST", `/v1/cloud-v2/workspaces/${target.workspaceId}/unpin`],
      ["GET", `/v1/cloud-v2/workspaces/${target.workspaceId}/followers?limit=200`]]);
    expect([header(0), header(1), header(2)]).toEqual(["1", "1", "1"]);
    expect(fetches[0]!.init.body).toBe("{}");
    respond({ members: [{ id: me, email: "me@example.test", display_name: "Me Person", avatar_url: "https://img.example.test/a.png", role: "member" },
      { id: alex, email: "alex@example.test", display_name: null, avatar_url: "javascript:alert(1)", role: "admin" }] });
    expect(await listOrganizationMembers(org)).toEqual([{ id: me, name: "Me Person", avatarUrl: "https://img.example.test/a.png", role: "member" },
      { id: alex, name: "alex", avatarUrl: null, role: "admin" }]);
  });

  it("renames through the control plane with the opt-in header and a bounded name, and reads the reply's sharing fields", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    respond({ workspace: ws(id, { ...shared, viewerRole: "admin", canManage: true, name: "Release notes" }), teamSharing: 1 });
    const renamed = await renameCloudV2Workspace({ organizationId: org, workspaceId: id }, "  Release notes ");
    expect(fetches[0]!.url).toBe(`https://api.example.test/v1/cloud-v2/workspaces/${id}/rename`);
    expect(JSON.parse(String(fetches[0]!.init.body))).toEqual({ name: "Release notes" });
    expect(header(0)).toBe("1");
    expect(cloudV2Document(renamed).sharing?.viewerRole).toBe("admin");
    await expect(renameCloudV2Workspace({ organizationId: org, workspaceId: id }, " ")).rejects.toThrow(/1 to 120/);
    await expect(renameCloudV2Workspace({ organizationId: org, workspaceId: id }, "x".repeat(121))).rejects.toThrow(/1 to 120/);
    expect(fetches).toHaveLength(1);
  });
});
