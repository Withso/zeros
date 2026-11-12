import { describe, expect, it, vi } from "vitest";

vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: null }) }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
import { cloudV2Document, CloudV2WorkspaceSchema } from "../cloud-v2";

/** Team sharing phase 2 (slice C): an activated workspace's document says members may write (teamWriting: 1) and whether this run executes for them. */
const org = "11111111-1111-4111-8111-111111111111", me = "33333333-3333-4333-8333-333333333333", alex = "44444444-4444-4444-8444-444444444444";
const ws = (extra: Record<string, unknown>) => ({ id: "22222222-2222-4222-8222-222222222222", organizationId: org, creatorUserId: alex, name: "w", repository: "Withso/zeros",
  branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] }, ...extra });
const member = { teamSharing: 1, createdByUserId: alex, viewerRole: "member", canManage: false, following: false, pinned: false, followerIds: [me], followerCount: 1 };
const doc = (extra: Record<string, unknown>) => cloudV2Document(CloudV2WorkspaceSchema.parse(ws({ ...member, ...extra })));

describe("team writing in the desktop's documents", () => {
  it("lets a member write and start an activated workspace that executes for them, without managing it", () => {
    const writer = doc({ teamWriting: 1, canExecute: true, readOnly: false });
    expect(writer.sharing).toMatchObject({ viewerRole: "member", readOnly: false, teamWriting: true, canExecute: true });
    expect(writer.capabilities).toMatchObject({ canWrite: true, canStart: true, canManage: false });
  });

  it("keeps a member read-only while the run cannot execute for them, and phase 1 documents exactly as before", () => {
    const waiting = doc({ teamWriting: 1, canExecute: false, readOnly: true });
    expect(waiting.sharing).toMatchObject({ teamWriting: true, canExecute: false, readOnly: true });
    expect(waiting.capabilities).toMatchObject({ canWrite: false, canStart: false });
    const reader = doc({ readOnly: true });
    expect(reader.sharing).not.toHaveProperty("teamWriting");
    expect(reader.sharing).not.toHaveProperty("canExecute");
    expect(reader.capabilities.canWrite).toBe(false);
    // A malformed writing field never reads as writable.
    expect(doc({ teamWriting: 2, canExecute: true, readOnly: false })).not.toHaveProperty("sharing");
  });
});
