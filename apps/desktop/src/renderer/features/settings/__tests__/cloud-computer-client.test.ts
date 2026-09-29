import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  generation: 0,
  source: vi.fn(),
  request: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../../team/team-store", () => ({
  getOrganizationStoreGeneration: () => state.generation,
}));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAccountRequest: state.request,
  createCloudWorkspaceDocument: state.create,
}));
vi.mock("../../../platform/cloud-github", () => ({
  authorizeCloudGithubSource: state.source,
  cloudGithubScopeKey: (user: string, org: string) => JSON.stringify([user, org]),
}));
import {
  buildCloudComputer,
  saveCloudComputer,
  prefetchCloudComputer,
  cloudComputerCache,
  clearCloudComputers,
} from "../cloud-computer-client";

const org = "11111111-1111-4111-8111-111111111111";
const operation = "22222222-2222-4222-8222-222222222222";
const repository = {
  id: "123",
  owner: "example",
  name: "repository",
  defaultBranch: "main",
  private: true,
};
beforeEach(() => {
  clearCloudComputers();
  state.generation = 0;
  state.request.mockReset();
  state.create.mockReset();
  state.source.mockReset();
  state.source.mockImplementation(async () => {
    state.generation++;
    return { repository, installationId: operation };
  });
});

describe("Cloud Computer account intent", () => {
  it("warms the exact user/org key, shares pending reads, and respects the panel freshness window", async () => {
    let finish!: (value: unknown) => void;
    state.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = prefetchCloudComputer("user-a", org);
    const second = prefetchCloudComputer("user-a", org);
    await Promise.resolve();
    expect(state.request).toHaveBeenCalledTimes(1);
    const snapshot = { revision: 1 };
    finish(snapshot);
    await Promise.all([first, second]);
    expect(cloudComputerCache.getSnapshot(JSON.stringify(["user-a", org])).data).toEqual(snapshot);
    await prefetchCloudComputer("user-a", org);
    expect(state.request).toHaveBeenCalledTimes(1);
    await prefetchCloudComputer("user-b", org);
    await prefetchCloudComputer("user-a", operation);
    expect(state.request).toHaveBeenCalledTimes(3);
  });
  it("does not save a previous account's recipe after its source probe completes", async () => {
    await expect(
      saveCloudComputer(org, 0, operation, {
        repositories: [repository],
        installScript: "echo ready",
        timeoutSeconds: 60,
      }),
    ).rejects.toThrow(/account changed/i);
    expect(state.request).not.toHaveBeenCalled();
  });

  it("uses the dedicated image endpoint without requesting member GitHub authority", async () => {
    await buildCloudComputer(org, 1, 3, operation);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.source).not.toHaveBeenCalled();
    expect(state.request).toHaveBeenCalledWith(`/v1/organizations/${org}/cloud-computer/builds`, expect.anything(),
      expect.objectContaining({ body: { id: operation, version: 1, expectedRevision: 3 } }));
  });
});
