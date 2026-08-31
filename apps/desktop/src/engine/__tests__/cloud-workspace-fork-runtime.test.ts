import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CloudReplicaClientError,
  type CloudWorkspaceDesktopApi,
} from "../cloud-replica-client";
import { CloudWorkspaceForkRuntime } from "../cloud-workspace-fork-runtime";
import { closeZerosDb, openZerosDb } from "../db";
import { upsertRepoByRoot } from "../db/projects";
import { getWorkspaceByCanonicalId } from "../git/state";
import { createWorkspace, getWorkspace, setStateRootForTesting } from "../git";

const execFileAsync = promisify(execFile);
let workdir: string;
let repoRoot: string;
let baseCommit: string;

async function initRepo(): Promise<void> {
  repoRoot = path.join(workdir, "repo");
  const remote = path.join(workdir, "remote.git");
  await mkdir(repoRoot);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: repoRoot,
  });
  await writeFile(path.join(repoRoot, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: repoRoot });
  await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["remote", "set-head", "origin", "main"], {
    cwd: repoRoot,
  });
  baseCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
  ).stdout.trim();
  upsertRepoByRoot({ repoRoot, originUrl: remote });
}

function api(
  value: Partial<CloudWorkspaceDesktopApi>,
): CloudWorkspaceDesktopApi {
  return value as CloudWorkspaceDesktopApi;
}

beforeEach(async () => {
  workdir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "zeros-fork-runtime-")),
  );
  setStateRootForTesting(path.join(workdir, "state"));
  openZerosDb();
  await initRepo();
});

afterEach(async () => {
  closeZerosDb();
  setStateRootForTesting(null);
  await rm(workdir, { recursive: true, force: true });
});

