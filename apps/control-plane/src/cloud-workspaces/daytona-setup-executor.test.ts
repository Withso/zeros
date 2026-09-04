import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { CloudProviderError } from "./provider.js";
import type {
  CloudWorkspaceSetupExecution,
  CloudWorkspaceSetupReadiness,
} from "./setup-worker.js";
import {
  DAYTONA_SETUP_HELPER_COMMAND,
  DaytonaCloudWorkspaceSetupExecutor,
  type CloudWorkspaceSetupAdmission,
  type CloudWorkspaceSetupAdmissionBroker,
  type DaytonaSetupCommandRunner,
} from "./daytona-setup-executor.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";

const NOW = 1_800_000_000_000;

function execution(
  overrides: Partial<CloudWorkspaceSetupExecution> = {},
): CloudWorkspaceSetupExecution {
  return {
    setupRunId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    organizationId: "33333333-3333-4333-8333-333333333333",
    authority: {
      accountUserId: "44444444-4444-4444-8444-444444444444",
    },
    generation: 3,
    attempt: 2,
    executionFence: 7,
    provider: { name: "daytona", resourceId: "sandbox-exact-id" },
    image: {
      ref: "snapshot-pinned-id",
      sourceCommit: "a".repeat(40),
    },
    repository: {
      forge: "github.com",
      owner: "withso",
      name: "zeros",
      revision: "refs/heads/main",
      githubInstallationId: randomUUID(),
    },
    settings: {
      version: 1,
      snapshot: { schemaVersion: 1, values: {} },
      sha256: "b".repeat(64),
    },
    ...overrides,
  };
}

function readiness(
  input: CloudWorkspaceSetupExecution,
): CloudWorkspaceSetupReadiness {
  return {
    version: 1,
    setupRunId: input.setupRunId,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: input.generation,
    executionFence: input.executionFence,
    image: {
      ref: input.image.ref,
      sourceCommit: input.image.sourceCommit!,
    },
    repository: {
      revision: input.repository.revision,
      commit: "c".repeat(40),
    },
    settings: {
      version: input.settings.version,
      sha256: input.settings.sha256,
    },
    engine: {
      instanceId: "55555555-5555-4555-8555-555555555555",
      protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      health: "ready",
      durableRecordConnected: true,
    },
  };
}

function admission(
  input: CloudWorkspaceSetupExecution,
  overrides: Partial<CloudWorkspaceSetupAdmission> = {},
): CloudWorkspaceSetupAdmission {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    token: `zws_${"A".repeat(43)}`,
    endpoint: "https://control.example.test/v1/internal/cloud-workspaces/setup",
    expiresAt: new Date(NOW + 60_000),
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    generation: input.generation,
    setupRunId: input.setupRunId,
    executionFence: input.executionFence,
    ...overrides,
  };
}

function harness(input = execution()) {
  const grant = admission(input);
  const broker: CloudWorkspaceSetupAdmissionBroker = {
    issue: vi.fn(async () => grant),
    revoke: vi.fn(async () => undefined),
  };
  const runner: DaytonaSetupCommandRunner = {
    execute: vi.fn(async () => ({
      exitCode: 0,
      output: JSON.stringify({
        audience: "zeros-cloud-workspace-setup-result-v1",
        outcome: "ready",
        readiness: readiness(input),
        logExcerpt: "setup complete",
        version: 1,
      }),
      outputTruncated: false,
    })),
  };
  const executor = new DaytonaCloudWorkspaceSetupExecutor({
    admissionBroker: broker,
    commandRunner: runner,
    engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
    timeoutSeconds: 300,
    now: () => NOW,
  });
  return { broker, executor, grant, input, runner };
}

