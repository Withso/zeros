import { describe, expect, it, vi } from "vitest";
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }), subscribeOrganizationSnapshots: () => () => {},
  getActiveOrganizationIdSnapshot: () => null }));
import { cloudV2Document, CloudV2WorkspaceSchema } from "../../platform/cloud-v2";
import { sharingFor } from "../../platform/team-sharing-state";
import { restoreCloudWorkspaceCatalog } from "../cloud-workspace-catalog";

const org = "11111111-1111-4111-8111-111111111111", alex = "44444444-4444-4444-8444-444444444444";
const ws = (id: string, extra: Record<string, unknown> = {}) => cloudV2Document(CloudV2WorkspaceSchema.parse({ id, organizationId: org, creatorUserId: alex, name: "w",
  repository: "Withso/zeros", branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z", version: 2, capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] }, ...extra }));
const sharing = (viewerRole: string) => ({ teamSharing: 1, createdByUserId: alex, viewerRole, readOnly: viewerRole !== "creator", canManage: viewerRole !== "member",
  following: false, pinned: false, followerIds: [], followerCount: 0 });

describe("the opt-in follows the document the catalog holds", () => {
  it("opts in only where the held document makes this account an admin or member", () => {
    const ids = ["22222221-2222-4222-8222-222222222222", "22222222-2222-4222-8222-222222222222", "22222223-2222-4222-8222-222222222222", "22222224-2222-4222-8222-222222222222"];
    restoreCloudWorkspaceCatalog([ws(ids[0]!, sharing("creator")), ws(ids[1]!, sharing("admin")), ws(ids[2]!, sharing("member")), ws(ids[3]!)]);
    expect(ids.map(sharingFor)).toEqual([{}, { teamSharing: true }, { teamSharing: true }, {}]);
    // Not loaded yet: no opt-in (get/by-number carry it and load the role first).
    expect(sharingFor("99999999-9999-4999-8999-999999999999")).toEqual({});
  });
});
