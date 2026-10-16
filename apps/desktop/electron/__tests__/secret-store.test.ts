import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/unused-electron-user-data" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^encrypted:/u, ""),
  },
}));

import { createSecretIfAbsent, deleteSecret, getSecret, migrateSecretsIfAbsent, setSecret } from "../secret-store";
import { localDevCallbackStore } from "../local-dev-callback-store";
import { WorkOSDevCallbackRelay } from "../workos-dev-callback-relay";
import { GithubDevCallbackRelay } from "../github-dev-callback-relay";
import { readProviderAccounts, updateProviderAccounts } from "../provider-account-store";

const directories: string[] = [];
const originalSharedDirectory = process.env.ZEROS_SHARED_SECRETS_DIR;

afterEach(async () => {
  if (originalSharedDirectory === undefined) {
    delete process.env.ZEROS_SHARED_SECRETS_DIR;
  } else {
    process.env.ZEROS_SHARED_SECRETS_DIR = originalSharedDirectory;
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function secretDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-secrets-"));
  directories.push(directory);
  process.env.ZEROS_SHARED_SECRETS_DIR = directory;
  return directory;
}

it("keeps saved accounts readable by older worktrees while retaining private revisions", async () => {
  await secretDirectory();
  const legacy = {
    version: 1, method: "account", initialized: true, methodSelected: true,
    activeId: "00000000-0000-4000-8000-000000000001",
    accounts: [{ id: "00000000-0000-4000-8000-000000000001", state: "connected", configDir: "/private/profile" }],
  };
  setSecret("provider-accounts-codex", JSON.stringify(legacy));
  updateProviderAccounts("codex", store => ({ ...store, selectionRevision: 3,
    accounts: store.accounts.map(account => ({ ...account, revision: 2 })),
  }));
  // The prior v1 reader is strict at both the root and each account.
  expect(JSON.parse(getSecret("provider-accounts-codex")!)).toEqual(legacy);
  expect(readProviderAccounts("codex")).toMatchObject({ selectionRevision: 3, accounts: [{ revision: 2 }] });
  // A status update from an older worktree preserves the companion metadata.
  setSecret("provider-accounts-codex", JSON.stringify({ ...legacy, accounts: [{ ...legacy.accounts[0], state: "expired" }] }));
  expect(readProviderAccounts("codex")).toMatchObject({ selectionRevision: 3, accounts: [{ revision: 2, state: "expired" }] });
});

describe("encrypted secret store whole-file safety", () => {
  it("adopts existing Local provider credentials once without overwriting shared choices or importing app sessions", async () => {
    const directory = await secretDirectory();
    const legacy = path.join(directory, "old-instance", "secrets.json");
    const accounts = ["anthropic-api-key", "openai-api-key", "cursor-api-key", "provider-accounts-claude"];
    createSecretIfAbsent("anthropic-api-key", "legacy-fixture-key", legacy);
    createSecretIfAbsent("openai-api-key", "legacy-codex-key", legacy);
    createSecretIfAbsent("auth-session:tokens", "legacy-app-session", legacy);
    const profile = JSON.stringify({ configDir: "/old-instance/provider-accounts/claude/stable-id" });
    createSecretIfAbsent("provider-accounts-claude", profile, legacy);
    setSecret("openai-api-key", "newer-shared-key");
    migrateSecretsIfAbsent(legacy, accounts, "local-provider-migration:test");
    expect(getSecret("anthropic-api-key")).toBe("legacy-fixture-key");
    expect(getSecret("openai-api-key")).toBe("newer-shared-key");
    expect(getSecret("provider-accounts-claude")).toBe(profile);
    expect(getSecret("auth-session:tokens")).toBeNull();
    expect(getSecret("anthropic-api-key", legacy)).toBe("legacy-fixture-key");
    deleteSecret("anthropic-api-key");
    migrateSecretsIfAbsent(legacy, accounts, "local-provider-migration:test");
    expect(getSecret("anthropic-api-key")).toBeNull();
  });

  it("leaves both stores untouched if the old Local store cannot be read", async () => {
    const directory = await secretDirectory();
    const legacy = path.join(directory, "old-secrets.json");
    await writeFile(legacy, "{invalid");
    setSecret("cursor-api-key", "shared-fixture-key");
    await expect(async () => migrateSecretsIfAbsent(legacy, ["cursor-api-key"], "local-provider-migration:test")).rejects.toThrow();
    expect(getSecret("cursor-api-key")).toBe("shared-fixture-key");
    expect(getSecret("local-provider-migration:test")).toBeNull();
  });

  it("relays GitHub without admitting account or provider credentials into the shared mailbox", async () => {
    const home = await secretDirectory();
    const nonce = "g".repeat(43);
    const accepted = vi.fn(() => true);
    const dispose = new GithubDevCallbackRelay(localDevCallbackStore(home)).register(nonce, Date.now() + 30_000, accepted);
    try {
      expect(new GithubDevCallbackRelay(localDevCallbackStore(home)).deliver({ nonce, accessToken: "discarded-private-field" })).toBe(true);
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith({ nonce }));
      for (const key of ["auth-session:tokens", "github-app-handoff:pending", "github-app"])
        expect(() => localDevCallbackStore(home).read(key)).toThrow(/Invalid Dev callback/);
    } finally { dispose(); }
  });
  it("routes a callback between isolated Dev instances without sharing their sessions", async () => {
    const home = await secretDirectory();
    const a = path.join(home, "a/secrets.json"), b = path.join(home, "b/secrets.json");
    createSecretIfAbsent("auth-session:tokens", "account-a", a);
    createSecretIfAbsent("auth-session:tokens", "account-b", b);
    const first = new WorkOSDevCallbackRelay(localDevCallbackStore(home));
    const second = new WorkOSDevCallbackRelay(localDevCallbackStore(home));
    const state = "zeros-dev." + "s".repeat(43);
    const accepted = vi.fn(() => true);
    const dispose = first.register(state, Date.now() + 30_000, accepted);
    try {
      expect(second.deliver({ state, code: "synthetic-callback-code" })).toBe(true);
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
      expect(getSecret("auth-session:tokens", a)).toBe("account-a");
      expect(getSecret("auth-session:tokens", b)).toBe("account-b");
      expect(() => localDevCallbackStore(home).read("auth-session:tokens")).toThrow(/Invalid Dev callback/);
    } finally { dispose(); }
  });
  it("creates a secret only once under the store mutation lock", async () => {
    await secretDirectory();

    expect(createSecretIfAbsent("cloud_replica_device:test", "winner")).toBe(
      true,
    );
    expect(createSecretIfAbsent("cloud_replica_device:test", "loser")).toBe(
      false,
    );
    expect(getSecret("cloud_replica_device:test")).toBe("winner");
  });

  it("never rewrites a malformed whole store during a secret mutation", async () => {
    const directory = await secretDirectory();
    const file = path.join(directory, "secrets.json");
    const malformed = "{not json";
    await writeFile(file, malformed, "utf8");

    expect(() => setSecret("cloud_replica_device:test", "new-value")).toThrow(
      /malformed|unreadable/u,
    );
    expect(await readFile(file, "utf8")).toBe(malformed);
  });

  it("fails closed when the whole store cannot be read", async () => {
    const directory = await secretDirectory();
    const file = path.join(directory, "secrets.json");
    await mkdir(file);

    expect(() => setSecret("cloud_replica_device:test", "new-value")).toThrow(
      /unreadable/u,
    );
    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
