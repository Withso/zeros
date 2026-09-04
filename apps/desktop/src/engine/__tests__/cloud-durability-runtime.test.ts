import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudWorkspaceDurabilityRuntime,
  scanCloudWorkspaceChanges,
} from "../cloud-durability-runtime";

const execFileAsync = promisify(execFile);
const LINUX_O_PATH = 0o10000000;
const roots: string[] = [];
const authority = {
  heartbeatEndpoint: "https://control.example.test/internal/heartbeat",
  heartbeatToken: "heartbeat-token",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
};
const checkpointIt = it.runIf(process.platform === "linux");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

async function checkpointRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-runtime-"));
  roots.push(root);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "cloud@example.test");
  await git(root, "config", "user.name", "Cloud Test");
  await writeFile(path.join(root, "README.md"), "checkpoint\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "--quiet", "-m", "base");
  return root;
}

async function addTrackedNestedFile(root: string): Promise<string> {
  const nested = path.join(root, "nested");
  await mkdir(nested);
  await writeFile(path.join(nested, "entry.txt"), "nested contents\n");
  await writeFile(path.join(root, ".gitignore"), "/nested\n");
  await git(root, "add", ".gitignore");
  await git(root, "add", "--force", "nested/entry.txt");
  await git(root, "commit", "--quiet", "-m", "add nested entry");
  return nested;
}

function recordingCheckpointFetch(writes: string[]): typeof fetch {
  return (async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/content/head") && init?.method === "GET") {
      return Response.json({
        checkpointId: null,
        currentRevision: 0,
        durableRevision: 0,
        entries: [],
        nextAfterPath: null,
      });
    }
    writes.push(pathname);
    throw new Error(`unexpected cloud checkpoint write: ${pathname}`);
  }) as typeof fetch;
}

