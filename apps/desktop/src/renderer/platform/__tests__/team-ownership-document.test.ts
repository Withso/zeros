import { describe, expect, it, vi } from "vitest";

vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }) }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
import { cloudV2Document, CloudV2WorkspaceSchema } from "../cloud-v2";
import { CloudWorkspaceDocumentSchema } from "../cloud-workspace-contract";

/** Team sharing 3B: with X-Zeros-Team-Ownership: 1 a workspace may have no Creator, and says who may reassign it. */
const org = "11111111-1111-4111-8111-111111111111", me = "33333333-3333-4333-8333-333333333333", alex = "44444444-4444-4444-8444-444444444444";
const ws = (extra: Record<string, unknown>) => ({ id: "22222222-2222-4222-8222-222222222222", organizationId: org, creatorUserId: alex, name: "w", repository: "Withso/zeros",
  branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] }, ...extra });
const admin = { teamSharing: 1, createdByUserId: alex, viewerRole: "admin", readOnly: false, canManage: true, following: false, pinned: false, followerIds: [me], followerCount: 1,
  teamWriting: 1, canExecute: true };
const owned = (extra: Record<string, unknown>) => ({ ...admin, teamOwnership: 1, creatorRevision: "7", noCreatorReason: null, canReassign: true, ...extra });

describe("team ownership in the desktop's documents", () => {
  it("reads a workspace with no Creator: no owner, its revision and why, and whether this viewer may reassign it", () => {
    const document = CloudWorkspaceDocumentSchema.parse(cloudV2Document(CloudV2WorkspaceSchema.parse(ws(owned({ creatorUserId: null, creatorRevision: "8", noCreatorReason: "left" })))));
    expect(document.ownerUserId).toBeNull();
    expect(document.createdBy).toBe(alex);
    expect(document.sharing).toMatchObject({ viewerRole: "admin", ownership: { creatorRevision: "8", noCreatorReason: "left", canReassign: true } });
  });

  it("keeps a Creator's document with its ownership fields, and today's documents without them", () => {
    expect(cloudV2Document(CloudV2WorkspaceSchema.parse(ws(owned({})))).sharing).toMatchObject({ ownership: { creatorRevision: "7", noCreatorReason: null, canReassign: true } });
    const today = cloudV2Document(CloudV2WorkspaceSchema.parse(ws(admin)));
    expect(today.ownerUserId).toBe(alex);
    expect(today.sharing).not.toHaveProperty("ownership");
  });

  it("never accepts a missing Creator without team ownership, and drops malformed ownership instead of guessing", () => {
    expect(CloudV2WorkspaceSchema.safeParse(ws({ ...admin, creatorUserId: null })).success).toBe(false);
    for (const bad of [{ creatorRevision: "0" }, { creatorRevision: "x" }, { noCreatorReason: "fired" }, { canReassign: "yes" }])
      expect(cloudV2Document(CloudV2WorkspaceSchema.parse(ws(owned(bad)))).sharing).not.toHaveProperty("ownership");
    expect(CloudV2WorkspaceSchema.safeParse(ws(owned({ creatorUserId: null, creatorRevision: "x" }))).success).toBe(false);
  });
});
