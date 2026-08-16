import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import type { BoundaryRequest } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AgentGateway provider command probes", () => {
  it("runs provider-owned probe bytes under a fresh agent-code boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-probe-root-"));
    temporaryDirectories.push(root);
    const requests: BoundaryRequest[] = [];
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const internal = gateway as unknown as {
      runProviderProbeCommand(
        providerId: string,
        binary: string,
        args: string[],
        options: { timeoutMs: number },
      ): Promise<{ exitCode: number | null; stdout: string }>;
    };

    const result = await internal.runProviderProbeCommand(
      "codex",
      process.execPath,
      ["-e", "process.stdout.write('probe 1.2.3\\n')"],
      { timeoutMs: 2_000 },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "probe 1.2.3\n" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actor: "agent-code",
      providerId: "codex",
      backendHint: "zeros-srt",
    });
    expect(requests[0]?.executionId).toMatch(/^probe-codex-/);
    expect(requests[0]?.territory).toBeUndefined();
    expect(requests[0]?.cwd).not.toBe(root);

    await gateway.dispose();
  });

  it("projects a custom provider executable before running its probe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-probe-custom-"));
    temporaryDirectories.push(root);
    const binaryRoot = path.join(root, "toolchain", "bin");
    const binary = path.join(binaryRoot, "custom-codex");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(binaryRoot, { recursive: true }),
    );
    await writeFile(
      binary,
      "#!/bin/sh\nprintf 'custom 9.8.7\\n'\n",
      "utf8",
    );
    await chmod(binary, 0o755);

    const requests: BoundaryRequest[] = [];
    const gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const internal = gateway as unknown as {
      runProviderProbeCommand(
        providerId: string,
        binary: string,
        args: string[],
        options: { timeoutMs: number },
      ): Promise<{ exitCode: number | null; stdout: string }>;
    };

    await expect(
      internal.runProviderProbeCommand("codex", binary, ["--version"], {
        timeoutMs: 2_000,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "custom 9.8.7\n" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.additionalReadOnlyRoots).toContain(binaryRoot);

    await gateway.dispose();
  });
});
