import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { CloudProviderError, type CloudWorkspaceCommandRunner } from "./provider.js";
import type {
  CloudWorkspaceSetupExecution,
  CloudWorkspaceSetupReadiness,
} from "./setup-worker.js";
import {
  CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND,
  CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND,
  CloudWorkspaceLinuxSetupExecutor,
  type CloudWorkspaceSetupAdmission,
  type CloudWorkspaceSetupAdmissionBroker,
} from "./linux-setup-executor.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { runtimeBase } from "./runtime-test-fixtures.js";

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
    provider: { name: "boat", resourceId: "sandbox-exact-id" },
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
  const runner: CloudWorkspaceCommandRunner = {
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
  const executor = new CloudWorkspaceLinuxSetupExecutor({
    admissionBroker: broker,
    runtimeArtifacts: null,
    commandRunner: runner,
    engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
    timeoutSeconds: 300,
    now: () => NOW,
  });
  return { broker, executor, grant, input, runner };
}

describe("CloudWorkspaceLinuxSetupExecutor", () => {
  const v4 = () => {
    const pin = { runtimeId: `r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64), baseImageId: runtimeBase.id,
      baseCompatibilityId: runtimeBase.compatibilityId, profile: "zeros-cloud-worker-v4" as const,
      engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION };
    const descriptor = { runtimeId: pin.runtimeId, manifestSha256: pin.manifestSha256, archiveSha256: "b".repeat(64),
      archiveBytes: 100, expandedBytes: 200, sourceCommit: "c".repeat(40), nodeModulesAbi: 127,
      bootstrapProtocolVersion: 1 as const, engineProtocolVersion: pin.engineProtocolVersion };
    const artifactUrl = "https://artifacts.example.test/runtime?signature=private-runtime-delivery";
    const input = execution({ provider: { name: "boat", resourceId: "sandbox-exact-id" }, runtime: pin });
    const f = harness(input);
    f.grant.expiresAt = new Date(NOW + 900_000);
    const artifact = { url: artifactUrl, expiresAt: new Date(NOW + 900_000).toISOString() };
    const objectKey = `runtime/v1/${pin.runtimeId}/${descriptor.archiveSha256}.tar.gz`;
    const resolveRuntimeArtifact = vi.fn(async () => ({ descriptor, objectKey }));
    const runtimeArtifacts = { presignGet: vi.fn(async () => artifact),
      presignCreatePut: vi.fn(), head: vi.fn() };
    const installerDiagnostic = { schema: "zeros.diagnostic/v1", component: "installer", stage: "done", ok: true,
      exitCode: 0, timedOut: false, failedChecks: [] };
    const output = JSON.stringify({ version: 1, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "ready", readiness: readiness(input) }) +
      "\n" + JSON.stringify(installerDiagnostic) + "\n";
    vi.mocked(f.runner.execute).mockResolvedValue({ exitCode: 0, output, outputTruncated: false });
    const executor = new CloudWorkspaceLinuxSetupExecutor({ admissionBroker: f.broker, commandRunner: f.runner,
      runtimeArtifacts, resolveRuntimeArtifact, engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, timeoutSeconds: 300, now: () => NOW });
    return { ...f, executor, runtimeArtifacts, resolveRuntimeArtifact, descriptor, pin, objectKey, artifact, artifactUrl, installerDiagnostic, output };
  };

  it("wraps the unchanged setup payload in the fixed v4 installer input with a 15-minute artifact capability", async () => {
    const f = v4();
    await expect(f.executor.execute(f.input, new AbortController().signal)).resolves.toMatchObject({ readiness: readiness(f.input) });
    const call = vi.mocked(f.runner.execute).mock.calls[0][0];
    expect(call.command).toBe(CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND);
    expect(call.runtimeBaseCompatibilityId).toBe(runtimeBase.compatibilityId);
    const wrapped = JSON.parse(Buffer.from(call.env!.ZEROS_CLOUD_WORKSPACE_SETUP_B64, "base64url").toString());
    expect(Object.keys(wrapped).sort()).toEqual(["artifact", "purpose", "runtime", "schema", "setup"]);
    expect(wrapped).toMatchObject({ schema: "zeros.runtime-install/v1", purpose: "workspace-setup", runtime: f.descriptor,
      artifact: { url: f.artifactUrl, expiresAt: new Date(NOW + 900_000).toISOString() } });
    expect(f.runtimeArtifacts.presignGet).toHaveBeenCalledExactlyOnceWith(f.objectKey, 900);
    const { runtime: _runtime, ...legacyInput } = f.input;
    const legacy = harness(legacyInput);
    legacy.grant.expiresAt = f.grant.expiresAt;
    await legacy.executor.execute(legacy.input, new AbortController().signal);
    expect(wrapped.setup).toBe(vi.mocked(legacy.runner.execute).mock.calls[0][0].env!.ZEROS_CLOUD_WORKSPACE_SETUP_B64);
    expect(JSON.stringify(vi.mocked(f.broker.revoke).mock.calls)).not.toContain(f.artifactUrl);
  });
  it("accepts bounded v4 setup timing envelopes without changing the readiness proof", async () => {
    const f = v4();
    const timings = { version: 1, clocks: [{ source: "setup", clockId: randomUUID(), startedAt: "2026-10-06T00:00:00.000Z",
      spans: [{ stage: "repository", startMs: 10, endMs: 25, outcome: "passed" }] }] };
    vi.mocked(f.runner.execute).mockResolvedValue({ exitCode: 0, outputTruncated: false,
      output: JSON.stringify({ version: 4, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "ready",
        readiness: readiness(f.input), timings }) + "\n" + JSON.stringify(f.installerDiagnostic) + "\n" });
    const result = await f.executor.execute(f.input, new AbortController().signal);
    expect(result.readiness).toEqual(readiness(f.input));
    expect((result as any).timings.clocks).toEqual(expect.arrayContaining(timings.clocks));
    vi.mocked(f.runner.execute).mockResolvedValue({ exitCode: 0, outputTruncated: false,
      output: JSON.stringify({ version: 4, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "ready",
        readiness: readiness(f.input), timings: { private: "discarded" } }) + "\n" + JSON.stringify(f.installerDiagnostic) + "\n" });
    const malformed = await f.executor.execute(f.input, new AbortController().signal);
    expect(malformed.readiness).toEqual(readiness(f.input));
    expect(JSON.stringify(malformed.timings)).not.toContain("private");
    expect(malformed.timings?.clocks.map(clock => clock.source)).toEqual(["control_plane"]);
  });
  it("never returns artifact URLs in setup logs or errors", async () => {
    const f = v4();
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: 1, output: f.artifactUrl, outputTruncated: false });
    const failure = await f.executor.execute(f.input, new AbortController().signal).catch(error => error);
    expect(failure.code).toBe("setup_helper_secret_echo");
    expect(String(failure)).not.toContain(f.artifactUrl);
    f.runtimeArtifacts.presignGet.mockRejectedValueOnce(new Error(f.artifactUrl));
    const signingFailure = await f.executor.execute(f.input, new AbortController().signal).catch(error => error);
    expect(String(signingFailure)).not.toContain(f.artifactUrl);
  });
  it("parses the unchanged helper document before the final installer diagnostic", async () => {
    const f = v4();
    const helper = JSON.parse(f.output.split("\n")[0]);
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: 0, outputTruncated: false,
      output: JSON.stringify(helper, null, 2) + "\n" + JSON.stringify(f.installerDiagnostic) + "\n" });
    await expect(f.executor.execute(f.input, new AbortController().signal)).resolves.toMatchObject({ readiness: readiness(f.input) });
  });
  it("keeps the helper's retry classification when the v4 installer reports its failure", async () => {
    const f = v4();
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: 1, outputTruncated: false,
      output: JSON.stringify({ version: 1, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error",
        code: "repository_temporarily_unavailable" }) + "\n" + JSON.stringify({ ...f.installerDiagnostic,
        stage: "run_setup", ok: false, exitCode: 1, failedChecks: ["setup_exit"] }) + "\n" });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_repository_unavailable", retryable: true });
  });
  it("retains only bounded redacted v4 hook logs and requires an explicit retry", async () => {
    const f=v4(),hookLog={version:1,text:"Install failed: [redacted]\n",truncated:false};
    const failure={version:3,audience:"zeros-cloud-workspace-setup-result-v1",outcome:"error",code:"setup_command_failed",diagnostic:{version:1,phase:"repository"},hookLog};
    const output=(value:unknown)=>JSON.stringify(value)+"\n"+JSON.stringify({...f.installerDiagnostic,stage:"run_setup",ok:false,exitCode:1,failedChecks:["setup_exit"]})+"\n";
    vi.mocked(f.runner.execute).mockResolvedValueOnce({exitCode:1,output:output(failure),outputTruncated:false});
    await expect(f.executor.execute(f.input,new AbortController().signal)).rejects.toMatchObject({code:"setup_command_failed",retryable:false,hookLog});
    vi.mocked(f.runner.execute).mockResolvedValueOnce({exitCode:1,output:output({...failure,hookLog:{...hookLog,text:"x".repeat(16385)}}),outputTruncated:false});
    const rejected=await f.executor.execute(f.input,new AbortController().signal).catch(error=>error);
    expect(rejected.hookLog).toBeUndefined();
    expect(String(rejected)).not.toContain("x".repeat(100));
  });
  it("rejects oversized v4 stdin and invalid or missing installer success diagnostics", async () => {
    const f = v4();
    f.runtimeArtifacts.presignGet.mockResolvedValueOnce({ ...f.artifact, url: "https://artifacts.example.test/" + "x".repeat(64 * 1024) });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_runtime_input_invalid" });
    expect(f.runner.execute).not.toHaveBeenCalled();
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: 0, output: f.output.split("\n")[0], outputTruncated: false });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_runtime_install_failed" });
  });
  it("fails closed when v4 runtime artifact delivery is not configured", async () => {
    const f = v4();
    const executor = new CloudWorkspaceLinuxSetupExecutor({ admissionBroker: f.broker, commandRunner: f.runner,
      runtimeArtifacts: null, resolveRuntimeArtifact: f.resolveRuntimeArtifact,
      engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, timeoutSeconds: 300, now: () => NOW });
    await expect(executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "cloud_runtime_unavailable" });
    expect(f.runner.execute).not.toHaveBeenCalled();
    expect(f.resolveRuntimeArtifact).not.toHaveBeenCalled();
  });
  it.each([NOW - 1, NOW + 900_001])("rejects an expired or overlong artifact capability", async expires => {
    const f = v4();
    f.runtimeArtifacts.presignGet.mockResolvedValueOnce({ ...f.artifact, expiresAt: new Date(expires).toISOString() });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_runtime_input_invalid" });
    expect(f.runner.execute).not.toHaveBeenCalled();
  });
  it.each([120_000, 604_999])("rejects v4 admission without time for installation and helper entry (%i ms)", async lifetime => {
    const f = v4();
    f.grant.expiresAt = new Date(NOW + lifetime);
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_admission_invalid", retryable: false });
    expect(f.runner.execute).not.toHaveBeenCalled();
    expect(f.runtimeArtifacts.presignGet).not.toHaveBeenCalled();
    expect(f.broker.revoke).toHaveBeenCalledWith(f.grant, "rejected");
  });
  it.each([
    { check: "timeout", exitCode: 124, transportExitCode: 124, retryable: true },
    { check: "process_signal", exitCode: 143, transportExitCode: 124, retryable: true },
    { check: "manifest_digest", exitCode: 1, transportExitCode: 1, retryable: false },
    { check: "archive_digest", exitCode: 1, transportExitCode: 124, retryable: false },
  ])("handles installer-only $check failures with child $exitCode / transport $transportExitCode", async ({ check, exitCode, transportExitCode, retryable }) => {
    const f = v4();
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: transportExitCode, outputTruncated: false,
      output: JSON.stringify({ ...f.installerDiagnostic, stage: "download", ok: false,
        exitCode, timedOut: check === "timeout", failedChecks: [check] }) + "\n" });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_runtime_install_failed", retryable });
  });
  it.each([
    { exitCode: 1, reason: "outer flock contention" },
    { exitCode: 124, reason: "outer timeout" },
    { exitCode: 137, reason: "outer timeout kill-after" },
  ])("retries $reason without an installer diagnostic", async ({ exitCode }) => {
    const f = v4();
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode, output: "", outputTruncated: false });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_runtime_install_failed", retryable: true });
    expect(f.broker.revoke).toHaveBeenCalledWith(f.grant, "failed");
  });
  it("requires installer success even when the helper already returned readiness before an outer timeout", async () => {
    const f = v4();
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: 124, outputTruncated: false,
      output: f.output.split("\n")[0] + "\n" + JSON.stringify({ ...f.installerDiagnostic,
        stage: "run_setup", ok: false, exitCode: 143, failedChecks: ["process_signal"] }) });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_runtime_install_failed", retryable: true });
  });
  it("attaches the validated installer diagnostic to a typed failure", async () => {
    const f = v4();
    const installer = { ...f.installerDiagnostic, stage: "verify_archive", ok: false, exitCode: 1, failedChecks: ["archive_digest"] };
    vi.mocked(f.runner.execute).mockResolvedValueOnce({ exitCode: 1, output: JSON.stringify(installer), outputTruncated: false });
    await expect(f.executor.execute(f.input, new AbortController().signal)).rejects.toMatchObject({
      code: "setup_runtime_install_failed", retryable: false, diagnostic: { version: 1, phase: "runtime", installer },
    });
  });
  it("accepts a bounded v2 failure envelope without changing the exact v1 proof", async () => {
    const { executor, runner, input } = harness();
    const diagnostic = { version: 1, phase: "image_preflight", checks: { source: false, engine: true } };
    vi.mocked(runner.execute).mockResolvedValue({ exitCode: 1, outputTruncated: false, output: JSON.stringify({
      version: 2, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error", code: "image_contract_invalid", diagnostic,
    }) });
    await expect(executor.execute(input, new AbortController().signal)).rejects.toMatchObject({ code: "setup_image_contract_invalid", diagnostic });
  });
  it("drops untrusted diagnostic fields while retaining fail-closed setup behavior", async () => {
    const { executor, runner, input } = harness();
    vi.mocked(runner.execute).mockResolvedValue({ exitCode: 1, outputTruncated: false, output: JSON.stringify({
      version: 2, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error", code: "image_contract_invalid",
      diagnostic: { version: 1, phase: "image_preflight", message: "credential-canary" },
    }) });
    const failure = await executor.execute(input, new AbortController().signal).catch(error => error);
    expect(JSON.stringify(failure)).not.toContain("credential-canary");
    expect(failure.diagnostic).toBeUndefined();
    expect(failure.code).toBe("setup_helper_failed");
  });
  it("serializes image setup so a reclaimed remote command cannot overlap its successor", () => {
    expect(CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND).toBe(
      "/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs",
    );
  });

  it.each(["boat", "boat"])(
    "invokes only the fixed Linux helper with a fence-bound admission for %s",
    async (providerName) => {
      const target = execution({
        provider: { name: providerName, resourceId: "sandbox-exact-id" },
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

      expect(broker.issue).toHaveBeenCalledWith(
        target,
        expect.any(AbortSignal),
      );
      expect(runner.execute).toHaveBeenCalledTimes(1);
      const command = vi.mocked(runner.execute).mock.calls[0]![0];
      expect(command).toMatchObject({
        resourceId: target.provider.resourceId,
        command: CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND,
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
    },
  );

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

  it.each([
    ["repository_temporarily_unavailable", "setup_repository_unavailable", true],
    ["repository_history_limit", "setup_repository_history_limit", false],
  ] as const)("maps allowlisted helper failure %s without trusting arbitrary retryability", async (helperCode, code, retryable) => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(runner.execute).mockResolvedValue({
      exitCode: 75,
      output: JSON.stringify({
        audience: "zeros-cloud-workspace-setup-result-v1",
        code: helperCode,
        outcome: "error",
        version: 1,
      }),
      outputTruncated: false,
    });

    await expect(
      executor.execute(input, new AbortController().signal),
    ).rejects.toMatchObject({
      code,
      retryable,
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

  it.each([
    ["boat", "image_contract_invalid", "setup_image_contract_invalid", true],
    ["boat", "checkpoint_restore_invalid", "setup_checkpoint_restore_invalid", false],
    ["boat", "settings_invalid", "setup_settings_invalid", false],
    ["boat", "cloud_workspace_v2_required", "cloud_workspace_v2_required", false],
  ])("keeps %s %s closed while classifying a full setup retry", async (provider, helperCode, code, retryable) => {
    const input = execution({ provider: { name: provider, resourceId: "sandbox-exact-id" } });
    const { broker, executor, grant, runner } = harness(input);
    vi.mocked(runner.execute).mockResolvedValue({
      exitCode: 1,
      output: JSON.stringify({ version: 1, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error", code: helperCode }),
      outputTruncated: false,
    });
    await expect(executor.execute(input, new AbortController().signal)).rejects.toMatchObject({ code, retryable });
    expect(broker.revoke).toHaveBeenCalledWith(grant, "failed");
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh fenced admission and full readiness after a Boat restore race", async () => {
    const first = execution({ provider: { name: "boat", resourceId: "sandbox-exact-id" } });
    const next = { ...first, executionFence: first.executionFence + 1 };
    const { broker, executor, grant, runner } = harness(first);
    const renewed = admission(next, { id: randomUUID(), token: `zws_${"B".repeat(43)}` });
    vi.mocked(broker.issue).mockResolvedValueOnce(grant).mockResolvedValueOnce(renewed);
    vi.mocked(runner.execute)
      .mockResolvedValueOnce({ exitCode: 1, output: JSON.stringify({ version: 1,
        audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error", code: "image_contract_invalid" }), outputTruncated: false })
      .mockResolvedValueOnce({ exitCode: 0, output: JSON.stringify({ version: 1,
        audience: "zeros-cloud-workspace-setup-result-v1", outcome: "ready", readiness: readiness(next) }), outputTruncated: false });
    await expect(executor.execute(first, new AbortController().signal)).rejects.toMatchObject({ retryable: true });
    expect(broker.revoke).toHaveBeenLastCalledWith(grant, "failed");
    await expect(executor.execute(next, new AbortController().signal)).resolves.toMatchObject({ readiness: readiness(next) });
    expect(broker.revoke).toHaveBeenLastCalledWith(renewed, "completed");
    const requests = vi.mocked(runner.execute).mock.calls.map(([call]) =>
      JSON.parse(Buffer.from(call.env!.ZEROS_CLOUD_WORKSPACE_SETUP_B64!, "base64url").toString("utf8")));
    expect(requests.map(request => request.admission.id)).toEqual([grant.id, renewed.id]);
    expect(requests.map(request => request.execution.executionFence)).toEqual([first.executionFence, next.executionFence]);
  });

  it.each([
    ["checkpoint_restore_invalid", "setup_checkpoint_restore_invalid", false],
    ["checkpoint_restore_unavailable", "setup_checkpoint_restore_unavailable", true],
  ])("classifies %s without losing its retry policy", async (failure, code, retryable) => {
    const { broker, executor, grant, input, runner } = harness();
    vi.mocked(runner.execute).mockResolvedValue({
      exitCode: 1,
      output: JSON.stringify({ version: 1, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error", code: failure }),
      outputTruncated: false,
    });
    await expect(executor.execute(input, new AbortController().signal)).rejects.toMatchObject({ code, retryable });
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