async function expectUnsafeCheckpointWithoutWrites(
  root: string,
  expected: RegExp,
): Promise<void> {
  const writes: string[] = [];
  const runtime = new CloudWorkspaceDurabilityRuntime(root, {
    fetch: recordingCheckpointFetch(writes),
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
  ).rejects.toThrow(expected);
  expect(writes).toEqual([]);
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
    await mkdir(path.join(root, "node_modules", "package"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "node_modules", "package", "index.js"),
      "cache\n",
    );
    await mkdir(path.join(root, ".zeros", "runtime"), { recursive: true });
    await writeFile(
      path.join(root, ".zeros", "runtime", "engine.sock"),
      "private\n",
    );
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
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-cloud-settings-scan-"),
    );
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

  checkpointIt(
    "rejects invalid UTF-8 Git path bytes before any remote write",
    async () => {
      const root = await checkpointRepository();
      const invalidPath = Buffer.concat([
        Buffer.from(`${root}${path.sep}invalid-`),
        Buffer.from([0xff]),
      ]);
      await writeFile(invalidPath, "invalid path bytes\n");
      await git(root, "add", "-A");

      await expectUnsafeCheckpointWithoutWrites(root, /not valid UTF-8/);
    },
  );

  checkpointIt.each([
    ["an absolute target", "/etc/passwd", /target is unsafe/],
    ["an escaping target", "../../outside", /escaped the repository/],
    ["the repository root", "..", /escaped the repository/],
    ["Git internals", "../.git/config", /unsafe path/],
    ["an excluded secret", "../.env", /target is excluded/],
    [
      "engine-private state",
      "../.zeros/runtime/engine.sock",
      /target is excluded/,
    ],
    ["a control character", "target\nname", /target is unsafe/],
    ["a non-NFC target", "e\u0301.txt", /target is unsafe/],
    ["a backslash target", "..\\outside", /target is unsafe/],
  ])(
    "rejects a symlink to %s before any remote write",
    async (_label, target, expected) => {
      const root = await checkpointRepository();
      await mkdir(path.join(root, "nested"));
      await symlink(target, path.join(root, "nested", "link"));

      await expectUnsafeCheckpointWithoutWrites(root, expected);
    },
  );

  checkpointIt(
    "rejects a non-UTF-8 symlink target before any remote write",
    async () => {
      const root = await checkpointRepository();
      await mkdir(path.join(root, "nested"));
      await symlink(
        Buffer.from([0xff]),
        Buffer.from(path.join(root, "nested", "link")),
      );

      await expectUnsafeCheckpointWithoutWrites(root, /not valid UTF-8/);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a regular leaf replacement after pinning its identity",
    async () => {
      const root = await checkpointRepository();
      const leafName = "race-replaced.txt";
      const leaf = path.join(root, leafName);
      const relocated = path.join(root, "race-replaced.original");
      await writeFile(leaf, "trusted contents\n");

      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const result = await originalOpen(...args);
        if (path.basename(String(args[0])) === leafName && !replaced) {
          replaced = true;
          await rename(leaf, relocated);
          await writeFile(leaf, "replacement contents\n");
        }
        return result;
      });
      try {
        const capture = scanCloudWorkspaceChanges(root).then((scan) => {
          for (const entry of scan.entries.values()) entry.bytes.fill(0);
          return scan;
        });
        await expect(capture).rejects.toThrow(/file changed during scan/);
        expect(replaced).toBe(true);
      } finally {
        open.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "classifies a raced FIFO without opening it for data",
    async () => {
      const root = await checkpointRepository();
      const leafName = "race-fifo.txt";
      const leaf = path.join(root, leafName);
      await writeFile(leaf, "regular contents\n");

      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      let openedForData = false;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])) === leafName) {
          if (!replaced) {
            replaced = true;
            await unlink(leaf);
            await execFileAsync("mkfifo", [leaf]);
          }
          const flags = Number(args[1]);
          if ((flags & LINUX_O_PATH) !== LINUX_O_PATH) {
            openedForData = true;
            throw new Error("test blocked an unsafe FIFO data open");
          }
        }
        return originalOpen(...args);
      });
      try {
        await expect(scanCloudWorkspaceChanges(root)).rejects.toThrow(
          /path type is unsupported/,
        );
        expect(replaced).toBe(true);
        expect(openedForData).toBe(false);
      } finally {
        open.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a symlink replacement after pinning its identity",
    async () => {
      const root = await checkpointRepository();
      const leafName = "race-replaced-link";
      const leaf = path.join(root, leafName);
      await writeFile(path.join(root, "alternate.txt"), "alternate\n");
      await symlink("README.md", leaf);

      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      const replaceLeaf = async (): Promise<void> => {
        if (replaced) return;
        replaced = true;
        await unlink(leaf);
        await symlink("alternate.txt", leaf);
      };
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])) !== leafName) {
          return originalOpen(...args);
        }
        try {
          const result = await originalOpen(...args);
          await replaceLeaf();
          return result;
        } catch (error) {
          await replaceLeaf();
          throw error;
        }
      });
      try {
        const capture = scanCloudWorkspaceChanges(root).then((scan) => {
          for (const entry of scan.entries.values()) entry.bytes.fill(0);
          return scan;
        });
        await expect(capture).rejects.toThrow(/symlink changed during scan/);
        expect(replaced).toBe(true);
      } finally {
        open.mockRestore();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a symlink ABA replacement during target capture",
    async () => {
      const root = await checkpointRepository();
      const leafName = "race-aba-link";
      const leaf = path.join(root, leafName);
      const parked = path.join(root, "race-aba-link.original");
      await writeFile(path.join(root, "OTHER.txt"), "alternate\n");
      await symlink("README.md", leaf);
      const originalStat = await fs.lstat(leaf);

      const originalLstat = fs.lstat.bind(fs);
      const originalReadlink = fs.readlink.bind(fs);
      let swapped = false;
      const readlink = vi
        .spyOn(fs, "readlink")
        .mockImplementation(async (...args) => {
          if (path.basename(String(args[0])) === leafName && !swapped) {
            swapped = true;
            await rename(leaf, parked);
            await symlink("OTHER.txt", leaf);
          }
          return originalReadlink(...args);
        });
      const lstat = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (...args) => {
          if (path.basename(String(args[0])) === leafName && swapped) {
            await unlink(leaf);
            await rename(parked, leaf);
            swapped = false;
          }
          return originalLstat(...args);
        });
      try {
        const capture = scanCloudWorkspaceChanges(root).then((scan) => {
          for (const entry of scan.entries.values()) entry.bytes.fill(0);
          return scan;
        });
        await expect(capture).rejects.toThrow(/symlink changed during scan/);
        const restoredStat = await fs.lstat(leaf);
        expect(restoredStat.dev).toBe(originalStat.dev);
        expect(restoredStat.ino).toBe(originalStat.ino);
      } finally {
        readlink.mockRestore();
        lstat.mockRestore();
        if (swapped) {
          await unlink(leaf);
          await rename(parked, leaf);
        }
      }
    },
  );

  checkpointIt(
    "rejects a symlinked parent before upload, append, or checkpoint commit",
    async () => {
      const root = await checkpointRepository();
      const nested = await addTrackedNestedFile(root);
      const relocated = path.join(
        path.dirname(root),
        `${path.basename(root)}-outside`,
      );
      roots.push(relocated);
      await rename(nested, relocated);
      await symlink(relocated, nested);

      await expectUnsafeCheckpointWithoutWrites(root, /ENOTDIR|ELOOP|parent/);
    },
  );

  checkpointIt(
    "pins an inspected parent against a symlink swap before any remote write",
    async () => {
      const root = await checkpointRepository();
      const nested = await addTrackedNestedFile(root);
      const leaf = path.join(nested, "entry.txt");
      const relocated = path.join(
        path.dirname(root),
        `${path.basename(root)}-swapped`,
      );
      roots.push(relocated);
      const originalOpen = fs.open.bind(fs);
      let swapped = false;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const result = await originalOpen(...args);
        if (
          path.basename(String(args[0])) === path.basename(leaf) &&
          !swapped
        ) {
          swapped = true;
          await rename(nested, relocated);
          await symlink(relocated, nested);
        }
        return result;
      });
      try {
        await expectUnsafeCheckpointWithoutWrites(root, /parent changed/);
        expect(swapped).toBe(true);
      } finally {
        open.mockRestore();
        if (swapped) {
          await unlink(nested);
          await rename(relocated, nested);
        }
      }
    },
  );

  it("never combines Git metadata from one repository root with files from another", async () => {
    const root = await checkpointRepository();
    const attacker = await mkdtemp(
      path.join(tmpdir(), "zeros-cloud-root-substitute-"),
    );
    const relocated = `${root}-relocated`;
    roots.push(attacker, relocated);
    await git(attacker, "init", "--quiet");
    await git(attacker, "config", "user.email", "cloud@example.test");
    await git(attacker, "config", "user.name", "Cloud Test");
    await writeFile(path.join(attacker, "attacker.txt"), "substituted\n");
    await git(attacker, "add", "attacker.txt");
    await git(attacker, "commit", "--quiet", "-m", "substitute");
    const originalCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const attackerCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: attacker })
    ).stdout.trim();

    const originalRealpath = fs.realpath.bind(fs);
    let calls = 0;
    let substituted = false;
    const realpath = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 1) {
          const resolved = await originalRealpath(...args);
          await rename(root, relocated);
          await rename(attacker, root);
          substituted = true;
          return resolved;
        }
        if (calls === 2 && substituted) {
          await rename(root, attacker);
          await rename(relocated, root);
          substituted = false;
        }
        return originalRealpath(...args);
      });
    try {
      const scan = await scanCloudWorkspaceChanges(root);
      const capturedOriginal =
        scan.gitBaseCommit === originalCommit &&
        scan.entries.has("README.md") &&
        !scan.entries.has("attacker.txt") &&
        !scan.deletions.has("attacker.txt");
      const capturedSubstitute =
        scan.gitBaseCommit === attackerCommit &&
        scan.entries.has("attacker.txt") &&
        !scan.entries.has("README.md") &&
        !scan.deletions.has("README.md");
      expect(capturedOriginal || capturedSubstitute).toBe(true);
    } finally {
      realpath.mockRestore();
      if (substituted) {
        await rename(root, attacker);
        await rename(relocated, root);
      }
    }
  });
});

