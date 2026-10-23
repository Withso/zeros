import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0, session: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: state.session }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../../features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
import { createCloudWorkspaceDocument } from "../cloud-workspaces";
import { subscribeCloudPromptErasure } from "../cloud-prompt-erasure";
import { changeCloudV2Workspace, getCloudV2InstalledRepositories } from "../cloud-v2";

const organizationId = "11111111-1111-4111-8111-111111111111";
const session = { access_token: "synthetic-session", user: { sub: "provider-subject", accountId: "55555555-5555-4555-8555-555555555555" } };
function workspace(baseBranch: string) {
  return {
    id: "22222222-2222-4222-8222-222222222222", organizationId, creatorUserId: organizationId, name: "fixture",
    repository: "Example/Fixture", branch: "zeros/fixture-22222222", baseBranch, state: "creating", errorCode: null,
    createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z", version: 2,
    capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
  };
}
function body(fetch: { mock: { calls: unknown[][] } }, call = 0) {
  return JSON.parse((fetch.mock.calls[call]![1] as RequestInit).body as string) as Record<string, unknown>;
}
beforeEach(() => { state.generation = 0; state.session.mockReset().mockResolvedValue(session); });
afterEach(() => vi.unstubAllGlobals());

describe("cloud v2 create", () => {
  // The worker runs `git switch -c <branch> origin/<baseBranch>`, so a full
  // ref such as refs/heads/main can never be checked out.
  it("sends the repository slug and a plain base branch with the caller's idempotency key", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ workspace: workspace("feature/ui") }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const document = await createCloudWorkspaceDocument({ organizationId, idempotencyKey: "create-intent-1",
      repository: { owner: "Example", name: "Fixture" }, baseBranch: "feature/ui" });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/v1/cloud-v2/workspaces");
    expect(body(fetch)).toEqual({ organizationId, repository: "Example/Fixture", baseBranch: "feature/ui" });
    expect((fetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "idempotency-key": "create-intent-1" });
    expect(document.repository).toMatchObject({ owner: "Example", name: "Fixture", revision: "feature/ui" });
  });
  it("omits the base branch so the server applies the Cloud Computer's branch", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ workspace: workspace("trunk") }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await createCloudWorkspaceDocument({ organizationId, idempotencyKey: "create-intent-2", name: "Named",
      repository: { owner: "Example", name: "Fixture" } });
    expect(body(fetch)).toEqual({ organizationId, repository: "Example/Fixture", name: "Named" });
  });
  it.each(["refs/heads/main", "refs/pull/7/head", "-main", "a..b"])("refuses the unusable base %s before any request", async baseBranch => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(createCloudWorkspaceDocument({ organizationId, idempotencyKey: "create-intent-3",
      repository: { owner: "Example", name: "Fixture" }, baseBranch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Cloud Computer repositories for members", () => {
  it("reads the member route and keys each repository by its lowercase slug", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ repositories: [
      { repository: "Example/Fixture", defaultBranch: "trunk" },
      { repository: "example/other", defaultBranch: null },
    ] }));
    vi.stubGlobal("fetch", fetch);
    expect(await getCloudV2InstalledRepositories(organizationId)).toEqual([
      { id: "example/fixture", owner: "Example", name: "Fixture", defaultBranch: "trunk" },
      { id: "example/other", owner: "example", name: "other", defaultBranch: null },
    ]);
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.example.test/v1/cloud-v2/organizations/${organizationId}/computer/repositories`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });
  it("reports an organization without a live build as null", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ repositories: null })));
    expect(await getCloudV2InstalledRepositories(organizationId)).toBeNull();
  });
});

it("erases private prompts only after an exact successful workspace deletion, never on Stop or a failed delete", async () => {
  const row = workspace("main"), target = { organizationId, workspaceId: row.id }, erased = vi.fn(), unsub = subscribeCloudPromptErasure(erased);
  const fetch = vi.fn(async () => Response.json({ workspace: row })); vi.stubGlobal("fetch", fetch);
  try {
    await changeCloudV2Workspace(target, "stop"); expect(erased).not.toHaveBeenCalled();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(changeCloudV2Workspace(target, "delete")).rejects.toThrow(); expect(erased).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ workspace: { ...row, organizationId: "33333333-3333-4333-8333-333333333333" } }));
    await expect(changeCloudV2Workspace(target, "delete")).rejects.toThrow(/identity/); expect(erased).not.toHaveBeenCalled();
    await changeCloudV2Workspace(target, "delete"); expect(erased).toHaveBeenCalledExactlyOnceWith(target);
  } finally { unsub(); }
});