describe("DaytonaCloudWorkspaceSetupExecutor", () => {
  it("serializes image setup so a reclaimed remote command cannot overlap its successor", () => {
    expect(DAYTONA_SETUP_HELPER_COMMAND).toBe(
      "/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /usr/local/bin/node /usr/local/lib/zeros/setup-cloud-workspace.mjs",
    );
  });

  it("invokes only the fixed image helper with a compact, fence-bound admission", async () => {
    const target = execution({
      settings: {
        version: 1,
        snapshot: {
          schemaVersion: 1,
          values: { largeValue: "x".repeat(100_000) },
        },
        sha256: "b".repeat(64),
      },
    });
    const { broker, executor, grant, runner } = harness(target);

    await expect(
      executor.execute(target, new AbortController().signal),
    ).resolves.toEqual({
      readiness: readiness(target),
      logExcerpt: "setup complete",
      logTruncated: false,
    });

    expect(broker.issue).toHaveBeenCalledWith(target, expect.any(AbortSignal));
    expect(runner.execute).toHaveBeenCalledTimes(1);
    const command = vi.mocked(runner.execute).mock.calls[0]![0];
    expect(command).toMatchObject({
      resourceId: target.provider.resourceId,
      command: DAYTONA_SETUP_HELPER_COMMAND,
      cwd: "/",
      timeoutSeconds: 300,
    });
    expect(Object.keys(command.env ?? {})).toEqual([
      "ZEROS_CLOUD_WORKSPACE_SETUP_B64",
    ]);
    expect(command.command).not.toContain(target.repository.owner);
    expect(command.command).not.toContain(grant.token);

    const encoded = command.env?.ZEROS_CLOUD_WORKSPACE_SETUP_B64 ?? "";
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(8 * 1024);
    const request = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      audience: "zeros-cloud-workspace-setup-v1",
      version: 1,
      admission: {
        endpoint: grant.endpoint,
        expiresAtMs: grant.expiresAt.getTime(),
        token: grant.token,
      },
      execution: {
        executionFence: target.executionFence,
        generation: target.generation,
        organizationId: target.organizationId,
        setupRunId: target.setupRunId,
        workspaceId: target.workspaceId,
      },
      expected: {
        imageRef: target.image.ref,
        imageSourceCommit: target.image.sourceCommit,
        repositoryRevision: target.repository.revision,
        settingsSha256: target.settings.sha256,
        settingsVersion: target.settings.version,
      },
    });
    expect(JSON.stringify(request)).not.toContain("largeValue");
    expect(JSON.stringify(request)).not.toContain(
      target.repository.githubInstallationId,
    );
    expect(broker.revoke).toHaveBeenCalledWith(grant, "completed");
  });

  it("does no broker or provider I/O when already aborted", async () => {
    const { broker, executor, input, runner } = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute(input, controller.signal),
    ).rejects.toMatchObject({
      code: "setup_execution_aborted",
      retryable: true,
    });
    expect(broker.issue).not.toHaveBeenCalled();
    expect(broker.revoke).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("rejects unsupported or unpinned execution before issuing a grant", async () => {
    for (const input of [
      execution({ provider: { name: "other", resourceId: "sandbox" } }),
      execution({ image: { ref: "snapshot", sourceCommit: null } }),
      execution({
        repository: {
          forge: "other.example",
          owner: "withso",
          name: "zeros",
          revision: "main",
          githubInstallationId: null,
        },
      }),
    ]) {
      const { broker, executor, runner } = harness(input);
      await expect(
        executor.execute(input, new AbortController().signal),
      ).rejects.toMatchObject({ retryable: false });
      expect(broker.issue).not.toHaveBeenCalled();
      expect(runner.execute).not.toHaveBeenCalled();
    }
  });

  it("revokes and rejects an expired or incorrectly fenced admission", async () => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(broker.issue).mockResolvedValue({
      ...grant,
      executionFence: input.executionFence + 1,
      expiresAt: new Date(NOW - 1),
    });

    await expect(
      executor.execute(input, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "setup_admission_invalid",
      retryable: false,
    });
    expect(runner.execute).not.toHaveBeenCalled();
    expect(broker.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ executionFence: input.executionFence + 1 }),
      "rejected",
    );
  });

  it("rejects a stale readiness attestation instead of publishing it", async () => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(runner.execute).mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify({
        audience: "zeros-cloud-workspace-setup-result-v1",
        outcome: "ready",
        readiness: {
          ...readiness(input),
          executionFence: input.executionFence - 1,
        },
        version: 1,
      }),
      outputTruncated: false,
    });

    await expect(
      executor.execute(input, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "setup_readiness_invalid",
      retryable: false,
    });
    expect(broker.revoke).toHaveBeenCalledWith(grant, "failed");
  });

  it("maps allowlisted helper failures without trusting arbitrary retryability", async () => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(runner.execute).mockResolvedValue({
      exitCode: 75,
      output: JSON.stringify({
        audience: "zeros-cloud-workspace-setup-result-v1",
        code: "repository_temporarily_unavailable",
        outcome: "error",
        version: 1,
      }),
      outputTruncated: false,
    });

    await expect(
      executor.execute(input, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "setup_repository_unavailable",
      retryable: true,
    });
    expect(broker.revoke).toHaveBeenCalledWith(grant, "failed");
  });

  it("normalizes provider failures and never returns their raw message", async () => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(runner.execute).mockRejectedValue(
      new CloudProviderError(
        "provider_command_response_timeout",
        "secret-bearing provider body",
        true,
      ),
    );

    const error = await executor
      .execute(input, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "setup_provider_command_response_timeout",
      retryable: true,
    });
    expect(String(error)).not.toContain("secret-bearing");
    expect(broker.revoke).toHaveBeenCalledWith(grant, "failed");
  });

  it("fails closed if the helper echoes its one-time secret", async () => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(runner.execute).mockResolvedValue({
      exitCode: 1,
      output: `unexpected ${grant.token}`,
      outputTruncated: false,
    });

    await expect(
      executor.execute(input, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "setup_helper_secret_echo",
      retryable: false,
    });
    expect(broker.revoke).toHaveBeenCalledWith(grant, "failed");
  });

  it("does not publish success when final admission revocation fails", async () => {
    const { broker, executor, input } = harness();
    vi.mocked(broker.revoke).mockRejectedValue(
      new Error("secret-bearing database error"),
    );

    const error = await executor
      .execute(input, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "setup_admission_revoke_failed",
      retryable: true,
    });
    expect(String(error)).not.toContain("secret-bearing");
  });
});