describe("cloud durability projection validation", () => {
  checkpointIt(
    "rejects a repeated non-adjacent cursor before scanning or writing",
    async () => {
      const pages = [
        {
          entries: [
            {
              operation: "delete",
              path: "a.txt",
              entryType: null,
              mode: null,
              blobId: null,
              contentSha256: null,
              sizeBytes: null,
            },
            {
              operation: "delete",
              path: "b.txt",
              entryType: null,
              mode: null,
              blobId: null,
              contentSha256: null,
              sizeBytes: null,
            },
          ],
          nextAfterPath: "a.txt",
        },
        { entries: [], nextAfterPath: "b.txt" },
        { entries: [], nextAfterPath: "a.txt" },
      ];
      let headCalls = 0;
      const writes: string[] = [];
      const runtime = new CloudWorkspaceDurabilityRuntime("/unused", {
        fetch: (async (input, init) => {
          const pathname = new URL(String(input)).pathname;
          if (!pathname.endsWith("/content/head") || init?.method !== "GET") {
            writes.push(pathname);
            throw new Error(`unexpected durability write: ${pathname}`);
          }
          const page = pages[headCalls];
          headCalls += 1;
          if (!page) throw new Error("unexpected fourth projection page");
          return Response.json({
            checkpointId: null,
            currentRevision: 1,
            durableRevision: 1,
            ...page,
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
      ).rejects.toThrow("cloud durability projection cursor is invalid");
      expect(headCalls).toBe(3);
      expect(writes).toEqual([]);
    },
  );

  checkpointIt(
    "cancels a chunked response as soon as it crosses the JSON byte limit",
    async () => {
      let pulls = 0;
      let cancelled = false;
      const runtime = new CloudWorkspaceDurabilityRuntime("/unused", {
        fetch: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(1024 * 1024));
                if (pulls === 8) controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "application/json" } },
          )) as typeof fetch,
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
      ).rejects.toThrow("cloud durability response is too large");
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(8);
    },
  );

  checkpointIt.each([
    ["a symlink encoded with a file mode", "symlink", 33188, 4],
    ["a file encoded with a symlink mode", "file", 40960, 4],
    ["an empty symlink target", "symlink", 40960, 0],
    ["an oversized symlink target", "symlink", 40960, 4_097],
    ["an oversized file", "file", 33188, 64 * 1024 * 1024 + 1],
  ])(
    "rejects %s before scanning or uploading",
    async (_label, entryType, mode, sizeBytes) => {
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
    },
  );

  checkpointIt.each([
    ["path", ["entry.txt"]],
    ["blobId", ["44444444-4444-4444-8444-444444444444"]],
    ["contentSha256", ["a".repeat(64)]],
  ] as const)(
    "rejects an array-encoded remote projection %s before scanning",
    async (field, value) => {
      let calls = 0;
      const runtime = new CloudWorkspaceDurabilityRuntime("/unused", {
        fetch: (async () => {
          calls += 1;
          return Response.json({
            checkpointId: null,
            currentRevision: 1,
            durableRevision: 1,
            entries: [
              {
                operation: "upsert",
                path: "entry.txt",
                entryType: "file",
                mode: 33188,
                blobId: "44444444-4444-4444-8444-444444444444",
                contentSha256: "a".repeat(64),
                sizeBytes: 1,
                [field]: value,
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
    },
  );

  checkpointIt.each([
    ["blob id", "blob"],
    ["checkpoint id", "checkpoint"],
  ] as const)("rejects an array-encoded remote %s", async (_label, target) => {
    const root = await checkpointRepository();
    const blobId = "77777777-7777-4777-8777-777777777777";
    const checkpointId = "88888888-8888-4888-8888-888888888888";
    const runtime = new CloudWorkspaceDurabilityRuntime(root, {
      fetch: (async (input, init) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/content/head")) {
          return Response.json({
            checkpointId: null,
            currentRevision: 0,
            durableRevision: 0,
            entries: [],
            nextAfterPath: null,
          });
        }
        if (pathname.endsWith("/blobs")) {
          const bytes = init?.body;
          if (!(bytes instanceof Uint8Array)) {
            throw new Error("expected binary upload");
          }
          return Response.json({
            id: target === "blob" ? [blobId] : blobId,
            plaintextSha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.byteLength,
          });
        }
        if (pathname.endsWith("/content/append")) {
          return Response.json({ revision: 1 });
        }
        if (pathname.endsWith("/checkpoints/commit")) {
          return Response.json({
            checkpointId:
              target === "checkpoint" ? [checkpointId] : checkpointId,
          });
        }
        throw new Error(`unexpected durability request: ${pathname}`);
      }) as typeof fetch,
    });

    await expect(
      runtime.checkpoint(
        {
          id: "99999999-9999-4999-8999-999999999999",
          reason: "manual",
          deadlineAtMs: Date.now() + 60_000,
        },
        authority,
      ),
    ).rejects.toThrow(
      target === "blob"
        ? "cloud durability blob response is invalid"
        : "cloud checkpoint commit response is invalid",
    );
  });
});
