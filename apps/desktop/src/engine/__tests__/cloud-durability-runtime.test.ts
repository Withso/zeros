import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  CloudWorkspaceDurabilityRuntime,
  scanCloudWorkspaceChanges,
} from "../cloud-durability-runtime";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

describe("cloud durability scanner", () => {
  it("captures the complete safe working tree plus deletions while excluding secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-scan-"));
    roots.push(root);
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "cloud@example.test");
    await git(root, "config", "user.name", "Cloud Test");
    await writeFile(path.join(root, "modified.txt"), "base\n");
    await writeFile(path.join(root, "deleted.txt"), "delete me\n");
    await writeFile(path.join(root, "unchanged.txt"), "stable\n");
    await git(root, "add", "modified.txt", "deleted.txt", "unchanged.txt");
    await git(root, "commit", "--quiet", "-m", "base");

    await writeFile(path.join(root, "modified.txt"), "changed\n");
    await unlink(path.join(root, "deleted.txt"));
    await writeFile(path.join(root, "untracked.txt"), "new\n");
    await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
    await mkdir(path.join(root, "node_modules", "package"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "package", "index.js"), "cache\n");
    await mkdir(path.join(root, ".zeros", "runtime"), { recursive: true });
    await writeFile(path.join(root, ".zeros", "runtime", "engine.sock"), "private\n");
    await writeFile(path.join(root, ".zeros", "settings.toml"), "[design]\n");
    await symlink("modified.txt", path.join(root, "link.txt"));

    const scan = await scanCloudWorkspaceChanges(root);
    try {
      expect([...scan.entries.keys()]).toEqual([
        ".zeros/settings.toml",
        "link.txt",
        "modified.txt",
        "unchanged.txt",
        "untracked.txt",
      ]);
      expect(scan.deletions).toEqual(new Set(["deleted.txt"]));
      expect(scan.entries.get("link.txt")).toMatchObject({
        entryType: "symlink",
        mode: 40960,
      });
      expect(scan.entries.get("modified.txt")?.bytes.toString("utf8")).toBe(
        "changed\n",
      );
      expect(scan.entries.get("unchanged.txt")?.bytes.toString("utf8")).toBe(
        "stable\n",
      );
      expect(scan.entries.has(".env")).toBe(false);
      expect(scan.entries.has("node_modules/package/index.js")).toBe(false);
      expect(scan.entries.has(".zeros/runtime/engine.sock")).toBe(false);
    } finally {
      for (const entry of scan.entries.values()) entry.bytes.fill(0);
    }
  });

  it("fails closed on Unicode/case collisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-collision-"));
    roots.push(root);
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "cloud@example.test");
    await git(root, "config", "user.name", "Cloud Test");
    await writeFile(path.join(root, "README.md"), "base\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "--quiet", "-m", "base");
    await writeFile(path.join(root, "Case.txt"), "one\n");
    await writeFile(path.join(root, "case.txt"), "two\n");

    await expect(scanCloudWorkspaceChanges(root)).rejects.toThrow(/collision/i);
  });

  it("can omit only the shared repository settings layer for a fork", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-settings-scan-"));
    roots.push(root);
    await git(root, "init", "--quiet");
    await git(root, "config", "user.email", "cloud@example.test");
    await git(root, "config", "user.name", "Cloud Test");
    await mkdir(path.join(root, ".zeros"));
    await writeFile(path.join(root, ".zeros", "settings.toml"), "[design]\n");
    await writeFile(
      path.join(root, ".zeros", "settings.local.toml"),
      "[env]\nTOKEN = 'never-upload'\n",
    );
    await writeFile(path.join(root, "README.md"), "base\n");
    await git(root, "add", ".zeros/settings.toml", "README.md");
    await git(root, "commit", "--quiet", "-m", "base");

    const included = await scanCloudWorkspaceChanges(root);
    const omitted = await scanCloudWorkspaceChanges(root, {
      includeRepositorySettings: false,
    });
    try {
      expect(included.entries.has(".zeros/settings.toml")).toBe(true);
      expect(included.entries.has(".zeros/settings.local.toml")).toBe(false);
      expect(omitted.entries.has(".zeros/settings.toml")).toBe(false);
      expect(omitted.entries.has(".zeros/settings.local.toml")).toBe(false);
      expect(omitted.entries.has("README.md")).toBe(true);
      expect(omitted.fingerprint).not.toBe(included.fingerprint);
    } finally {
      for (const scan of [included, omitted]) {
        for (const entry of scan.entries.values()) entry.bytes.fill(0);
      }
    }
  });
});

describe("cloud durability projection validation", () => {
  const authority = {
    heartbeatEndpoint: "https://control.example.test/internal/heartbeat",
    heartbeatToken: "heartbeat-token",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    engineInstanceId: "33333333-3333-4333-8333-333333333333",
  };

  it.each([
    ["a symlink encoded with a file mode", "symlink", 33188, 4],
    ["a file encoded with a symlink mode", "file", 40960, 4],
    ["an empty symlink target", "symlink", 40960, 0],
    ["an oversized symlink target", "symlink", 40960, 4_097],
    ["an oversized file", "file", 33188, 64 * 1024 * 1024 + 1],
  ])("rejects %s before scanning or uploading", async (_label, entryType, mode, sizeBytes) => {
    let calls = 0;
    const runtime = new CloudWorkspaceDurabilityRuntime("/unused", {
      fetch: (async () => {
        calls += 1;
        if (calls !== 1) throw new Error("unexpected durability request");
        return Response.json({
          checkpointId: null,
          currentRevision: 1,
          durableRevision: 1,
          entries: [
            {
              operation: "upsert",
              path: "link.txt",
              entryType,
              mode,
              blobId: "44444444-4444-4444-8444-444444444444",
              contentSha256: "a".repeat(64),
              sizeBytes,
            },
          ],
          nextAfterPath: null,
        });
      }) as typeof fetch,
    });

    await expect(
      runtime.checkpoint(
        {
          id: "55555555-5555-4555-8555-555555555555",
          reason: "manual",
          deadlineAtMs: Date.now() + 60_000,
        },
        authority,
      ),
    ).rejects.toThrow("cloud durability projection is invalid");
    expect(calls).toBe(1);
  });
});
