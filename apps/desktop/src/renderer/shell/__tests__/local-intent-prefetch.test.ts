import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ files: vi.fn(), ignored: vi.fn(), cloud: vi.fn(async () => {}) }));
vi.mock("../workspace-files-cache", () => ({ warmWorkspaceFiles: mocks.files }));
vi.mock("../workbench/tabs/ignored-entries-cache", () => ({ warmIgnoredRoots: mocks.ignored }));
vi.mock("../../state/cloud-workspace-warmup", () => ({ warmCloudWorkspaceDestination: mocks.cloud }));
vi.mock("../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => ({ workbenchByScope: {} }) }, workbenchScopeForFolder: (s: string) => s }));
vi.mock("../workspace-file-data-cache", () => ({ prefetchWorkspaceFileDiff: vi.fn(), prefetchWorkspaceFileRead: vi.fn() }));
vi.mock("../workbench/tabs/review-data", () => ({ prefetchReviewLiveData: vi.fn() }));
vi.mock("../../features/design-workspace/state/design-workspace-cache", () => ({ warmDesignWorkspaceSnapshot: vi.fn() }));
import { prefetchWorkspaceSurface } from "../prefetch-workspace-surface";

beforeEach(() => { vi.clearAllMocks(); });
describe("Local workspace intent prefetch", () => {
  it.each([["/personal/repo/tree", "/personal/repo"], ["/organization/repo/tree", "/organization/repo"]])(
    "warms the Files tree and its ignored roots for %s without touching cloud",
    (path, repoRoot) => {
      prefetchWorkspaceSurface({ path, repoRoot });
      expect(mocks.files).toHaveBeenCalledWith(path);
      expect(mocks.ignored).toHaveBeenCalledWith(path);
      expect(mocks.cloud).not.toHaveBeenCalled();
    },
  );
  it("sends a cloud destination only to the cloud warmup", () => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    prefetchWorkspaceSurface({ path: folder, repoRoot: folder });
    expect(mocks.cloud).toHaveBeenCalledWith(folder, true);
    expect(mocks.files).not.toHaveBeenCalled();
    expect(mocks.ignored).not.toHaveBeenCalled();
  });
});
