import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";

const state = vi.hoisted(() => ({
  copied: true,
  copy: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../../shared/lib/clipboard", () => ({
  copyToClipboardWithFallback: async (text: string) => {
    state.copy(text);
    return state.copied;
  },
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: state.toast }));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({
  useCloudWorkspaceAccountAccess: () => true,
}));
vi.mock("../../features/team/team-store", () => ({
  getTeamStoreState: () => ({
    me: {
      organizations: [
        { id: "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35", slug: "acme-labs", isPersonal: false },
      ],
      teams: [],
    },
  }),
}));
vi.mock("../../features/team/organization-links", async (original) => ({
  ...(await original<typeof import("../../features/team/organization-links")>()),
  APP_BASE_URL: "https://app-alpha.zeros.build",
}));
import { copyCloudWorkspaceLink } from "../cloud-workspace-link-actions";

const ws = "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46";
const workspace = (path: string, number?: number) => ({ path, number }) as Workspace;

beforeEach(() => {
  vi.clearAllMocks();
  state.copied = true;
});

describe("copying a cloud workspace link", () => {
  it("copies this channel's web workspace page", async () => {
    await copyCloudWorkspaceLink(workspace(`cloud://5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35/${ws}`));
    expect(state.copy).toHaveBeenCalledExactlyOnceWith(`https://app-alpha.zeros.build/workspace/${ws}`);
    expect(state.toast.success).toHaveBeenCalledWith("Link copied.");
  });

  it("copies the organization's numbered page for a numbered workspace", async () => {
    await copyCloudWorkspaceLink(workspace(`cloud://5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35/${ws}`, 310));
    expect(state.copy).toHaveBeenCalledExactlyOnceWith("https://app-alpha.zeros.build/acme-labs/w/310");
  });

  it("keeps the id page for an organization whose slug is unknown", async () => {
    await copyCloudWorkspaceLink(workspace(`cloud://7d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35/${ws}`, 4));
    expect(state.copy).toHaveBeenCalledExactlyOnceWith(`https://app-alpha.zeros.build/workspace/${ws}`);
  });

  it("says when the clipboard refused", async () => {
    state.copied = false;
    await copyCloudWorkspaceLink(workspace(`cloud://5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35/${ws}`));
    expect(state.toast.error).toHaveBeenCalledWith("Couldn't write to the clipboard — focus the app and retry.");
  });

  it.each(["/Users/alex/repo", "cloud://not-a-key", `cloud://5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35/${ws}/../x`])(
    "copies nothing for %s",
    async (path) => {
      await copyCloudWorkspaceLink(workspace(path));
      expect(state.copy).not.toHaveBeenCalled();
      expect(state.toast.success).not.toHaveBeenCalled();
    },
  );
});
