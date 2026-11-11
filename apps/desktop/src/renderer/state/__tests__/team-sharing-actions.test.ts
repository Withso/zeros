import { beforeEach, describe, expect, it, vi } from "vitest";

const me = "33333333-3333-4333-8333-333333333333", alex = "44444444-4444-4444-8444-444444444444";
const api = vi.hoisted(() => ({ follow: vi.fn(), pin: vi.fn() }));
const catalog = vi.hoisted(() => ({ doc: null as Record<string, unknown> | null }));
vi.mock("../../platform/team-sharing", () => ({ setCloudWorkspaceFollowing: api.follow, setCloudWorkspacePinned: api.pin }));
vi.mock("../../platform/team-sharing-state", () => ({ myUserId: () => me }));
vi.mock("../cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => catalog.doc,
  acceptCloudWorkspaceDocument: (doc: Record<string, unknown>) => { catalog.doc = doc; },
}));
import { setCloudWorkspaceSharingFlag } from "../team-sharing-actions";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const sharing = () => (catalog.doc!.sharing as { following: boolean; pinned: boolean; followerIds: string[]; followerCount: number });
beforeEach(() => {
  api.follow.mockReset(); api.pin.mockReset();
  catalog.doc = { id: target.workspaceId, sharing: { createdByUserId: alex, viewerRole: "member", readOnly: true, canManage: false, following: false, pinned: false, followerIds: [alex], followerCount: 1 } };
});

describe("Follow and Pin", () => {
  it("shows the change at once, with the viewer among the followers, and keeps the server's answer", async () => {
    let answer!: (value: boolean) => void;
    api.follow.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const done = setCloudWorkspaceSharingFlag(target, "following", true);
    expect(sharing()).toMatchObject({ following: true, followerIds: [alex, me], followerCount: 2 });
    answer(true);
    await done;
    expect(api.follow).toHaveBeenCalledWith(target, true);
    expect(sharing().following).toBe(true);
  });

  it("puts it back when the request fails, unless a later toggle replaced it", async () => {
    api.pin.mockRejectedValueOnce(new Error("rate_limited"));
    await expect(setCloudWorkspaceSharingFlag(target, "pinned", true)).rejects.toThrow("rate_limited");
    expect(sharing().pinned).toBe(false);
    let failFirst!: (error: Error) => void;
    api.pin.mockReturnValueOnce(new Promise((_resolve, reject) => { failFirst = reject; })).mockResolvedValueOnce(false);
    const first = setCloudWorkspaceSharingFlag(target, "pinned", true);
    await setCloudWorkspaceSharingFlag(target, "pinned", false);
    failFirst(new Error("network"));
    await expect(first).rejects.toThrow("network");
    expect(sharing().pinned).toBe(false);
  });
});
