// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  doc: undefined as Record<string, unknown> | undefined,
  listeners: new Set<() => void>(),
  me: "33333333-3333-4333-8333-333333333333" as string | null,
  list: vi.fn(),
  reassign: vi.fn(),
  accept: vi.fn(),
  refresh: vi.fn(async () => ({})),
  openReassign: vi.fn(),
}));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => io.doc,
  subscribeCloudWorkspaces: (listener: () => void) => { io.listeners.add(listener); return () => io.listeners.delete(listener); },
  acceptCloudWorkspaceDocument: io.accept,
  refreshCloudWorkspace: io.refresh,
}));
vi.mock("../../platform/team-sharing", () => ({ listReassignCandidates: io.list, reassignCloudWorkspace: io.reassign }));
vi.mock("../../platform/team-sharing-state", () => ({ useMyUserId: () => io.me }));
vi.mock("../../platform/reassign-dialog-signal", () => ({ openReassignDialog: io.openReassign }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { NoCreatorBar } from "../no-creator-bar";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target);
const doc = (extra: Record<string, unknown> = {}) => ({ id: target.workspaceId, organizationId: target.organizationId, name: "api-server", ownerUserId: null,
  sharing: { ownership: { creatorRevision: "7", noCreatorReason: "left", canReassign: true } }, ...extra });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const changed = () => act(() => { for (const listener of io.listeners) listener(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find(element => element.textContent === label);
const dialogButton = (label: string) => [...document.body.querySelectorAll('[role="dialog"] button')].find(element => element.textContent === label) as HTMLButtonElement | undefined;

beforeEach(() => {
  io.doc = doc(); io.me = "33333333-3333-4333-8333-333333333333"; io.listeners.clear();
  for (const mock of [io.list, io.reassign, io.accept, io.openReassign]) mock.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });
const render = () => act(() => root.render(createElement(NoCreatorBar, { folder, surfaceActive: true })));

describe("no-Creator bar in place of the composer", () => {
  it("shows an admin the line with Reassign… at once, and Make me the Creator once their own row says eligible", async () => {
    const listed = deferred<{ creatorRevision: string; candidates: unknown[] }>(); io.list.mockReturnValue(listed.promise);
    render();
    expect(text()).toContain("This workspace has no Creator.");
    expect(button("Reassign…")).toBeDefined(); expect(button("Make me the Creator")).toBeUndefined();
    await act(async () => listed.resolve({ creatorRevision: "7", candidates: [{ userId: io.me, eligible: true }] }));
    expect(button("Make me the Creator")).toBeDefined();
    act(() => button("Reassign…")!.click());
    expect(io.openReassign).toHaveBeenCalledWith(expect.objectContaining(target));
  });

  it("shows the reason instead of the first action when the admin is not eligible, and Reassign… only when unlisted", async () => {
    io.list.mockResolvedValue({ creatorRevision: "7", candidates: [{ userId: io.me, eligible: false, reason: "repository_access_required" }] });
    render(); await flush();
    expect(text()).toContain("You need access to this workspace's repository to be its Creator.");
    expect(button("Make me the Creator")).toBeUndefined(); expect(button("Reassign…")).toBeDefined();
    io.list.mockResolvedValue({ creatorRevision: "8", candidates: [] });
    io.doc = doc({ sharing: { ownership: { creatorRevision: "8", noCreatorReason: "left", canReassign: true } } }); changed(); await flush();
    expect(button("Make me the Creator")).toBeUndefined(); expect(text()).not.toContain("You need access");
  });

  it("shows a member the plain line with no action and reads no candidates", () => {
    io.doc = doc({ sharing: { ownership: { creatorRevision: "7", noCreatorReason: "left", canReassign: false } } });
    render();
    expect(text()).toContain("This workspace has no Creator. An admin can reassign it.");
    expect(document.body.querySelectorAll("button")).toHaveLength(0);
    expect(io.list).not.toHaveBeenCalled();
  });

  it("clears as soon as the document shows a Creator", async () => {
    io.list.mockResolvedValue({ creatorRevision: "7", candidates: [] });
    render(); await flush();
    io.doc = doc({ ownerUserId: "44444444-4444-4444-8444-444444444444" }); changed();
    expect(text()).toBe("");
  });

  it("drops a late candidates reply for an older Creator revision", async () => {
    const old = deferred<{ creatorRevision: string; candidates: unknown[] }>();
    io.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ creatorRevision: "8", candidates: [{ userId: io.me, eligible: false, reason: "on_hold" }] });
    render();
    io.doc = doc({ sharing: { ownership: { creatorRevision: "8", noCreatorReason: "left", canReassign: true } } }); changed(); await flush();
    await act(async () => old.resolve({ creatorRevision: "7", candidates: [{ userId: io.me, eligible: true }] }));
    expect(button("Make me the Creator")).toBeUndefined();
    expect(text()).toContain("You're on hold in this organization");
  });

  it("makes the caller the Creator after one confirm, compare-and-set, and a retry replays the same request", async () => {
    io.list.mockResolvedValue({ creatorRevision: "7", candidates: [{ userId: io.me, eligible: true }] });
    render(); await flush();
    act(() => button("Make me the Creator")!.click());
    expect(text()).toContain("Make yourself the Creator of api-server?");
    expect(text()).toContain("Your agent logins will run every turn here, and commits will carry your Git identity.");
    io.reassign.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "rate_limited" }));
    await act(async () => dialogButton("Make me the Creator")!.click());
    const first = io.reassign.mock.calls[0]![1];
    expect(first).toEqual({ requestId: expect.any(String), toUserId: io.me, expectedCreatorUserId: null, expectedCreatorRevision: "7" });
    const workspace = doc({ ownerUserId: io.me });
    io.reassign.mockResolvedValueOnce({ workspace, reassignment: {} });
    await act(async () => dialogButton("Make me the Creator")!.click());
    expect(io.reassign.mock.calls[1]![1].requestId).toBe(first.requestId);
    expect(io.accept).toHaveBeenCalledWith(workspace);
  });
});
