import { describe, expect, it, vi } from "vitest";

import type {
  GithubAuthMethod,
  GithubCredential,
} from "@zeros/core/github-auth";
import {
  GITHUB_APP_ACCOUNT,
  GITHUB_LEGACY_ACCOUNT,
  GITHUB_PAT_ACCOUNT,
  createGithubCredentialStore,
  migrateLegacyGithubCredential,
} from "../github-credential-store";

const gitIdentity = {
  gitHost: "github.com",
  gitHttpUsername: "x-access-token",
} as const;

function harness(options?: {
  selected?: GithubAuthMethod | null;
  gh?: GithubCredential | null;
}) {
  const secrets = new Map<string, string>();
  let selected = options?.selected ?? null;
  let disconnectedAt: string | null = null;
  const writes: GithubAuthMethod[] = [];
  const store = createGithubCredentialStore({
    readSecret: (account) => secrets.get(account) ?? null,
    writeSecret: (account, value) => secrets.set(account, value),
    deleteSecret: (account) => secrets.delete(account),
    readSelectedMethod: () => selected,
    writeSelectedMethod: (method) => {
      selected = method;
      writes.push(method);
    },
    readDisconnectedAt: () => disconnectedAt,
    writeDisconnectedAt: (value) => {
      disconnectedAt = value;
    },
    readGhCliCredential: async () => options?.gh ?? null,
  });
  return {
    secrets,
    store,
    writes,
    selected: () => selected,
    disconnectedAt: () => disconnectedAt,
  };
}

describe("GitHub credential store", () => {
  it("defaults to gh CLI and never persists its borrowed token", async () => {
    const gh = {
      ...gitIdentity,
      method: "gh-cli",
      accessToken: "gh-token",
      login: "octocat",
    } as const;
    const h = harness({ gh });

    expect(await h.store.getSelectedMethod()).toBe("gh-cli");
    expect(await h.store.get("gh-cli")).toEqual(gh);
    expect(h.secrets.size).toBe(0);
  });

  it("honors an explicit gh disconnect without logging the CLI out", async () => {
    const h = harness({
      gh: {
        ...gitIdentity,
        method: "gh-cli",
        accessToken: "gh-token",
        login: "octocat",
      },
    });
    await h.store.markExplicitlyDisconnected();

    expect(await h.store.get("gh-cli")).toMatchObject({ login: "octocat" });
    expect(await h.store.getSelectedCredential()).toBeNull();
    expect(h.disconnectedAt()).not.toBeNull();

    await h.store.setSelectedMethod("gh-cli");
    expect(h.disconnectedAt()).toBeNull();
    expect(await h.store.getSelectedCredential()).toMatchObject({
      login: "octocat",
    });
  });

  it("keeps an inactive CLI disconnect while PAT or App remains selected", async () => {
    const h = harness({
      selected: "pat",
      gh: {
        ...gitIdentity,
        method: "gh-cli",
        accessToken: "gh-token",
        login: "cli-user",
      },
    });
    await h.store.set("pat", {
      ...gitIdentity,
      method: "pat",
      accessToken: "pat-token",
      login: "pat-user",
    });

    await h.store.markExplicitlyDisconnected();
    expect(await h.store.getSelectedCredential()).toMatchObject({
      method: "pat",
      login: "pat-user",
    });

    await h.store.setSelectedMethod("pat");
    expect(h.store.isExplicitlyDisconnected()).toBe(true);
    await h.store.setSelectedMethod("github-app");
    expect(h.store.isExplicitlyDisconnected()).toBe(true);
    await h.store.setSelectedMethod("gh-cli");
    expect(h.store.isExplicitlyDisconnected()).toBe(false);
  });

  it("does not re-adopt an explicitly disconnected CLI during automatic fallback", async () => {
    const h = harness({
      selected: "pat",
      gh: {
        ...gitIdentity,
        method: "gh-cli",
        accessToken: "gh-token",
        login: "cli-user",
      },
    });
    await h.store.markExplicitlyDisconnected();

    await h.store.setFallbackMethod("gh-cli");

    expect(await h.store.getSelectedMethod()).toBe("gh-cli");
    expect(h.store.isExplicitlyDisconnected()).toBe(true);
    expect(await h.store.getSelectedCredential()).toBeNull();
  });

  it("keeps PAT and GitHub App credentials in independent slots", async () => {
    const h = harness();
    await h.store.set("pat", {
      ...gitIdentity,
      method: "pat",
      accessToken: "pat-token",
      login: "pat-user",
    });
    await h.store.set("github-app", {
      ...gitIdentity,
      method: "github-app",
      accessToken: "app-token",
      login: "app-user",
      variantKey: "github.com",
    });
    await h.store.setSelectedMethod("pat");

    expect(await h.store.get("pat")).toMatchObject({
      accessToken: "pat-token",
    });
    expect(await h.store.get("github-app")).toMatchObject({
      accessToken: "app-token",
    });

    await h.store.clear("pat");
    expect(await h.store.get("pat")).toBeNull();
    expect(await h.store.get("github-app")).toMatchObject({
      accessToken: "app-token",
    });
    expect(h.secrets.has(GITHUB_PAT_ACCOUNT)).toBe(false);
    expect(h.secrets.has(GITHUB_APP_ACCOUNT)).toBe(true);
  });

  it("rejects a credential written to the wrong method", async () => {
    const h = harness();
    await expect(
      h.store.set("pat", {
        ...gitIdentity,
        method: "github-app",
        accessToken: "wrong",
      }),
    ).rejects.toThrow(/method/i);
  });

  it("does not change the selected method when a slot write fails", async () => {
    const h = harness({ selected: "gh-cli" });
    // Assert on the spy, not only on getSelectedMethod(): the harness's reader
    // is backed by the same variable the writer would set, so a state-only
    // assertion passes even if the store did try to switch methods.
    const writeSelectedMethod = vi.fn();
    const broken = createGithubCredentialStore({
      readSecret: (account) => h.secrets.get(account) ?? null,
      writeSecret: () => {
        throw new Error("keystore unavailable");
      },
      deleteSecret: vi.fn(),
      readSelectedMethod: () => h.selected(),
      writeSelectedMethod,
      readDisconnectedAt: () => null,
      writeDisconnectedAt: vi.fn(),
      readGhCliCredential: async () => null,
    });

    await expect(
      broken.set("pat", {
        ...gitIdentity,
        method: "pat",
        accessToken: "token",
      }),
    ).rejects.toThrow("keystore unavailable");
    expect(writeSelectedMethod).not.toHaveBeenCalled();
    expect(await broken.getSelectedMethod()).toBe("gh-cli");
  });
});

