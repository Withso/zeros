import { describe, expect, it, vi } from "vitest";
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }), subscribeOrganizationSnapshots: () => () => {},
  getActiveOrganizationIdSnapshot: () => null }));
import type { Workspace } from "../../platform/git";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudV2Document, CloudV2WorkspaceSchema } from "../../platform/cloud-v2";
import { sharingOwnerLookup } from "../cloud-workspace-creators";

const org = "11111111-1111-4111-8111-111111111111", alex = "44444444-4444-4444-8444-444444444444";
const doc = (id: string, flags: { following: boolean; pinned: boolean }) => cloudV2Document(CloudV2WorkspaceSchema.parse({ id, organizationId: org, creatorUserId: alex, name: "w",
  repository: "Withso/zeros", branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z", version: 2, capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
  teamSharing: 1, createdByUserId: alex, viewerRole: "member", readOnly: true, canManage: false, followerIds: [], followerCount: 0, ...flags }));
const row = (id: string) => ({ id: cloudWorkspaceKey({ organizationId: org, workspaceId: id }) }) as unknown as Workspace;

describe("sharing owner lookup", () => {
  it("counts a teammate row as Following only while it is followed, pinned or not", () => {
    const ids = ["22222221-2222-4222-8222-222222222222", "22222222-2222-4222-8222-222222222222", "22222223-2222-4222-8222-222222222222"];
    const ownerOf = sharingOwnerLookup([
      doc(ids[0]!, { following: true, pinned: true }),
      doc(ids[1]!, { following: false, pinned: true }),
      doc(ids[2]!, { following: true, pinned: false }),
    ], null);
    expect(ids.map((id) => ownerOf(row(id)))).toEqual(["following", null, "following"]);
  });
});
