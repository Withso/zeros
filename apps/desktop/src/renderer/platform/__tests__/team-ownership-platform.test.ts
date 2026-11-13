import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }) }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test",
  ControlPlaneError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message); } } }));
import { listCloudWorkspaceCatalogSnapshot } from "../cloud-workspaces";
import { listReassignCandidates, reassignCloudWorkspace } from "../team-sharing";
import { resetTeamSharingStateForTests } from "../team-sharing-state";

const org = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
const alex = "44444444-4444-4444-8444-444444444444", sam = "55555555-5555-4555-8555-555555555555", kim = "66666666-6666-4666-8666-666666666666";
const target = { organizationId: org, workspaceId };
const ws = (extra: Record<string, unknown> = {}) => ({ id: workspaceId, organizationId: org, creatorUserId: alex, name: "w", repository: "Withso/zeros", branch: "zeros/w", baseBranch: "main",
  state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
  teamSharing: 1, createdByUserId: alex, viewerRole: "admin", readOnly: false, canManage: true, following: false, pinned: false, followerIds: [], followerCount: 0,
  teamOwnership: 1, creatorRevision: "7", noCreatorReason: null, canReassign: true, ...extra });
let fetches: Array<{ url: string; init: RequestInit }> = [];
const respond = (...replies: Array<{ status?: number; body: unknown }>) => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
  fetches.push({ url, init }); const reply = replies.length > 1 ? replies.shift()! : replies[0]!; return Response.json(reply.body, { status: reply.status ?? 200 });
}));
beforeEach(() => { fetches = []; resetTeamSharingStateForTests(); });
afterEach(() => vi.unstubAllGlobals());
const headers = (index: number) => new Headers(fetches[index]!.init.headers);

describe("team ownership requests", () => {
  it("asks for team ownership with team sharing on the catalog, so a workspace with no Creator can be shown", async () => {
    respond({ body: { workspaces: [ws({ creatorUserId: null, noCreatorReason: "hold" })], teamSharing: 1, nextCursor: null } });
    const snapshot = await listCloudWorkspaceCatalogSnapshot(org);
    expect(snapshot.workspaces[0]).toMatchObject({ ownerUserId: null, sharing: { ownership: { noCreatorReason: "hold", canReassign: true } } });
    expect([headers(0).get("x-zeros-team-sharing"), headers(0).get("x-zeros-team-ownership")]).toEqual(["1", "1"]);
  });

  it("lists the reassign candidates across pages of one Creator revision, with each ineligible reason and the agents they could run", async () => {
    respond({ body: { candidates: [{ userId: sam, eligible: true, agentLogins: { claude: true } }, { userId: kim, eligible: false, reason: "on_hold" }], nextCursor: "c2", creatorRevision: "7" } },
      { body: { candidates: [{ userId: alex, eligible: false, reason: "repository_access_required" }], nextCursor: null, creatorRevision: "7" } });
    expect(await listReassignCandidates(target)).toEqual({ creatorRevision: "7", candidates: [
      { userId: sam, eligible: true, agentLogins: { claude: true } }, { userId: kim, eligible: false, reason: "on_hold" }, { userId: alex, eligible: false, reason: "repository_access_required" }] });
    expect(fetches.map(fetch => new URL(fetch.url).search)).toEqual(["?limit=200", "?limit=200&cursor=c2"]);
    expect(headers(0).get("x-zeros-team-ownership")).toBe("1");
  });

  it("refuses a candidate page from another Creator revision as creator_changed", async () => {
    respond({ body: { candidates: [], nextCursor: "c2", creatorRevision: "7" } }, { body: { candidates: [], nextCursor: null, creatorRevision: "8" } });
    await expect(listReassignCandidates(target)).rejects.toMatchObject({ code: "creator_changed" });
  });

  it("reassigns with the exact held body and applies the returned document", async () => {
    respond({ body: { workspace: ws({ creatorUserId: sam, creatorRevision: "8" }), teamSharing: 1, teamOwnership: 1,
      reassignment: { requestId: "77777777-7777-4777-8777-777777777777", fromUserId: alex, toUserId: sam, creatorRevision: "8" } } });
    const result = await reassignCloudWorkspace(target, { requestId: "77777777-7777-4777-8777-777777777777", toUserId: sam, expectedCreatorUserId: alex, expectedCreatorRevision: "7" });
    expect(JSON.parse(String(fetches[0]!.init.body))).toEqual({ requestId: "77777777-7777-4777-8777-777777777777", toUserId: sam, expectedCreatorUserId: alex, expectedCreatorRevision: "7" });
    expect(fetches[0]!.url).toBe(`https://api.example.test/v1/cloud-v2/workspaces/${workspaceId}/reassign`);
    expect(result.workspace).toMatchObject({ id: workspaceId, ownerUserId: sam, sharing: { ownership: { creatorRevision: "8" } } });
    expect(result.reassignment).toMatchObject({ toUserId: sam, creatorRevision: "8" });
  });

  it("keeps each refusal's closed code for the dialog", async () => {
    for (const [status, code] of [[409, "creator_changed"], [409, "reassign_conflict"], [403, "workspace_management_denied"], [422, "assignee_ineligible"], [503, "github_verification_unavailable"], [429, "rate_limited"]] as const) {
      respond({ status, body: { error: { code, message: "refused" } } });
      await expect(reassignCloudWorkspace(target, { requestId: "77777777-7777-4777-8777-777777777777", toUserId: sam, expectedCreatorUserId: null, expectedCreatorRevision: "7" }))
        .rejects.toMatchObject({ status, code });
    }
  });
});
