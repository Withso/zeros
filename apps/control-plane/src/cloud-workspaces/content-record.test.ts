import { describe, expect, it } from "vitest";

import {
  MAX_WORKSPACE_FILE_BYTES,
  validateWorkspaceFileMutations,
  workspacePathIsReplicaSafe,
} from "./content-record.js";

describe("workspace content path contract", () => {
  it.each([
    "src/index.ts",
    "packages/日本語/éxample.ts",
    ".zeros/settings.toml",
  ])("accepts a normalized confined path: %s", (value) => {
    expect(workspacePathIsReplicaSafe(value)).toBe(true);
  });

  it.each([
    "/etc/passwd",
    "../escape",
    "src/../escape",
    ".git/config",
    "src\\windows.ts",
    "src//double.ts",
    "trailing/",
    "e\u0301xample.ts",
    ".env",
    "config/.env.production",
    "node_modules/package/index.js",
    ".aws/credentials",
    ".zeros/settings.local.toml",
    ".zeros/runtime/engine.sock",
  ])("rejects an unsafe or ambiguous path: %s", (value) => {
    expect(workspacePathIsReplicaSafe(value)).toBe(false);
  });

  it("rejects file/directory aliases inside one projected mutation batch", () => {
    const descriptor = {
      operation: "upsert" as const,
      entryType: "file" as const,
      mode: 33188 as const,
      blobId: "11111111-1111-4111-8111-111111111111",
      contentSha256: "a".repeat(64),
      sizeBytes: 1,
    };
    expect(() =>
      validateWorkspaceFileMutations([
        { ...descriptor, path: "src" },
        { ...descriptor, path: "src/index.ts" },
      ]),
    ).toThrow("file and directory");
  });
});

describe("workspace content size contract", () => {
  const mutation = (sizeBytes: number) => ({
    operation: "upsert" as const,
    path: "src/large.bin",
    entryType: "file" as const,
    mode: 33188 as const,
    blobId: "11111111-1111-4111-8111-111111111111",
    contentSha256: "a".repeat(64),
    sizeBytes,
  });

  it("matches the durable blob and desktop apply ceiling", () => {
    expect(validateWorkspaceFileMutations([mutation(MAX_WORKSPACE_FILE_BYTES)]))
      .toHaveLength(1);
    expect(() =>
      validateWorkspaceFileMutations([mutation(MAX_WORKSPACE_FILE_BYTES + 1)]),
    ).toThrow("File mutation is invalid");
  });

  it("rejects symbolic-link targets larger than the desktop safety contract", () => {
    expect(() =>
      validateWorkspaceFileMutations([
        {
          ...mutation(4_097),
          entryType: "symlink",
          mode: 40960,
        },
      ]),
    ).toThrow("File mutation is invalid");
  });
});