describe("legacy GitHub credential migration", () => {
  it("infers gh CLI when the borrowed token matches", async () => {
    const h = harness({
      gh: {
        ...gitIdentity,
        method: "gh-cli",
        accessToken: "same-token",
        login: "octocat",
      },
    });
    h.secrets.set(GITHUB_LEGACY_ACCOUNT, "same-token");

    expect(await migrateLegacyGithubCredential(h.store)).toBe("gh-cli");
    expect(h.selected()).toBe("gh-cli");
    expect(h.secrets.has(GITHUB_LEGACY_ACCOUNT)).toBe(false);
    expect(h.secrets.has(GITHUB_PAT_ACCOUNT)).toBe(false);
  });

  it("preserves a non-matching legacy credential as a PAT", async () => {
    const h = harness({
      gh: {
        ...gitIdentity,
        method: "gh-cli",
        accessToken: "different-token",
        login: "octocat",
      },
    });
    h.secrets.set(GITHUB_LEGACY_ACCOUNT, "legacy-token");

    expect(await migrateLegacyGithubCredential(h.store)).toBe("pat");
    expect(h.selected()).toBe("pat");
    expect(await h.store.get("pat")).toMatchObject({
      method: "pat",
      accessToken: "legacy-token",
    });
    expect(h.secrets.has(GITHUB_LEGACY_ACCOUNT)).toBe(false);
  });

  it("is idempotent after the legacy slot is removed", async () => {
    const h = harness();
    expect(await migrateLegacyGithubCredential(h.store)).toBeNull();
    expect(await migrateLegacyGithubCredential(h.store)).toBeNull();
    expect(h.writes).toEqual([]);
  });

  // The legacy slot survives whenever the final delete fails (the secret store
  // throws on lock timeout, and the caller treats that as "migration deferred"),
  // and a one-release downgrade can recreate it. A re-run must not resurrect the
  // stale token over a newer PAT or override the user's explicit choice.
  it("does not clobber a newer PAT or the selected method when it re-runs", async () => {
    const h = harness({ selected: "github-app" });
    h.secrets.set(GITHUB_LEGACY_ACCOUNT, "stale-legacy-token");
    await h.store.set("pat", {
      ...gitIdentity,
      method: "pat",
      accessToken: "current-pat-token",
      login: "pat-user",
    });
    h.writes.length = 0;

    expect(await migrateLegacyGithubCredential(h.store)).toBeNull();

    expect(await h.store.get("pat")).toMatchObject({
      accessToken: "current-pat-token",
    });
    expect(h.selected()).toBe("github-app");
    expect(h.writes).toEqual([]);
    // The stale source is retired so it cannot come back on a later boot.
    expect(h.secrets.has(GITHUB_LEGACY_ACCOUNT)).toBe(false);
  });

  // Same shape as above, except the PAT slot happens to hold exactly the legacy
  // token (the migration's own delete failed after it completed). That must not
  // be read as "migration still pending" and reset the user's App selection.
  it("leaves the selected method alone when the PAT slot already holds the legacy token", async () => {
    const h = harness({ selected: "github-app" });
    await h.store.set("pat", {
      ...gitIdentity,
      method: "pat",
      accessToken: "legacy-token",
      login: "pat-user",
    });
    h.secrets.set(GITHUB_LEGACY_ACCOUNT, "legacy-token");
    h.writes.length = 0;

    expect(await migrateLegacyGithubCredential(h.store)).toBeNull();

    expect(h.selected()).toBe("github-app");
    expect(h.secrets.has(GITHUB_LEGACY_ACCOUNT)).toBe(false);
  });

  it("keeps the legacy credential when the destination write fails", async () => {
    const h = harness();
    h.secrets.set(GITHUB_LEGACY_ACCOUNT, "legacy-token");
    const broken = createGithubCredentialStore({
      readSecret: (account) => h.secrets.get(account) ?? null,
      writeSecret: () => {
        throw new Error("disk full");
      },
      deleteSecret: (account) => h.secrets.delete(account),
      readSelectedMethod: () => null,
      writeSelectedMethod: vi.fn(),
      readDisconnectedAt: () => null,
      writeDisconnectedAt: vi.fn(),
      readGhCliCredential: async () => null,
    });

    await expect(migrateLegacyGithubCredential(broken)).rejects.toThrow(
      "disk full",
    );
    expect(h.secrets.get(GITHUB_LEGACY_ACCOUNT)).toBe("legacy-token");
  });
});
