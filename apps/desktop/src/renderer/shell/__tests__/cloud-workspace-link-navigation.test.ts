import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCloudNavigationLink,
  type CloudWorkspaceLink,
  type OrganizationWorkspaceLink,
} from "@zeros/protocol/cloud-workspace-link";
import { parseLocalLink } from "@zeros/protocol/local-orchestration";

const ACME = "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35";
const NORTHWIND = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const WS = "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46";
const KEY = `cloud://${ACME}/${WS}`;

const organization = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  slug: id === ACME ? "acme" : id === NORTHWIND ? "northwind" : `personal-${id.replaceAll("-", "")}`,
  name: id === ACME ? "Acme" : "Northwind",
  isPersonal: false,
  seat: "full",
  workspaceCapabilities: { local: true, cloud: true },
  ...overrides,
});

const state = vi.hoisted(() => ({
  feature: true,
  me: null as null | { user: { id: string }; organizations: Array<Record<string, unknown>> },
  active: null as string | null,
  switchSticks: true,
  rows: [] as Array<Record<string, unknown>>,
  docs: [] as Array<{ id: string; organizationId: string; number?: number | null }>,
  read: vi.fn(),
  byNumber: vi.fn(),
  calls: [] as string[],
  toast: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../config/release-channel", () => ({
  isFeatureEnabled: (feature: string) => feature === "cloud-workspaces" && state.feature,
}));
vi.mock("../../features/team/active-team", () => ({
  setActiveOrganizationSelection: (id: string, isPersonal: boolean) => {
    state.calls.push(`switch:${id}:${isPersonal}`);
    if (state.switchSticks) state.active = id;
  },
}));
vi.mock("../../features/team/team-store", () => ({
  getTeamStoreState: () => ({ me: state.me }),
  getActiveOrganizationSnapshot: () =>
    state.me?.organizations.find((candidate) => candidate.id === state.active) ?? null,
  useTeams: vi.fn(),
}));
vi.mock("../../features/team/control-plane", () => ({
  ControlPlaneError: class ControlPlaneError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  refreshCloudWorkspace: state.read,
  canReadCloudWorkspace: (doc?: { deletedAt: string | null; status: string }) =>
    doc !== undefined && doc.deletedAt === null && doc.status !== "deleting" && doc.status !== "deleted",
  getCloudWorkspaceRows: () => state.rows,
  cloudWorkspaceDocumentByNumber: (organizationId: string, number: number) =>
    state.docs.find((doc) => doc.organizationId === organizationId && doc.number === number),
  readCloudWorkspaceByNumber: state.byNumber,
}));
vi.mock("../../state/cloud-chat-link-selection", () => ({
  selectCloudChatWhenLoaded: (folder: string, chatId: string) => state.calls.push(`select:${folder}:${chatId}`),
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: state.toast }));

import { ControlPlaneError } from "../../features/team/control-plane";
import {
  navigateCloudWorkspaceLink,
  type CloudNavigationLink,
} from "../cloud-workspace-link-navigation";

const link: CloudWorkspaceLink = {
  scheme: "zeros",
  kind: "cloud-workspace",
  organizationId: ACME,
  workspaceId: WS,
};
const row = { id: KEY, path: KEY, repoRoot: KEY, placement: "cloud", archivedAt: null };
let current = true;
const openWorkspace = vi.fn((workspace: { path: string }) => state.calls.push(`open:${workspace.path}`));
const run = (target: CloudNavigationLink = link) =>
  navigateCloudWorkspaceLink(target, {
    openWorkspace,
    current: () => current,
    beforeCommit: () => state.calls.push("beforeCommit"),
  });

beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  state.feature = true;
  state.switchSticks = true;
  state.calls = [];
  state.me = {
    user: { id: "u-alex" },
    organizations: [
      organization(PERSONAL, { name: "Alex", isPersonal: true }),
      organization(ACME),
      organization(NORTHWIND),
    ],
  };
  state.active = PERSONAL;
  state.rows = [row];
  state.docs = [];
  state.read.mockResolvedValue({ id: WS, organizationId: ACME, status: "stopped", deletedAt: null });
  state.byNumber.mockResolvedValue({ id: WS, organizationId: ACME, number: 310, status: "stopped", deletedAt: null });
});

const UNAVAILABLE = "You don't have access to that cloud workspace.";
const CHAT_UNAVAILABLE = "You don't have access to that chat.";
const numbered = (href: string) => parseLocalLink(href) as OrganizationWorkspaceLink;

