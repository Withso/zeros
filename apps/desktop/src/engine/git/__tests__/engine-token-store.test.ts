import { afterEach, describe, expect, it, vi } from "vitest";

import {
  engineGithubTokenStore,
  getSeededGithubCredential,
  seedGithubCredential,
  setGithubCredentialChangeNotifier,
} from "../engine-token-store";

describe("engine GitHub credential working copy", () => {
  afterEach(() => {
    seedGithubCredential(null);
    setGithubCredentialChangeNotifier(null);
  });

  it("seeds a method-addressed credential without notifying the host", async () => {
    const notify = vi.fn();
    setGithubCredentialChangeNotifier(notify);
    seedGithubCredential({
      method: "pat",
      accessToken: "secret",
      login: "octocat",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });

    expect(await engineGithubTokenStore.get()).toBe("secret");
    expect(getSeededGithubCredential()).toMatchObject({
      method: "pat",
      login: "octocat",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports only method and reason when an invalid credential is cleared", async () => {
    const notify = vi.fn();
    seedGithubCredential({
      method: "github-app",
      accessToken: "app-secret",
      login: "octocat",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });
    setGithubCredentialChangeNotifier(notify);

    await engineGithubTokenStore.clear();

    expect(getSeededGithubCredential()).toBeNull();
    expect(notify).toHaveBeenCalledWith({
      method: "github-app",
      reason: "credential-invalid",
    });
    expect(JSON.stringify(notify.mock.calls)).not.toContain("app-secret");
  });

  it("preserves method metadata when a token is refreshed", async () => {
    seedGithubCredential({
      method: "github-app",
      accessToken: "old",
      refreshToken: "host-only",
      login: "octocat",
      variantKey: "github.com",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });

    await engineGithubTokenStore.set("new");

    expect(getSeededGithubCredential()).toEqual({
      method: "github-app",
      accessToken: "new",
      login: "octocat",
      variantKey: "github.com",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });
  });

  it("hands a rejected App token to the host and resumes with its replacement", async () => {
    const notify = vi.fn();
    seedGithubCredential({
      method: "github-app",
      accessToken: "rejected",
      login: "octocat",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });
    setGithubCredentialChangeNotifier(notify);

    const refresh = engineGithubTokenStore.refreshAfterRejection!("rejected");

    expect(getSeededGithubCredential()).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    seedGithubCredential({
      method: "github-app",
      accessToken: "rotated",
      login: "octocat",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });
    await expect(refresh).resolves.toBe("rotated");
  });

  it("shares concurrent App refreshes and ignores a stale rejected re-seed", async () => {
    const notify = vi.fn();
    setGithubCredentialChangeNotifier(notify);
    seedGithubCredential({
      method: "github-app",
      accessToken: "rejected",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });

    const first = engineGithubTokenStore.refreshAfterRejection!("rejected");
    const second = engineGithubTokenStore.refreshAfterRejection!("rejected");
    seedGithubCredential({
      method: "github-app",
      accessToken: "rejected",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });
    expect(getSeededGithubCredential()).toBeNull();
    seedGithubCredential({
      method: "github-app",
      accessToken: "rotated",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "rotated",
      "rotated",
    ]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not rotate or discard borrowed and personal credentials", async () => {
    for (const method of ["gh-cli", "pat"] as const) {
      seedGithubCredential({
        method,
        accessToken: `${method}-token`,
        gitHost: "github.com",
        gitHttpUsername: "x-access-token",
      });
      await expect(
        engineGithubTokenStore.refreshAfterRejection!(`${method}-token`),
      ).resolves.toBeUndefined();
      expect(getSeededGithubCredential()?.accessToken).toBe(`${method}-token`);
    }
  });

  it("uses a credential that rotated before rejection handling began", async () => {
    seedGithubCredential({
      method: "github-app",
      accessToken: "rotated",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });

    await expect(
      engineGithubTokenStore.refreshAfterRejection!("rejected"),
    ).resolves.toBe("rotated");
    expect(getSeededGithubCredential()?.accessToken).toBe("rotated");
  });

  it("retains selected-host ownership while its working credential is absent", async () => {
    seedGithubCredential(null, "github-app");

    await expect(
      engineGithubTokenStore.ownsGitHost!("github.com"),
    ).resolves.toBe(true);
    await expect(engineGithubTokenStore.getCredential!()).resolves.toBeNull();
    await expect(
      engineGithubTokenStore.ownsGitHost!("gitlab.com"),
    ).resolves.toBe(false);

    seedGithubCredential(null);
    await expect(
      engineGithubTokenStore.ownsGitHost!("github.com"),
    ).resolves.toBe(false);
  });

  it("does not clear a credential that changed after a rejection", async () => {
    seedGithubCredential({
      method: "pat",
      accessToken: "new-token",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    });

    await expect(
      engineGithubTokenStore.clearAfterRejection!("old-token"),
    ).resolves.toBe(false);
    expect(getSeededGithubCredential()?.accessToken).toBe("new-token");

    await expect(
      engineGithubTokenStore.clearAfterRejection!("new-token"),
    ).resolves.toBe(true);
    expect(getSeededGithubCredential()).toBeNull();
  });
});
