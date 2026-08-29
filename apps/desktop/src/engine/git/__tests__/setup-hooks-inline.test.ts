import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type {
  BoundaryProcess,
  PreparedBoundary,
  RepoTaskBoundaryFactory,
} from "../../agents/containment/types";
import { runContainedInlineScript } from "../setup-hooks";

describe("contained inline repository scripts", () => {
  it("turns output overflow into an immediate fail-closed teardown", async () => {
    const stdout = new PassThrough();
    const processHandle = {
      stdout,
      wait: () => new Promise<never>(() => {}),
      stopAndProve: async () => {
        throw new Error("child stop proof failed");
      },
    } as unknown as BoundaryProcess;
    const boundary = {
      spawn: async () => processHandle,
      stopAndProve: async () => {
        throw new Error("boundary stop proof failed");
      },
    } as unknown as PreparedBoundary;
    const boundaryFactory: RepoTaskBoundaryFactory = async () => boundary;

    const running = runContainedInlineScript(
      {
        kind: "archive",
        command: "ignored",
        workspaceId: "ws_inline1-elm",
        worktreePath: "/tmp",
        repoRoot: "/tmp",
        baseBranch: "main",
        boundaryFactory,
      },
      "/bin/sh",
      "-c",
      "ignored",
      {},
      { maxOutputBytes: 1, timeoutMs: 5_000 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdout.write("overflow");

    await expect(running).rejects.toThrow(
      /repository task containment teardown was not proven/i,
    );
  });
});
