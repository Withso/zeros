import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPr,
  listRepositoryBranches,
  setOctokitFactoryForTesting,
  setTokenStoreForTesting,
} from "../github";
import {
  githubReadTransport,
  runWithGithubReadTransport,
} from "../github-read-context";

const repository = { owner: "org", repo: "repo" };
const pr = (title: string) => ({
  number: 7,
  title,
  state: "open",
  user: { login: "member" },
  head: { ref: "topic", sha: "a".repeat(40) },
  base: { ref: "main" },
});
afterEach(() => {
  setTokenStoreForTesting(null);
  setOctokitFactoryForTesting(null);
});

describe("local GitHub reads beside the cloud request context", () => {
  it("uses the local token path while another request holds a cloud actor read", async () => {
    const get = vi.fn(async () => "local-credential-fixture");
    setTokenStoreForTesting({ get, set: vi.fn(), clear: vi.fn() });
    const factory = vi.fn(async () => ({
      pulls: { get: async () => ({ data: pr("Local PR") }) },
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        listBranches: async () => ({
          data: [{ name: "main" }, { name: "topic" }],
        }),
      },
    }));
    setOctokitFactoryForTesting(factory as never);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cloud = vi.fn(async () => {
      await gate;
      return Response.json(pr("Cloud PR"));
    });
    const pending = runWithGithubReadTransport(
      cloud,
      () => true,
      () => getPr({ workspaceId: "unused", prNumber: 7 }, repository),
    );
    try {
      await vi.waitFor(() => expect(cloud).toHaveBeenCalledOnce());
      expect(githubReadTransport()).toBeUndefined();
      expect(
        (await getPr({ workspaceId: "unused", prNumber: 7 }, repository)).title,
      ).toBe("Local PR");
      expect(await listRepositoryBranches(repository)).toEqual([
        { name: "main", isDefault: true },
        { name: "topic", isDefault: false },
      ]);
      expect(get).toHaveBeenCalled();
      expect(factory).toHaveBeenCalledExactlyOnceWith(
        "local-credential-fixture",
        undefined,
      );
      expect(cloud).toHaveBeenCalledOnce();
    } finally {
      finish();
    }
    expect((await pending).title).toBe("Cloud PR");
    expect(githubReadTransport()).toBeUndefined();
  });

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