describe("opening a cloud workspace link", () => {
  it.each([
    ["Local", PERSONAL],
    ["another organization", NORTHWIND],
    ["the same organization", ACME],
  ])("switches from %s to its organization, then opens its row", async (_label, active) => {
    state.active = active;
    await run();
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ organizationId: ACME, workspaceId: WS });
    expect(state.calls).toEqual(["beforeCommit", `switch:${ACME}:false`, `open:${KEY}`]);
    expect(openWorkspace).toHaveBeenCalledWith(row, { wake: false });
    expect(state.toast.info).not.toHaveBeenCalled();
    expect(state.toast.error).not.toHaveBeenCalled();
    expect(state.active).toBe(ACME);
  });

  it("passes an archived row as it is, so it opens read-only like the sidebar's", async () => {
    const archived = { ...row, archivedAt: "2026-11-01T00:00:00.000Z" };
    state.rows = [archived];
    await run();
    expect(openWorkspace).toHaveBeenCalledWith(archived, { wake: false });
  });

  it("opens the exact key when the catalog has not built its row", async () => {
    state.rows = [];
    await run();
    expect(openWorkspace).toHaveBeenCalledWith({ path: KEY, repoRoot: KEY }, { wake: false });
  });

  it.each([
    ["an organization the account is not in", { ...link, organizationId: "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e" }],
    ["the device's Personal organization", { ...link, organizationId: PERSONAL }],
  ])("refuses %s without reading or switching", async (_label, target) => {
    await run(target);
    expect(state.toast.error).toHaveBeenCalledWith(UNAVAILABLE);
    expect(state.read).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it.each([
    ["has no cloud entitlement", { workspaceCapabilities: { local: true, cloud: false } }],
    ["has the member on hold", { seat: "hold" }],
  ])("says so when the organization %s", async (_label, overrides) => {
    state.me!.organizations[1] = organization(ACME, overrides);
    await run();
    expect(state.toast.error).toHaveBeenCalledWith("Cloud workspaces aren't available in Acme.");
    expect(state.read).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("says so when this release has no cloud workspaces", async () => {
    state.feature = false;
    await run();
    expect(state.toast.info).toHaveBeenCalledWith("Cloud workspaces aren't available in this version of Zeros.");
    expect(state.read).not.toHaveBeenCalled();
  });

  it("fails without a confirmed account", async () => {
    state.me = null;
    await run();
    expect(state.toast.error).toHaveBeenCalledWith("Couldn't open that cloud workspace. Try again in a moment.");
    expect(state.read).not.toHaveBeenCalled();
  });

  it("treats the control plane's 404 as no access, without switching", async () => {
    state.read.mockRejectedValue(new ControlPlaneError(404, "not_found", "Cloud workspace not found"));
    await run();
    expect(state.toast.error).toHaveBeenCalledWith(UNAVAILABLE);
    expect(state.calls).toEqual([]);
    expect(state.active).toBe(PERSONAL);
  });

  it("reports any other read failure, without switching", async () => {
    state.read.mockRejectedValue(new Error("offline"));
    await run();
    expect(state.toast.error).toHaveBeenCalledWith("Couldn't open that cloud workspace. Try again in a moment.");
    expect(state.calls).toEqual([]);
  });

  it.each(["deleting", "deleted"])("refuses a %s workspace", async (status) => {
    state.read.mockResolvedValue({ id: WS, organizationId: ACME, status, deletedAt: null });
    await run();
    expect(state.toast.error).toHaveBeenCalledWith(UNAVAILABLE);
    expect(state.calls).toEqual([]);
  });

  it("drops a read that a newer link, navigation or owner change retired", async () => {
    let finish!: (doc: unknown) => void;
    state.read.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = run();
    current = false;
    finish({ id: WS, organizationId: ACME, status: "ready", deletedAt: null });
    await pending;
    expect(state.calls).toEqual([]);
    expect(state.toast.info).not.toHaveBeenCalled();
    expect(state.toast.error).not.toHaveBeenCalled();
  });

  it("drops a retired read's failure silently", async () => {
    let fail!: (error: unknown) => void;
    state.read.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    const pending = run();
    current = false;
    fail(new Error("account changed"));
    await pending;
    expect(state.toast.error).not.toHaveBeenCalled();
  });

  it("does not open the workspace when the organization did not become active", async () => {
    state.switchSticks = false;
    await run();
    expect(state.calls).toEqual(["beforeCommit", `switch:${ACME}:false`]);
    expect(state.toast.info).toHaveBeenCalledWith("Select Acme to open this link.");
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});

describe("opening an organization's numbered link", () => {
  it("routes every owner but local to the cloud", () => {
    expect(isCloudNavigationLink(numbered("zeros://acme/w/310"))).toBe(true);
    expect(isCloudNavigationLink(numbered("zeros://acme/w/310?session=chat-1"))).toBe(true);
    expect(isCloudNavigationLink(link)).toBe(true);
    expect(isCloudNavigationLink(parseLocalLink("zeros://local/w/3")!)).toBe(false);
    expect(isCloudNavigationLink(parseLocalLink("zeros://chat/chat-1")!)).toBe(false);
  });

  it("finds the organization by its ID and a loaded workspace by number, then opens it", async () => {
    state.docs = [{ id: WS, organizationId: ACME, number: 310 }];
    await run(numbered("zeros://Acme/w/310"));
    expect(state.byNumber).not.toHaveBeenCalled();
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ organizationId: ACME, workspaceId: WS });
    expect(state.calls).toEqual(["beforeCommit", `switch:${ACME}:false`, `open:${KEY}`]);
    expect(state.toast.error).not.toHaveBeenCalled();
  });

  it("asks the control plane for a workspace the catalog has not loaded", async () => {
    state.active = NORTHWIND;
    await run(numbered("zeros://acme/w/310"));
    expect(state.byNumber).toHaveBeenCalledExactlyOnceWith({ owner: "acme", number: 310 });
    expect(state.read).toHaveBeenCalledExactlyOnceWith({ organizationId: ACME, workspaceId: WS });
    expect(state.calls).toEqual(["beforeCommit", `switch:${ACME}:false`, `open:${KEY}`]);
  });

  it("lands a chat link on its chat in the opened workspace", async () => {
    await run(numbered("zeros://acme/w/310?session=chat-1"));
    expect(state.calls).toEqual([
      "beforeCommit",
      `switch:${ACME}:false`,
      `open:${KEY}`,
      `select:${KEY}:cloud:${ACME}:${WS}:chat-1`,
    ]);
  });

  it.each([
    ["an organization the account is not in", "zeros://elsewhere/w/310"],
    ["a Personal organization's ID", `zeros://personal-${PERSONAL.replaceAll("-", "")}/w/310`],
    ["a reserved owner", "zeros://api/w/310"],
  ])("shows an error for %s without reading or switching", async (_label, href) => {
    await run(numbered(href));
    expect(state.toast.error).toHaveBeenCalledWith(UNAVAILABLE);
    expect(state.byNumber).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("says a chat link's chat is unavailable when the account can't open it", async () => {
    state.byNumber.mockRejectedValue(new ControlPlaneError(404, "not_found", "Cloud workspace not found"));
    await run(numbered("zeros://acme/w/311?session=chat-1"));
    expect(state.toast.error).toHaveBeenCalledWith(CHAT_UNAVAILABLE);
    expect(state.read).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
    await run(numbered("zeros://nobody/w/1?session=chat-1"));
    expect(state.toast.error).toHaveBeenLastCalledWith(CHAT_UNAVAILABLE);
  });

  it("refuses an answer for another organization or number", async () => {
    for (const doc of [
      { id: WS, organizationId: NORTHWIND, number: 310 },
      { id: WS, organizationId: ACME, number: 309 },
    ]) {
      state.byNumber.mockResolvedValueOnce({ ...doc, status: "ready", deletedAt: null });
      await run(numbered("zeros://acme/w/310"));
      expect(state.toast.error).toHaveBeenLastCalledWith(UNAVAILABLE);
    }
    expect(state.read).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("reports an unreachable control plane, and stays quiet once retired", async () => {
    state.byNumber.mockRejectedValueOnce(new Error("offline"));
    await run(numbered("zeros://acme/w/310"));
    expect(state.toast.error).toHaveBeenCalledWith("Couldn't open that cloud workspace. Try again in a moment.");
    let fail!: (error: unknown) => void;
    state.byNumber.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const pending = run(numbered("zeros://acme/w/310"));
    current = false;
    fail(new ControlPlaneError(404, "not_found", "gone"));
    await pending;
    expect(state.toast.error).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([]);
  });
});
