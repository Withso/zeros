import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../state/projects-store";

const state = vi.hoisted(() => ({ read: vi.fn(), options: vi.fn() }));
vi.mock("react", async importOriginal => ({ ...(await importOriginal<typeof import("react")>()), useMemo: (run: () => unknown) => run() }));
vi.mock("../../../state/use-cached-read", () => ({ useCachedRead: state.read }));
vi.mock("../../../features/team/team-store", () => ({
  useActiveOrganization: () => ({ id: "org", isPersonal: false, workspaceCapabilities: { local: false, cloud: true } }),
  useTeams: () => ({ me: { user: { id: "user" } } }),
}));
vi.mock("../../../platform/cloud-workspaces", () => ({ getCloudWorkspaceCreateOptions: state.options }));
import { useCloudCreate } from "../cloud-create";

beforeEach(() => {
  state.read.mockReset(); state.options.mockReset();
  state.read.mockReturnValueOnce({ data: { enabled: true } }).mockReturnValueOnce({
    data: { configured: true, installations: [{ id: "installation" }], repository: { owner: "example", name: "project", defaultBranch: "trunk" } },
  }).mockReturnValueOnce({ data: undefined });
});
describe("cloud creation without a running source worker", () => {
  const project = { repoRoot: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
    originUrl: "https://github.com/example/project.git" } as Project;
  it("uses the authorized repository default without opening an archived or stopped worker", async () => {
    const result = useCloudCreate(project, null, true);
    expect(state.read.mock.calls[2][1]).toBeNull();
    expect(result).toMatchObject({ reason: null, revision: "refs/heads/trunk", installationId: "installation" });
    const [, key, fetcher] = state.read.mock.calls[1];
    await fetcher(key);
    expect(state.options).toHaveBeenCalledWith("org", "example", "project");
  });
  it("continues to reject a local-only source even when GitHub metadata is available", () => {
    const result = useCloudCreate(project, { kind: "branch", source: "local", branch: "refs/heads/private", label: "private" }, true);
    expect(result.reason).toContain("Push local-only work");
    expect(result.revision).toBeNull();
  });
});
