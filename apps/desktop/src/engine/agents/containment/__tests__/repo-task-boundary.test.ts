import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testExecutionBoundary } from "../../__tests__/helpers/test-execution-boundary";
import { createRepoTaskBoundaryFactory } from "../repo-task-boundary";
import type { BoundaryRequest } from "../types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("repository task boundary factory", () => {
  it("does not provision service or container authority for a PATH-only shell probe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-repo-boundary-"));
    temporaryDirectories.push(root);
    const requests: BoundaryRequest[] = [];
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: (candidate) => {
          requests.push(candidate);
        },
      }),
    );

    const prepared = await factory({
      executionId: "path-only-probe",
      cwd: root,
      workspaceRoot: root,
      repoRoot: root,
      env: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DOCKER_HOST: "unix:///ambient/docker.sock",
      },
      serviceCapabilities: "none",
    });
    await prepared.stopAndProve();

    const request = requests.at(-1);
    expect(request).toBeDefined();
    expect(request?.containerWorker).toBeUndefined();
    expect(request?.containerWorkflowExpected).toBeUndefined();
    expect(request?.localServices).toBeUndefined();
  });

  it("does not hide a failed proof while unwinding service admission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-repo-boundary-"));
    temporaryDirectories.push(root);
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        localServiceError: new Error("service admission failed"),
        stopError: new Error("repository boundary teardown proof failed"),
      }),
    );

    await expect(
      factory({
        executionId: "repo-task-cleanup-failure",
        cwd: root,
        workspaceRoot: root,
        repoRoot: root,
        env: { DATABASE_URL: "postgres://127.0.0.1:5432/zeros" },
      }),
    ).rejects.toThrow(/teardown could not be proven/);
  });
});
