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

import { setSecret } from "../secret-store";

const directories: string[] = [];
const originalSharedDirectory = process.env.ZEROS_SHARED_SECRETS_DIR;

afterEach(async () => {
  if (originalSharedDirectory === undefined) {
    delete process.env.ZEROS_SHARED_SECRETS_DIR;
  } else {
    process.env.ZEROS_SHARED_SECRETS_DIR = originalSharedDirectory;
  }
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function secretDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-secrets-"));
  directories.push(directory);
  process.env.ZEROS_SHARED_SECRETS_DIR = directory;
  return directory;
}

describe("encrypted secret store whole-file safety", () => {
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
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "EISDIR" });
  });
});
