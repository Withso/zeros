import { describe, expect, it, vi } from "vitest";

import { GithubPatUndoStore } from "../github-pat-undo";

const credential = {
  method: "pat",
  accessToken: "pat-secret",
  login: "octocat",
  gitHost: "github.com",
  gitHttpUsername: "x-access-token",
} as const;

describe("GitHub PAT undo store", () => {
  it("returns only an opaque handle when stashing a credential", () => {
    const store = new GithubPatUndoStore({
      now: () => 1_000,
      randomId: () => "opaque-handle",
    });

    expect(store.stash(credential, true)).toEqual({
      id: "opaque-handle",
      expiresAtMs: 11_000,
    });
  });

  it("is exact-handle, single-use, and preserves prior selection metadata", () => {
    const store = new GithubPatUndoStore({
      randomId: () => "opaque-handle",
    });
    store.stash(credential, true);

    expect(store.take("wrong-handle")).toBeNull();
    expect(store.take("opaque-handle")).toEqual(
      expect.objectContaining({
        id: "opaque-handle",
        credential,
        wasSelected: true,
      }),
    );
    expect(store.take("opaque-handle")).toBeNull();
  });

  it("expires and forgets the credential", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new GithubPatUndoStore({
        ttlMs: 5_000,
        randomId: () => "opaque-handle",
      });
      store.stash(credential, false);

      vi.advanceTimersByTime(5_001);
      expect(store.take("opaque-handle")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates an older removal when a newer PAT is removed", () => {
    let sequence = 0;
    const store = new GithubPatUndoStore({
      randomId: () => `handle-${++sequence}`,
    });
    const first = store.stash(credential, false);
    const second = store.stash(
      { ...credential, accessToken: "new-secret" },
      true,
    );

    expect(store.take(first.id)).toBeNull();
    expect(store.take(second.id)?.credential.accessToken).toBe("new-secret");
  });

  it("can put a consumed handle back after a failed keychain restore", () => {
    const store = new GithubPatUndoStore({
      now: () => 1_000,
      randomId: () => "opaque-handle",
    });
    store.stash(credential, true);
    const pending = store.take("opaque-handle");

    expect(pending).not.toBeNull();
    expect(store.restore(pending!)).toBe(true);
    expect(store.take("opaque-handle")).toEqual(
      expect.objectContaining({
        id: "opaque-handle",
        credential,
        wasSelected: true,
        expiresAtMs: 11_000,
      }),
    );
  });

  it("never overwrites a newer undo or revives an expired one", () => {
    let now = 1_000;
    let sequence = 0;
    const store = new GithubPatUndoStore({
      now: () => now,
      randomId: () => `handle-${++sequence}`,
    });
    const firstHandle = store.stash(credential, false);
    const first = store.take(firstHandle.id)!;
    const second = store.stash(
      { ...credential, accessToken: "new-secret" },
      true,
    );

    expect(store.restore(first)).toBe(false);
    expect(store.take(second.id)?.credential.accessToken).toBe("new-secret");

    now = first.expiresAtMs + 1;
    expect(store.restore(first)).toBe(false);
  });
});
