import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
const mocks = vi.hoisted(() => ({ files: vi.fn(), ignored: vi.fn(), registry: vi.fn(async () => []), doc: undefined as unknown, epoch: 1 }));
vi.mock("../workspace-files-cache", () => ({ warmWorkspaceFiles: mocks.files }));
vi.mock("../workbench/tabs/ignored-entries-cache", () => ({ warmIgnoredRoots: mocks.ignored }));
vi.mock("../../features/agent/workspace-agent-registry", () => ({ warmCloudAgentRegistry: mocks.registry }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => mocks.doc,
  cloudCatalogGeneration: () => mocks.epoch,
  canReadCloudWorkspace: (doc: { status: string } | undefined) => !!doc && !["deleting", "deleted"].includes(doc.status),
}));
vi.mock("../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => ({ workbenchByScope: {} }) }, workbenchScopeForFolder: (s: string) => s }));
vi.mock("../workspace-file-data-cache", () => ({ prefetchWorkspaceFileDiff: vi.fn(), prefetchWorkspaceFileRead: vi.fn() }));
vi.mock("../workbench/tabs/review-data", () => ({ prefetchReviewLiveData: vi.fn() }));
vi.mock("../../features/design-workspace/state/design-workspace-cache", () => ({ warmDesignWorkspaceSnapshot: vi.fn() }));
import { prefetchWorkspaceSurface } from "../prefetch-workspace-surface";
import { WorkspaceRuntimeClient, type WorkspaceRuntimeOptions } from "../../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { warmCloudWorkspaceDestination } from "../../state/cloud-workspace-warmup";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target);
let client: WorkspaceRuntimeClient;
let readHistory: Mock<NonNullable<WorkspaceRuntimeOptions["readHistory"]>>;
let open: Mock<WorkspaceRuntimeOptions["open"]>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.doc = { status: "stopped", generation: { number: 1 }, deletedAt: null };
  vi.stubGlobal("document", { visibilityState: "visible" });
  readHistory = vi.fn<NonNullable<WorkspaceRuntimeOptions["readHistory"]>>(async () => ({ chats: [], chatDeletions: [] }));
  open = vi.fn<WorkspaceRuntimeOptions["open"]>(async () => { throw new Error("stopped VM must not open"); });
  client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
  setActiveBridge(client);
});
afterEach(() => { setActiveBridge(null); client.dispose(); vi.unstubAllGlobals(); });
describe("sidebar cloud intent", () => {
  it.each(["ready", "busy"])("shares %s hover and selected warmup without worker mutations", async status => {
    mocks.doc = { status, generation: { number: 1 }, deletedAt: null };
    open.mockResolvedValue({
      client: { status: "connected", on: () => () => {}, onStatusChange: () => () => {} } as unknown as RuntimeClient,
      scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "local-main" }, release: vi.fn(),
    });
    prefetchWorkspaceSurface({ path: folder, repoRoot: folder });
    await warmCloudWorkspaceDestination(folder);
    expect(open).toHaveBeenCalledOnce(); expect(readHistory).toHaveBeenCalledOnce();
    expect(mocks.files).not.toHaveBeenCalled(); expect(mocks.registry).not.toHaveBeenCalled();
  });
  it.each(["stopped", "archived"])("warms %s history before the read-only return and shares it with selection", async status => {
    mocks.doc = { status, generation: { number: 1 }, deletedAt: null };
    prefetchWorkspaceSurface({ path: folder, repoRoot: folder, archivedAt: status === "archived" ? 1 : null });
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledOnce());
    await client.warmHistoryWorkspace(target);
    expect(readHistory).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(mocks.files).not.toHaveBeenCalled();
    expect(mocks.registry).not.toHaveBeenCalled();
  });
  it("does no intent work in a hidden document", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    prefetchWorkspaceSurface({ path: folder, repoRoot: folder });
    await Promise.resolve();
    expect(readHistory).not.toHaveBeenCalled();
    expect(mocks.files).not.toHaveBeenCalled();
  });
  it("keeps Local prefetch unchanged", () => {
    prefetchWorkspaceSurface({ path: "/repo/tree", repoRoot: "/repo" });
    expect(mocks.files).toHaveBeenCalledWith("/repo/tree");
    expect(mocks.ignored).toHaveBeenCalledWith("/repo/tree");
    expect(readHistory).not.toHaveBeenCalled();
  });
});
