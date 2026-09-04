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
import {
  CloudWorkspaceForkRuntime,
  isPermanentCloudWorkspaceForkFailure,
} from "../cloud-workspace-fork-runtime";
import {
  cloudWorkspaceForkStageRoot,
  stageCloudWorkspaceForkBlob,
} from "../cloud-workspace-fork-stage";
import { DatabaseCloudWorkspaceForkState } from "../cloud-workspace-fork-state";
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
  process.env.ZEROS_DATA_DIR = path.join(workdir, "data");
  openZerosDb();
  await initRepo();
});

afterEach(async () => {
  closeZerosDb();
  setStateRootForTesting(null);
  delete process.env.ZEROS_DATA_DIR;
  await rm(workdir, { recursive: true, force: true });
});

describe("local and cloud workspace copy runtime", () => {
  it("startup GC removes terminal, expired, and orphaned plaintext stages while retaining resumable work", async () => {
    const db = openZerosDb();
    const state = new DatabaseCloudWorkspaceForkState(db);
    const accountUserId = randomUUID();
    const createJob = (jobId: string) =>
      state.create({
        jobId,
        operation: "cloud_to_local",
        accountUserId,
        organizationId: randomUUID(),
        sourceWorkspaceId: randomUUID(),
        targetWorkspaceId: randomUUID(),
        repoRoot,
        request: { version: 1, kind: "cloud_to_local", includeChats: false },
        now: Date.now(),
      });
    const resumable = createJob(randomUUID());
    const terminal = createJob(randomUUID());
    const expired = createJob(randomUUID());
    state.cancel({
      jobId: terminal.jobId,
      code: "cancelled_by_user",
      message: "Cancelled",
      now: Date.now(),
    });
    state.failPermanent({
      jobId: expired.jobId,
      code: "export_expired",
      message: "Export expired",
      now: Date.now(),
    });
    const orphan = randomUUID();
    const bytes = Buffer.from("plaintext stage\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await Promise.all(
      [resumable.jobId, terminal.jobId, expired.jobId, orphan].map((jobId) =>
        stageCloudWorkspaceForkBlob({ jobId, sha256, bytes }),
      ),
    );
    const runtime = new CloudWorkspaceForkRuntime(db, {
      context: () => ({ accountUserId, api: api({}) }),
      schedulerIntervalMs: 300_000,
    });

    await vi.waitFor(async () => {
      await expect(
        cloudWorkspaceForkStageRoot(terminal.jobId),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        cloudWorkspaceForkStageRoot(expired.jobId),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(cloudWorkspaceForkStageRoot(orphan)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    await expect(
      cloudWorkspaceForkStageRoot(resumable.jobId),
    ).resolves.toBeTruthy();
    await runtime.dispose();
  });

  it("classifies permanent remote failures and removes their plaintext stage", async () => {
    const sourceCreated = await createWorkspace({
      repoRoot,
      runRepoScripts: false,
    });
    const source = getWorkspace(sourceCreated.workspaceId);
    await writeFile(
      path.join(source.path, "overlay.txt"),
      "sensitive overlay\n",
    );
    const accountUserId = randomUUID();
    const runtime = new CloudWorkspaceForkRuntime(openZerosDb(), {
      context: () => ({
        accountUserId,
        api: api({
          createCloudFromLocal: async () => {
            throw new CloudReplicaClientError(403, "forbidden", "revoked");
          },
        }),
      }),
      schedulerIntervalMs: 300_000,
    });

    expect(
      isPermanentCloudWorkspaceForkFailure(
        new CloudReplicaClientError(403, "forbidden", "revoked"),
      ),
    ).toBe(true);
    await expect(
      runtime.copyLocalToCloud({
        sourceWorkspaceAlias: source.id,
        organizationId: randomUUID(),
        repository: {
          forge: "github.com",
          owner: "acme",
          name: "example",
          revision: "main",
          githubInstallationId: randomUUID(),
        },
        includeChats: false,
      }),
    ).rejects.toMatchObject({ code: "permanent.forbidden" });
    const [job] = runtime.list();
    expect(job).toMatchObject({
      state: "failed",
      lastErrorCode: "permanent.forbidden",
    });
    await expect(cloudWorkspaceForkStageRoot(job!.jobId)).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    await runtime.dispose();
  });

  it("cancels active copy work and cleans its staged plaintext", async () => {
    const sourceCreated = await createWorkspace({
      repoRoot,
      runRepoScripts: false,
    });
    const source = getWorkspace(sourceCreated.workspaceId);
    await writeFile(path.join(source.path, "overlay.txt"), "cancel me\n");
    const accountUserId = randomUUID();
    let release!: () => void;
    let started!: () => void;
    const startedRemote = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = new CloudWorkspaceForkRuntime(openZerosDb(), {
      context: () => ({
        accountUserId,
        api: api({
          createCloudFromLocal: async () => {
            started();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return {
              workspaceId: randomUUID(),
              lifecycleIntentId: randomUUID(),
              forkIntentId: randomUUID(),
              replayed: false,
            };
          },
        }),
      }),
      schedulerIntervalMs: 300_000,
    });
    const running = runtime.copyLocalToCloud({
      sourceWorkspaceAlias: source.id,
      organizationId: randomUUID(),
      repository: {
        forge: "github.com",
        owner: "acme",
        name: "example",
        revision: "main",
        githubInstallationId: randomUUID(),
      },
      includeChats: false,
    });
    await startedRemote;
    const [job] = runtime.list();
    const cancelling = runtime.cancel(job!.jobId);
    release();
    const cancelled = await cancelling;

    await expect(running).resolves.toMatchObject({ state: "cancelled" });
    expect(cancelled).toMatchObject({ state: "cancelled" });
    await expect(cloudWorkspaceForkStageRoot(job!.jobId)).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    await runtime.dispose();
  });

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

  it.each([
    {
      name: "path",
      expected: {
        entries: [
          {
            path: "README.md",
            entryType: "file" as const,
            mode: 33188 as const,
          },
        ],
        deletions: [],
      },
      received: [
        {
          operation: "upsert" as const,
          path: "renamed.md",
          entryType: "file" as const,
          mode: 33188 as const,
        },
      ],
    },
    {
      name: "mode",
      expected: {
        entries: [
          {
            path: "README.md",
            entryType: "file" as const,
            mode: 33188 as const,
          },
        ],
        deletions: [],
      },
      received: [
        {
          operation: "upsert" as const,
          path: "README.md",
          entryType: "file" as const,
          mode: 33261 as const,
        },
      ],
    },
    {
      name: "deletion",
      expected: { entries: [], deletions: ["removed.txt"] },
      received: [{ operation: "delete" as const, path: "other-removed.txt" }],
    },
  ])(
    "does not publish a cloud export with a tampered $name descriptor even when blob hashes and totals match",
    async ({ expected, received }) => {
      const organizationId = randomUUID();
      const sourceWorkspaceId = randomUUID();
      const forkIntentId = randomUUID();
      const checkpointRequestId = randomUUID();
      const checkpointId = randomUUID();
      const checkpointManifestBlobId = randomUUID();
      const exportManifestBlobId = randomUUID();
      const bytes = Buffer.from("same bytes\n");
      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      const expectedEntries = expected.entries.map((entry) => ({
        ...entry,
        contentSha256,
        sizeBytes: bytes.byteLength,
      }));
      const checkpointManifest = Buffer.from(
        JSON.stringify({
          version: 1,
          audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
          gitBaseCommit: baseCommit,
          gitHeadRef: "refs/heads/main",
          entries: expectedEntries,
          deletions: expected.deletions,
        }),
        "utf8",
      );
      let targetLocalWorkspaceId = "";
      const exportDescriptor = {
        audience: "zeros-cloud-to-local-fork-v1",
        checkpointId,
        contentRevision: 1,
        fileCount: expectedEntries.length,
        forkIntentId,
        includeChats: false,
        recordRevision: 0,
        sourceCloudWorkspaceId: sourceWorkspaceId,
        targetLocalWorkspaceId: "filled-by-request",
        totalBytes: expectedEntries.reduce(
          (sum, entry) => sum + entry.sizeBytes,
          0,
        ),
      };
      let descriptorBytes = Buffer.alloc(0);
      const createLocal = vi.fn();
      const remote = api({
        requestCloudToLocal: vi.fn(async (input) => {
          targetLocalWorkspaceId = input.targetLocalWorkspaceId;
          descriptorBytes = Buffer.from(
            JSON.stringify({
              ...exportDescriptor,
              targetLocalWorkspaceId,
            }),
            "utf8",
          );
          return { forkIntentId, checkpointRequestId, replayed: false };
        }),
        issueExportGrant: vi.fn(async () => ({
          grantToken: `zwe_${Buffer.alloc(32, 6).toString("base64url")}`,
          deviceId: randomUUID(),
          deviceKeyVersion: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })),
        readForkManifest: vi.fn(async () => ({
          sourceCloudWorkspaceId: sourceWorkspaceId,
          targetLocalWorkspaceId,
          checkpointId,
          exportManifestBlobId,
          exportManifestSha256: createHash("sha256")
            .update(descriptorBytes)
            .digest("hex"),
          manifestBlobId: checkpointManifestBlobId,
          integritySha256: createHash("sha256")
            .update(checkpointManifest)
            .digest("hex"),
          contentRevision: 1,
          recordRevision: 0,
          includeChats: false,
          fileCount: expectedEntries.length,
          totalBytes: expectedEntries.reduce(
            (sum, entry) => sum + entry.sizeBytes,
            0,
          ),
          gitBaseCommit: baseCommit,
          gitHeadRef: "refs/heads/main",
          repository: {
            forge: "github.com" as const,
            owner: "acme",
            name: "example",
            revision: "main",
          },
          entries: received.map((entry) =>
            entry.operation === "delete"
              ? entry
              : {
                  ...entry,
                  blobId: randomUUID(),
                  contentSha256,
                  sizeBytes: bytes.byteLength,
                },
          ),
          nextAfterPath: null,
        })),
        readForkBlob: vi.fn(async ({ blobId }) => {
          if (blobId === exportManifestBlobId)
            return new Uint8Array(descriptorBytes);
          if (blobId === checkpointManifestBlobId)
            return new Uint8Array(checkpointManifest);
          return new Uint8Array(bytes);
        }),
      });
      const accountUserId = randomUUID();
      const runtime = new CloudWorkspaceForkRuntime(openZerosDb(), {
        context: () => ({ accountUserId, api: remote }),
        validateRepository: async () => undefined,
        createWorkspace: createLocal as never,
        schedulerIntervalMs: 300_000,
      });

      await expect(
        runtime.copyCloudToLocal({
          organizationId,
          sourceWorkspaceId,
          repoRoot,
          includeChats: false,
        }),
      ).rejects.toThrow("Cloud checkpoint manifest");
      expect(createLocal).not.toHaveBeenCalled();
      const [job] = runtime.list();
      expect(job).toMatchObject({
        state: "failed",
        lastErrorCode: "permanent.remote_protocol_error",
      });
      await runtime.dispose();
    },
  );

  it("rejects an advertised canonical export manifest that does not bind this fork", async () => {
    const organizationId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const forkIntentId = randomUUID();
    const checkpointRequestId = randomUUID();
    const checkpointId = randomUUID();
    const exportManifestBlobId = randomUUID();
    let targetLocalWorkspaceId = "";
    let descriptorBytes = Buffer.alloc(0);
    const createLocal = vi.fn();
    const remote = api({
      requestCloudToLocal: vi.fn(async (input) => {
        targetLocalWorkspaceId = input.targetLocalWorkspaceId;
        descriptorBytes = Buffer.from(
          JSON.stringify({
            audience: "zeros-cloud-to-local-fork-v1",
            checkpointId,
            contentRevision: 0,
            fileCount: 0,
            forkIntentId,
            includeChats: false,
            recordRevision: 0,
            sourceCloudWorkspaceId: sourceWorkspaceId,
            targetLocalWorkspaceId: randomUUID(),
            totalBytes: 0,
          }),
          "utf8",
        );
        return { forkIntentId, checkpointRequestId, replayed: false };
      }),
      issueExportGrant: vi.fn(async () => ({
        grantToken: `zwe_${Buffer.alloc(32, 7).toString("base64url")}`,
        deviceId: randomUUID(),
        deviceKeyVersion: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
      readForkManifest: vi.fn(async () => {
        return {
          sourceCloudWorkspaceId: sourceWorkspaceId,
          targetLocalWorkspaceId,
          checkpointId,
          exportManifestBlobId,
          exportManifestSha256: createHash("sha256")
            .update(descriptorBytes)
            .digest("hex"),
          contentRevision: 0,
          recordRevision: 0,
          includeChats: false,
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
        };
      }),
      readForkBlob: vi.fn(async () => new Uint8Array(descriptorBytes)),
    });
    const accountUserId = randomUUID();
    const runtime = new CloudWorkspaceForkRuntime(openZerosDb(), {
      context: () => ({ accountUserId, api: remote }),
      validateRepository: async () => undefined,
      createWorkspace: createLocal as never,
      schedulerIntervalMs: 300_000,
    });

    await expect(
      runtime.copyCloudToLocal({
        organizationId,
        sourceWorkspaceId,
        repoRoot,
        includeChats: false,
      }),
    ).rejects.toThrow("canonical export manifest");
    expect(createLocal).not.toHaveBeenCalled();
    await runtime.dispose();
  });
});
