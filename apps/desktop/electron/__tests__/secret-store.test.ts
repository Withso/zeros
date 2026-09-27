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

import { createSecretIfAbsent, getSecret, setSecret } from "../secret-store";
import { localDevCallbackStore } from "../local-dev-callback-store";
import { WorkOSDevCallbackRelay } from "../workos-dev-callback-relay";

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

describe("encrypted secret store whole-file safety", () => {
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
