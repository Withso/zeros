import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testExecutionBoundary } from "../../__tests__/helpers/test-execution-boundary";
import { createRepoTaskBoundaryFactory } from "../repo-task-boundary";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("repository task boundary factory", () => {
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
