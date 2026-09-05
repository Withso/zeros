import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseCloudWorkspaceForkState } from "../cloud-workspace-fork-state";
import { runMigrations } from "../db/migrations";

const databases: Database.Database[] = [];

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("device-private cloud workspace copy journal", () => {
  it("persists resumable progress without authentication or provider credentials", () => {
    const db = database();
    const state = new DatabaseCloudWorkspaceForkState(db);
    const ids = {
      jobId: randomUUID(),
      accountUserId: randomUUID(),
      organizationId: randomUUID(),
      sourceWorkspaceId: randomUUID(),
      targetWorkspaceId: randomUUID(),
    };
    const created = state.create({
      ...ids,
      operation: "local_to_cloud",
      sourceWorkspaceAlias: "ws_source",
      repoRoot: "/safe/repository",
      request: { version: 1, includeChats: true },
      now: 100,
    });
    expect(created).toMatchObject({
      ...ids,
      state: "prepared",
      attemptCount: 0,
    });

    state.replacePayload({
      jobId: ids.jobId,
      entries: [
        {
          ordinal: 0,
          path: "src/index.ts",
          portablePathKey: "src/index.ts",
          operation: "upsert",
          entryType: "file",
          mode: 33188,
          contentSha256: "a".repeat(64),
          sizeBytes: 4,
          stageName: "a".repeat(64),
          remoteBlobId: null,
        },
        {
          ordinal: 1,
          path: "old.ts",
          portablePathKey: "old.ts",
          operation: "delete",
          entryType: null,
          mode: null,
          contentSha256: null,
          sizeBytes: null,
          stageName: null,
          remoteBlobId: null,
        },
      ],
      records: [{ ordinal: 0, entityKind: "chat" }],
    });
    expect(state.entries(ids.jobId)).toHaveLength(2);
    expect(state.records(ids.jobId)).toEqual([
      { ordinal: 0, entityKind: "chat" },
    ]);

    const blobId = randomUUID();
    state.setRemoteBlob(ids.jobId, 0, blobId);
    expect(state.entries(ids.jobId)[0]).toMatchObject({ remoteBlobId: blobId });
    expect(
      state.transition({
        jobId: ids.jobId,
        from: ["prepared"],
        to: "uploading",
        now: 200,
        remoteForkIntentId: randomUUID(),
        sourceSnapshotSha256: "b".repeat(64),
        sourceRevision: 0,
      }),
    ).toMatchObject({ state: "uploading", attemptCount: 1 });
    expect(state.resumable(ids.accountUserId, 200)).toHaveLength(1);

    const columns = db
      .prepare("PRAGMA table_info(cloud_workspace_fork_jobs)")
      .all() as Array<{ name: string }>;
    const names = columns.map(({ name }) => name);
    for (const forbidden of [
      "access_token",
      "export_grant",
      "private_key",
      "provider_credential",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("rejects duplicate portable paths and stale transitions", () => {
    const state = new DatabaseCloudWorkspaceForkState(database());
    const jobId = randomUUID();
    const accountUserId = randomUUID();
    state.create({
      jobId,
      operation: "cloud_to_local",
      accountUserId,
      organizationId: randomUUID(),
      sourceWorkspaceId: randomUUID(),
      targetWorkspaceId: randomUUID(),
      repoRoot: "/safe/repository",
      request: { version: 1, includeChats: false },
      now: 1,
    });
    expect(() =>
      state.replacePayload({
        jobId,
        entries: [
          {
            ordinal: 0,
            path: "Readme.md",
            portablePathKey: "readme.md",
            operation: "delete",
            entryType: null,
            mode: null,
            contentSha256: null,
            sizeBytes: null,
            stageName: null,
            remoteBlobId: null,
          },
          {
            ordinal: 1,
            path: "README.md",
            portablePathKey: "readme.md",
            operation: "delete",
            entryType: null,
            mode: null,
            contentSha256: null,
            sizeBytes: null,
            stageName: null,
            remoteBlobId: null,
          },
        ],
        records: [],
      }),
    ).toThrow();
    expect(state.entries(jobId)).toEqual([]);
    expect(() =>
      state.transition({
        jobId,
        from: ["uploading"],
        to: "finalizing",
        now: 2,
      }),
    ).toThrow(/concurrently/);
  });

  it("keeps transient failures resumable but makes cancellation and permanent failures terminal", () => {
    const state = new DatabaseCloudWorkspaceForkState(database());
    const ids = {
      jobId: randomUUID(),
      accountUserId: randomUUID(),
      organizationId: randomUUID(),
      sourceWorkspaceId: randomUUID(),
      targetWorkspaceId: randomUUID(),
    };
    state.create({
      ...ids,
      operation: "local_to_cloud",
      repoRoot: "/safe/repository",
      request: { version: 1 },
      now: 10,
    });
    expect(
      state.failPermanent({
        jobId: ids.jobId,
        code: "identity_mismatch",
        message: "Account changed",
        now: 20,
      }),
    ).toMatchObject({
      state: "failed",
      lastErrorCode: "permanent.identity_mismatch",
    });
    expect(state.resumable(ids.accountUserId, Number.MAX_SAFE_INTEGER)).toEqual(
      [],
    );
    expect(state.terminalStageJobIds()).toEqual([ids.jobId]);

    const cancelledIds = {
      ...ids,
      jobId: randomUUID(),
      targetWorkspaceId: randomUUID(),
    };
    state.create({
      ...cancelledIds,
      operation: "local_to_cloud",
      repoRoot: "/safe/repository",
      request: { version: 1 },
      now: 30,
    });
    expect(
      state.cancel({
        jobId: cancelledIds.jobId,
        code: "cancelled_by_user",
        message: "Cancelled by user",
        now: 40,
      }),
    ).toMatchObject({ state: "cancelled", completedAt: 40 });
    expect(state.terminalStageJobIds()).toEqual(
      expect.arrayContaining([ids.jobId, cancelledIds.jobId]),
    );
  });
});
