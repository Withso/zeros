import { describe, expect, it, vi } from "vitest";

import type {
  GithubAuthMethod,
  GithubCredential,
} from "@zeros/protocol/github-auth";
import {
  GITHUB_APP_ACCOUNT,
  GITHUB_LEGACY_ACCOUNT,
  GITHUB_PAT_ACCOUNT,
  isGithubCredentialAccount,
  createGithubCredentialStore,
  migrateLegacyGithubCredential,
} from "../github-credential-store";

const gitIdentity = {
  gitHost: "github.com",
  gitHttpUsername: "x-access-token",
} as const;

it("observes shared-store writes to an account's PAT slot", () => {
  expect(isGithubCredentialAccount("github.pat.0e10f07e-04cf-49b9-91cf-b18563e73969")).toBe(true);
  expect(isGithubCredentialAccount("github-app:dev-callbacks")).toBe(false);
});

function harness(options?: {
  currentAccount?: () => string | null;
  selected?: GithubAuthMethod | null;
  gh?: GithubCredential | null;
  verifyIdentity?: (token: string) => Promise<{ login: string; githubUserId: string }>;
}) {
  const secrets = new Map<string, string>();
  let selected = options?.selected ?? null;
  let disconnectedAt: string | null = null;
  const writes: GithubAuthMethod[] = [];
  const store = createGithubCredentialStore({
    ...(options?.currentAccount ? { currentAccount: options.currentAccount } : {}),
    readSecret: (account) => secrets.get(account) ?? null,
    verifyIdentity: options?.verifyIdentity ?? (async token => ({ login: token.startsWith("pat") ? "pat-user" : "octocat", githubUserId: "123" })),
    updateSecrets: (keys, edit) => {
      const before = Object.fromEntries(keys.map(key => [key, secrets.get(key) ?? null]));
      const after = edit(before);
      for (const key of keys) {
        const value = after[key];
        if (value == null) secrets.delete(key);
        else secrets.set(key, value);
      }
    },
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
  it.each(["pat", "github-app"] as const)("keeps credential bytes and selection after a mismatched second method (%s first)", async method => {
    const other = method === "pat" ? "github-app" : "pat";
    const ownerSub = "11111111-1111-4111-8111-111111111111";
    const h = harness({ currentAccount: () => ownerSub });
    await h.store.set(method, { ...gitIdentity, method, ownerSub, accessToken: "first", login: "first-account", githubUserId: "123" });
    await h.store.setSelectedMethod(method);
    const before = [...h.secrets];
    await expect(h.store.set(other, { ...gitIdentity, method: other, ownerSub, accessToken: "second", login: "second-account", githubUserId: "456" }))
      .rejects.toThrow(/@second-account.*@first-account/);
    expect([...h.secrets]).toEqual(before);
    expect(h.selected()).toBe(method);
    await h.store.set(other, { ...gitIdentity, method: other, ownerSub, accessToken: "second", login: "renamed", githubUserId: "123" });
    expect(await h.store.get(other)).toMatchObject({ login: "renamed", githubUserId: "123" });
  });

  it("verifies a login-only Local record once and persists the ID and current login", async () => {
    const verifyIdentity = vi.fn(async () => ({ login: "renamed", githubUserId: "123" }));
    const h = harness({ selected: "pat", verifyIdentity });
    h.secrets.set(GITHUB_PAT_ACCOUNT, JSON.stringify({ ...gitIdentity, method: "pat", accessToken: "old", login: "old-name" }));
    expect(await h.store.getSelectedCredential()).toMatchObject({ login: "renamed", githubUserId: "123" });
    expect(await h.store.getSelectedCredential()).toMatchObject({ githubUserId: "123" });
    expect(JSON.parse(h.secrets.get(GITHUB_PAT_ACCOUNT)!)).toMatchObject({ login: "renamed", githubUserId: "123" });
    expect(verifyIdentity).toHaveBeenCalledExactlyOnceWith("old");
  });

  it("keeps using a login-only record while GitHub is unreachable or its saved peer differs", async () => {
    const verifyIdentity = vi.fn(async (token: string) => {
      if (token === "offline") throw new Error("offline");
      return { login: token, githubUserId: token === "app" ? "456" : "123" };
    });
    const h = harness({ selected: "pat", verifyIdentity });
    const legacy = { ...gitIdentity, method: "pat", accessToken: "offline", login: "old-name" } as const;
    h.secrets.set(GITHUB_PAT_ACCOUNT, JSON.stringify(legacy));
    expect(await h.store.getSelectedCredential()).toEqual(legacy);
    expect(await h.store.getSelectedCredential()).toEqual(legacy);
    expect(verifyIdentity).toHaveBeenCalledOnce();
    await h.store.set("github-app", { ...gitIdentity, method: "github-app", accessToken: "app", login: "app", githubUserId: "456" });
    expect(await h.store.get("github-app")).toMatchObject({ githubUserId: "456" });

    const mixed = harness({ selected: "pat", verifyIdentity });
    mixed.secrets.set(GITHUB_PAT_ACCOUNT, JSON.stringify({ ...legacy, accessToken: "pat" }));
    mixed.secrets.set(GITHUB_APP_ACCOUNT, JSON.stringify({ ...gitIdentity, method: "github-app", accessToken: "app", login: "app" }));
    expect(await mixed.store.getSelectedCredential()).toMatchObject({ accessToken: "pat", githubUserId: "123" });
    await expect(mixed.store.setSelectedMethod("github-app")).rejects.toThrow(/@app.*@pat/);
    expect(mixed.selected()).toBe("pat");
  });

  it("rejects a competing identity that arrives during verification", async () => {
    let resume!: (value: { githubUserId: string; login: string }) => void;
    const verifyIdentity = vi.fn(() => new Promise<{ githubUserId: string; login: string }>(resolve => { resume = resolve; }));
    const h = harness({ verifyIdentity });
    const pending = h.store.set("pat", { ...gitIdentity, method: "pat", accessToken: "first", login: "first" });
    await vi.waitFor(() => expect(verifyIdentity).toHaveBeenCalledOnce());
    await h.store.set("github-app", { ...gitIdentity, method: "github-app", accessToken: "second", githubUserId: "456", login: "second" });
    resume({ githubUserId: "123", login: "first" });
    await expect(pending).rejects.toThrow();
    expect(await h.store.get("pat")).toBeNull();
  });

  it("preserves existing device PATs without adopting them when a Zeros account signs in", async () => {
    let current: string | null = null;
    const { store, secrets } = harness({ currentAccount: () => current, selected: "pat" });
    const devicePat = { ...gitIdentity, method: "pat", accessToken: "device-pat" } as const;
    await store.set("pat", devicePat);
    secrets.set(GITHUB_LEGACY_ACCOUNT, "device-legacy");

    current = "member";
    expect(await store.getSelectedCredential()).toBeNull();
    expect(await migrateLegacyGithubCredential(store)).toBeNull();
    await store.clear("pat");
    await expect(store.set("pat", devicePat)).rejects.toThrow();

    current = null;
    expect(await store.getSelectedCredential()).toMatchObject(devicePat);
    expect(store.readLegacyToken()).toBe("device-legacy");
  });
  it("restores each Zeros account's own PAT for the same GitHub login after a switch", async () => {
    const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
    let current: string | null = a;
    const { store } = harness({ currentAccount: () => current, selected: "pat" });
    const pat = { ...gitIdentity, method: "pat", login: "octocat", accessToken: "synthetic-token-a", ownerSub: a } as const;
    await store.set("pat", pat);
    current = b;
    expect(await store.getSelectedCredential()).toBeNull();
    await expect(store.set("pat", pat)).rejects.toThrow();
    await store.set("pat", { ...pat, accessToken: "synthetic-token-b", ownerSub: b });
    current = a;
    expect(await store.getSelectedCredential()).toEqual({ ...pat, githubUserId: "123" });
    await store.clear("pat");
    current = b;
    expect(await store.getSelectedCredential()).toMatchObject({ accessToken: "synthetic-token-b" });
    current = null;
    expect(await store.getSelectedCredential()).toBeNull();
  });
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
      verifyIdentity: async () => ({ githubUserId: "123", login: "octocat" }),
      updateSecrets: () => {
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
      verifyIdentity: async () => ({ githubUserId: "123", login: "octocat" }),
      updateSecrets: () => {
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
