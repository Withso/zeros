import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubAuthSnapshot } from "@zeros/core/github-auth";

import { prefetchGithubAuthSnapshot } from "../github-auth-prefetch";
import { ghAuthStatusCache } from "../../store/read-caches";

const snapshot: GithubAuthSnapshot = {
  selectedMethod: "gh-cli",
  methods: {
    "gh-cli": {
      method: "gh-cli",
      configured: true,
      available: true,
      health: "connected",
      login: "octocat",
    },
    "github-app": {
      method: "github-app",
      configured: false,
      health: "not-connected",
    },
    pat: {
      method: "pat",
      configured: false,
      health: "not-connected",
    },
  },
};

describe("GitHub auth intent prefetch", () => {
  beforeEach(() => {
    ghAuthStatusCache.clear();
  });

  it("deduplicates pointer/focus intent on the exact auth cache key", async () => {
    let resolve!: (value: GithubAuthSnapshot) => void;
    const pending = new Promise<GithubAuthSnapshot>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn(() => pending);

    prefetchGithubAuthSnapshot(fetcher);
    prefetchGithubAuthSnapshot(fetcher);
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ghAuthStatusCache.keys()).toEqual(["auth"]);

    resolve(snapshot);
    await vi.waitFor(() =>
      expect(ghAuthStatusCache.peekSnapshot("auth").data).toBe(snapshot),
    );

    prefetchGithubAuthSnapshot(fetcher);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains a confirmed snapshot when intent revalidation fails", async () => {
    ghAuthStatusCache.setData("auth", snapshot);
    ghAuthStatusCache.invalidate("auth");

    prefetchGithubAuthSnapshot(async () => {
      throw new Error("offline");
    });

    await vi.waitFor(() =>
      expect(ghAuthStatusCache.peekSnapshot("auth")).toMatchObject({
        data: snapshot,
        loading: false,
        refreshing: false,
        error: expect.objectContaining({ message: "offline" }),
      }),
    );
  });
});