describe("local and cloud workspace copy runtime", () => {
  it("copies a stable local overlay to a new cloud identity without removing the source", async () => {
    const sourceCreated = await createWorkspace({
      repoRoot,
      runRepoScripts: false,
    });
    const source = getWorkspace(sourceCreated.workspaceId);
    await writeFile(
      path.join(source.path, "cloud-only.txt"),
      "local overlay\n",
    );
    const organizationId = randomUUID();
    const lifecycleIntentId = randomUUID();
    const forkIntentId = randomUUID();
    const checkpointId = randomUUID();
    const uploaded = new Map<string, Uint8Array>();
    const stagedEntries: unknown[] = [];
    let targetWorkspaceId = "";
    const remote = api({
      createCloudFromLocal: vi.fn(async (input) => {
        targetWorkspaceId = input.targetWorkspaceId;
        expect(input.sourceWorkspaceId).toBe(source.canonicalId);
        expect(input.sourceWorkspaceId).not.toBe(input.targetWorkspaceId);
        expect(input.repository.revision).toBe(baseCommit);
        // The exported copy must stay pinned to its staged snapshot even when
        // the live source changes while the remote workspace is being made.
        await writeFile(
          path.join(source.path, "cloud-only.txt"),
          "changed later\n",
        );
        return {
          workspaceId: input.targetWorkspaceId,
          lifecycleIntentId,
          forkIntentId,
          replayed: false,
        };
      }),
      uploadForkBlob: vi.fn(async ({ bytes }) => {
        const id = randomUUID();
        const copy = new Uint8Array(bytes);
        uploaded.set(id, copy);
        return {
          id,
          plaintextSha256: createHash("sha256").update(copy).digest("hex"),
          plaintextBytes: copy.byteLength,
          reused: false,
        };
      }),
      stageForkEntries: vi.fn(async ({ entries }) => {
        stagedEntries.push(...entries);
        return { accepted: entries.length };
      }),
      stageForkRecords: vi.fn(async ({ records }) => ({
        accepted: records.length,
      })),
      finalizeForkImport: vi.fn(async () => ({
        checkpointId,
        replayed: false,
      })),
    });
    const accountUserId = randomUUID();
    const stableRuntime = new CloudWorkspaceForkRuntime(openZerosDb(), {
      context: () => ({ accountUserId, api: remote }),
      schedulerIntervalMs: 300_000,
    });
    const result = await stableRuntime.copyLocalToCloud({
      sourceWorkspaceAlias: source.id,
      organizationId,
      repository: {
        forge: "github.com",
        owner: "acme",
        name: "example",
        revision: "main",
        githubInstallationId: randomUUID(),
      },
      includeChats: false,
      includeSettings: true,
    });
    expect(result).toMatchObject({
      state: "succeeded",
      sourceWorkspaceId: source.canonicalId,
      targetWorkspaceId,
      checkpointId,
    });
    expect(targetWorkspaceId).not.toBe(source.canonicalId);
    expect(existsSync(source.path)).toBe(true);
    expect(stagedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "upsert",
          path: "cloud-only.txt",
        }),
      ]),
    );
    expect(uploaded.size).toBeGreaterThan(0);
    expect(
      [...uploaded.values()].some((value) =>
        Buffer.from(value).equals(Buffer.from("local overlay\n")),
      ),
    ).toBe(true);
    await stableRuntime.dispose();
  });

  it("rejects a cloud transcript page that skips a durable revision", async () => {
    const organizationId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const forkIntentId = randomUUID();
    const checkpointRequestId = randomUUID();
    const checkpointId = randomUUID();
    let targetLocalWorkspaceId = "";
    const occurredAt = new Date().toISOString();
    const remote = api({
      requestCloudToLocal: vi.fn(async (input) => {
        targetLocalWorkspaceId = input.targetLocalWorkspaceId;
        return { forkIntentId, checkpointRequestId, replayed: false };
      }),
      issueExportGrant: vi.fn(async () => ({
        grantToken: `zwe_${Buffer.alloc(32, 4).toString("base64url")}`,
        deviceId: randomUUID(),
        deviceKeyVersion: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      readForkManifest: vi.fn(async () => ({
        sourceCloudWorkspaceId: sourceWorkspaceId,
        targetLocalWorkspaceId,
        checkpointId,
        contentRevision: 0,
        recordRevision: 3,
        includeChats: true,
        fileCount: 0,
        totalBytes: 0,
        gitBaseCommit: baseCommit,
        gitHeadRef: "refs/heads/main",
        repository: {
          forge: "github.com" as const,
          owner: "acme",
          name: "example",
          revision: "main",
        },
        entries: [],
        nextAfterPath: null,
      })),
      readForkRecords: vi.fn(async () => ({
        recordRevision: 3,
        events: [1, 3].map((revision) => ({
          revision,
          entityKind: "metadata" as const,
          entityId: `event-${revision}`,
          operation: "upsert" as const,
          schemaVersion: 1,
          document: { revision },
          occurredAt,
        })),
        hasMore: false,
      })),
    });
    const accountUserId = randomUUID();
    const runtime = new CloudWorkspaceForkRuntime(openZerosDb(), {
      context: () => ({ accountUserId, api: remote }),
      validateRepository: async () => undefined,
      schedulerIntervalMs: 300_000,
    });

    await expect(
      runtime.copyCloudToLocal({
        organizationId,
        sourceWorkspaceId,
        repoRoot,
        includeChats: true,
      }),
    ).rejects.toThrow("Cloud export record stream is discontinuous");
    await runtime.dispose();
  });

  it("waits for a durable export, then creates an exact-base local copy and keeps cloud intact", async () => {
    const organizationId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const forkIntentId = randomUUID();
    const checkpointRequestId = randomUUID();
    const checkpointId = randomUUID();
    const blobId = randomUUID();
    const bytes = Buffer.from("from cloud\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let grantAttempts = 0;
    const remote = api({
      requestCloudToLocal: vi.fn(async () => ({
        forkIntentId,
        checkpointRequestId,
        replayed: false,
      })),
      issueExportGrant: vi.fn(async () => {
        grantAttempts += 1;
        if (grantAttempts === 1) {
          throw new CloudReplicaClientError(
            409,
            "workspace_fork_export_unavailable",
            "not ready",
          );
        }
        return {
          grantToken: `zwe_${Buffer.alloc(32, 3).toString("base64url")}`,
          deviceId: randomUUID(),
          deviceKeyVersion: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }),
      readForkManifest: vi.fn(async ({ workspaceId }) => ({
        sourceCloudWorkspaceId: workspaceId,
        targetLocalWorkspaceId: "filled-by-wrapper",
        checkpointId,
        contentRevision: 1,
        recordRevision: 0,
        includeChats: false,
        fileCount: 1,
        totalBytes: bytes.byteLength,
        gitBaseCommit: baseCommit,
        gitHeadRef: "refs/heads/main",
        repository: {
          forge: "github.com" as const,
          owner: "acme",
          name: "example",
          revision: "main",
        },
        entries: [
          {
            operation: "upsert" as const,
            path: "README.md",
            entryType: "file" as const,
            mode: 33188 as const,
            blobId,
            contentSha256: sha256,
            sizeBytes: bytes.byteLength,
          },
        ],
        nextAfterPath: null,
      })),
      readForkBlob: vi.fn(async () => new Uint8Array(bytes)),
    });
    const accountUserId = randomUUID();
    const wrapped = new Proxy(remote, {
      get(target, property, receiver) {
        if (property !== "readForkManifest")
          return Reflect.get(target, property, receiver);
        return async (
          input: Parameters<CloudWorkspaceDesktopApi["readForkManifest"]>[0],
        ) => {
          const value = await remote.readForkManifest(input);
          return { ...value, targetLocalWorkspaceId: targetId };
        };
      },
    });
    let targetId = "";
    const runtime = new CloudWorkspaceForkRuntime(openZerosDb(), {
      context: () => ({ accountUserId, api: wrapped }),
      validateRepository: async () => undefined,
      schedulerIntervalMs: 300_000,
    });
    const waiting = await runtime.copyCloudToLocal({
      organizationId,
      sourceWorkspaceId,
      repoRoot,
      includeChats: false,
    });
    expect(waiting.state).toBe("waiting_export");
    targetId = waiting.targetWorkspaceId;
    const completed = await runtime.run(waiting.jobId);
    expect(completed.state).toBe("succeeded");
    expect(completed.sourceWorkspaceId).toBe(sourceWorkspaceId);
    expect(completed.targetWorkspaceId).not.toBe(sourceWorkspaceId);
    const local = getWorkspaceByCanonicalId(completed.targetWorkspaceId);
    expect(local).not.toBeNull();
    expect(local!.placement).toBe("local");
    expect(local!.baseBranch).toBe(baseCommit);
    expect(await readFile(path.join(local!.path, "README.md"), "utf8")).toBe(
      "from cloud\n",
    );
    expect(getWorkspaceByCanonicalId(sourceWorkspaceId)).toBeNull();
    await runtime.dispose();
  });
});
