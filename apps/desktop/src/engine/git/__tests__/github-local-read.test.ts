import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listRepositoryBranches,
  setOctokitFactoryForTesting,
  setTokenStoreForTesting,
} from "../github";

const repository = { owner: "org", repo: "repo" };
afterEach(() => {
  setTokenStoreForTesting(null);
  setOctokitFactoryForTesting(null);
});

describe("local GitHub reads", () => {
  it("rechecks the local token after replacement and sign-out", async () => {
    let token: string | null = "local-credential-one";
    const get = vi.fn(async () => token);
    setTokenStoreForTesting({ get, set: vi.fn(), clear: vi.fn() });
    const factory = vi.fn(async () => ({
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        listBranches: async () => ({ data: [] }),
      },
    }));
    setOctokitFactoryForTesting(factory as never);

    await listRepositoryBranches(repository);
    token = "local-credential-two";
    await listRepositoryBranches(repository);
    expect(factory.mock.calls).toEqual([
      ["local-credential-one", undefined],
      ["local-credential-two", undefined],
    ]);
    token = null;
    await expect(listRepositoryBranches(repository)).rejects.toThrow(
      "Not signed in",
    );
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
