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
  subscribeOrganizationSnapshots: () => () => {},
}));
vi.mock("../../features/team/organization-links", async (original) => ({
  ...(await original<typeof import("../../features/team/organization-links")>()),
  APP_BASE_URL: "https://app-alpha.zeros.build",
}));
import {
  cloudChatShareUrl,
  copyCloudChatLink,
  copyCloudWorkspaceLink,
  isCloudChatOfWorkspace,
} from "../cloud-workspace-link-actions";

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

describe("copying a cloud chat link", () => {
  const org = "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35";
  const target = { organizationId: org, workspaceId: ws };
  const chatId = (id: string, workspaceId = ws) => `cloud:${org}:${workspaceId}:${encodeURIComponent(id)}`;

  it("copies the chat's page: the workspace's numbered page with its session", async () => {
    await copyCloudChatLink(workspace(`cloud://${org}/${ws}`, 310), chatId("7e2b720c-ab56-441d-b189-6e7d1eb7a628"));
    expect(state.copy).toHaveBeenCalledExactlyOnceWith(
      "https://app-alpha.zeros.build/acme-labs/w/310?session=7e2b720c-ab56-441d-b189-6e7d1eb7a628",
    );
    expect(state.toast.success).toHaveBeenCalledWith("Link copied.");
  });

  it("encodes a chat id's colon as the desktop link does", () => {
    expect(cloudChatShareUrl({ number: 3 }, target, chatId("chat:1"))).toBe(
      "https://app-alpha.zeros.build/acme-labs/w/3?session=chat%3A1",
    );
  });

  it.each([
    ["a workspace without a number", { number: undefined }, chatId("chat-1")],
    ["another workspace's chat", { number: 3 }, chatId("chat-1", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")],
    ["a Local chat id", { number: 3 }, "chat-1"],
    ["a chat id no link can carry", { number: 3 }, chatId("a/b")],
  ])("has no link for %s", async (_label, row, id) => {
    expect(cloudChatShareUrl(row, target, id)).toBeNull();
    await copyCloudChatLink(workspace(`cloud://${org}/${ws}`, row.number), id);
    expect(state.copy).not.toHaveBeenCalled();
    expect(state.toast.error).toHaveBeenCalledWith("Couldn't copy the link. Try again in a moment.");
  });

  it("has no link while the organization's ID is unknown", () => {
    expect(cloudChatShareUrl({ number: 3 }, { ...target, organizationId: "7d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35" },
      `cloud:7d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35:${ws}:chat-1`)).toBeNull();
  });

  it("matches a chat to its own workspace only", () => {
    const row = workspace(`cloud://${org}/${ws}`, 3);
    expect(isCloudChatOfWorkspace(row, chatId("chat-1"))).toBe(true);
    expect(isCloudChatOfWorkspace(row, chatId("chat-1", "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"))).toBe(false);
    expect(isCloudChatOfWorkspace(workspace("/Users/alex/repo"), "chat-1")).toBe(false);
    expect(isCloudChatOfWorkspace(row, "cloud:bad")).toBe(false);
  });
});
